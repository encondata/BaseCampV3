"""DigitalOcean environments' records (deploy phase 7): the frozen
settings, slots and ownership rows, the slot an Update targets, the SSH
connection to a slot's droplet, and the JSON shape. Secrets are
Fernet-encrypted with SIRDAR_SECRETS_KEY and never returned.

record/forget/set_do/set_slot each write in their own committed
transaction: step 0 records a resource the moment DigitalOcean answers, so a
later failure still knows it exists."""

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import DoEnvironment, DoResource, DoSlot, Environment
from sirdar_api.deploy import acme, certs, do_accounts, envfile, spaces, vault, vms
from sirdar_api.deploy import apps as app_rules
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.deploy.ssh import SshTargetConfig

DO_TARGET = "digitalocean"
PRODUCTION_SLOTS = ("blue", "green")
ONE_SLOT = ("orange",)
TWO_SLOTS = ("orange", "purple")
DEFAULT_DROPLET_SIZE = "s-2vcpu-4gb"     # V2 production: 2 vCPU / 4 GB / 80 GB
DEFAULT_DB_SIZE = "db-s-2vcpu-4gb"       # V2 production: 2 vCPU / 4 GB / 60 GB
DROPLET_IMAGE = "ubuntu-24-04-x64"
CADDY_IP = "172.30.0.2"                  # Caddy on the ss-<env> network = the env's proxy_ip
NETWORK_SUBNET = "172.30.0.0/24"
BIND_IP = "127.0.0.1"                    # app ports stay on the droplet; Caddy publishes :80
DB_NAME = DB_USER = "serversherpa"
_SIZE_RE = re.compile(r"[a-z0-9][a-z0-9-]{2,39}")
_DB_SIZE_RE = re.compile(r"db-[a-z0-9][a-z0-9-]{2,36}")


class DoEnvError(Exception):
    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


# ---- names and tags ----------------------------------------------------------------

def resource_name(env_name: str, suffix: str = "") -> str:
    return f"ss-{env_name}{suffix}"


def droplet_name(env_name: str, slot: str) -> str:
    return f"ss-{env_name}-{slot}"


def bucket_name(env_name: str, env_id) -> str:
    return f"ss-{env_name}-{uuid.UUID(str(env_id)).hex[:8]}"


def env_tag(env_id) -> str:
    """The ownership tag: only this environment's resources carry it."""
    return f"sirdar-env-{env_id}"


def tags(env_id, env_name: str, slot: str | None = None) -> list[str]:
    found = ["sirdar", env_tag(env_id), f"sirdar-env:{env_name}"]
    return found + ([f"sirdar-slot:{slot}"] if slot else [])


# ---- create ------------------------------------------------------------------------------

def check_spec(fields, *, production: bool) -> dict:
    if not isinstance(fields, dict):
        raise DoEnvError("do_invalid")
    account = fields.get("account") or ("production" if production else None)
    if account not in ("production", "development"):
        raise DoEnvError("do_invalid")
    count = fields.get("slots")
    if count is not None and (isinstance(count, bool) or count not in (1, 2)):
        raise DoEnvError("do_slots_invalid")
    if production:
        if count == 1:
            raise DoEnvError("do_slots_invalid")
        if fields.get("acme_staging"):
            raise DoEnvError("do_invalid")
        slots = PRODUCTION_SLOTS
    else:
        slots = TWO_SLOTS if count == 2 else ONE_SLOT
    droplet = fields.get("droplet_size") or DEFAULT_DROPLET_SIZE
    if not isinstance(droplet, str) or not _SIZE_RE.fullmatch(droplet) \
            or droplet.startswith("db-"):
        raise DoEnvError("do_size_invalid")
    db_size = fields.get("db_size") or DEFAULT_DB_SIZE
    if not isinstance(db_size, str) or not _DB_SIZE_RE.fullmatch(db_size):
        raise DoEnvError("do_db_size_invalid")
    standby, staging = fields.get("db_standby", False), fields.get("acme_staging", False)
    if not isinstance(standby, bool) or not isinstance(staging, bool):
        raise DoEnvError("do_invalid")
    auto = fields.get("auto_activate", False)
    if not isinstance(auto, bool):
        raise DoEnvError("do_invalid")
    if production and auto:
        raise DoEnvError("auto_activate_not_allowed")    # production waits for Activate
    return {"account": account, "slots": slots, "droplet_size": droplet, "db_size": db_size,
            "db_standby": standby, "acme_staging": staging, "auto_activate": auto}


