"""Environments: create a new one, adopt a hand-built one, edit one.
Secrets are generated (new) or imported (adopt), encrypted with
SIRDAR_SECRETS_KEY, and never returned, logged or put in an error. Callers
audit and commit.

Adopt reads <env-dir>/.env and the checkout's HEAD over SSH and touches
nothing else: the environment's database, files, .env and containers stay
as they are. Keys Sirdar doesn't know are reported by name and dropped from
the .env on the next deploy."""

import ipaddress
import re
import shlex
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath

from cryptography.fernet import Fernet
from sqlalchemy import delete, func, select, text
from sqlalchemy import update as sql_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    EsxiVm,
    ProxmoxVm,
    Snapshot,
)
from sirdar_api.deploy import (
    ConnectFailed,
    certs,
    do_accounts,
    do_envs,
    envfile,
    first_admins,
    integrations,
    lan_slots,
    names,
    ssh,
    targets,
    vault,
    vms,
)
from sirdar_api.deploy.gitref import SHA_RE, valid_ref
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.deploy.ssh import SshTargetConfig

ENV_TYPES = ("dev", "beta", "custom", "production")
DEFAULT_DOMAIN_SUFFIX = "serversherpa.com"
DEFAULT_GIT_REF = "main"
DEFAULT_BIND_IP = "0.0.0.0"
SSH_TARGET_RE = re.compile(r"ssh|ssh:[a-z0-9]+(-[a-z0-9]+)*")
_DOMAIN_RE = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
_BUCKET_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
_TAG_RE = re.compile(r"[A-Za-z0-9_.-]{1,128}")
# Optional secrets set by hand (API keys, passwords): no whitespace, quotes,
# "$" (compose interpolation), "#", backslash or backtick.
_SECRET_VALUE_RE = re.compile(r"[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}")
# Adopted required secrets must have the shapes create generates.
_HEX_RE = re.compile(r"[0-9a-fA-F]{1,1024}")
_FERNET_KEY_RE = re.compile(r"[A-Za-z0-9_-]{43}=")
_NO_ANSWER = "The target didn't answer in time."
# The names `ss-stack dump` gives pre-deploy dumps (UTC timestamps).
BACKUP_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z\.dump")
# pg_advisory_xact_lock key serializing "is there a live production?" with
# the write that depends on it (create, un-retire). Fixed and arbitrary.
PRODUCTION_LOCK = 0x5D0_0001


