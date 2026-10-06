"""Steps 0, 14 and 18 of a DigitalOcean environment (deploy phase 7), run in
Sirdar through do_api.connect with the environment's account token:
Prepare DigitalOcean ("do_prepare"), Switch traffic ("go_live") and Remove
DigitalOcean resources ("do_destroy").

Step 0 is idempotent: it makes what is missing and never replaces what
exists. In order: the team check, the VPC, the bucket and its key, a droplet
per slot, the database cluster (its firewall set to the droplets right after
create), the droplets' SSH host keys (Sirdar generated them; cloud-init
delivers them; they are pinned before any command runs), the commit, the
database role and database (SQL on the slot's droplet, as doadmin), the
certificate, the load balancer and the cloud firewall.

Every resource is recorded in do_resources the moment DigitalOcean answers,
in its own transaction. Sirdar acts only on what is recorded and still
matches (its tag, or its exact name); droplets and databases tagged
sirdar-env-<id> but not recorded are Sirdar's (the tag holds the
environment's UUID) and are recorded again. Failures raise
publish.StepFailed with our own copy."""

import asyncio
import shlex
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import asyncssh
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    Deployment,
    DoAccount,
    DoResource,
    DoSlot,
    Environment,
    EnvironmentSecret,
)
from sirdar_api.deploy import (
    ConnectFailed,
    certs,
    cloudinit,
    do_accounts,
    do_api,
    do_envs,
    gitref,
    integrations,
    known_hosts,
    pgauth,
    smoke,
    spaces,
    ssh,
    targets,
    vault,
    vmcommon,
    vms,
)
from sirdar_api.deploy.do_api import DigitalOceanApi, DoError
from sirdar_api.deploy.integrations import CloudflareConfig, IntegrationError
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.ssh import SshTargetConfig
from sirdar_api.deploy.vmcommon import Output, VmOutcome, VmPrepareError

POLL_SECONDS = 10
WAITS = {"droplet": 10 * 60, "database": 30 * 60, "lb": 10 * 60, "ssh": 10 * 60,
         "vpc": 10 * 60}
FIREWALL_TRIES = 60
SQL_TIMEOUT = 15 * 60          # cloud-init may still be installing psql
_PSQL = ('IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql '
         '"host=$0 port=$1 dbname=defaultdb user=doadmin sslmode=require" '
         '-v ON_ERROR_STOP=1 -q -f -')
_READY = "cloud-init status --wait > /dev/null 2>&1; command -v psql > /dev/null"
_UNREADABLE = ("Sirdar can't read this environment's DigitalOcean secrets with the current "
               "SIRDAR_SECRETS_KEY.")


# ---- context -----------------------------------------------------------------------------

@dataclass(frozen=True)
class SlotState:
    slot: str
    host_key_public: str
    host_key_private: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class DoContext:
    env_id: uuid.UUID
    env_name: str
    env_type: str
    deployment_id: uuid.UUID
    actor_id: uuid.UUID | None
    mode: str
    git_ref: str
    sha: str
    repo_url: str
    slot: str | None                 # the slot it deploys / switches to
    go_live: bool
    slots: tuple[str, ...]
    active_slot: str | None
    account_key: str
    account_label: str
    team_uuid: str | None            # frozen by the first step 0
    region: str
    droplet_size: str
    droplet_image: str
    db_size: str
    db_standby: bool
    acme_staging: bool
    acme_directory: str
    bucket: str
    ssh_public_key: str
    slot_states: tuple[SlotState, ...]
    hosts: tuple[tuple[str, str], ...]     # (service, public hostname)
    token: str = field(repr=False)
    db_password: str = field(repr=False)
    ssh_private_key: str = field(repr=False)
    db_admin_password: str | None = field(default=None, repr=False)
    cloudflare: CloudflareConfig | None = field(default=None, repr=False)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(h for _, h in self.hosts)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        found = [self.token, self.db_password, self.ssh_private_key, self.db_admin_password,
                 self.cloudflare.token if self.cloudflare else None,
                 *(s.host_key_private for s in self.slot_states)]
        return [v for v in found if v]

    def slot_state(self, slot: str) -> SlotState:
        return next(s for s in self.slot_states if s.slot == slot)