def _size_of(catalog: list[dict], slug: str | None) -> dict | None:
    return next((s for s in catalog if isinstance(s, dict) and s.get("slug") == slug), None)


_SLUG_RE = re.compile(r"(?P<family>[a-z0-9_]+(?:-[a-z0-9_]+)*?-)(?P<cpu>\d+)vcpu-"
                      r"(?P<mem>\d+)gb(?P<tail>(?:-[a-z0-9_]+)*)")


def size_parts(slug: str | None) -> tuple[str, int, int] | None:
    """(family, vCPUs, memory GB) read from a size slug: `s-4vcpu-8gb` is
    ("s-*", 4, 8), `db-s-2vcpu-4gb` ("db-s-*", 2, 4), `s-2vcpu-4gb-amd`
    ("s-*-amd", 2, 4). None when the slug doesn't read that way."""
    found = _SLUG_RE.fullmatch(slug or "")
    if found is None:
        return None
    return f"{found['family']}*{found['tail']}", int(found["cpu"]), int(found["mem"])


def grows(old: str | None, new: str | None) -> bool:
    """`new` is `old` or larger, in the same family (both readable)."""
    a, b = size_parts(old), size_parts(new)
    return a is not None and b is not None and a[0] == b[0] and b[1] >= a[1] and b[2] >= a[2]


def _check_droplet_grow(catalog: list, row: DoEnvironment, want: str) -> None:
    new = _size_of(catalog, want)
    if new is None or not new.get("available", True) \
            or row.region not in (new.get("regions") or []):
        raise DoEnvError("do_size_invalid")           # not offered (here)
    new_parts, old_parts = size_parts(want), size_parts(row.droplet_size)
    if new_parts and old_parts and new_parts[0] != old_parts[0]:
        raise DoEnvError("do_size_invalid")           # another family
    old = _size_of(catalog, row.droplet_size)
    if old is not None:
        mine = [(int(new.get(k) or 0), int(old.get(k) or 0)) for k in ("vcpus", "memory", "disk")]
    elif old_parts is not None:                       # retired from the catalog: its slug
        mine = [(int(new.get("vcpus") or 0), old_parts[1]),
                (int(new.get("memory") or 0), old_parts[2] * 1024)]
    else:
        raise DoEnvError("do_shrink_refused")         # nothing to prove it grows
    if any(n < o for n, o in mine) or not any(n > o for n, o in mine):
        raise DoEnvError("do_shrink_refused")


def _db_layout(options: dict, nodes: int) -> list:
    layouts = ((options.get("pg") or {}).get("layouts")) or []
    return next((lay.get("sizes") or [] for lay in layouts
                 if isinstance(lay, dict) and lay.get("num_nodes") == nodes), [])