class EnvError(Exception):
    """A validation or state failure. `code` is the API error code; `extra`
    holds non-secret details (service and key names, never values)."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def _now() -> datetime:
    return datetime.now(UTC)


# ---- checks ------------------------------------------------------------------

def _check_name(name: str) -> None:
    if not names.is_valid_custom_name(name):
        raise EnvError("name_invalid")
    if names.is_reserved_name(name):
        raise EnvError("name_reserved")


def _check_ref(ref: str) -> str:
    if not valid_ref(ref):
        raise EnvError("ref_invalid")
    return ref


def _check_domain(value: str) -> str:
    domain = value.strip().lower().rstrip(".")
    if not _DOMAIN_RE.fullmatch(domain):
        raise EnvError("base_domain_invalid")
    return domain


def _check_ipv4(value: str, code: str) -> str:
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        raise EnvError(code) from None


def _check_port(value, service: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise EnvError("port_invalid", service=service)
    return value


def _check_ports_unique(ports: dict[str, int]) -> None:
    if len(set(ports.values())) != len(ports):
        raise EnvError("ports_conflict")


def _check_keep_dumps(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise EnvError("keep_dumps_invalid")
    return value


def _check_bucket(value: str) -> str:
    if not _BUCKET_RE.fullmatch(value):
        raise EnvError("bucket_invalid")
    return value


def _check_log_level(value: str) -> str:
    level = value.upper()
    if level not in envfile.LOG_LEVELS:
        raise EnvError("log_level_invalid")
    return level


def _check_target(target_id: str, settings: Settings) -> SshTargetConfig | None:
    """An SSH target's config, or None for a host Sirdar builds (a VM or
    DigitalOcean droplets: step 0 builds them)."""
    if targets.is_built_target(target_id):
        return None
    if not SSH_TARGET_RE.fullmatch(target_id):
        raise EnvError("target_invalid")
    cfg = targets.ssh_config_for(target_id, settings)
    if cfg is None:
        raise EnvError("target_not_configured")
    return cfg


def _hostname(service: str, domain: str) -> str | None:
    return f"{service}.{domain}" if service in envfile.PUBLIC_SERVICES else None


# ---- reads -------------------------------------------------------------------

async def get_by_name(db: AsyncSession, name: str) -> Environment | None:
    return await db.scalar(select(Environment).where(Environment.name == name))


async def list_all(db: AsyncSession) -> list[Environment]:
    return list(await db.scalars(select(Environment).order_by(Environment.name)))


async def services_of(db: AsyncSession, env_id) -> list[EnvironmentService]:
    rows = await db.scalars(select(EnvironmentService)
                            .where(EnvironmentService.environment_id == env_id))
    order = {s: i for i, s in enumerate(envfile.SERVICES)}
    return sorted(rows, key=lambda r: order.get(r.service, len(order)))


async def secret_keys_of(db: AsyncSession, env_id) -> set[str]:
    return set(await db.scalars(select(EnvironmentSecret.key)
                                .where(EnvironmentSecret.environment_id == env_id)))


async def is_deploying(db: AsyncSession, env_id) -> bool:
    found = await db.scalar(select(Deployment.id).where(
        Deployment.environment_id == env_id, Deployment.status == "running").limit(1))
    return found is not None


# ---- create and adopt --------------------------------------------------------

async def _precheck(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                    target_id: str, git_ref: str) -> SshTargetConfig | None:
    _check_name(name)
    if type_ not in ENV_TYPES:
        raise EnvError("type_invalid")
    cfg = _check_target(target_id, settings)
    _check_ref(git_ref)
    if not vault.is_configured(settings):
        raise EnvError("secrets_key_missing")
    if await get_by_name(db, name) is not None:
        raise EnvError("environment_exists")
    return cfg


async def _insert(db: AsyncSession, settings: Settings, *, name: str,
                  type_: str, target_id: str, git_ref: str, host: str, domain: str,
                  proxy_ip: str,
                  bind_ip: str, ports: dict[str, int], keep_dumps: int, spaces_bucket: str,
                  log_level: str, status: str, current_sha: str | None,
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id, seed_snapshot_id: uuid.UUID | None = None,
                  publish: bool = False,
                  public_services: tuple[str, ...] = envfile.PUBLIC_SERVICES,
                  slots: list[str] | None = None) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id,
                      seed_snapshot_id=seed_snapshot_id, publish=publish)
    if slots is not None:
        # Set on the INSERT: the database checks production's slots there.
        env.slots = slots
    db.add(env)
    await db.flush()
    for service in envfile.SERVICES:
        db.add(EnvironmentService(environment_id=env.id, service=service, host_ip=host,
                                  port=ports[service],
                                  hostname=(f"{service}.{domain}"
                                            if service in public_services else None),
                                  proxied=False))
    for key, value in secrets.items():
        db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                 value_enc=vault.encrypt(settings, value)))
    await db.flush()
    return env


async def create_new(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                     target_id: str, git_ref: str = DEFAULT_GIT_REF,
                     base_domain: str | None = None, proxy_ip: str | None = None,
                     bind_ip: str = DEFAULT_BIND_IP,
                     ports: dict[str, int] | None = None, actor_id=None,
                     snapshot_id: uuid.UUID | None = None,
                     publish: bool = True, vm: dict | None = None,
                     do: dict | None = None,
                     first_admin: dict | None = None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets. With a
    snapshot, its first deploy restores that snapshot (and its keys). With
    publish (the default), its deploys add DNS, proxy and smoke steps. On a
    VM target ("proxmox" or "esxi"), `vm` sizes the VM step 0 builds and
    sets its network; every service points at its static address (0.0.0.0
    for DHCP until step 0 reads it), and its VM row records it as Sirdar's.
    On DigitalOcean ("digitalocean"), `do` picks the account, slots and
    sizes (see do_envs.check_spec); production lives only there.
    first_admin: the first super admin step 11 of the first deploy creates
    (never with a snapshot). With `vm.slots: 2` (ESXi or Proxmox) the
    environment is LAN Blue/Green: a data VM and two app VMs (orange,
    purple), static addresses, Nginx Proxy Manager as the switch."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    admin_spec = None
    if first_admin is not None:
        if snapshot_id is not None:
            raise EnvError("first_admin_with_seed")    # a seed already has its users
        try:
            admin_spec = first_admins.check(first_admin)
        except first_admins.FirstAdminError as e:
            raise EnvError(e.code, **e.extra) from None
    on_do = target_id == targets.DO_TARGET
    if vm is not None and not _slots_ok(vm):
        raise EnvError("vm_invalid")
    if vm is not None and vm.get("slots") == 2 and not targets.is_vm_target(target_id):
        raise EnvError("bluegreen_not_allowed")
    if type_ == "production" and not on_do:
        raise EnvError("production_requires_digitalocean")
    if do is not None and not on_do:
        raise EnvError("do_not_allowed")
    if on_do and vm is not None:
        raise EnvError("vm_not_allowed")
    if snapshot_id is not None:
        # Locked until the caller commits, so a concurrent delete waits and
        # then sees this environment's seed (in use) instead of racing it.
        snap = await db.scalar(select(Snapshot).where(Snapshot.id == snapshot_id)
                               .with_for_update()
                               .execution_options(populate_existing=True))
        if snap is None:
            raise EnvError("snapshot_not_found")
        if snap.status != "ready":
            raise EnvError("snapshot_not_ready")
    domain = _check_domain(base_domain or f"{name}.{DEFAULT_DOMAIN_SUFFIX}")
    if not on_do:                       # DigitalOcean sets its own proxy and bind
        if not proxy_ip:
            raise EnvError("proxy_ip_required")
        proxy = _check_ipv4(proxy_ip, "proxy_ip_invalid")
        bind = _check_ipv4(bind_ip, "bind_ip_invalid")
    given = ports or {}
    unknown = sorted(set(given) - set(envfile.SERVICES))
    if unknown:
        raise EnvError("service_unknown", service=unknown[0])
    all_ports = {s: _check_port(given.get(s, envfile.DEFAULT_PORTS[s]), s)
                 for s in envfile.SERVICES}
    _check_ports_unique(all_ports)
    if on_do:
        env = await _create_on_do(db, settings, name=name, type_=type_, git_ref=git_ref,
                                  domain=domain, ports=all_ports, actor_id=actor_id,
                                  snapshot_id=snapshot_id, do=do or {})
        if admin_spec is not None:
            await first_admins.put(db, settings, env.id, admin_spec)
        return env
    spec = bluegreen = None
    host = cfg.host if cfg is not None else ""
    if targets.is_vm_target(target_id):
        if not await integrations.is_configured(db, target_id):
            raise EnvError("integration_not_configured", kinds=[target_id])
        try:
            if (vm or {}).get("slots") == 2:
                if not await integrations.is_configured(db, "npm"):
                    # Nginx Proxy Manager is the switch between the two app VMs.
                    raise EnvError("integration_not_configured", kinds=["npm"])
                bluegreen = vms.check_bluegreen(vm)
                addresses = [vms.static_ip(bluegreen[r]["ip_cidr"])
                             for r in ("orange", "purple", "data")]
                await vms.lock_addresses(db)        # held until the caller commits
                for address in addresses:
                    if await vms.address_in_use(db, settings, address, proxy_ip=proxy):
                        raise EnvError("ip_in_use")
                address = addresses[0]                 # services start on orange
            else:
                spec = vms.check_spec({} if vm is None else
                                      {k: v for k, v in vm.items() if k != "slots"})
                address = vms.static_ip(spec["ip_cidr"])
                if address:
                    await vms.lock_addresses(db)    # held until the caller commits
                    if await vms.address_in_use(db, settings, address, proxy_ip=proxy):
                        raise EnvError("ip_in_use")
        except vms.VmError as e:
            raise EnvError(e.code, **e.extra) from None
        roles = (vms.DATA, *lan_slots.SLOTS) if bluegreen is not None else (vms.MAIN,)
        taken = await _vm_name_taken(db, [vms.vm_name(name, r) for r in roles])
        if taken is not None:
            raise EnvError("vm_name_taken", name=taken)
        host = address or "0.0.0.0"
    elif vm is not None:
        raise EnvError("vm_not_allowed")
    env = await _insert(
        db, settings, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        host=host, domain=domain, proxy_ip=proxy, bind_ip=bind, ports=all_ports,
        keep_dumps=envfile.DEFAULT_KEEP_DUMPS, spaces_bucket=envfile.DEFAULT_SPACES_BUCKET,
        log_level=envfile.DEFAULT_LOG_LEVEL, status="new", current_sha=None, image_tag=None,
        secrets=vault.generate_env_secrets(), actor_id=actor_id, seed_snapshot_id=snapshot_id,
        publish=publish)
    if spec is not None or bluegreen is not None:
        stored = await integrations.config_of(db, target_id)
        add_vm = vms.add_esxi if target_id == targets.ESXI_TARGET else vms.add
        role = vms.MAIN
        try:
            if bluegreen is not None:
                env.slots = list(lan_slots.SLOTS)
                env.auto_activate = bluegreen["auto_activate"]
                for role in (vms.DATA, *lan_slots.SLOTS):
                    await add_vm(db, settings, env, bluegreen[role], stored, role=role)
                await lan_slots.add(db, env.id, lan_slots.SLOTS)
                await db.execute(sql_update(EnvironmentService).where(
                    EnvironmentService.environment_id == env.id,
                    EnvironmentService.service == "spaces")
                    .values(host_ip=vms.static_ip(bluegreen["data"]["ip_cidr"])))
            else:
                await add_vm(db, settings, env, spec, stored)
        except vms.VmError as e:
            raise EnvError(e.code, **e.extra) from None
        except IntegrityError as e:
            # Two creates both passed _vm_name_taken; the name key settled it.
            # The session needs a rollback, as for any EnvError.
            if any(key in str(e.orig) for key in _VM_NAME_KEYS):
                raise EnvError("vm_name_taken", name=vms.vm_name(name, role)) from None
            raise
    if admin_spec is not None:
        await first_admins.put(db, settings, env.id, admin_spec)
    return env


def _slots_ok(vm) -> bool:
    """`vm.slots`: absent, 1 (one server) or 2 (Blue/Green); never True,
    2.0 or "2"."""
    if not isinstance(vm, dict):
        return False
    s = vm.get("slots")
    return s is None or (not isinstance(s, bool) and isinstance(s, int) and s in (1, 2))


_VM_NAME_KEYS = ("proxmox_vms_name_key", "esxi_vms_name_key")


async def _vm_name_taken(db: AsyncSession, names: list[str]) -> str | None:
    """The first of these VM names another environment's VM (Proxmox or
    ESXi) already has: vm_name("lan1", "data") and vm_name("lan1-data") are
    both ss-lan1-data."""
    used: set[str] = set()
    for model in (ProxmoxVm, EsxiVm):
        used |= set(await db.scalars(select(model.name).where(model.name.in_(names))))
    return next((n for n in names if n in used), None)


async def lock_production(db: AsyncSession) -> None:
    """Held until the transaction ends: two creates (even in different
    accounts), or a create and an un-retire, can't both see no live
    production. The partial unique index environments_one_production is the
    backstop; routes map it to production_exists."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": PRODUCTION_LOCK})