def _decrypt(settings: Settings, blob: bytes | None) -> str | None:
    if blob is None:
        return None
    try:
        return vault.decrypt(settings, blob)
    except (vault.SecretsKeyMissing, vault.SecretUnreadable):
        raise VmPrepareError(_UNREADABLE) from None


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> DoContext:
    row = await do_envs.get(db, env.id)
    if row is None:
        raise VmPrepareError("This environment has no DigitalOcean record, so Sirdar won't "
                             "build or remove anything for it.")
    label = (await db.get(DoAccount, row.account_key)).label
    try:
        account = await do_accounts.load(db, settings, row.account_key)
        cloudflare = await integrations.load_cloudflare(db, settings)
    except IntegrationError as e:
        raise VmPrepareError(e.reason) from None
    if account is None:
        raise VmPrepareError(f"The {label} DigitalOcean account has no API token. Add it in "
                             "Settings › Integrations, then retry.")
    building = dep.mode == "update"
    if building and account.renewal_token is None:
        raise VmPrepareError(f"The {label} DigitalOcean account has no renewal token (the "
                             "token droplets renew their certificate with). Add it in Settings "
                             "› Integrations, then retry.")
    secret = await db.get(EnvironmentSecret, (env.id, "POSTGRES_PASSWORD"))
    if secret is None:
        raise VmPrepareError("This environment has no database password. Recreate it.")
    slots = await do_envs.slots_of(db, env.id)
    states = tuple(SlotState(s, slots[s].host_key_public,
                             _decrypt(settings, slots[s].host_key_private_enc) if building
                             else None) for s in env.slots)
    directory = settings.acme_staging_directory if row.acme_staging else settings.acme_directory
    return DoContext(
        env_id=env.id, env_name=env.name, env_type=env.type, deployment_id=dep.id,
        actor_id=dep.actor_id, mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
        repo_url=settings.deploy_repo_url, slot=dep.slot, go_live=dep.go_live,
        slots=tuple(env.slots), active_slot=env.active_slot, account_key=row.account_key,
        account_label=label, team_uuid=row.team_uuid, region=row.region,
        droplet_size=row.droplet_size, droplet_image=row.droplet_image, db_size=row.db_size,
        db_standby=row.db_standby, acme_staging=row.acme_staging, acme_directory=directory,
        bucket=row.bucket, ssh_public_key=row.ssh_public_key, slot_states=states,
        hosts=tuple((s, f"{s}.{env.base_domain}") for s in certs.PUBLIC_SERVICES),
        token=account.token, db_password=_decrypt(settings, secret.value_enc),
        ssh_private_key=_decrypt(settings, row.ssh_private_key_enc),
        db_admin_password=_decrypt(settings, row.db_admin_password_enc),
        cloudflare=cloudflare)


# ---- fresh records -----------------------------------------------------------------------

@dataclass
class Records:
    resources: list[DoResource]
    slots: dict[str, DoSlot]

    def find(self, kind: str, slot: str | None = None) -> list[DoResource]:
        return [r for r in self.resources
                if r.kind == kind and (slot is None or r.slot == slot)]


async def load_records(env_id) -> Records:
    """What do_resources and do_slots hold now (each step reads them again:
    the context was built before step 0 wrote anything)."""
    async with get_sessionmaker()() as s:
        return Records(await do_envs.resources_of(s, env_id), await do_envs.slots_of(s, env_id))


# ---- load balancer bodies ----------------------------------------------------------------

def _rules(certificate_id: str) -> list[dict]:
    return [{"entry_protocol": "https", "entry_port": 443, "target_protocol": "http",
             "target_port": 80, "certificate_id": certificate_id, "tls_passthrough": False},
            {"entry_protocol": "http", "entry_port": 80, "target_protocol": "http",
             "target_port": 80}]


def lb_body(ctx: DoContext, vpc_id: str, certificate_id: str, droplet_ids: list[int]) -> dict:
    return {"name": do_envs.resource_name(ctx.env_name, "-lb"), "region": ctx.region,
            "size_unit": 1, "vpc_uuid": vpc_id, "forwarding_rules": _rules(certificate_id),
            "health_check": {"protocol": "http", "port": 80, "path": "/healthz",
                             "check_interval_seconds": 10, "response_timeout_seconds": 5,
                             "healthy_threshold": 3, "unhealthy_threshold": 3},
            "redirect_http_to_https": False, "droplet_ids": droplet_ids}