async def check_grow(api, row: DoEnvironment, fields: dict) -> dict:
    """The sizes a PATCH asks for, checked against DigitalOcean's catalogs: a
    droplet size offered in the environment's region, in the same family,
    with at least the vCPUs, memory and disk of the current one and more of
    one; a database size offered for the node count, in the same family, at
    least as large (vCPUs and memory from the slug); a standby node that is
    never removed and only on a size that can have one. Returns only what
    changes."""
    if not isinstance(fields, dict) or set(fields) - {"droplet_size", "db_size", "db_standby"}:
        raise DoEnvError("do_invalid")
    out: dict = {}
    want = fields.get("droplet_size")
    if want is not None and want != row.droplet_size:
        if not isinstance(want, str) or not _SIZE_RE.fullmatch(want) or want.startswith("db-"):
            raise DoEnvError("do_size_invalid")
        _check_droplet_grow(await api.sizes(), row, want)
        out["droplet_size"] = want
    standby = fields.get("db_standby")
    if standby is not None and not isinstance(standby, bool):
        raise DoEnvError("do_invalid")
    if standby is False and row.db_standby:
        raise DoEnvError("do_shrink_refused")
    adding_standby = standby is True and not row.db_standby
    db_size = fields.get("db_size") or row.db_size
    if not isinstance(db_size, str) or not _DB_SIZE_RE.fullmatch(db_size):
        raise DoEnvError("do_db_size_invalid")
    if db_size != row.db_size or adding_standby:
        nodes = 2 if (adding_standby or row.db_standby) else 1
        options = await api.database_options()
        if db_size not in _db_layout(options, nodes):
            if adding_standby and db_size in _db_layout(options, 1):
                raise DoEnvError("db_standby_size_invalid")   # that size has no standby
            raise DoEnvError("do_db_size_invalid")
        new_parts, old_parts = size_parts(db_size), size_parts(row.db_size)
        if new_parts is None or (old_parts is not None and old_parts[0] != new_parts[0]):
            raise DoEnvError("do_db_size_invalid")    # unreadable, or another family
        if not grows(row.db_size, db_size):
            raise DoEnvError("do_shrink_refused")
        if db_size != row.db_size:
            out["db_size"] = db_size
    if adding_standby:
        out["db_standby"] = True
    return out


def apply_sizes(row: DoEnvironment, values: dict) -> list[str]:
    """Store checked sizes; step 0 applies them on the next deploy."""
    changed = [f"do.{k}" for k, v in values.items() if getattr(row, k) != v]
    for key, value in values.items():
        setattr(row, key, value)
    if changed:
        row.updated_at = datetime.now(UTC)
    return changed


async def add_slot(db: AsyncSession, settings: Settings, env: Environment, slot: str) -> DoSlot:
    private, public = vms.new_host_keypair(f"{env.name}-{slot}")
    row = DoSlot(environment_id=env.id, slot=slot, host_key_public=public,
                 host_key_private_enc=vault.encrypt(settings, private))
    db.add(row)
    await db.flush()
    return row


async def add(db: AsyncSession, settings: Settings, env: Environment, spec: dict, *,
              region: str, team_uuid: str | None = None) -> DoEnvironment:
    """The record, frozen at create: the account (and the team its token
    answered for, when known), region and sizes, a fresh key pair, the
    cert-worker's ACME key, the bucket name, and one host key per slot."""
    private, public = vms.new_keypair(env.name)
    row = DoEnvironment(environment_id=env.id, account_key=spec["account"],
                        team_uuid=team_uuid, region=region,
                        droplet_size=spec["droplet_size"], droplet_image=DROPLET_IMAGE,
                        db_size=spec["db_size"], db_standby=spec["db_standby"],
                        acme_staging=spec["acme_staging"], ssh_public_key=public,
                        ssh_private_key_enc=vault.encrypt(settings, private),
                        acme_key_enc=vault.encrypt(settings, acme.new_key_pem()),
                        bucket=bucket_name(env.name, env.id))
    db.add(row)
    await db.flush()
    for slot in spec["slots"]:
        await add_slot(db, settings, env, slot)
    env.slots = list(spec["slots"])
    await db.flush()
    return row


async def production_exists(db: AsyncSession, *, other_than=None) -> bool:
    """Whether a production environment that isn't retiring exists (other
    than `other_than`, an environment id)."""
    query = select(Environment.id).where(Environment.type == "production",
                                         Environment.retiring.is_(False))
    if other_than is not None:
        query = query.where(Environment.id != other_than)
    return await db.scalar(query.limit(1)) is not None