async def _create_on_do(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                        git_ref: str, domain: str, ports: dict[str, int], actor_id,
                        snapshot_id, do: dict) -> Environment:
    """A DigitalOcean environment: the account and sizes frozen, Caddy as the
    proxy on the droplet, publishing on (its plan has DNS), and only the
    public names its load balancer certificate covers."""
    try:
        spec = do_envs.check_spec(do, production=type_ == "production")
    except do_envs.DoEnvError as e:
        raise EnvError(e.code, **e.extra) from None
    try:
        # Held until the caller commits: a concurrent token clear or team
        # change waits, so this environment never freezes an account left
        # without a token or holding another team's token.
        await do_accounts.lock_account(db, spec["account"])
        account = await do_accounts.require(db, settings, spec["account"])
    except IntegrationError as e:
        raise EnvError(e.code, **e.extra) from None
    if account.region is None:
        raise EnvError("do_account_not_configured", account=spec["account"])
    if not await integrations.is_configured(db, "cloudflare"):
        raise EnvError("integration_not_configured", kinds=["cloudflare"])
    zone = (await integrations.config_of(db, "cloudflare")).get("zone") or ""
    if not (domain == zone or domain.endswith("." + zone)):
        raise EnvError("base_domain_not_in_zone")
    if type_ == "production":
        await lock_production(db)
        if await do_envs.production_exists(db):
            raise EnvError("production_exists")
    env = await _insert(
        db, settings, name=name, type_=type_, target_id=targets.DO_TARGET, git_ref=git_ref,
        host="0.0.0.0", domain=domain, proxy_ip=do_envs.CADDY_IP, bind_ip=do_envs.BIND_IP,
        ports=ports, keep_dumps=envfile.DEFAULT_KEEP_DUMPS,
        spaces_bucket=envfile.DEFAULT_SPACES_BUCKET, log_level=envfile.DEFAULT_LOG_LEVEL,
        status="new", current_sha=None, image_tag=None, secrets=vault.generate_env_secrets(),
        actor_id=actor_id, seed_snapshot_id=snapshot_id, publish=True,
        public_services=certs.PUBLIC_SERVICES, slots=list(spec["slots"]))
    env.auto_activate = spec["auto_activate"]
    env.spaces_bucket = do_envs.bucket_name(env.name, env.id)
    await do_envs.add(db, settings, env, spec, region=account.region,
                      team_uuid=account.team_uuid)
    return env