def lb_update_body(lb: dict, **changes) -> dict:
    """A PUT replaces the whole load balancer: what it has, plus `changes`."""
    region = lb.get("region")
    body = {"name": lb.get("name"),
            "region": region.get("slug") if isinstance(region, dict) else region,
            "size_unit": lb.get("size_unit") or 1, "vpc_uuid": lb.get("vpc_uuid"),
            "forwarding_rules": lb.get("forwarding_rules") or [],
            "health_check": lb.get("health_check"), "droplet_ids": lb.get("droplet_ids") or [],
            "redirect_http_to_https": bool(lb.get("redirect_http_to_https"))}
    return {**body, **changes}


def https_certificate(lb: dict) -> str | None:
    return next((r.get("certificate_id") for r in lb.get("forwarding_rules") or []
                 if r.get("entry_protocol") == "https"), None)


# ---- the provisioner ---------------------------------------------------------------------

Remote = Callable[[SshTargetConfig, str, str | None], Awaitable[int | None]]


async def _ssh_remote(cfg: SshTargetConfig, command: str, stdin: str | None) -> int | None:
    """One command on a pinned droplet; `stdin` carries any secret. None when
    it didn't finish in SQL_TIMEOUT. Errors are StepFailed with our copy."""
    async with get_sessionmaker()() as s:
        try:
            result = await ssh.run_command(cfg, s, command, input=stdin, timeout=SQL_TIMEOUT)
        except ConnectFailed as e:
            raise StepFailed(e.reason) from None
        except (ssh.HostKeyUnknown, ssh.HostKeyMismatch):
            raise StepFailed(f"{cfg.host} no longer answers SSH with the host key Sirdar "
                             "pinned. Sirdar sent it nothing. Retry from step 0.") from None
    return result.exit_status