# ---- reads ---------------------------------------------------------------------------------

async def get(db: AsyncSession, env_id) -> DoEnvironment | None:
    return await db.get(DoEnvironment, env_id, populate_existing=True)


async def slots_of(db: AsyncSession, env_id) -> dict[str, DoSlot]:
    rows = await db.scalars(select(DoSlot).where(DoSlot.environment_id == env_id)
                            .execution_options(populate_existing=True))
    return {r.slot: r for r in rows}


async def resources_of(db: AsyncSession, env_id) -> list[DoResource]:
    return list(await db.scalars(select(DoResource).where(DoResource.environment_id == env_id)
                                 .order_by(DoResource.created_at, DoResource.kind)
                                 .execution_options(populate_existing=True)))


def target_slot(env: Environment) -> str:
    """The slot an Update deploys to: the idle one of two, else the only one."""
    slots = list(env.slots)
    if env.active_slot is None or len(slots) == 1:
        return slots[0]
    return next(s for s in slots if s != env.active_slot)


def goes_live(env: Environment, slot: str) -> bool:
    """Whether an Update of `slot` switches traffic to it: nothing is live
    yet, a one-slot environment (in place), or a non-production environment
    with auto_activate. Production always waits for Activate."""
    if env.active_slot is None or len(env.slots) == 1 or env.active_slot == slot:
        return True
    return env.auto_activate and env.type != "production"


async def host_config(db: AsyncSession, settings: Settings, env: Environment,
                      slot: str | None = None) -> SshTargetConfig | None:
    """SSH to a slot's droplet (default: the active slot, else the first);
    None until step 0 has its address. vault errors propagate."""
    slot = slot or env.active_slot or (env.slots[0] if env.slots else None)
    if slot is None:
        return None
    row = await get(db, env.id)
    slot_row = await db.get(DoSlot, (env.id, slot), populate_existing=True)
    if row is None or slot_row is None or not slot_row.public_ip:
        return None
    return SshTargetConfig(host=slot_row.public_ip, port=vms.VM_SSH_PORT, user=vms.VM_USER,
                           private_key=vault.decrypt(settings, row.ssh_private_key_enc),
                           key_name=f"Sirdar's key for {droplet_name(env.name, slot)}")