@dataclass(frozen=True)
class AdoptReport:
    sha: str
    imported_secrets: list[str]
    ignored_keys: list[str]


def _adopted_settings(values: dict[str, str]) -> dict:
    """Non-secret settings from an adopted .env. A bad value raises
    adopt_value_invalid naming the key."""
    def invalid(key: str) -> EnvError:
        return EnvError("adopt_value_invalid", key=key)

    def checked(key: str, check, default: str = ""):
        try:
            return check(values.get(key) or default)
        except EnvError:
            raise invalid(key) from None

    domain = checked("STACK_DOMAIN", _check_domain)
    proxy = checked("STACK_PROXY_IP", lambda v: _check_ipv4(v, "x"))
    bind = checked("STACK_BIND_IP", lambda v: _check_ipv4(v, "x"), "0.0.0.0")
    ports: dict[str, int] = {}
    for service in envfile.SERVICES:
        key = envfile.PORT_KEYS[service]
        raw = values.get(key) or str(envfile.DEFAULT_PORTS[service])
        if not (raw.isascii() and raw.isdecimal()):
            raise invalid(key)
        ports[service] = checked(key, lambda v, s=service: _check_port(int(v), s), raw)
    _check_ports_unique(ports)
    keep = values.get("STACK_KEEP_DUMPS") or str(envfile.DEFAULT_KEEP_DUMPS)
    if not (keep.isascii() and keep.isdecimal()):
        raise invalid("STACK_KEEP_DUMPS")
    keep_dumps = checked("STACK_KEEP_DUMPS", lambda v: _check_keep_dumps(int(v)), keep)
    bucket = checked("SS_SPACES_BUCKET", _check_bucket, envfile.DEFAULT_SPACES_BUCKET)
    level = checked("SS_LOG_LEVEL", _check_log_level, envfile.DEFAULT_LOG_LEVEL)
    tag = values.get("STACK_IMAGE_TAG") or None
    if tag is not None and not _TAG_RE.fullmatch(tag):
        raise invalid("STACK_IMAGE_TAG")
    return {"domain": domain, "proxy_ip": proxy, "bind_ip": bind, "ports": ports,
            "keep_dumps": keep_dumps, "spaces_bucket": bucket, "log_level": level,
            "image_tag": tag}


