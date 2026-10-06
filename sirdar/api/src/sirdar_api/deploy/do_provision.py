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
in its own transaction, before Sirdar waits for it. Sirdar acts only on what
is recorded and still matches: droplets and databases carry both `sirdar` and
sirdar-env-<id>; the rest have the exact name (the VPC also Sirdar's marker
in its description). What isn't recorded is adopted only when it is plainly
this environment's: droplets and databases by both tags (the env tag alone is
refused, never duplicated), the VPC by its name and marker, the load balancer
by its name inside the environment's VPC, the cloud firewall by its name and
the environment's tag. Anything else with one of our names stops the step.
Failures raise publish.StepFailed with our own copy.

Not step 0's: growing a droplet or the cluster (7b resizes the slot being
deployed), and the load balancer's targets (step 14, go_live, owns them; step
0 sets them only on the load balancer it creates)."""

import asyncio
import base64
import re
import shlex
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import asyncssh
from sqlalchemy import select
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
    outbound,
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
         "vpc": 10 * 60, "health": 5 * 60}
HEALTH_MARGIN = 10             # seconds on top of the load balancer's health checks
_HEALTHZ = "curl -fsS -o /dev/null --max-time 5 http://127.0.0.1/healthz"
CORS_SERVICES = ("portal", "kiosk", "wiki")   # the apps that upload straight to the bucket
SQL_TIMEOUT = 15 * 60          # cloud-init may still be installing psql
# Runs as `bash -c _PSQL <host> <port>` on the droplet. Stdin: the doadmin
# password, the cluster's CA (base64, one line), then the SQL. The password
# goes into a mode-600 pgpass file (escaped for its format) in a private
# temporary folder that is removed on exit; never argv, never the environment.
# The server is verified against the CA (verify-full on the private host).
_PSQL = r"""set -eu
umask 077
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
IFS= read -r pw
IFS= read -r ca
bs='\'
pw=${pw//"$bs"/"$bs$bs"}
pw=${pw//:/"$bs:"}
printf '%s:%s:defaultdb:doadmin:%s\n' "$0" "$1" "$pw" > "$d/pgpass"
unset pw
unset PGPASSWORD || true
printf '%s' "$ca" | base64 -d > "$d/ca.pem"
export PGPASSFILE="$d/pgpass"
psql "host=$0 port=$1 dbname=defaultdb user=doadmin sslmode=verify-full sslrootcert=$d/ca.pem" \
  -v ON_ERROR_STOP=1 -q -f -
"""
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


_LB_READ_ONLY = ("id", "ip", "ipv6", "status", "created_at")


def lb_update_body(lb: dict, **changes) -> dict:
    """A PUT replaces the whole load balancer: its live body (read-only and
    empty fields left out, so settings Sirdar doesn't manage stay), plus
    `changes`."""
    body = {k: v for k, v in lb.items()
            if k not in _LB_READ_ONLY and not k.startswith("_") and v is not None}
    if isinstance(body.get("region"), dict):
        body["region"] = body["region"].get("slug")
    if "size_unit" in body:
        body.pop("size", None)                 # size is the older spelling; never both
    body.update(changes)
    if body.get("droplet_ids") is not None or not body.get("tag"):
        body.pop("tag", None)                  # droplet_ids and tag are exclusive
    return body


def https_certificate(lb: dict) -> str | None:
    return next((r.get("certificate_id") for r in lb.get("forwarding_rules") or []
                 if r.get("entry_protocol") == "https"), None)


def psql_command(host: str, port: int) -> str:
    """The command step 0 runs on a droplet to set up the managed database."""
    return f"bash -c {shlex.quote(_PSQL)} {shlex.quote(host)} {int(port)}"


_EVERYWHERE = {"addresses": ["0.0.0.0/0", "::/0"]}


def _firewall_body(name: str, env_tag: str, lb_id: str) -> dict:
    """The cloud firewall, whole: SSH from anywhere, HTTP only from the load
    balancer, nothing else in; everything out; applied by the env tag."""
    return {"name": name, "tags": [env_tag], "droplet_ids": [],
            "inbound_rules": [
                {"protocol": "tcp", "ports": "22", "sources": _EVERYWHERE},
                {"protocol": "tcp", "ports": "80", "sources": {"load_balancer_uids": [lb_id]}}],
            "outbound_rules": [
                {"protocol": "tcp", "ports": "all", "destinations": _EVERYWHERE},
                {"protocol": "udp", "ports": "all", "destinations": _EVERYWHERE},
                {"protocol": "icmp", "destinations": _EVERYWHERE}]}


def _rule_key(rule: dict, where: str) -> tuple:
    ends = rule.get(where) or {}
    protocol = rule.get("protocol")
    ports = "" if protocol == "icmp" else str(rule.get("ports") or "")
    if ports in ("", "0", "all"):          # DigitalOcean answers "0" for "all"
        ports = "all"
    return (protocol, "" if protocol == "icmp" else ports,
            *(tuple(sorted(str(v) for v in ends.get(k) or []))
              for k in ("addresses", "load_balancer_uids", "tags", "droplet_ids",
                        "kubernetes_ids")))


def _firewall_matches(live: dict, body: dict) -> bool:
    def rules(fw: dict, key: str, where: str) -> list:
        return sorted(_rule_key(r, where) for r in fw.get(key) or [])
    return (live.get("name") == body["name"]
            and sorted(live.get("tags") or []) == sorted(body["tags"])
            and not (live.get("droplet_ids") or [])
            and rules(live, "inbound_rules", "sources") == rules(body, "inbound_rules", "sources")
            and rules(live, "outbound_rules", "destinations")
            == rules(body, "outbound_rules", "destinations"))


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
        # Sizes are as frozen at create: step 0 never resizes a droplet or the
        # cluster (growing them is 7b's, on the slot being deployed).
        droplets = await self._droplets(api, ctx, vpc, host_keys, out)
        database = await self._database(api, ctx, vpc, droplets, out)
        await self._pin(ctx, droplets, host_keys, out)
        sha = await vmcommon.resolve_ref(self._settings, self._resolve, env_id=ctx.env_id,
                                         git_ref=ctx.git_ref, repo_url=ctx.repo_url, out=out,
                                         slot=ctx.slot)
        await self._grants(ctx, droplets, database, out)
        cert = await self._certificate(api, ctx, out)
        # The load balancer's targets are step 14's (go_live): step 0 sets them
        # only on a load balancer it creates.
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

        def ours(found: dict) -> bool:
            return found.get("name") == name and marker in str(found.get("description") or "")
        vpc, adopted = None, False
        for rec in (await load_records(ctx.env_id)).find("vpc"):
            found = await api.vpc(rec.do_id)
            if found is None:
                await do_envs.forget(ctx.env_id, "vpc", rec.do_id)
                out(f"The VPC {name} Sirdar recorded is gone; making it again.\n")
                continue
            if not ours(found):
                raise StepFailed(f"VPC {rec.do_id} no longer looks like Sirdar's {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            vpc = found
        if vpc is None:
            # Names are unique in an account: a VPC with ours is either this
            # environment's (its marker) or in the way.
            same = [v for v in await api.vpcs() if v.get("name") == name]
            if same and not ours(same[0]):
                raise StepFailed(f"A VPC named {name} ({same[0].get('id')}) already exists and "
                                 "isn't Sirdar's for this environment. Sirdar changed nothing: "
                                 "rename or remove it, then retry.")
            if same:
                vpc, adopted = same[0], True
                await do_envs.record(ctx.env_id, "vpc", vpc["id"], name)
                out(f"VPC {name}: found it by its name and Sirdar's marker; recorded it "
                    f"({vpc.get('ip_range')}).\n")
        if vpc is None:
            vpc = await api.create_vpc(name, ctx.region, f"{marker} Built by Sirdar for the "
                                                         f"environment {ctx.env_name}.")
            await do_envs.record(ctx.env_id, "vpc", vpc["id"], name)
            out(f"Created the VPC {name} ({vpc.get('ip_range')}).\n")
        elif not adopted:
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

    def _open(self, blob: bytes) -> str:
        try:
            return vault.decrypt(self._settings, blob)
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise StepFailed(_UNREADABLE) from None

    async def _bucket(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        """The bucket and its own readwrite key, both checked live: a recorded
        key DigitalOcean no longer has is forgotten (and replaced); a recorded
        bucket is checked with a HEAD under that key and made again when gone.
        A key is deleted only when DigitalOcean still lists it under the name
        Sirdar recorded."""
        setup_name = do_envs.resource_name(ctx.env_name, "-setup")
        app_name = do_envs.resource_name(ctx.env_name)
        live_keys = {k.get("access_key"): k for k in await api.spaces_keys()}
        recorded_keys = (await load_records(ctx.env_id)).find("spaces_key")
        for rec in recorded_keys:
            live = live_keys.get(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "spaces_key", rec.do_id)
                if rec.name == app_name:
                    out(f"Bucket key {rec.do_id} is gone from DigitalOcean; making a new one.\n")
                continue
            if live.get("name") != rec.name:
                raise StepFailed(f"Spaces key {rec.do_id} is no longer named {rec.name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            if rec.name == setup_name:              # a run stopped before deleting it
                await self._drop_setup_key(api, ctx, rec.do_id)
                out("Removed a temporary Spaces key a stopped run left behind.\n")
        row = await self._row(ctx)
        await self._lost_keys(api, ctx, live_keys, {r.do_id for r in recorded_keys}, row, out)
        records = await load_records(ctx.env_id)
        app_keys = [r for r in records.find("spaces_key") if r.name == app_name]
        app_key = None
        if row.spaces_secret_enc is not None and row.spaces_key_id in {r.do_id for r in app_keys}:
            app_key = spaces.SpacesKey(row.spaces_key_id, self._open(row.spaces_secret_enc))
        recorded = bool(records.find("bucket"))
        if recorded and app_key is not None:
            if await spaces.bucket_exists(ctx.bucket, ctx.region, app_key):
                out(f"Bucket {ctx.bucket}: in place.\n")
            else:
                await do_envs.forget(ctx.env_id, "bucket", ctx.bucket)
                out(f"The bucket {ctx.bucket} Sirdar recorded is gone; making it again.\n")
                recorded = False
                await self._make_bucket(api, ctx, False, out)
        else:
            # No key to look with: the create is idempotent (ours answers "already").
            await self._make_bucket(api, ctx, recorded, out)
        if app_key is not None:
            out(f"Bucket key {app_key.access_key}: in place.\n")
            await self._bucket_cors(api, ctx, app_key, out)
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
        await self._bucket_cors(api, ctx, spaces.SpacesKey(key["access_key"], key["secret_key"]),
                                out)

    async def _lost_keys(self, api: DigitalOceanApi, ctx: DoContext, live_keys: dict,
                         recorded: set[str], row, out: Output) -> None:
        """A key whose create answer was lost: DigitalOcean lists it under
        Sirdar's exact name but nothing recorded it. The bucket's own key
        is adopted when its secret was saved; otherwise (DigitalOcean shows a
        secret once) it, or a temporary key, is deleted."""
        setup_name = do_envs.resource_name(ctx.env_name, "-setup")
        app_name = do_envs.resource_name(ctx.env_name)
        for access, live in live_keys.items():
            name = live.get("name")
            if access in recorded or name not in (setup_name, app_name):
                continue
            if name == app_name and not any(g.get("bucket") == ctx.bucket
                                            for g in live.get("grants") or []):
                continue                     # named like ours, but for another bucket
            if (name == app_name and row.spaces_key_id == access
                    and row.spaces_secret_enc is not None):
                await do_envs.record(ctx.env_id, "spaces_key", access, app_name)
                out(f"Bucket key {access}: recorded it again (its record was lost).\n")
                continue
            await api.delete_spaces_key(access)
            out(f"Removed the Spaces key {access} ({name}): Sirdar never recorded it or its "
                "secret.\n")

    async def _apply_cors(self, ctx: DoContext, key: spaces.SpacesKey,
                          wanted: list[spaces.CorsRule]) -> bool:
        if await spaces.bucket_cors(ctx.bucket, ctx.region, key) == wanted:
            return False
        await spaces.put_bucket_cors(ctx.bucket, ctx.region, key, wanted)
        return True

    async def _bucket_cors(self, api: DigitalOceanApi, ctx: DoContext, key: spaces.SpacesKey,
                           out: Output) -> None:
        """The apps' browsers PUT to presigned URLs: PUT, GET and HEAD from
        their origins. Set with the bucket's own key, or with a temporary
        full-access key when Spaces refuses that one; only when it differs."""
        origins = sorted(f"https://{h}" for s, h in ctx.hosts if s in CORS_SERVICES)
        wanted = [spaces.cors_rule(origins)]
        used = "the bucket's own key"
        try:
            changed = await self._apply_cors(ctx, key, wanted)
        except spaces.SpacesDenied:
            used = "the temporary full-access key"
            setup = await self._setup_key(api, ctx)
            failure: spaces.SpacesError | None = None
            try:
                changed = await self._apply_cors(ctx, setup, wanted)
            except spaces.SpacesError as e:
                failure = e
            try:
                await self._drop_setup_key(api, ctx, setup.access_key)
            except DoError as e:
                if failure is None:
                    raise
                raise StepFailed(f"{failure.reason} Sirdar also couldn't delete the temporary "
                                 f"Spaces key {setup.access_key} ({e.reason}); the next run "
                                 "removes it.") from None
            if failure is not None:
                raise StepFailed(failure.reason) from None
        if changed:
            out(f"Bucket {ctx.bucket}: CORS now lets {', '.join(origins)} upload (set with "
                f"{used}).\n")
        else:
            out(f"Bucket {ctx.bucket}: CORS in place (checked with {used}).\n")

    async def _make_bucket(self, api: DigitalOceanApi, ctx: DoContext, recorded: bool,
                           out: Output) -> None:
        setup = await self._setup_key(api, ctx)
        try:
            made = await spaces.create_bucket(ctx.bucket, ctx.region, setup)
        finally:
            await self._drop_setup_key(api, ctx, setup.access_key)
        await do_envs.record(ctx.env_id, "bucket", ctx.bucket, ctx.bucket)
        if made:
            out(f"Created the bucket {ctx.bucket}.\n")
        else:
            out(f"Bucket {ctx.bucket}: in place.\n" if recorded
                else f"Bucket {ctx.bucket}: already this account's; recorded it.\n")

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
        recorded = {r.do_id for r in records.find("droplet")}
        tagged = [d for d in await api.droplets_tagged(do_envs.env_tag(ctx.env_id))
                  if str(d.get("id")) not in recorded]
        found: dict[str, dict] = {}
        for slot in ctx.slots:
            name = do_envs.droplet_name(ctx.env_name, slot)
            droplet = None
            for rec in records.find("droplet", slot):
                live = await api.droplet(rec.do_id)
                if live is None:
                    await do_envs.forget(ctx.env_id, "droplet", rec.do_id)
                    await self._forget_slot_pin(ctx, records, slot, out)
                    out(f"{name}: the droplet Sirdar recorded is gone; building it again.\n")
                    continue
                self._check_owned(ctx, live, name, "droplet")
                droplet = live
            if droplet is None:
                droplet = self._adoptable(ctx, [d for d in tagged if d.get("name") == name],
                                          name, "droplet")
                if droplet is not None:
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

    def _adoptable(self, ctx: DoContext, named: list[dict], name: str, what: str) -> dict | None:
        """An unrecorded droplet or cluster carrying this environment's tag and
        one of our names: adopted only with Sirdar's own tag too. The env tag
        alone is refused (never adopted, never duplicated)."""
        for found in named:
            if "sirdar" not in (found.get("tags") or []):
                raise StepFailed(f"The {what} {name} ({found.get('id')}) carries this "
                                 "environment's tag but not Sirdar's own tag, so Sirdar won't "
                                 "adopt it or build a second one. Sirdar changed nothing: tag it "
                                 "sirdar or remove it, then retry.")
        return named[0] if named else None

    async def _forget_slot_pin(self, ctx: DoContext, records: Records, slot: str,
                               out: Output) -> None:
        """A recorded droplet is gone: its address and pinned host key go too
        (unless another slot of this environment, another environment's
        droplet or a saved SSH target uses the address)."""
        row = records.slots.get(slot)
        ip = row.public_ip if row else None
        await do_envs.set_slot(ctx.env_id, slot, droplet_id=None, public_ip=None,
                               private_ip=None)
        others = {r.public_ip for s, r in records.slots.items() if s != slot and r.public_ip}
        if ip and ip not in others:
            await self._forget_pins(ctx, {ip}, out)

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
            self._check_owned(ctx, live, name, "database")
            database = live
        if database is None:
            database = self._adoptable(
                ctx, [d for d in await api.databases_tagged(env_tag) if d.get("name") == name],
                name, "database")
            if database is not None:
                await do_envs.record(ctx.env_id, "database", database["id"], name)
                out(f"Database {name}: found it by its tag and recorded it.\n")
        droplet_ids = [str(d["id"]) for d in droplets.values()]
        if database is None:
            # Locked to the droplets from creation (trusted sources in the
            # create body): never open to every address, not even briefly.
            database = await api.create_database({
                "name": name, "engine": "pg", "version": "16", "region": ctx.region,
                "size": ctx.db_size, "num_nodes": 2 if ctx.db_standby else 1,
                "private_network_uuid": vpc["id"],
                "tags": do_envs.tags(ctx.env_id, ctx.env_name),
                "rules": [{"type": "droplet", "value": d} for d in droplet_ids]})
            await do_envs.record(ctx.env_id, "database", database["id"], name)
            out(f"Creating the database cluster {name} (PostgreSQL 16, {ctx.db_size}"
                f"{', with a standby node' if ctx.db_standby else ''}).\n")
        else:
            out(f"Database {name}: in place.\n")
        await self._db_firewall(api, database["id"], droplet_ids, name, out)
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
        ca = await api.database_ca(database["id"])
        await do_envs.set_do(ctx.env_id, db_host=host, db_port=int(port), db_ca_cert=ca,
                             db_admin_password_enc=vault.encrypt(self._settings, admin))
        out(f"Database {name}: online at {host}:{port}.\n")
        return {"id": database["id"], "host": host, "port": int(port), "admin": admin, "ca": ca}

    async def _db_firewall(self, api: DigitalOceanApi, database_id: str,
                           droplet_ids: list[str], name: str, out: Output) -> None:
        """The reconcile: only this environment's droplets, by droplet ID (the
        create already set them; this puts them back after a drift or a slot
        change), retried while DigitalOcean isn't ready for it, for as long as
        Sirdar waits for the database."""
        open_copy = (f"so the database {name} may be reachable from any address. Retry from "
                     "step 0: Sirdar sets the firewall again before anything uses the database.")
        wanted = sorted(("droplet", d) for d in droplet_ids)
        seconds = self._waits["database"]
        for _ in range(self._tries(seconds)):
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
                raise StepFailed(f"{e.reason} Sirdar couldn't set the database firewall, "
                                 f"{open_copy}") from None
            out("Database firewall: only this environment's droplets may connect.\n")
            return
        raise StepFailed(f"DigitalOcean didn't accept the database firewall in {seconds // 60} "
                         f"minutes, {open_copy}")

    async def _pin(self, ctx: DoContext, droplets: dict[str, dict], host_keys: dict[str, str],
                   out: Output) -> None:
        saved = {cfg.host for _, cfg in targets.ssh_configs(self._settings)}
        for slot, droplet in droplets.items():
            name = do_envs.droplet_name(ctx.env_name, slot)
            ip, _ = do_api.droplet_ips(droplet)
            if ip in saved:
                raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a "
                                 "droplet's key there.")
            # As on ESXi: an address another environment, an SSH target or the
            # proxy uses is refused before any key is trusted there.
            await vmcommon.check_address(self._settings, ctx.env_id, ip,
                                         host_label="DigitalOcean")
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
        command = psql_command(database["host"], database["port"])
        ca_b64 = base64.b64encode(database["ca"].encode()).decode()
        code = await self._remote(cfg, command, f"{database['admin']}\n{ca_b64}\n{sql}")
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
        for cert in await api.certificates():     # an upload whose answer was lost
            cert_id = str(cert.get("id"))
            if cert_id not in recorded and certs.is_ours(cert, ctx.env_name, ctx.names):
                await do_envs.record(ctx.env_id, "certificate", cert_id, cert["name"])
                recorded.add(cert_id)
                out(f"Recorded the certificate {cert['name']} (its record was lost).\n")
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
            same = [x for x in await api.load_balancers() if x.get("name") == name]
            for found in same:
                if found.get("vpc_uuid") != vpc["id"]:
                    raise StepFailed(f"A load balancer named {name} ({found.get('id')}) already "
                                     "exists and isn't in this environment's VPC. Sirdar changed "
                                     "nothing: rename or remove it, then retry.")
            if same:
                lb = same[0]
                await do_envs.record(ctx.env_id, "load_balancer", lb["id"], name)
                out(f"Load balancer {name}: found it by its name in this environment's VPC; "
                    "recorded it.\n")
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
        """The whole rule set is checked each run; drift (a rebuilt load
        balancer included) is fixed in place with a PUT, never delete+create."""
        name = do_envs.resource_name(ctx.env_name, "-fw")
        env_tag = do_envs.env_tag(ctx.env_id)
        body = _firewall_body(name, env_tag, lb["id"])
        fw = None
        for rec in (await load_records(ctx.env_id)).find("firewall"):
            live = await api.firewall(rec.do_id)
            if live is None:
                await do_envs.forget(ctx.env_id, "firewall", rec.do_id)
                continue
            if live.get("name") != name:
                raise StepFailed(f"Cloud firewall {rec.do_id} is no longer named {name}. Sirdar "
                                 "changed nothing: fix it by hand, then retry.")
            fw = live
        if fw is None:
            same = [f for f in await api.firewalls() if f.get("name") == name]
            for found in same:
                if env_tag not in (found.get("tags") or []):
                    raise StepFailed(f"A cloud firewall named {name} ({found.get('id')}) already "
                                     "exists and doesn't apply to this environment's droplets. "
                                     "Sirdar changed nothing: rename or remove it, then retry.")
            if same:
                fw = same[0]
                await do_envs.record(ctx.env_id, "firewall", fw["id"], name)
                out(f"Cloud firewall {name}: found it by its name and tag; recorded it.\n")
        if fw is None:
            made = await api.create_firewall(body)
            await do_envs.record(ctx.env_id, "firewall", made["id"], name)
            out(f"Cloud firewall {name}: SSH from anywhere, HTTP only from the load balancer.\n")
        elif _firewall_matches(fw, body):
            out(f"Cloud firewall {name}: in place.\n")
        else:
            await api.update_firewall(fw["id"], body)
            out(f"Cloud firewall {name}: put its rules back (SSH from anywhere, HTTP only from "
                "the load balancer).\n")

    # ---- step 14: Switch traffic ---------------------------------------------------------

    def _check_owned(self, ctx: DoContext, found: dict, name: str, what: str) -> None:
        """Both of Sirdar's tags (sirdar and sirdar-env-<id>) and the exact name."""
        self._check_tagged(ctx, found, name, what)
        if "sirdar" not in (found.get("tags") or []):
            raise StepFailed(f"The {what} Sirdar recorded as {name} ({found.get('id')}) no "
                             "longer carries Sirdar's tag and name for this environment. Sirdar "
                             "changed nothing: put them back or remove it by hand, then retry.")

    async def _same_team(self, api: DigitalOceanApi, ctx: DoContext) -> None:
        """Steps 14 and 18 refuse a token from another team, as step 0 does,
        before they write anything."""
        try:
            team, _ = await do_accounts.read_team(api)
        except ConnectFailed as e:
            raise StepFailed(e.reason) from None
        if await do_envs.freeze_team(ctx.env_id, team) != team:
            raise StepFailed(f"The {ctx.account_label} DigitalOcean token now answers for "
                             "another team than the one this environment was built in. Sirdar "
                             "changed nothing. Put back a token for that team in Settings › "
                             "Integrations, then retry.")

    async def _live_lb(self, api: DigitalOceanApi, ctx: DoContext, records: Records) -> dict:
        name = do_envs.resource_name(ctx.env_name, "-lb")
        recs = records.find("load_balancer")
        if not recs:
            raise StepFailed("This environment has no load balancer yet. Retry from step 0.")
        lb = await api.load_balancer(recs[0].do_id)
        if lb is None:
            raise StepFailed("The load balancer Sirdar recorded is gone. Deploy again: step 0 "
                             "builds a new one.")
        if lb.get("name") != name:
            raise StepFailed(f"Load balancer {lb.get('id')} is no longer named {name}. Sirdar "
                             "changed nothing: fix it by hand, then retry.")
        return lb

    async def _lb_active(self, api: DigitalOceanApi, lb_id: str, name: str) -> dict:
        return await self._wait(lambda: api.load_balancer(lb_id),
                                lambda x: x.get("status") == "active", self._waits["lb"],
                                f"The load balancer {name}")

    async def _put_targets(self, api: DigitalOceanApi, lb_id: str, name: str,
                           droplet_ids: list[int]) -> dict:
        """Wait until the load balancer isn't applying a change (a PUT then is
        refused), send the targets on top of its live body, wait again."""
        current = await self._lb_active(api, lb_id, name)
        await api.update_load_balancer(lb_id, lb_update_body(current, droplet_ids=droplet_ids))
        return await self._lb_active(api, lb_id, name)

    @staticmethod
    def _settle_seconds(lb: dict) -> int:
        """How long the load balancer takes to mark a healthy droplet healthy."""
        check = lb.get("health_check") or {}
        try:
            n = int(check.get("healthy_threshold") or 3)
            every = int(check.get("check_interval_seconds") or 10)
        except (TypeError, ValueError):
            n, every = 3, 10
        return n * every + HEALTH_MARGIN

    async def _slot_healthy(self, ctx: DoContext, droplet: dict, out: Output) -> None:
        """The slot's droplet answers its own /healthz (what the load
        balancer's health check asks) before it carries any traffic.
        DigitalOcean doesn't report per-droplet health, so this asks the
        droplet itself over SSH."""
        name = do_envs.droplet_name(ctx.env_name, ctx.slot)
        ip, _ = do_api.droplet_ips(droplet)
        if not ip:
            raise StepFailed(f"{name} has no public address, so Sirdar can't check it.")
        cfg = self._slot_config(ctx, ctx.slot, ip)
        for _ in range(self._tries(self._waits["health"])):
            if await self._remote(cfg, _HEALTHZ, None) == 0:
                out(f"{name} answers /healthz.\n")
                return
            await self._sleep(self._poll)
        raise StepFailed(f"{name} didn't answer /healthz within "
                         f"{self._waits['health'] // 60} minutes.")

    async def _public_smoke(self, ctx: DoContext, lb_ip: str, out: Output,
                            outlast: float = 0) -> list[str]:
        """`outlast`: the rounds together last longer than that many seconds
        (the load balancer's health checks)."""
        attempts = self._smoke_attempts
        if self._smoke_delay > 0:
            # the waits between rounds, (attempts - 1) x delay, exceed `outlast`
            attempts = max(attempts, int(outlast // self._smoke_delay) + 2)
        results = await smoke.run(list(ctx.hosts), lb_ip,
                                  transport=outbound.transports().get("smoke"),
                                  sleep=self._sleep, attempts=attempts,
                                  delay=self._smoke_delay, out=out, insecure=ctx.acme_staging)
        for r in results:
            out(f"{r.url}: {r.detail}\n")
        return [r.service for r in results if not r.ok]

    def _smoke_failure(self, ctx: DoContext, failed: list[str]) -> str:
        return (f"{len(failed)} of {len(ctx.hosts)} public URLs didn't answer through the "
                f"load balancer: {', '.join(failed)}.")

    async def _go_live(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        """Point the load balancer at ctx.slot's droplet (no slot: at none)
        without a gap: the new droplet joins the old one, is healthy, passes
        the public smoke test through the load balancer, and only then is
        the old one dropped. On any failure the previous targets go back."""
        await self._same_team(api, ctx)
        records = await load_records(ctx.env_id)
        lb = await self._live_lb(api, ctx, records)
        name, lb_id = lb["name"], lb["id"]
        previous = [int(d) for d in lb.get("droplet_ids") or []]
        before = next((r.slot for r in records.find("droplet")
                       if r.do_id.isdigit() and int(r.do_id) in previous), None)
        was = f" (was {before})" if before else ""
        if ctx.slot is None:
            if previous:
                await self._put_targets(api, lb_id, name, [])
                out(f"Load balancer {name}: traffic now goes to no slot{was}.\n")
            else:
                out(f"Load balancer {name}: already sends traffic to no slot.\n")
            return
        if not lb.get("ip"):
            raise StepFailed(f"Load balancer {name} has no IP address yet. Retry from step 0.")
        recs = records.find("droplet", ctx.slot)
        droplet = await api.droplet(recs[0].do_id) if recs else None
        if droplet is None:
            raise StepFailed(f"The {ctx.slot} slot has no droplet. Deploy to it first.")
        self._check_owned(ctx, droplet, do_envs.droplet_name(ctx.env_name, ctx.slot), "droplet")
        new = int(droplet["id"])
        if previous == [new]:
            out(f"Load balancer {name}: already sends traffic to {ctx.slot}.\n")
            failed = await self._public_smoke(ctx, lb["ip"], out)
            if failed:
                # One slot: the deploy replaced the very droplet that serves traffic.
                tail = (" The droplet already runs the new commit; retry Switch traffic."
                        if len(ctx.slots) == 1 else " Traffic stays where it was.")
                raise StepFailed(f"{self._smoke_failure(ctx, failed)}{tail}")
            return
        both = previous if new in previous else previous + [new]
        try:
            if both != previous:
                await self._put_targets(api, lb_id, name, both)
                out(f"Load balancer {name}: {ctx.slot} joins {before or 'no slot'}.\n")
            await self._slot_healthy(ctx, droplet, out)
            settle = self._settle_seconds(lb)
            out(f"Waiting {settle} s for the load balancer's health checks.\n")
            await self._sleep(settle)
            failed = await self._public_smoke(ctx, lb["ip"], out, settle)
            if failed:
                raise StepFailed(self._smoke_failure(ctx, failed))
            if both != [new]:
                await self._put_targets(api, lb_id, name, [new])
                out(f"Load balancer {name}: only {ctx.slot} now; checking it alone.\n")
                await self._sleep(settle)
            await self._prove_switch(api, ctx, records, lb, new)
            if both != [new]:
                failed = await self._public_smoke(ctx, lb["ip"], out)
                if failed:
                    raise StepFailed(self._smoke_failure(ctx, failed))
        except (StepFailed, DoError) as e:
            await self._put_back(api, lb_id, name, previous, before, e.reason, out)
            raise StepFailed(f"{e.reason} Traffic stays where it was.") from None
        out(f"Load balancer {name}: traffic now goes to {ctx.slot}{was}.\n")

    async def _prove_switch(self, api: DigitalOceanApi, ctx: DoContext, records: Records,
                            lb: dict, new: int) -> None:
        """Read the load balancer again: only the new droplet, and a
        certificate of ours (another writer, the cert-worker, may have raced
        the switch)."""
        final = await api.load_balancer(lb["id"])
        if final is None:
            raise StepFailed(f"Load balancer {lb['name']} disappeared during the switch.")
        ids = sorted(int(d) for d in final.get("droplet_ids") or [])
        if ids != [new]:
            raise StepFailed(f"Load balancer {lb['name']}'s targets changed during the switch "
                             f"(now {', '.join(map(str, ids)) or 'none'}): something else "
                             "updated it.")
        cert_id = https_certificate(final)
        cert = await api.certificate(cert_id) if cert_id else None
        if cert is None or not (certs.is_ours(cert, ctx.env_name, ctx.names)
                                or cert_id in {r.do_id for r in records.find("certificate")}):
            raise StepFailed(f"Load balancer {lb['name']} serves a certificate that isn't one of "
                             f"Sirdar's for {ctx.env_name}. Run step 0 again to put one back.")

    async def _put_back(self, api: DigitalOceanApi, lb_id: str, name: str,
                        previous: list[int], before: str | None, reason: str,
                        out: Output) -> None:
        try:
            await self._put_targets(api, lb_id, name, previous)
        except (StepFailed, DoError) as e:
            raise StepFailed(f"{reason} Sirdar couldn't put traffic back on "
                             f"{before or 'no slot'} ({e.reason}): point load balancer "
                             f"{name} there by hand.") from None
        out(f"Put traffic back on {before or 'no slot'}.\n")

    # ---- step 18: Remove DigitalOcean resources -------------------------------------------

    _FETCH = {"vpc": "vpc", "droplet": "droplet", "database": "database",
              "certificate": "certificate", "load_balancer": "load_balancer",
              "firewall": "firewall"}

    async def _removable(self, ctx: DoContext) -> None:
        """Read fresh: a production environment goes only once it is retiring
        and serves no slot."""
        async with get_sessionmaker()() as s:
            env = await s.get(Environment, ctx.env_id)
        if env is None:
            raise StepFailed("This environment is gone from Sirdar's records. Sirdar changed "
                             "nothing.")
        if env.type == "production" and (not env.retiring or env.active_slot):
            raise StepFailed("This production environment is still live (not retiring, or "
                             "still serving a slot). Sirdar removes production only once it is "
                             "retiring and serves no slot. Sirdar changed nothing.")

    def _stray(self, ctx: DoContext, found: dict, recorded: set[str]) -> bool:
        """Tagged for this environment, not recorded, and plainly Sirdar's:
        both tags and the environment's name prefix."""
        tags = found.get("tags") or []
        return (str(found.get("id")) not in recorded and "sirdar" in tags
                and do_envs.env_tag(ctx.env_id) in tags
                and str(found.get("name") or "").startswith(
                    do_envs.resource_name(ctx.env_name) + "-"))

    async def _check_all(self, api: DigitalOceanApi, ctx: DoContext, records: Records,
                         out: Output) -> list[dict]:
        """Before anything is deleted: every recorded resource that still
        exists must still match (both tags and the exact name, or the exact
        name). The certificate the load balancer serves now (the cert-worker
        may have renewed it) is recorded when it is ours. Returns the live
        recorded droplets."""
        droplets = []
        certificates = {r.do_id for r in records.find("certificate")}
        for rec in records.resources:
            if rec.kind == "bucket":
                if rec.do_id != ctx.bucket:
                    raise StepFailed(f"Sirdar recorded the bucket {rec.do_id}, not this "
                                     f"environment's {ctx.bucket}. Sirdar changed nothing.")
                continue
            if rec.kind not in self._FETCH:
                continue
            live = await getattr(api, self._FETCH[rec.kind])(rec.do_id)
            if live is None:
                continue
            what = rec.kind.replace("_", " ")
            if rec.kind in ("droplet", "database"):
                self._check_owned(ctx, live, rec.name, what)
                if rec.kind == "droplet":
                    droplets.append(live)
            elif rec.kind == "certificate":
                if not (certs.is_ours(live, ctx.env_name, ctx.names)
                        or live.get("name") == rec.name):
                    raise StepFailed(f"Certificate {rec.do_id} is no longer one of Sirdar's for "
                                     f"{ctx.env_name}. Sirdar changed nothing.")
            elif rec.kind == "vpc":
                if live.get("name") != rec.name or f"sirdar:{ctx.env_id}" not in str(
                        live.get("description") or ""):
                    raise StepFailed(f"VPC {rec.do_id} no longer looks like Sirdar's {rec.name}. "
                                     "Sirdar changed nothing.")
            elif live.get("name") != rec.name:
                raise StepFailed(f"The {what} {rec.do_id} is no longer named {rec.name}. "
                                 "Sirdar changed nothing.")
            if rec.kind == "load_balancer":
                current = https_certificate(live)
                if current and current not in certificates:
                    cert = await api.certificate(current)
                    if cert is not None and certs.is_ours(cert, ctx.env_name, ctx.names):
                        await do_envs.record(ctx.env_id, "certificate", current, cert["name"])
                        certificates.add(current)
                        out(f"Recorded the certificate {cert['name']} the load balancer "
                            "serves now.\n")
        if records.find("spaces_key"):
            keys = {k.get("access_key"): k for k in await api.spaces_keys()}
            for rec in records.find("spaces_key"):
                live = keys.get(rec.do_id)
                if live is not None and live.get("name") != rec.name:
                    raise StepFailed(f"Spaces key {rec.do_id} is no longer named {rec.name}. "
                                     "Sirdar changed nothing.")
        return droplets

    async def _remove(self, ctx: DoContext, rec: DoResource, delete, out: Output) -> None:
        gone = await delete(rec.do_id)
        await do_envs.forget(ctx.env_id, rec.kind, rec.do_id)
        out(f"{rec.name}: {'deleted' if gone else 'already gone'}.\n")

    async def _remove_certificate(self, ctx: DoContext, api: DigitalOceanApi, rec: DoResource,
                                  out: Output) -> None:
        """A certificate stays in use a little after its load balancer goes
        (DigitalOcean answers 403 "in use", as step 0 expects): a bounded
        retry."""
        for _ in range(self._tries(self._waits["lb"])):
            try:
                await self._remove(ctx, rec, api.delete_certificate, out)
                return
            except DoError as e:
                if e.status not in (403, 409, 422):
                    raise
            await self._sleep(self._poll)
        raise StepFailed(f"The certificate {rec.name} is still in use after "
                         f"{self._waits['lb'] // 60} minutes. Retry Delete in a few minutes.")

    @staticmethod
    def _member(member: dict) -> str:
        """`droplet 4001 (ss-uat9-orange)` from a VPC member's urn and name,
        cut to safe characters (DigitalOcean's text never reaches the log raw)."""
        parts = str(member.get("urn") or "").split(":")
        kind = re.sub(r"[^a-z]", "", parts[1] if len(parts) > 1 else "")[:20] or "member"
        ident = re.sub(r"[^A-Za-z0-9-]", "", parts[2] if len(parts) > 2 else "")[:40]
        name = re.sub(r"[^A-Za-z0-9._-]", "", str(member.get("name") or ""))[:63]
        return " ".join(p for p in (kind, ident, f"({name})" if name else "") if p)

    async def _remove_vpc(self, api: DigitalOceanApi, ctx: DoContext, rec: DoResource,
                          out: Output) -> None:
        """A VPC can't go while it has members; deleted droplets and databases
        leave it a little later. A refusal while it has none (a missing scope,
        a default VPC) stops at once."""
        for _ in range(self._tries(self._waits["vpc"])):
            try:
                await self._remove(ctx, rec, api.delete_vpc, out)
                return
            except DoError as e:
                if e.status not in (403, 409, 422):
                    raise
                status = e.status
            if status == 403 and not await api.vpc_members(rec.do_id):
                raise StepFailed(f"DigitalOcean refused to delete the VPC {rec.name} although "
                                 "nothing is in it (HTTP 403: check the token's scopes). Sirdar "
                                 "stopped there.")
            await self._sleep(self._poll)
        left = [self._member(m) for m in await api.vpc_members(rec.do_id)]
        named = f": {', '.join(left[:10])}{' and more' if len(left) > 10 else ''}" if left else ""
        raise StepFailed(f"The VPC {rec.name} still has members after "
                         f"{self._waits['vpc'] // 60} minutes{named}. Remove what isn't this "
                         "environment's, or retry Delete in a few minutes.")

    async def _empty_and_delete_bucket(self, api: DigitalOceanApi, ctx: DoContext,
                                       rec: DoResource, out: Output) -> None:
        setup = await self._setup_key(api, ctx)
        failure: spaces.SpacesError | None = None
        try:
            count = await spaces.empty_bucket(rec.do_id, ctx.region, setup)
            gone = await spaces.delete_bucket(rec.do_id, ctx.region, setup)
        except spaces.SpacesError as e:
            failure = e
        try:
            await self._drop_setup_key(api, ctx, setup.access_key)
        except DoError as e:
            if failure is None:
                raise
            raise StepFailed(f"{failure.reason} Sirdar also couldn't delete the temporary "
                             f"Spaces key {setup.access_key} ({e.reason}); the next Delete "
                             "removes it.") from None
        if failure is not None:
            raise StepFailed(failure.reason) from None
        await do_envs.forget(ctx.env_id, "bucket", rec.do_id)
        out(f"Bucket {rec.name}: emptied ({count} objects) and "
            f"{'deleted' if gone else 'already gone'}.\n")

    async def _forget_pins(self, ctx: DoContext, ips: set[str], out: Output) -> None:
        """Forget each removed droplet's pinned host key, unless the address is
        a saved SSH target's or another DigitalOcean environment's droplet's."""
        saved = {cfg.host for _, cfg in targets.ssh_configs(self._settings)}
        async with get_sessionmaker()() as s:
            others = set(await s.scalars(select(DoSlot.public_ip).where(
                DoSlot.environment_id != ctx.env_id, DoSlot.public_ip.in_(ips or {""}))))
        for ip in sorted(ips - saved - others):
            if await vmcommon.forget_pin(ip, ctx.actor_id, "digitalocean"):
                out(f"Forgot {ip}'s SSH host key.\n")

    async def _destroy(self, api: DigitalOceanApi, ctx: DoContext, out: Output) -> None:
        await self._removable(ctx)
        await self._same_team(api, ctx)
        env_tag = do_envs.env_tag(ctx.env_id)
        # Everything is checked (and the strays found) before anything is deleted.
        live_droplets = await self._check_all(api, ctx, await load_records(ctx.env_id), out)
        records = await load_records(ctx.env_id)        # with an adopted certificate
        recorded = {r.do_id for r in records.find("droplet")}
        tagged = await api.droplets_tagged(env_tag)
        stray_droplets = [d for d in tagged if self._stray(ctx, d, recorded)]
        recorded_dbs = {r.do_id for r in records.find("database")}
        stray_dbs = [d for d in await api.databases_tagged(env_tag)
                     if self._stray(ctx, d, recorded_dbs)]
        for found in tagged:
            if str(found["id"]) not in recorded and found not in stray_droplets:
                out(f"{found.get('name')} ({found['id']}) carries this environment's tag but "
                    "not Sirdar's own; left alone.\n")
        ips = {s.public_ip for s in records.slots.values() if s.public_ip}
        ips |= {ip for d in live_droplets + stray_droplets
                if (ip := do_api.droplet_ips(d)[0])}

        for rec in records.find("load_balancer"):
            await self._remove(ctx, rec, api.delete_load_balancer, out)
        for rec in records.find("certificate"):
            await self._remove_certificate(ctx, api, rec, out)
        for rec in records.find("firewall"):
            await self._remove(ctx, rec, api.delete_firewall, out)
        for rec in records.find("droplet"):
            await self._remove(ctx, rec, api.delete_droplet, out)
        for droplet in stray_droplets:
            out(f"{droplet.get('name')}: tagged for this environment but not recorded; "
                "deleting it too.\n")
            await api.delete_droplet(str(droplet["id"]))
        await self._forget_pins(ctx, ips, out)
        for rec in records.find("database"):
            await self._remove(ctx, rec, api.delete_database, out)
        for database in stray_dbs:
            out(f"{database.get('name')}: tagged for this environment but not recorded; "
                "deleting it too.\n")
            await api.delete_database(str(database["id"]))
        for rec in records.find("spaces_key"):
            await self._remove(ctx, rec, api.delete_spaces_key, out)
        for rec in records.find("bucket"):
            await self._empty_and_delete_bucket(api, ctx, rec, out)
        for rec in records.find("vpc"):
            await self._remove_vpc(api, ctx, rec, out)
        out("Nothing of this environment is left on DigitalOcean.\n")