async def env_extra(db: AsyncSession, settings: Settings, env: Environment, slot: str,
                    secrets: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """The .env keys a slot's droplet needs on top of the usual ones, and the
    secret values among them (for the redactor). DoEnvError("do_not_ready",
    missing=[...]) until step 0 has recorded them. POSTGRES_PASSWORD is the
    managed role's password too (step 0 sets it); it is URL-quoted. The
    cluster's CA goes in base64 (SS_DATABASE_CA_B64, one line) so the api,
    migrate and ss-stack's client verify the server (verify-full). Then the
    cert-worker's keys: the account's renewal token, the load balancer, the
    public names, the ACME directory and this environment's ACME key
    (base64). A droplet id that isn't a number counts as missing (the
    cert-worker would idle)."""
    import base64
    from urllib.parse import quote

    row = await get(db, env.id)
    slot_row = await db.get(DoSlot, (env.id, slot), populate_existing=True)
    try:
        account = await do_accounts.load(db, settings, row.account_key) if row else None
    except IntegrationError:              # a token that won't open: reported as missing
        account = None
    lb_id = await db.scalar(select(DoResource.do_id).where(
        DoResource.environment_id == env.id, DoResource.kind == "load_balancer").limit(1))
    droplet = slot_row.droplet_id if slot_row else None
    missing = [label for label, value in (
        ("load balancer address", row.lb_ip if row else None),
        ("VPC range", row.vpc_ip_range if row else None),
        ("database host", row.db_host if row else None),
        ("database port", row.db_port if row else None),
        ("database CA", row.db_ca_cert if row else None),
        ("Spaces key", row.spaces_key_id if row and row.spaces_secret_enc else None),
        ("droplet", droplet if droplet and droplet.isdecimal() else None),
        ("load balancer", lb_id),
        ("renewal token", account.renewal_token if account else None)) if not value]
    if missing:
        raise DoEnvError("do_not_ready", missing=missing)
    spaces_secret = vault.decrypt(settings, row.spaces_secret_enc)
    password = quote(secrets["POSTGRES_PASSWORD"], safe="")
    url = f"postgresql+asyncpg://{DB_USER}:{password}@{row.db_host}:{row.db_port}/{DB_NAME}"
    ca_b64 = base64.b64encode(row.db_ca_cert.encode()).decode()
    extra = {
        "STACK_EXTERNAL_DATA": "1", "STACK_CADDY": "1", "STACK_NETWORK_SUBNET": NETWORK_SUBNET,
        "STACK_HOSTS_IP": row.lb_ip, "STACK_TRUSTED_PROXIES": row.vpc_ip_range,
        "STACK_DB_HOST": row.db_host, "STACK_DB_PORT": str(row.db_port),
        "STACK_DB_NAME": DB_NAME, "STACK_DB_USER": DB_USER,
        "SS_DATABASE_URL": url, "SS_DATABASE_SSL": "require", "SS_DATABASE_CA_B64": ca_b64,
        "SS_SPACES_ENDPOINT": spaces.endpoint(row.region), "SS_SPACES_REGION": row.region,
        "SS_SPACES_ACCESS_KEY": row.spaces_key_id, "SS_SPACES_SECRET_KEY": spaces_secret,
        "SS_SPACES_USE_PATH_STYLE": "false", "STACK_DROPLET_ID": droplet,
    }
    acme_key = base64.b64encode(vault.decrypt(settings, row.acme_key_enc).encode()).decode()
    extra |= {   # the cert-worker's (Task 3); STACK_ENV and STACK_DROPLET_ID come with the rest
        "SS_CERT_DO_TOKEN": account.renewal_token, "SS_CERT_LB_ID": lb_id,
        # the running apps' names only (as do_provision's certificate covers)
        "SS_CERT_NAMES": ",".join(f"{s}.{env.base_domain}" for s in certs.PUBLIC_SERVICES
                                  if app_rules.is_public(env, s)),
        "SS_CERT_ACME_DIRECTORY": (settings.acme_staging_directory if row.acme_staging
                                   else settings.acme_directory),
        "SS_CERT_ACME_KEY": acme_key}
    found = [url, spaces_secret, ca_b64, account.renewal_token, acme_key]
    if password != secrets["POSTGRES_PASSWORD"]:
        found.append(password)          # the URL carries it quoted: a secret too
    return extra, found


async def secret_values(db: AsyncSession, settings: Settings, env: Environment) -> list[str]:
    """Every DigitalOcean secret of this environment Sirdar holds now, for a
    deployment's redactor: the account's tokens (the renewal token reaches the
    droplet), the cert-worker's ACME key (as PEM and as the base64 the .env
    carries), the Spaces secret and the doadmin password (step 0 makes the
    last two, after the run's context was built, so each host step reads them
    again). Values that don't open are left out: whatever needs them fails on
    its own."""
    import base64

    row = await get(db, env.id)
    if row is None:
        return []
    found: list[str | None] = []
    for blob in (row.acme_key_enc, row.spaces_secret_enc, row.db_admin_password_enc):
        if blob is not None:
            try:
                value = vault.decrypt(settings, blob)
            except (vault.SecretsKeyMissing, vault.SecretUnreadable):
                continue
            found.append(value)
            if blob is row.acme_key_enc:
                found.append(base64.b64encode(value.encode()).decode())
    try:
        account = await do_accounts.load(db, settings, row.account_key)
    except IntegrationError:              # unreadable: the step that needs it says so
        account = None
    if account is not None:
        found += [account.token, account.renewal_token]
    return [v for v in found if v]


async def after_success(db: AsyncSession, env: Environment, dep) -> None:
    """A DigitalOcean Update or Activate that finished: the slot keeps the
    commit it now runs; if traffic moved, the slot is the active one (None:
    Deactivate) and its commit is the environment's. The caller commits.
    DoEnvError("slot_not_deployed") for traffic moved to a slot that has
    never run a deploy (there is no commit to make the environment's)."""
    now = datetime.now(UTC)
    slot = await db.get(DoSlot, (env.id, dep.slot), populate_existing=True) if dep.slot else None
    if dep.go_live and dep.mode != "update" and dep.slot and (slot is None or not slot.sha):
        raise DoEnvError("slot_not_deployed", slot=dep.slot)
    if dep.mode == "update" and slot is not None:
        slot.sha, slot.image_tag, slot.updated_at = dep.sha, envfile.image_tag(dep.sha), now
    if dep.go_live:
        env.active_slot = dep.slot
        if slot is not None and slot.sha:
            env.current_sha, env.image_tag = slot.sha, slot.image_tag
    env.status, env.updated_at = "ready", now


# ---- own-session writers -------------------------------------------------------------------

async def record(env_id, kind: str, do_id, name: str, slot: str | None = None) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(insert(DoResource).values(
            environment_id=env_id, kind=kind, do_id=str(do_id), name=name, slot=slot)
            .on_conflict_do_nothing(index_elements=["kind", "do_id"]))
        await s.commit()


async def forget(env_id, kind: str, do_id) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(delete(DoResource).where(
            DoResource.environment_id == env_id, DoResource.kind == kind,
            DoResource.do_id == str(do_id)))
        await s.commit()


async def set_do(env_id, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env_id)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def freeze_team(env_id, team_uuid: str) -> str | None:
    """Store the DigitalOcean team the environment is built in, unless one is
    stored already, and return the stored team (which a caller then compares:
    a token from another team must not touch the environment)."""
    async with get_sessionmaker()() as s:
        await s.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env_id,
                                                    DoEnvironment.team_uuid.is_(None))
                        .values(team_uuid=team_uuid, updated_at=datetime.now(UTC)))
        stored = await s.scalar(select(DoEnvironment.team_uuid)
                                .where(DoEnvironment.environment_id == env_id))
        await s.commit()
        return stored