def _valid_fernet_key(value: str) -> bool:
    if not _FERNET_KEY_RE.fullmatch(value):
        return False
    try:
        Fernet(value.encode())
    except ValueError:
        return False
    return True


def _adopted_secrets(values: dict[str, str]) -> dict[str, str]:
    """The secrets of an adopted .env, only in shapes that render back
    unchanged: a Fernet key for TOTP, hex for POSTGRES_PASSWORD (a local
    stack's compose file puts it into its database URL unescaped; only the
    DigitalOcean URL that env_extra builds quotes it), and the PATCH rule's
    safe characters for the rest. A hand-built env may carry secrets Sirdar didn't generate (uat's
    pepper came from dev), so those are kept as they are, not forced to hex.
    An optional secret left at CHANGEME is unset. Anything else raises
    adopt_value_invalid naming the key, never the value."""
    secrets: dict[str, str] = {}
    for key in envfile.SECRET_KEYS:
        value = values.get(key, "")
        if key in envfile.OPTIONAL_SECRETS:
            if value in ("", envfile.PLACEHOLDER):
                continue
            ok = bool(_SECRET_VALUE_RE.fullmatch(value))
        elif key in envfile.FERNET_SECRETS:
            ok = _valid_fernet_key(value)
        elif key == "POSTGRES_PASSWORD":
            ok = bool(_HEX_RE.fullmatch(value))
        else:
            ok = value != envfile.PLACEHOLDER and bool(_SECRET_VALUE_RE.fullmatch(value))
        if not ok:
            raise EnvError("adopt_value_invalid", key=key)
        secrets[key] = value
    return secrets


