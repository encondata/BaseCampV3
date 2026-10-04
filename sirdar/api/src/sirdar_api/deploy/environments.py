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

from cryptography.fernet import Fernet
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import (
    Deployment,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Snapshot,
)
from sirdar_api.deploy import ConnectFailed, envfile, names, ssh, targets, vault
from sirdar_api.deploy.gitref import SHA_RE, valid_ref
from sirdar_api.deploy.ssh import SshTargetConfig

ENV_TYPES = ("dev", "beta", "custom")
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


def _check_target(target_id: str, settings: Settings) -> SshTargetConfig:
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
                    target_id: str, git_ref: str) -> SshTargetConfig:
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


async def _insert(db: AsyncSession, settings: Settings, cfg: SshTargetConfig, *, name: str,
                  type_: str, target_id: str, git_ref: str, domain: str, proxy_ip: str,
                  bind_ip: str, ports: dict[str, int], keep_dumps: int, spaces_bucket: str,
                  log_level: str, status: str, current_sha: str | None,
                  image_tag: str | None, secrets: dict[str, str],
                  actor_id, seed_snapshot_id: uuid.UUID | None = None) -> Environment:
    env = Environment(name=name, type=type_, target_id=target_id, base_domain=domain,
                      git_ref=git_ref, current_sha=current_sha, image_tag=image_tag,
                      status=status, proxy_ip=proxy_ip, bind_ip=bind_ip,
                      keep_dumps=keep_dumps, spaces_bucket=spaces_bucket,
                      log_level=log_level, created_by=actor_id,
                      seed_snapshot_id=seed_snapshot_id)
    db.add(env)
    await db.flush()
    for service in envfile.SERVICES:
        db.add(EnvironmentService(environment_id=env.id, service=service, host_ip=cfg.host,
                                  port=ports[service], hostname=_hostname(service, domain),
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
                     snapshot_id: uuid.UUID | None = None) -> Environment:
    """A new environment (status "new"): default ports unless given, the
    target's host for every service, freshly generated secrets. With a
    snapshot, its first deploy restores that snapshot (and its keys)."""
    cfg = await _precheck(db, settings, name=name, type_=type_, target_id=target_id,
                          git_ref=git_ref)
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
    return await _insert(
        db, settings, cfg, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        domain=domain, proxy_ip=proxy, bind_ip=bind, ports=all_ports,
        keep_dumps=envfile.DEFAULT_KEEP_DUMPS, spaces_bucket=envfile.DEFAULT_SPACES_BUCKET,
        log_level=envfile.DEFAULT_LOG_LEVEL, status="new", current_sha=None, image_tag=None,
        secrets=vault.generate_env_secrets(), actor_id=actor_id, seed_snapshot_id=snapshot_id)


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
    unchanged: a Fernet key for TOTP, hex for POSTGRES_PASSWORD (it goes into
    a database URL unescaped), and the PATCH rule's safe characters for the
    rest. A hand-built env may carry secrets Sirdar didn't generate (uat's
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
        db, settings, cfg, name=name, type_=type_, target_id=target_id, git_ref=git_ref,
        domain=picked["domain"], proxy_ip=picked["proxy_ip"], bind_ip=picked["bind_ip"],
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
    ignored = sorted(k for k in values if k not in envfile.KNOWN_KEYS)
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
    if fields.get("target") is not None:
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

    if changed:
        env.updated_at = _now()
    await db.flush()
    return changed