async def set_slot(env_id, slot: str, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DoSlot).where(DoSlot.environment_id == env_id,
                                             DoSlot.slot == slot)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def lb_ip(env_id) -> str | None:
    async with get_sessionmaker()() as s:
        return await s.scalar(select(DoEnvironment.lb_ip)
                              .where(DoEnvironment.environment_id == env_id))


# ---- JSON ------------------------------------------------------------------------------------

def public(env: Environment, row: DoEnvironment, slots: dict[str, DoSlot],
           resources: list[DoResource], account_label: str) -> dict:
    return {
        "account": row.account_key, "account_label": account_label, "region": row.region,
        "droplet_size": row.droplet_size, "db_size": row.db_size, "db_standby": row.db_standby,
        "acme_staging": row.acme_staging, "vpc_ip_range": row.vpc_ip_range, "lb_ip": row.lb_ip,
        "db_host": row.db_host, "bucket": row.bucket, "cert_not_after": row.cert_not_after,
        "slots": [{"slot": s, "droplet_id": r.droplet_id, "public_ip": r.public_ip,
                   "private_ip": r.private_ip, "sha": r.sha, "image_tag": r.image_tag,
                   "active": s == env.active_slot, "last_check_ok": r.last_check_ok,
                   "last_check_at": r.last_check_at}
                  for s in env.slots if (r := slots.get(s)) is not None],
        "resources": [{"kind": r.kind, "name": r.name, "slot": r.slot} for r in resources],
    }