async def adopt(db: AsyncSession, settings: Settings, *, name: str, type_: str,
                target_id: str, git_ref: str = "main",
                actor_id=None) -> tuple[Environment, Deployment, AdoptReport]:
    if targets.is_built_target(target_id):
        # VM environments are only ones Sirdar built: a hand-built VM (uat)
        # stays an SSH target.
        raise EnvError("adopt_not_allowed")
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
    folder = envfile.env_dir(name)
    found = await ssh.run_command(cfg, db, f"cat -- {shlex.quote(folder + '/.env')}")
    if found.exit_status is None:
        raise ConnectFailed(_NO_ANSWER)
    if found.exit_status != 0:
        raise EnvError("adopt_env_missing")
    if len(found.stdout) >= ssh.OUTPUT_LIMIT:
        # run_command cuts stdout at OUTPUT_LIMIT without saying so: a file
        # that reached the cap may be partial, so refuse it.
        raise EnvError("adopt_env_too_large")
    values = envfile.parse_env(found.stdout)
    if values.get("STACK_ENV") != name:
        raise EnvError("adopt_env_mismatch")
    missing = [k for k in envfile.REQUIRED_SECRETS
               if values.get(k, "") in ("", envfile.PLACEHOLDER)]
    if missing:
        raise EnvError("adopt_env_incomplete", missing=missing)
    picked = _adopted_settings(values)
    secrets = _adopted_secrets(values)

    repo = shlex.quote(folder + "/repo")
    head = await ssh.run_command(cfg, db, f"git -C {repo} rev-parse HEAD")
    if head.exit_status is None:
        raise ConnectFailed(_NO_ANSWER)
    sha = head.stdout.strip()      # a truncated HEAD can't match SHA_RE
    if head.exit_status != 0 or not SHA_RE.fullmatch(sha):
        raise EnvError("adopt_repo_missing")

    env = await _insert(
        db, settings, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        host=cfg.host, domain=picked["domain"], proxy_ip=picked["proxy_ip"],
        bind_ip=picked["bind_ip"],
        ports=picked["ports"], keep_dumps=picked["keep_dumps"],
        spaces_bucket=picked["spaces_bucket"], log_level=picked["log_level"],
        status="ready", current_sha=sha, image_tag=picked["image_tag"], secrets=secrets,
        actor_id=actor_id)
    now = _now()
    dep = Deployment(environment_id=env.id, mode="adopt", git_ref=git_ref, sha=sha,
                     status="adopted", start_step=1, actor_id=actor_id, started_at=now,
                     finished_at=now)
    db.add(dep)
    await db.flush()
    # a droplet's keys (EXTRA_KEYS) never come from a hand-built .env
    adoptable = set(envfile.KNOWN_KEYS) - set(envfile.EXTRA_KEYS)
    ignored = sorted(k for k in values if k not in adoptable)
    return env, dep, AdoptReport(sha=sha, imported_secrets=sorted(secrets),
                                 ignored_keys=ignored)


# ---- edit --------------------------------------------------------------------