class DoProvisioner:
    """The real DigitalOcean provisioner. Waits, the clock, the ref lookup
    and the commands on droplets are injectable for tests."""

    STEPS = ("do_prepare", "go_live", "do_destroy")

    def __init__(self, *, settings: Settings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 poll: float = POLL_SECONDS, now: Callable[[], datetime] | None = None,
                 resolve=None, remote: Remote | None = None, dns_wait: float = certs.DNS_WAIT,
                 waits: dict | None = None, smoke_attempts: int = smoke.ATTEMPTS,
                 smoke_delay: float = smoke.DELAY):
        self._settings = settings
        self._sleep = sleep
        self._poll = poll
        self._now = now or (lambda: datetime.now(UTC))
        self._resolve = resolve or gitref.resolve_ref
        self._remote = remote or _ssh_remote
        self._dns_wait = dns_wait
        self._waits = {**WAITS, **(waits or {})}
        self._smoke_attempts = smoke_attempts
        self._smoke_delay = smoke_delay

    async def run(self, step: str, ctx: DoContext, out: Output) -> VmOutcome:
        if step not in self.STEPS:
            raise ValueError(f"{step!r} isn't a DigitalOcean step")
        try:
            async with do_api.connect(ctx.token, sleep=self._sleep) as api:
                if step == "do_prepare":
                    return await self._prepare(api, ctx, out)
                if step == "go_live":
                    await self._go_live(api, ctx, out)
                else:
                    await self._destroy(api, ctx, out)
                return VmOutcome()
        except DoError as e:
            raise StepFailed(e.reason) from None
        except spaces.SpacesError as e:
            raise StepFailed(e.reason) from None

    # ---- shared helpers ------------------------------------------------------------------

    def _tries(self, seconds: int) -> int:
        return max(1, int(seconds // self._poll)) if self._poll else max(1, seconds)

    async def _wait(self, fetch, ready, seconds: int, what: str) -> dict:
        for _ in range(self._tries(seconds)):
            found = await fetch()
            if found is None:
                raise StepFailed(f"{what} disappeared from DigitalOcean while Sirdar waited.")
            if ready(found):
                return found
            await self._sleep(self._poll)
        raise StepFailed(f"{what} wasn't ready after {seconds // 60} minutes.")

    def _slot_config(self, ctx: DoContext, slot: str, ip: str) -> SshTargetConfig:
        name = do_envs.droplet_name(ctx.env_name, slot)
        return SshTargetConfig(host=ip, port=vms.VM_SSH_PORT, user=vms.VM_USER,
                               private_key=ctx.ssh_private_key, key_name=f"Sirdar's key for {name}")

    # ---- step 0 --------------------------------------------------------------------------

    async def _prepare(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> VmOutcome:
        if ctx.slot is None:
            raise StepFailed("This deployment has no slot to build. Start a new deployment.")
        await self._check_team(api, ctx, out)
        vpc = await self._vpc(api, ctx, out)
        await self._bucket(api, ctx, out)
        host_keys = {s.slot: s.host_key_public for s in ctx.slot_states}
        droplets = await self._droplets(api, ctx, vpc, host_keys, out)
        database = await self._database(api, ctx, vpc, droplets, out)
        await self._pin(ctx, droplets, host_keys, out)
        sha = await vmcommon.resolve_ref(self._settings, self._resolve, env_id=ctx.env_id,
                                         git_ref=ctx.git_ref, repo_url=ctx.repo_url, out=out,
                                         slot=ctx.slot)
        await self._grants(ctx, droplets, database, out)
        cert = await self._certificate(api, ctx, out)
        lb = await self._load_balancer(api, ctx, vpc, cert, droplets, out)
        await self._firewall(api, ctx, lb, out)
        return VmOutcome(sha=sha)

    async def _check_team(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        """Before anything is made: the team the token answers for (one
        /account read) is frozen on the environment the first time, and every
        later step 0 refuses a token from another team."""
        try:
            team, team_name = await do_accounts.read_team(api)
        except ConnectFailed as e:
            raise StepFailed(e.reason) from None
        frozen = await do_envs.freeze_team(ctx.env_id, team)
        if frozen != team:
            raise StepFailed(f"The {ctx.account_label} DigitalOcean token now answers for "
                             "another team than the one this environment was built in. Sirdar "
                             "changed nothing. Put back a token for that team in Settings › "
                             "Integrations, then retry.")
        if ctx.team_uuid is None:
            out(f"Building in the {ctx.account_label} account ({team_name or team}).\n")

    async def _vpc(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> dict:
        name = do_envs.resource_name(ctx.env_name)
        marker = f"sirdar:{ctx.env_id}"
        vpc = None
        for rec in (await load_records(ctx.env_id)).find("vpc"):
            found = await api.vpc(rec.do_id)
            if found is None:
                await do_envs.forget(ctx.env_id, "vpc", rec.do_id)
                out(f"The VPC {name} Sirdar recorded is gone; making it again.\n")
                continue
            if found.get("name") != name or marker not in str(found.get("description") or ""):
                raise StepFailed(f"VPC {rec.do_id} no longer looks like Sirdar's {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            vpc = found
        if vpc is None:
            vpc = await api.create_vpc(name, ctx.region, f"{marker} Built by Sirdar for the "
                                                         f"environment {ctx.env_name}.")
            await do_envs.record(ctx.env_id, "vpc", vpc["id"], name)
            out(f"Created the VPC {name} ({vpc.get('ip_range')}).\n")
        else:
            out(f"VPC {name}: in place ({vpc.get('ip_range')}).\n")
        await do_envs.set_do(ctx.env_id, vpc_ip_range=vpc.get("ip_range"))
        return vpc

    async def _setup_key(self, api: DigitalOceanApi, ctx: DoContext) -> spaces.SpacesKey:
        name = do_envs.resource_name(ctx.env_name, "-setup")
        key = await api.create_spaces_key(name, [{"bucket": "", "permission": "fullaccess"}])
        await do_envs.record(ctx.env_id, "spaces_key", key["access_key"], name)
        return spaces.SpacesKey(key["access_key"], key["secret_key"])

    async def _drop_setup_key(self, api: DigitalOceanApi, ctx: DoContext, access_key: str):
        await api.delete_spaces_key(access_key)
        await do_envs.forget(ctx.env_id, "spaces_key", access_key)

    async def _bucket(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        setup_name = do_envs.resource_name(ctx.env_name, "-setup")
        app_name = do_envs.resource_name(ctx.env_name)
        records = await load_records(ctx.env_id)
        for rec in records.find("spaces_key"):
            if rec.name == setup_name:              # a run stopped before deleting it
                await self._drop_setup_key(api, ctx, rec.do_id)
                out("Removed a temporary Spaces key a stopped run left behind.\n")
        if not records.find("bucket"):
            setup = await self._setup_key(api, ctx)
            try:
                made = await spaces.create_bucket(ctx.bucket, ctx.region, setup)
            finally:
                await self._drop_setup_key(api, ctx, setup.access_key)
            await do_envs.record(ctx.env_id, "bucket", ctx.bucket, ctx.bucket)
            out(f"Created the bucket {ctx.bucket}.\n" if made
                else f"Bucket {ctx.bucket}: already this account's; recorded it.\n")
        else:
            out(f"Bucket {ctx.bucket}: in place.\n")
        row = await self._row(ctx)
        app_keys = [r for r in records.find("spaces_key") if r.name == app_name]
        usable = row.spaces_secret_enc is not None and row.spaces_key_id in {
            r.do_id for r in app_keys}
        if usable:
            out(f"Bucket key {row.spaces_key_id}: in place.\n")
            return
        for rec in app_keys:          # its secret was never saved: DigitalOcean shows it once
            await api.delete_spaces_key(rec.do_id)
            await do_envs.forget(ctx.env_id, "spaces_key", rec.do_id)
            out(f"Removed the bucket key {rec.do_id}: Sirdar never saved its secret.\n")
        key = await api.create_spaces_key(app_name, [{"bucket": ctx.bucket,
                                                      "permission": "readwrite"}])
        await do_envs.record(ctx.env_id, "spaces_key", key["access_key"], app_name)
        await do_envs.set_do(ctx.env_id, spaces_key_id=key["access_key"],
                             spaces_secret_enc=vault.encrypt(self._settings, key["secret_key"]))
        out(f"Made the bucket's own key {key['access_key']}.\n")

    async def _row(self, ctx: DoContext):
        async with get_sessionmaker()() as s:
            return await do_envs.get(s, ctx.env_id)

    def _check_tagged(self, ctx: DoContext, found: dict, name: str, what: str) -> None:
        if found.get("name") != name or do_envs.env_tag(ctx.env_id) not in (found.get("tags")
                                                                             or []):
            raise StepFailed(f"The {what} Sirdar recorded as {name} ({found.get('id')}) no "
                             "longer carries Sirdar's tag and name for this environment. Sirdar "
                             "changed nothing: put them back or remove it by hand, then retry.")

    async def _droplets(self, api: DigitalOceanApi, ctx: DoContext, vpc: dict,
                        host_keys: dict[str, str], out: Output) -> dict[str, dict]:
        records = await load_records(ctx.env_id)
        tagged = {d.get("name"): d for d in await api.droplets_tagged(do_envs.env_tag(ctx.env_id))}
        found: dict[str, dict] = {}
        for slot in ctx.slots:
            name = do_envs.droplet_name(ctx.env_name, slot)
            droplet = None
            for rec in records.find("droplet", slot):
                live = await api.droplet(rec.do_id)
                if live is None:
                    await do_envs.forget(ctx.env_id, "droplet", rec.do_id)
                    out(f"{name}: the droplet Sirdar recorded is gone; building it again.\n")
                    continue
                self._check_tagged(ctx, live, name, "droplet")
                droplet = live
            if droplet is None and name in tagged:
                droplet = tagged[name]
                await do_envs.record(ctx.env_id, "droplet", droplet["id"], name, slot)
                out(f"{name}: found it by its tag and recorded it.\n")
            if droplet is None:
                droplet = await self._create_droplet(api, ctx, slot, vpc, host_keys, out)
            else:
                out(f"{name}: in place (droplet {droplet['id']}).\n")
            found[slot] = droplet
        for slot, droplet in list(found.items()):
            name = do_envs.droplet_name(ctx.env_name, slot)
            ready = await self._wait(
                lambda d=droplet: api.droplet(str(d["id"])),
                lambda d: d.get("status") == "active" and all(do_api.droplet_ips(d)),
                self._waits["droplet"], f"The droplet {name}")
            public, private = do_api.droplet_ips(ready)
            await do_envs.set_slot(ctx.env_id, slot, droplet_id=str(ready["id"]),
                                   public_ip=public, private_ip=private)
            found[slot] = ready
        return found

    async def _create_droplet(self, api: DigitalOceanApi, ctx: DoContext, slot: str, vpc: dict,
                              host_keys: dict[str, str], out: Output) -> dict:
        name = do_envs.droplet_name(ctx.env_name, slot)
        private = ctx.slot_state(slot).host_key_private
        if private is None:
            # Delivered to a droplet that is gone: a new key for the new droplet.
            private, public = vms.new_host_keypair(f"{ctx.env_name}-{slot}")
            await do_envs.set_slot(ctx.env_id, slot, host_key_public=public,
                                   host_key_private_enc=vault.encrypt(self._settings, private))
            host_keys[slot] = public
        user_data = cloudinit.droplet_userdata(hostname=name, ssh_public_key=ctx.ssh_public_key,
                                               host_key_private=private,
                                               host_key_public=host_keys[slot])
        made = await api.create_droplet({
            "name": name, "region": ctx.region, "size": ctx.droplet_size,
            "image": ctx.droplet_image, "vpc_uuid": vpc["id"], "ipv6": False,
            "monitoring": True, "tags": do_envs.tags(ctx.env_id, ctx.env_name, slot),
            "user_data": user_data})
        await do_envs.record(ctx.env_id, "droplet", made["id"], name, slot)
        out(f"{name}: created droplet {made['id']} ({ctx.droplet_size}, {ctx.droplet_image}).\n")
        return made

    async def _database(self, api: DigitalOceanApi, ctx: DoContext, vpc: dict,
                        droplets: dict[str, dict], out: Output) -> dict:
        name = do_envs.resource_name(ctx.env_name, "-db")
        env_tag = do_envs.env_tag(ctx.env_id)
        database = None
        for rec in (await load_records(ctx.env_id)).find("database"):
            live = await api.database(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "database", rec.do_id)
                out(f"The database {name} Sirdar recorded is gone; creating it again.\n")
                continue
            self._check_tagged(ctx, live, name, "database")
            database = live
        if database is None:
            tagged = [d for d in await api.databases_tagged(env_tag) if d.get("name") == name]
            if tagged:
                database = tagged[0]
                await do_envs.record(ctx.env_id, "database", database["id"], name)
                out(f"Database {name}: found it by its tag and recorded it.\n")
        if database is None:
            database = await api.create_database({
                "name": name, "engine": "pg", "version": "16", "region": ctx.region,
                "size": ctx.db_size, "num_nodes": 2 if ctx.db_standby else 1,
                "private_network_uuid": vpc["id"],
                "tags": do_envs.tags(ctx.env_id, ctx.env_name)})
            await do_envs.record(ctx.env_id, "database", database["id"], name)
            out(f"Creating the database cluster {name} (PostgreSQL 16, {ctx.db_size}"
                f"{', with a standby node' if ctx.db_standby else ''}).\n")
        else:
            out(f"Database {name}: in place.\n")
        await self._db_firewall(api, database["id"], [str(d["id"]) for d in droplets.values()],
                                out)
        online = await self._wait(lambda: api.database(database["id"]),
                                  lambda d: d.get("status") == "online",
                                  self._waits["database"], f"The database {name}")
        private = online.get("private_connection") or {}
        host, port = private.get("host"), private.get("port")
        if not host or not port:
            raise StepFailed("DigitalOcean didn't give the database a private address.")
        admin = ((online.get("connection") or {}).get("password")
                 or (database.get("connection") or {}).get("password") or ctx.db_admin_password)
        if not admin:
            raise StepFailed("DigitalOcean didn't give Sirdar the database's admin password.")
        await do_envs.set_do(ctx.env_id, db_host=host, db_port=int(port),
                             db_ca_cert=await api.database_ca(database["id"]),
                             db_admin_password_enc=vault.encrypt(self._settings, admin))
        out(f"Database {name}: online at {host}:{port}.\n")
        return {"id": database["id"], "host": host, "port": int(port), "admin": admin}

    async def _db_firewall(self, api: DigitalOceanApi, database_id: str,
                           droplet_ids: list[str], out: Output) -> None:
        """Only this environment's droplets, by droplet ID: set right after the
        cluster is created, retried while DigitalOcean isn't ready for it."""
        wanted = sorted(("droplet", d) for d in droplet_ids)
        for _ in range(FIREWALL_TRIES):
            current = sorted((r["type"], str(r["value"]))
                             for r in await api.database_firewall(database_id))
            if current == wanted:
                return
            try:
                await api.set_database_firewall(database_id, droplet_ids)
            except DoError as e:
                if e.status in (409, 422):
                    await self._sleep(self._poll)
                    continue
                raise
            out("Database firewall: only this environment's droplets may connect.\n")
            return
        raise StepFailed("DigitalOcean didn't accept the database firewall in time. Sirdar "
                         "won't go on while the database isn't locked to the droplets.")

    async def _pin(self, ctx: DoContext, droplets: dict[str, dict], host_keys: dict[str, str],
                   out: Output) -> None:
        saved = {cfg.host for _, cfg in targets.ssh_configs(self._settings)}
        for slot, droplet in droplets.items():
            name = do_envs.droplet_name(ctx.env_name, slot)
            ip, _ = do_api.droplet_ips(droplet)
            if ip in saved:
                raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a "
                                 "droplet's key there.")
            expected = known_hosts.fingerprint(asyncssh.import_public_key(host_keys[slot]))
            await vmcommon.confirm_pin(
                ip=ip, expected=expected, actor_id=ctx.actor_id, target_id="digitalocean",
                tries=self._tries(self._waits["ssh"]), poll=self._poll, sleep=self._sleep,
                out=out, how="the key Sirdar generated for the droplet",
                mismatch=(f"{name} answered SSH with a host key Sirdar didn't generate for it. "
                          "Sirdar trusted nothing. Check the droplet in DigitalOcean, then "
                          "retry."), minutes=self._waits["ssh"] // 60)
            await do_envs.set_slot(ctx.env_id, slot, host_key_private_enc=None)

    async def _grants(self, ctx: DoContext, droplets: dict[str, dict], database: dict,
                      out: Output) -> None:
        name = do_envs.droplet_name(ctx.env_name, ctx.slot)
        ip, _ = do_api.droplet_ips(droplets[ctx.slot])
        cfg = self._slot_config(ctx, ctx.slot, ip)
        if await self._remote(cfg, _READY, None) != 0:
            raise StepFailed(f"cloud-init didn't finish setting up {name} (psql is missing). "
                             "Retry from step 0.")
        sql = pgauth.setup_sql(role=do_envs.DB_USER, database=do_envs.DB_NAME,
                               verifier=pgauth.scram_sha256(ctx.db_password))
        command = (f"bash -c {shlex.quote(_PSQL)} {shlex.quote(database['host'])} "
                   f"{int(database['port'])}")
        code = await self._remote(cfg, command, f"{database['admin']}\n{sql}")
        if code != 0:
            raise StepFailed("The managed database didn't accept Sirdar's setup (psql exited "
                             f"{code}). Retry from step 0.")
        out(f"Database: {do_envs.DB_USER} owns {do_envs.DB_NAME}.\n")

    async def _certificate(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> dict:
        records = await load_records(ctx.env_id)
        recorded = {r.do_id for r in records.find("certificate")}
        current = None
        for rec in records.find("load_balancer"):
            lb = await api.load_balancer(rec.do_id)
            current = https_certificate(lb) if lb else None
            if current and current not in recorded:
                cert = await api.certificate(current)
                if cert is not None and certs.is_ours(cert, ctx.env_name, ctx.names):
                    await do_envs.record(ctx.env_id, "certificate", current, cert["name"])
                    recorded.add(current)
                    out(f"Recorded the certificate {cert['name']} the cert-worker uploaded.\n")
        live = []
        for cert_id in sorted(recorded):
            cert = await api.certificate(cert_id)
            if cert is None:
                await do_envs.forget(ctx.env_id, "certificate", cert_id)
                continue
            live.append(cert)
        # The latest to expire; on a tie, the one the load balancer already uses.
        oldest = datetime.min.replace(tzinfo=UTC)
        best = max(live, key=lambda c: (certs.not_after(c) or oldest, c["id"] == current),
                   default=None)
        now = self._now()
        when = certs.not_after(best) if best else None
        if when is not None and certs.days_left(when, now) > certs.SIRDAR_RENEW_DAYS:
            out(f"Certificate {best['name']}: valid until {when:%Y-%m-%d}.\n")
        else:
            if ctx.cloudflare is None:
                raise StepFailed("Cloudflare isn't set up, so Sirdar can't prove to Let's Encrypt "
                                 "that it owns these names. Add it in Settings › Integrations, "
                                 "then retry.")
            out("Requesting a Let's Encrypt certificate"
                f"{' (staging)' if ctx.acme_staging else ''} for {', '.join(ctx.names)}.\n")
            try:
                issued = await certs.issue_dns01(
                    self._settings, names=ctx.names, directory=ctx.acme_directory,
                    cloudflare=ctx.cloudflare, out=out, sleep=self._sleep,
                    dns_wait=self._dns_wait, poll=self._poll)
            except certs.CertError as e:
                raise StepFailed(e.reason) from None
            name = certs.cert_name(ctx.env_name, now)
            best = await api.create_certificate(name, issued.key_pem, issued.leaf_pem,
                                                issued.chain_pem)
            await do_envs.record(ctx.env_id, "certificate", best["id"], name)
            out(f"Uploaded the certificate {name} (valid until {issued.not_after:%Y-%m-%d}).\n")
        await do_envs.set_do(ctx.env_id, cert_not_after=certs.not_after(best))
        return best

    async def _load_balancer(self, api: DigitalOceanApi, ctx: DoContext, vpc: dict, cert: dict,
                             droplets: dict[str, dict], out: Output) -> dict:
        name = do_envs.resource_name(ctx.env_name, "-lb")
        lb = None
        for rec in (await load_records(ctx.env_id)).find("load_balancer"):
            live = await api.load_balancer(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "load_balancer", rec.do_id)
                out(f"The load balancer {name} Sirdar recorded is gone; creating it again.\n")
                continue
            if live.get("name") != name:
                raise StepFailed(f"Load balancer {rec.do_id} is no longer named {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            lb = live
        if lb is None:
            active = droplets.get(ctx.active_slot) if ctx.active_slot else None
            lb = await api.create_load_balancer(lb_body(ctx, vpc["id"], cert["id"],
                                                        [int(active["id"])] if active else []))
            await do_envs.record(ctx.env_id, "load_balancer", lb["id"], name)
            out(f"Creating the load balancer {name}.\n")
        elif https_certificate(lb) != cert["id"]:
            lb = await api.update_load_balancer(lb["id"], lb_update_body(
                lb, forwarding_rules=_rules(cert["id"])))
            out(f"Load balancer {name}: now uses the certificate {cert['name']}.\n")
        ready = await self._wait(lambda: api.load_balancer(lb["id"]),
                                 lambda x: x.get("status") == "active" and bool(x.get("ip")),
                                 self._waits["lb"], f"The load balancer {name}")
        await do_envs.set_do(ctx.env_id, lb_ip=ready["ip"])
        out(f"Load balancer {name}: active at {ready['ip']}.\n")
        await self._retire_certificates(api, ctx, cert["id"], out)
        return ready

    async def _retire_certificates(self, api: DigitalOceanApi, ctx: DoContext, keep: str,
                                   out: Output) -> None:
        for rec in (await load_records(ctx.env_id)).find("certificate"):
            if rec.do_id == keep:
                continue
            try:
                gone = await api.delete_certificate(rec.do_id)
            except do_api.DoForbidden:
                out(f"Certificate {rec.name}: still in use; left for the next run.\n")
                continue
            await do_envs.forget(ctx.env_id, "certificate", rec.do_id)
            out(f"Certificate {rec.name}: {'deleted' if gone else 'already gone'}.\n")

    async def _firewall(self, api: DigitalOceanApi, ctx: DoContext, lb: dict,
                        out: Output) -> None:
        name = do_envs.resource_name(ctx.env_name, "-fw")
        for rec in (await load_records(ctx.env_id)).find("firewall"):
            live = await api.firewall(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "firewall", rec.do_id)
                continue
            if live.get("name") != name:
                raise StepFailed(f"Cloud firewall {rec.do_id} is no longer named {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            sources = [r.get("sources") or {} for r in live.get("inbound_rules") or []]
            if any(lb["id"] in (s.get("load_balancer_uids") or []) for s in sources):
                out(f"Cloud firewall {name}: in place.\n")
                return
            await api.delete_firewall(rec.do_id)         # its load balancer was rebuilt
            await do_envs.forget(ctx.env_id, "firewall", rec.do_id)
        everywhere = {"addresses": ["0.0.0.0/0", "::/0"]}
        made = await api.create_firewall({
            "name": name, "tags": [do_envs.env_tag(ctx.env_id)],
            "inbound_rules": [
                {"protocol": "tcp", "ports": "22", "sources": everywhere},
                {"protocol": "tcp", "ports": "80", "sources": {"load_balancer_uids": [lb["id"]]}}],
            "outbound_rules": [
                {"protocol": "tcp", "ports": "all", "destinations": everywhere},
                {"protocol": "udp", "ports": "all", "destinations": everywhere},
                {"protocol": "icmp", "destinations": everywhere}]})
        await do_envs.record(ctx.env_id, "firewall", made["id"], name)
        out(f"Cloud firewall {name}: SSH from anywhere, HTTP only from the load balancer.\n")

    # Task 10: _go_live and _destroy.
    async def _go_live(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        raise StepFailed("Switch traffic isn't built yet.")

    async def _destroy(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        raise StepFailed("Remove DigitalOcean resources isn't built yet.")