async def update(db: AsyncSession, settings: Settings, env: Environment,
                 fields: dict) -> list[str]:
    """Apply a PATCH: an absent or None field is kept. Only the optional
    secrets are editable ("" clears one). Returns the changed names."""
    if await is_deploying(db, env.id):
        raise EnvError("deploy_in_progress")
    changed: list[str] = []

    def put(attr: str, value) -> None:
        if getattr(env, attr) != value:
            setattr(env, attr, value)
            changed.append(attr)

    if fields.get("git_ref") is not None:
        put("git_ref", _check_ref(fields["git_ref"]))
    on_vm = targets.is_vm_target(env.target_id)
    on_do = env.target_id == targets.DO_TARGET
    if on_do:
        # Its names, proxy, bucket and DNS belong to what step 0 built.
        attrs = {"target": "target_id"}
        for key in ("target", "proxy_ip", "bind_ip", "base_domain", "spaces_bucket", "publish"):
            if fields.get(key) is not None and fields[key] != getattr(env, attrs.get(key, key)):
                raise EnvError("do_field_locked", field=key)
    if fields.get("retiring") is not None:
        if env.type != "production":
            raise EnvError("retiring_not_allowed")
        if env.retiring and not fields["retiring"]:
            await lock_production(db)
            if await do_envs.production_exists(db, other_than=env.id):
                raise EnvError("production_exists")     # at most one live production
        put("retiring", bool(fields["retiring"]))
    if fields.get("auto_activate") is not None:
        # Off is always fine; on only for a non-production DigitalOcean environment.
        if fields["auto_activate"] and (not on_do or env.type == "production"):
            raise EnvError("auto_activate_not_allowed")
        put("auto_activate", bool(fields["auto_activate"]))
    if fields.get("target") is not None:
        # An environment never moves to or from a host Sirdar builds, nor
        # between them.
        if fields["target"] != env.target_id and (
                targets.is_built_target(env.target_id)
                or targets.is_built_target(fields["target"])):
            raise EnvError("target_kind_locked")
        _check_target(fields["target"], settings)
        put("target_id", fields["target"])
    old_domain = env.base_domain
    if fields.get("base_domain") is not None:
        put("base_domain", _check_domain(fields["base_domain"]))
    if fields.get("proxy_ip") is not None:
        put("proxy_ip", _check_ipv4(fields["proxy_ip"], "proxy_ip_invalid"))
    if fields.get("bind_ip") is not None:
        put("bind_ip", _check_ipv4(fields["bind_ip"], "bind_ip_invalid"))
    if fields.get("keep_dumps") is not None:
        put("keep_dumps", _check_keep_dumps(fields["keep_dumps"]))
    if fields.get("spaces_bucket") is not None:
        put("spaces_bucket", _check_bucket(fields["spaces_bucket"]))
    if fields.get("log_level") is not None:
        put("log_level", _check_log_level(fields["log_level"]))
    if fields.get("publish") is not None:
        put("publish", bool(fields["publish"]))

    rows = {r.service: r for r in await services_of(db, env.id)}
    service_fields = fields.get("services") or {}
    unknown = sorted(set(service_fields) - set(rows))
    if unknown:
        raise EnvError("service_unknown", service=unknown[0])
    for service, patch in service_fields.items():
        row, patch = rows[service], patch or {}
        if patch.get("port") is not None:
            port = _check_port(patch["port"], service)
            if row.port != port:
                row.port = port
                changed.append(f"services.{service}.port")
        if patch.get("host_ip") is not None:
            if on_vm or on_do:                  # step 0 points them at the VM / droplets
                raise EnvError("host_ip_managed", service=service)
            host_ip = _check_ipv4(patch["host_ip"], "host_ip_invalid")
            if row.host_ip != host_ip:
                row.host_ip = host_ip
                changed.append(f"services.{service}.host_ip")
        if patch.get("proxied") is not None and row.proxied != bool(patch["proxied"]):
            row.proxied = bool(patch["proxied"])
            changed.append(f"services.{service}.proxied")
    _check_ports_unique({s: r.port for s, r in rows.items()})
    if env.base_domain != old_domain:
        for service, row in rows.items():
            row.hostname = _hostname(service, env.base_domain)

    secrets = fields.get("secrets") or {}
    for key, value in secrets.items():
        if key not in envfile.OPTIONAL_SECRETS:
            raise EnvError("secret_not_editable", key=key)
        if value is not None and (not isinstance(value, str)
                                  or (value and not _SECRET_VALUE_RE.fullmatch(value))):
            raise EnvError("secret_invalid", key=key)
    if any(v for v in secrets.values()) and not vault.is_configured(settings):
        raise EnvError("secrets_key_missing")
    existing = await secret_keys_of(db, env.id)
    for key, value in secrets.items():
        if value is None:
            continue
        if value == "":
            if key in existing:
                await db.execute(delete(EnvironmentSecret).where(
                    EnvironmentSecret.environment_id == env.id, EnvironmentSecret.key == key))
                changed.append(f"secrets.{key}")
            continue
        row = await db.get(EnvironmentSecret, (env.id, key))
        if row is None:
            db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                     value_enc=vault.encrypt(settings, value)))
        else:
            row.value_enc, row.updated_at = vault.encrypt(settings, value), _now()
        changed.append(f"secrets.{key}")

    if fields.get("vm") is not None:
        machine = await vms.get_for(db, env) if on_vm else None
        if machine is None:
            raise EnvError("vm_not_allowed")
        try:
            changed += await vms.update(db, machine, fields["vm"])
        except vms.VmError as e:
            raise EnvError(e.code, **e.extra) from None
    if fields.get("do_checked") is not None:       # checked by the route (it asks DigitalOcean)
        row = await do_envs.get(db, env.id) if on_do else None
        if row is None:
            raise EnvError("do_not_allowed")
        changed += do_envs.apply_sizes(row, fields["do_checked"])

    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed


# ---- backups (pre-deploy dumps on the target) -----------------------------------

def backups_command(name: str) -> str:
    folder = shlex.quote(envfile.env_dir(name) + "/backups")
    return (f"find {folder} -maxdepth 1 -type f -name '*.dump' "
            "-printf '%f\\t%s\\t%T@\\n' 2>/dev/null || true")


def backup_taken_at(name: str) -> datetime:
    """When `ss-stack dump` took a backup: the UTC time in its name (a name
    valid_backup_name accepts)."""
    return datetime.strptime(name, "%Y%m%dT%H%M%SZ.dump").replace(tzinfo=UTC)


def valid_backup_name(name: str) -> bool:
    """A name `ss-stack dump` could give: BACKUP_RE's shape and a real UTC
    time (not month 13, February 30th or second 60)."""
    if not BACKUP_RE.fullmatch(name):
        return False
    try:
        backup_taken_at(name)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class KeyChanges:
    """What makes an environment's backups unrestorable: when a snapshot
    restore last replaced its pepper and TOTP key (the end of its latest
    succeeded Restore snapshot step, or None), and the names of the dumps
    that deployments with a Restore snapshot step took of the database that
    was there before (a seeded first deploy's own dump)."""
    changed_at: datetime | None
    pre_restore: frozenset[str]


async def key_changes(db: AsyncSession, env_id) -> KeyChanges:
    changed_at = await db.scalar(
        select(func.max(DeploymentStep.finished_at))
        .join(Deployment, Deployment.id == DeploymentStep.deployment_id)
        .where(Deployment.environment_id == env_id, DeploymentStep.key == "restore",
               DeploymentStep.status == "succeeded"))
    restoring = select(DeploymentStep.deployment_id).where(DeploymentStep.key == "restore")
    paths = await db.scalars(select(Deployment.dump_path).where(
        Deployment.environment_id == env_id, Deployment.dump_path.is_not(None),
        Deployment.id.in_(restoring)))
    return KeyChanges(changed_at, frozenset(PurePosixPath(p).name for p in paths))


PRE_RESTORE = ("Taken from the database that was here before a snapshot restore; its sign-in "
               "keys are gone.")


def backup_blocked(name: str, changes: KeyChanges) -> str | None:
    """Why a backup (a valid_backup_name) can't be restored, or None. A dump
    made under keys a snapshot restore replaced would lock everyone out: the
    keys no longer exist anywhere.
    - A dump a restoring deployment took is from before its restore, whatever
      the target's clock wrote in its name.
    - Otherwise the name's time against the key change. Names have whole
      seconds: a dump named for the second the keys changed in may have
      started before, so it counts as before."""
    if name in changes.pre_restore:
        return PRE_RESTORE
    if changes.changed_at is None or backup_taken_at(name) > changes.changed_at:
        return None
    when = changes.changed_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
    return f"Taken before the sign-in keys changed (snapshot restore on {when})."


async def list_backups(db: AsyncSession, cfg: SshTargetConfig, env: Environment) -> list[dict]:
    """The environment's pre-deploy dumps, newest first: name, size, time,
    and whether it can be restored (`restorable`, else a `reason`). Lines
    that aren't `ss-stack dump` files are ignored."""
    result = await ssh.run_command(cfg, db, backups_command(env.name))
    if result.exit_status is None:
        raise ConnectFailed(_NO_ANSWER)
    rows: list[dict] = []
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not valid_backup_name(parts[0]) or not parts[1].isdecimal():
            continue
        try:
            modified = datetime.fromtimestamp(float(parts[2]), UTC)
        except (ValueError, OverflowError, OSError):
            continue
        rows.append({"name": parts[0], "size_bytes": int(parts[1]), "modified_at": modified})
    changes = await key_changes(db, env.id)
    for row in rows:
        row["reason"] = backup_blocked(row["name"], changes)
        row["restorable"] = row["reason"] is None
    return sorted(rows, key=lambda r: r["name"], reverse=True)
