"""Publishing an environment (spec Section 2 steps 12–14, Section 3
managed_records): a Cloudflare A record and a proxy host for every public
service, a smoke test of the public URLs, and their removal when the
environment is deleted. A LAN environment's proxy (Environment.proxy) is
Switchyard or Nginx Proxy Manager: NPM proxy hosts get a Let's Encrypt
certificate Sirdar requests; Switchyard hosts get theirs from Caddy, and
Sirdar waits for it. Every Switchyard change set ends with one apply.

Sirdar edits or deletes only what managed_records lists for the
environment. A row's origin says why it is there: "created" (Sirdar made
it; Delete environment removes it) or "claimed" (it existed before and
someone claimed it on the Publish tab; Sirdar keeps it up to date and never
deletes it). Anything else at a wanted name blocks: the step changes
nothing, fails, and says to claim it or fix it by hand.

The status functions are pure: they compare what Cloudflare and NPM hold
with the managed rows and give one Status per service. The Publish tab
shows them (inspect), Claim records the claimable ones, and the steps
apply them. Errors carry our own copy; credentials stay inside the
Cloudflare and Npm clients.

Step 14 Switch traffic of a LAN Blue/Green environment (lan_switch) points
the proxy hosts at the slot's app VM, checks the public names, and puts them
back on failure; spaces always forwards to the data VM."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Environment, EnvironmentService, ManagedRecord
from sirdar_api.deploy import (
    apps as app_rules,
    do_envs,
    envfile,
    home,
    integrations,
    lan_slots,
    npm,
    outbound,
    smoke,
    switchyard,
    targets,
    vms,
)
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError, DnsRecord
from sirdar_api.deploy.environments import services_of
from sirdar_api.deploy.integrations import (
    CloudflareConfig,
    IntegrationError,
    NpmConfig,
    SwitchyardConfig,
)
from sirdar_api.deploy.npm import (
    CERT_BACKOFF,
    RENEW_DAYS,
    Certificate,
    Npm,
    NpmError,
    ProxyHost,
    covers,
    days_left,
)
from sirdar_api.deploy.switchyard import Switchyard, SwitchyardError

Output = Callable[[str], None]
DNS, PROXY, CERT = "dns_record", "proxy_host", "certificate"
# A Switchyard host (migration 0018). Switchyard has no certificate rows:
# Caddy gets and renews them itself, and Sirdar only waits for them.
SY_HOST = "switchyard_host"
KIND_INTEGRATION = {DNS: "cloudflare", PROXY: "npm", CERT: "npm", SY_HOST: "switchyard"}
PROXY_LABEL = {"npm": "Nginx Proxy Manager", "switchyard": "Switchyard"}
# What each proxy's managed rows are.
PROXY_KINDS = {"npm": (PROXY, CERT), "switchyard": (SY_HOST,)}


def proxy_of(env: Environment) -> str | None:
    """The proxy the environment publishes through: None on DigitalOcean
    (its load balancer), else Environment.proxy ("npm" when NULL: what
    every LAN environment made before migration 0018 used)."""
    if env.target_id == targets.DO_TARGET:
        return None
    return env.proxy or "npm"


class PublishError(Exception):
    """The publish context can't be built. `reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ServicePlan:
    service: str
    hostname: str
    host_ip: str
    port: int
    proxied: bool

    @property
    def forward(self) -> str:
        return f"{self.host_ip}:{self.port}"


SPACES_ADVANCED = "client_max_body_size 0;"


def advanced_config(sp: ServicePlan) -> str:
    """The NPM advanced config Sirdar writes for a service: uploads without a
    size cap for spaces, the redirect to the portal for the bare name."""
    if sp.service == "spaces":
        return SPACES_ADVANCED
    if sp.service == home.HOME:
        return home.nginx_redirect(sp.hostname)
    return ""


NO_LB_YET = ("No load balancer yet: step 0 (Prepare DigitalOcean) makes it, and the records "
             "point at its address.")


@dataclass(frozen=True)
class PublishContext:
    env_id: uuid.UUID
    env_name: str
    proxy_ip: str
    services: tuple[ServicePlan, ...]
    cloud: bool = False             # DigitalOcean: DNS at the load balancer, no NPM
    slot: str | None = None         # LAN Blue/Green: the slot a Switch traffic moves to
    proxy: str | None = "npm"       # "switchyard" | "npm" | None (DigitalOcean)
    cloudflare: CloudflareConfig | None = field(default=None, repr=False)
    npm: NpmConfig | None = field(default=None, repr=False)
    switchyard: SwitchyardConfig | None = field(default=None, repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [v for v in (self.cloudflare.token if self.cloudflare else None,
                            self.npm.password if self.npm else None,
                            self.switchyard.api_key if self.switchyard else None) if v]

    @property
    def proxy_label(self) -> str:
        return PROXY_LABEL.get(self.proxy or "npm", "the proxy")


@dataclass(frozen=True)
class Status:
    state: str              # ok | update | create | claimable | conflict
    detail: str
    current: object = field(default=None, compare=False)    # DnsRecord / ProxyHost / Certificate


# ---- context -------------------------------------------------------------------

async def service_plans(db: AsyncSession, env: Environment) -> tuple[ServicePlan, ...]:
    """The public services (those with a hostname, of an app that runs), in
    envfile order: DNS records, proxy hosts, certificates and the smoke test."""
    rows = await services_of(db, env.id)
    return tuple(ServicePlan(r.service, r.hostname, r.host_ip, r.port, r.proxied)
                 for r in rows if r.hostname and app_rules.is_public(env, r.service))


async def _load_proxy(db: AsyncSession, settings: Settings, kind: str, *, needed: bool):
    """The proxy's config. The environment's own proxy must load; the other
    one only matters for removing what Sirdar made there earlier, so one that
    can't be read is left out."""
    try:
        return await integrations.load(db, settings, kind)
    except IntegrationError:
        if needed:
            raise
        return None


async def prepare(db: AsyncSession, env: Environment, settings: Settings) -> PublishContext:
    cloud = env.target_id == targets.DO_TARGET
    proxy = proxy_of(env)
    try:
        cf = await integrations.load_cloudflare(db, settings)
        npm_cfg = sy_cfg = None
        if not cloud:
            npm_cfg = await _load_proxy(db, settings, "npm", needed=proxy == "npm")
            sy_cfg = await _load_proxy(db, settings, "switchyard", needed=proxy == "switchyard")
    except IntegrationError as e:
        raise PublishError(e.reason) from None
    return PublishContext(env_id=env.id, env_name=env.name, proxy_ip=env.proxy_ip,
                          services=await service_plans(db, env), cloud=cloud, proxy=proxy,
                          cloudflare=cf, npm=npm_cfg, switchyard=sy_cfg)


# ---- managed rows ----------------------------------------------------------------

async def rows_of(db: AsyncSession, env_id) -> dict[tuple[str, str], ManagedRecord]:
    rows = await db.scalars(select(ManagedRecord).where(ManagedRecord.environment_id == env_id)
                            .execution_options(populate_existing=True))
    return {(r.service, r.kind): r for r in rows}


async def owners_of(db: AsyncSession, env_id, kind: str) -> dict[str, str]:
    """External id -> name of the other environment that manages it."""
    rows = await db.execute(
        select(ManagedRecord.external_id, Environment.name)
        .join(Environment, Environment.id == ManagedRecord.environment_id)
        .where(ManagedRecord.kind == kind, ManagedRecord.environment_id != env_id))
    return {external_id: name for external_id, name in rows}


def current_row(rows: dict, sp: ServicePlan, kind: str) -> ManagedRecord | None:
    """The managed row for this service and kind, if it serves the wanted name."""
    found = rows.get((sp.service, kind))
    return found if found is not None and found.name == sp.hostname else None


def stale_holder(rows: dict, sp: ServicePlan, kind: str) -> ManagedRecord | None:
    """This service's row of this kind when it is under another name (the
    base domain changed): it holds the (service, kind) place a claim needs."""
    found = rows.get((sp.service, kind))
    return found if found is not None and found.name != sp.hostname else None


def _waits_for_stale(status: Status, rows: dict, sp: ServicePlan, kind: str) -> Status:
    """A claimable entry whose place is held by something Sirdar created
    under an old name can't be claimed yet: publishing removes the old one
    first (the steps drop stale rows before planning)."""
    old = stale_holder(rows, sp, kind)
    if status.state != "claimable" or old is None or old.origin != "created":
        return status
    noun = {DNS: "record", SY_HOST: "Switchyard host"}.get(kind, "proxy host")
    return Status("conflict", f"{status.detail} Publishing first removes Sirdar's old {noun} "
                              f"at {old.name}; then claim this one.", status.current)


def stale_rows(rows: dict, services) -> list[ManagedRecord]:
    """Managed rows for a service that is no longer public, or under a name
    the environment no longer uses (its base domain changed)."""
    wanted = {s.service: s.hostname for s in services}
    return [r for r in rows.values() if wanted.get(r.service) != r.name]


async def missing_integrations(db: AsyncSession, env: Environment, *,
                               teardown: bool = False) -> list[str]:
    """Integrations a publish (Cloudflare and the environment's proxy) or a
    teardown (those whose created entries it must delete) needs but which
    aren't configured. A DigitalOcean environment uses no proxy."""
    if teardown:
        rows = await rows_of(db, env.id)
        wanted = {KIND_INTEGRATION[r.kind] for r in rows.values() if r.origin == "created"}
    else:
        wanted = {"cloudflare", proxy_of(env)} - {None}
    return sorted([k for k in wanted if not await integrations.is_configured(db, k)])


# ---- status ----------------------------------------------------------------------

def in_zone(hostname: str, zone: str) -> bool:
    return hostname == zone or hostname.endswith("." + zone)


# Record types that block an A record at the same name: CNAME and NS can't
# share it, and a foreign AAAA would send IPv6 clients elsewhere, out of the
# smoke test's sight. Everything else (TXT for SPF/DKIM, MX, CAA, SRV, ...)
# sits beside it and is ignored.
BLOCKS_AN_A = ("CNAME", "NS", "AAAA")


def _unmanaged_dns(sp: ServicePlan, records: list[DnsRecord], owners: dict[str, str], *,
                   public_ip: str) -> Status:
    """The name as seen without a managed record of this environment."""
    here = [r for r in records if r.name == sp.hostname]
    blocking = [r for r in here if r.type in BLOCKS_AN_A]
    if blocking:
        return Status("conflict", f"A {blocking[0].type} record already uses this name.")
    a_records = [r for r in here if r.type == "A"]
    if len(a_records) > 1:
        return Status("conflict", "More than one A record uses this name.")
    if a_records:
        found = a_records[0]
        if found.id in owners:
            return Status("conflict", f"The environment {owners[found.id]} manages this record.")
        return Status("claimable", f"A {found.content}, made outside Sirdar.", found)
    parent = sp.hostname.split(".", 1)[1]
    wildcard = f"*.{parent}"
    # A name that already has records of its own isn't answered by the wildcard.
    # The bare name's A only shadows a wildcard for that one name (the
    # wildcard itself is never touched), so home is never blocked by one.
    if (sp.service != home.HOME and not here
            and any(r.name == wildcard for r in records)):
        return Status("conflict", f"The wildcard {wildcard} covers this name; a record here "
                                  "would override it.")
    return Status("create", f"Sirdar will create A {public_ip}.")


def dns_status(sp: ServicePlan, records: list[DnsRecord], row: ManagedRecord | None,
               owners: dict[str, str], *, zone: str, public_ip: str) -> Status:
    if not in_zone(sp.hostname, zone):
        return Status("conflict", f"{sp.hostname} isn't in the Cloudflare zone {zone}.")
    if row is not None:
        mine = next((r for r in records if r.id == row.external_id), None)
        if mine is not None and mine.name != sp.hostname:
            return Status("conflict", f"Sirdar's record {mine.id} is now named {mine.name}; "
                                      "fix it in Cloudflare or remove it.", mine)
        if mine is not None:
            if mine.type == "A" and mine.content == public_ip:
                if mine.proxied == sp.proxied:
                    return Status("ok", f"A {public_ip}", mine)
                return Status("update",
                              f"Cloudflare's proxy is {'on' if mine.proxied else 'off'}; "
                              f"Sirdar will turn it {'on' if sp.proxied else 'off'}.", mine)
            return Status("update", f"A {mine.content}; Sirdar will point it at {public_ip}.",
                          mine)
    status = _unmanaged_dns(sp, records, owners, public_ip=public_ip)
    if row is None:
        return status
    # Sirdar's record is gone: recreate it only where nothing else holds the name.
    if status.state == "create":
        return Status("create", "The record Sirdar claimed is gone; it will be created again."
                      if row.origin == "claimed"
                      else "Sirdar's record is gone; it will be created again.")
    if status.state == "claimable":
        return Status("conflict",
                      "Sirdar's record is gone and another A record now uses this name.")
    return status


def _forward_drift(host: ProxyHost, sp: ServicePlan) -> list[str]:
    checks = [("the scheme", host.forward_scheme, "http"),
              ("the forward host", host.forward_host, sp.host_ip),
              ("the forward port", host.forward_port, sp.port),
              ("WebSockets", host.allow_websocket_upgrade, True)]
    if sp.service == home.HOME:
        # only the bare name's advanced config is Sirdar's; others keep theirs
        checks.append(("the redirect", host.raw.get("advanced_config") or "",
                       advanced_config(sp)))
    return [name for name, have, want in checks if have != want]


def _and(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _unmanaged_proxy(sp: ServicePlan, hosts: list[ProxyHost],
                     owners: dict[str, str]) -> Status:
    """The name as seen without a managed proxy host of this environment."""
    named = [h for h in hosts if sp.hostname in h.domain_names]
    if len(named) > 1:
        return Status("conflict", "More than one proxy host serves this name.")
    if named:
        found = named[0]
        if str(found.id) in owners:
            return Status("conflict",
                          f"The environment {owners[str(found.id)]} manages this proxy host.")
        extra = [d for d in found.domain_names if d != sp.hostname]
        if extra:
            return Status("conflict", f"This proxy host also serves {', '.join(extra)}.")
        return Status("claimable",
                      f"To {found.forward_host}:{found.forward_port}, made outside Sirdar.", found)
    return Status("create", f"Sirdar will create a proxy host to {sp.forward}.")


def proxy_status(sp: ServicePlan, hosts: list[ProxyHost], row: ManagedRecord | None,
                 owners: dict[str, str]) -> Status:
    if row is not None:
        mine = next((h for h in hosts if str(h.id) == row.external_id), None)
        if mine is not None and sp.hostname not in mine.domain_names:
            return Status("conflict", f"Sirdar's proxy host #{mine.id} no longer serves "
                                      f"{sp.hostname}; fix it in NPM or remove it.", mine)
        if mine is not None:
            drift = _forward_drift(mine, sp)
            if not drift:
                return Status("ok", f"To {sp.forward}", mine)
            return Status("update", f"Sirdar will change {_and(drift)}.", mine)
    status = _unmanaged_proxy(sp, hosts, owners)
    if row is None:
        return status
    # Sirdar's proxy host is gone: recreate it only where no other host serves the name.
    if status.state == "create":
        return Status("create", "The proxy host Sirdar claimed is gone; it will be created "
                                "again." if row.origin == "claimed"
                      else "Sirdar's proxy host is gone; it will be created again.")
    if status.state == "claimable":
        return Status("conflict", "Sirdar's proxy host is gone and another proxy host now "
                                  "serves this name.")
    return status


def _date(cert: Certificate) -> str:
    return cert.expires_on.strftime("%Y-%m-%d") if cert.expires_on else "an unknown date"


def usable_certificate(certs: list[Certificate], hostname: str,
                       now: datetime) -> Certificate | None:
    """A certificate covering the name with more than RENEW_DAYS left (or no
    expiry date): one naming it exactly first, then the latest to expire."""
    fresh = [c for c in certs if covers(c, hostname)
             and ((left := days_left(c, now)) is None or left > RENEW_DAYS)]
    fresh.sort(key=lambda c: (hostname not in c.domain_names,
                              -(c.expires_on.timestamp() if c.expires_on else float("inf"))))
    return fresh[0] if fresh else None


def cert_status(host: ProxyHost | None, certs: list[Certificate], hostname: str,
                now: datetime) -> Status:
    current = None
    if host is not None and host.certificate_id:
        current = next((c for c in certs if c.id == host.certificate_id), None)
    if current is not None and covers(current, hostname):
        left = days_left(current, now)
        if left is None or left > RENEW_DAYS:
            if not host.ssl_forced:
                return Status("update", "Force SSL is off; Sirdar will turn it on.", current)
            if current.expires_on is None:
                return Status("ok", "In place; no expiry date.", current)
            return Status("ok", f"Valid until {_date(current)}.", current)
        if current.provider == "letsencrypt":
            return Status("update", f"Expires {_date(current)}; Sirdar will renew it.", current)
    other = usable_certificate(certs, hostname, now)
    if other is not None:
        return Status("update",
                      f"Sirdar will use certificate #{other.id} (valid until {_date(other)}).",
                      other)
    return Status("create", "Sirdar will request a Let's Encrypt certificate.")


# Switchyard hosts

SY_MARKER = "Managed by Sirdar: "


def sy_notes(env_name: str, env_id) -> str:
    """The notes of a Switchyard host Sirdar creates: also the mark that it
    is Sirdar's, and whose."""
    return f"{SY_MARKER}{env_name} ({env_id})"


def sy_owner(host: switchyard.Host) -> tuple[str, str] | None:
    """(environment name, id) from Sirdar's notes on a host, else None."""
    notes = host.notes.strip()
    if not notes.startswith(SY_MARKER) or not notes.endswith(")") or " (" not in notes:
        return None
    name, _, rest = notes.removeprefix(SY_MARKER).rpartition(" (")
    return name, rest[:-1]


def _sy_upstreams(sp: ServicePlan) -> tuple[switchyard.Upstream, ...]:
    return (switchyard.Upstream("http", sp.host_ip, sp.port),)


def _sy_redirect(sp: ServicePlan) -> tuple[str, int, bool]:
    """The bare name: a 302 to the portal, path and query kept (home.py)."""
    return home.redirect_target(sp.hostname), 302, True


def sy_fields(sp: ServicePlan) -> dict:
    """Sirdar's fields on a Switchyard host: a proxy to the service, or for
    the bare name a redirect to the portal; HTTPS from Caddy, HSTS off as on
    Sirdar's NPM hosts. The spaces service needs no body-size setting:
    Caddy has no cap."""
    fields = {"enabled": True, "domains": [sp.hostname], "tls_mode": "auto",
              "force_https": True}
    if sp.service == home.HOME:
        to, code, keep = _sy_redirect(sp)
        return {**fields, "type": "redirect", "upstreams": [], "redirect_to": to,
                "redirect_code": code, "preserve_path": keep}
    return {**fields, "type": "proxy",
            "upstreams": [{"scheme": "http", "host": sp.host_ip, "port": sp.port}]}


def new_sy_body(ctx: PublishContext, sp: ServicePlan) -> dict:
    return {**sy_fields(sp), "hsts": False, "notes": sy_notes(ctx.env_name, ctx.env_id)}


def sy_host_body(host: switchyard.Host, sp: ServicePlan) -> dict:
    """PUT replaces the whole host: everything it has, Sirdar's fields on
    top. A redirect host's upstreams are left as they are, and so are a
    proxy host's redirect fields."""
    body = dict(host.raw)
    fields = sy_fields(sp)
    if fields["type"] == "redirect":
        fields.pop("upstreams")
    return {**body, **fields}


def _sy_target(sp: ServicePlan) -> str:
    return (f"redirect to {home.redirect_target(sp.hostname)}" if sp.service == home.HOME
            else sp.forward)


def _sy_drift(host: switchyard.Host, sp: ServicePlan) -> list[str]:
    want = "redirect" if sp.service == home.HOME else "proxy"
    checks = [("the type", host.type, want)]
    if want == "proxy":
        checks.append(("the upstream", host.upstreams, _sy_upstreams(sp)))
    else:
        checks.append(("the redirect", (host.redirect_to, host.redirect_code,
                                        host.preserve_path), _sy_redirect(sp)))
    checks += [("HTTPS", (host.tls_mode, host.force_https), ("auto", True)),
               ("the enabled switch", host.enabled, True)]
    return [name for name, have, want in checks if have != want]


def _sy_found(host: switchyard.Host) -> str:
    if host.type == "redirect":
        return f"Redirects to {host.redirect_to}"
    if host.upstreams:
        return f"To {host.upstreams[0].host}:{host.upstreams[0].port}"
    return f"A {host.type} host"


def _unmanaged_sy(sp: ServicePlan, hosts: list[switchyard.Host], owners: dict[str, str],
                  env_id) -> Status:
    """The name as seen without a managed Switchyard host of this environment."""
    named = [h for h in hosts if sp.hostname in h.domains]
    if len(named) > 1:
        return Status("conflict", "More than one Switchyard host serves this name.")
    if named:
        found = named[0]
        if str(found.id) in owners:
            return Status("conflict",
                          f"The environment {owners[str(found.id)]} manages this Switchyard host.")
        owner = sy_owner(found)
        if owner is not None and owner[1] != str(env_id):
            return Status("conflict",
                          f"The environment {owner[0]} manages this Switchyard host.")
        extra = [d for d in found.domains if d != sp.hostname]
        if extra:
            return Status("conflict", f"This Switchyard host also serves {', '.join(extra)}.")
        if owner is not None:
            # Sirdar made it for this environment but has no row for it (the
            # create's answer was lost): it is taken back as created.
            return Status("update", "Sirdar made this host for this environment; it will "
                                    "manage it again.", found)
        return Status("claimable", f"{_sy_found(found)}, made outside Sirdar.", found)
    if sp.service == home.HOME:
        return Status("create", f"Sirdar will create a Switchyard redirect to "
                                f"{home.redirect_target(sp.hostname)}.")
    return Status("create", f"Sirdar will create a Switchyard host to {sp.forward}.")


def sy_status(sp: ServicePlan, hosts: list[switchyard.Host], row: ManagedRecord | None,
              owners: dict[str, str], env_id) -> Status:
    if row is not None:
        mine = next((h for h in hosts if str(h.id) == row.external_id), None)
        if mine is not None and sp.hostname not in mine.domains:
            return Status("conflict", f"Sirdar's Switchyard host #{mine.id} no longer serves "
                                      f"{sp.hostname}; fix it in Switchyard or remove it.", mine)
        if mine is not None:
            drift = _sy_drift(mine, sp)
            if not drift:
                return Status("ok", "Redirects to the portal" if sp.service == home.HOME
                              else f"To {sp.forward}", mine)
            return Status("update", f"Sirdar will change {_and(drift)}.", mine)
    status = _unmanaged_sy(sp, hosts, owners, env_id)
    if row is None:
        return status
    if status.state == "create":
        return Status("create", "The Switchyard host Sirdar claimed is gone; it will be "
                                "created again." if row.origin == "claimed"
                      else "Sirdar's Switchyard host is gone; it will be created again.")
    if status.state == "claimable":
        return Status("conflict", "Sirdar's Switchyard host is gone and another host now "
                                  "serves this name.")
    return status


def sy_cert_status(certs: dict[str, switchyard.CertState], hostname: str) -> Status:
    """Caddy's certificate for the name, as Switchyard lists it."""
    found = certs.get(hostname)
    if found is not None and found.ready:
        return Status("ok", "Caddy has a certificate." if found.state == "valid"
                      else "Caddy has a certificate and will renew it soon.")
    if found is not None and found.error:
        return Status("create", "Caddy couldn't get one yet; Sirdar will ask it to try again.")
    return Status("create", "Caddy will get one once the host is applied.")


# ---- the Publish tab ---------------------------------------------------------------

def _entry(status: Status | None, row: ManagedRecord | None, id_key: str) -> dict:
    if status is None:
        return {"state": "unknown", "detail": "", "origin": None, id_key: None}
    found = status.current
    return {"state": status.state, "detail": status.detail,
            "origin": row.origin if row is not None else None,
            id_key: found.id if found is not None else None}


def _cert_entry(status: Status | None) -> dict:
    if status is None:
        return {"state": "unknown", "detail": "", "expires_on": None}
    found = status.current
    return {"state": status.state, "detail": status.detail,
            "expires_on": found.expires_on if found is not None else None}


async def inspect(db: AsyncSession, env: Environment, settings: Settings) -> dict:
    """What publishing this environment would do now, per service. Reads
    Cloudflare and the environment's proxy (Switchyard or NPM), changes
    nothing. A section whose integration isn't configured or can't be read
    reports "unknown" and says why. A DigitalOcean environment's records
    point at its load balancer, and it has no proxy section to read."""
    transports = outbound.transports()
    cloud = env.target_id == targets.DO_TARGET
    proxy = proxy_of(env)
    lb = None
    if cloud:
        do_row = await do_envs.get(db, env.id)
        lb = do_row.lb_ip if do_row is not None else None
    services = await service_plans(db, env)
    rows = await rows_of(db, env.id)
    now = datetime.now(UTC)
    out: dict = {"publish": env.publish, "proxy_ip": env.proxy_ip,
                 "cloudflare": {"configured": False, "zone": None, "public_ip": None,
                                "error": None},
                 "proxy": {"kind": proxy, "configured": False, "url": None, "error": None}}
    dns: dict[str, Status] = {}
    proxies: dict[str, Status] = {}
    certs: dict[str, Status] = {}

    try:
        cf = await integrations.load_cloudflare(db, settings)
    except IntegrationError as e:
        cf, out["cloudflare"]["error"] = None, e.reason
    if cf is not None and cloud and lb is None:
        # Before step 0 there is no address to point the records at.
        out["cloudflare"].update(configured=True, zone=cf.zone, public_ip=None)
        dns = {s.service: Status("unknown", NO_LB_YET) for s in services}
    elif cf is not None:
        out["cloudflare"].update(configured=True, zone=cf.zone, public_ip=lb or cf.public_ip)
        try:
            async with Cloudflare(cf, transport=transports["cloudflare"]) as api:
                records = await api.records()
        except CloudflareError as e:
            out["cloudflare"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, DNS)
            dns = {s.service: _waits_for_stale(
                       dns_status(s, records, current_row(rows, s, DNS), owners,
                                  zone=cf.zone, public_ip=lb or cf.public_ip), rows, s, DNS)
                   for s in services}

    proxy_cfg = None
    if proxy is not None:
        try:
            proxy_cfg = await integrations.load(db, settings, proxy)
        except IntegrationError as e:
            out["proxy"]["error"] = e.reason
    if proxy_cfg is not None:
        out["proxy"].update(configured=True, url=proxy_cfg.url)
    if proxy_cfg is not None and proxy == "switchyard":
        try:
            async with Switchyard(proxy_cfg, transport=transports["switchyard"]) as api:
                sy_hosts = await api.hosts()
                sy_certs = {c.domain: c for c in await api.certificates()}
        except SwitchyardError as e:
            out["proxy"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, SY_HOST)
            for s in services:
                status = _waits_for_stale(
                    sy_status(s, sy_hosts, current_row(rows, s, SY_HOST), owners, env.id),
                    rows, s, SY_HOST)
                proxies[s.service] = status
                certs[s.service] = (sy_cert_status(sy_certs, s.hostname)
                                    if status.state in ("ok", "update", "create")
                                    else Status("unknown", "Waits for the proxy host."))
    elif proxy_cfg is not None:
        try:
            async with Npm(proxy_cfg, transport=transports["npm"]) as api:
                hosts = await api.proxy_hosts()
                all_certs = await api.certificates()
        except NpmError as e:
            out["proxy"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, PROXY)
            for s in services:
                status = _waits_for_stale(
                    proxy_status(s, hosts, current_row(rows, s, PROXY), owners), rows, s, PROXY)
                proxies[s.service] = status
                # Only a host Sirdar manages (or will create) has its certificate judged.
                certs[s.service] = (
                    cert_status(status.current, all_certs, s.hostname, now)
                    if status.state in ("ok", "update", "create")
                    else Status("unknown", "Waits for the proxy host."))

    host_kind = SY_HOST if proxy == "switchyard" else PROXY
    out["services"] = [{
        "service": s.service, "hostname": s.hostname, "forward": s.forward,
        "dns": _entry(dns.get(s.service), current_row(rows, s, DNS), "record_id"),
        "proxy": _entry(proxies.get(s.service), current_row(rows, s, host_kind), "host_id"),
        "certificate": _cert_entry(certs.get(s.service)),
    } for s in services]
    out["stale"] = [{"service": r.service, "kind": r.kind, "name": r.name, "origin": r.origin}
                    for r in stale_rows(rows, services)]
    return out


async def claim(db: AsyncSession, env: Environment, state: dict) -> list[str]:
    """Record every claimable DNS record and proxy host in `state` (from
    inspect) as claimed: an NPM proxy host or a Switchyard host, by the
    environment's proxy. Certificates are never claimed. Writes only
    Sirdar's database; the caller audits and commits."""
    rows = await rows_of(db, env.id)
    claimed: list[str] = []
    host_kind = SY_HOST if proxy_of(env) == "switchyard" else PROXY
    for svc in state["services"]:
        for key, kind, id_key in (("dns", DNS, "record_id"), ("proxy", host_kind, "host_id")):
            entry = svc[key]
            if entry["state"] != "claimable":
                continue
            old = rows.get((svc["service"], kind))
            if old is not None:
                if old.origin != "claimed" or old.name == svc["hostname"]:
                    continue        # a created entry under an old name goes by publishing first
                # A claimed entry under an old name: forgotten, left in place.
                await db.delete(old)
                await db.flush()
            db.add(ManagedRecord(environment_id=env.id, service=svc["service"], kind=kind,
                                 external_id=str(entry[id_key]), name=svc["hostname"],
                                 origin="claimed"))
            claimed.append(f"{key}:{svc['hostname']}")
    await db.flush()
    return claimed


# ---- steps 12–14 and 16–17 -------------------------------------------------------------


class StepFailed(Exception):
    """A publish step can't finish. `reason` (our own copy) ends its log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Publisher(Protocol):
    async def run(self, step: str, ctx: PublishContext, out: Output) -> None: ...


def _need_to_publish(cfg, label: str):
    if cfg is None:
        raise StepFailed(f"{label} isn't set up. Add it in Settings › Integrations, or turn "
                         "Publish off for this environment.")
    return cfg


def _need_to_remove(cfg, label: str):
    if cfg is None:
        raise StepFailed(f"{label} isn't set up, so Sirdar can't remove what it made there. "
                         "Add it in Settings › Integrations, then retry.")
    return cfg


def _stop_on_blockers(plan: list[tuple[ServicePlan, Status]], what: str) -> None:
    """Plan first: one blocker anywhere and nothing is changed."""
    bad = [(s, st) for s, st in plan if st.state in ("claimable", "conflict")]
    if not bad:
        return
    lines = "\n".join(f"  {s.hostname}: {st.detail}" for s, st in bad)
    hint = ("Claim the existing ones on the Publish tab, or remove them by hand, then retry."
            if any(st.state == "claimable" for _, st in bad) else "Fix them by hand, then retry.")
    raise StepFailed(f"Sirdar changed nothing: these {what} are in the way.\n{lines}\n{hint}")


async def _rows_and_owners(env_id, kind: str) -> tuple[dict, dict]:
    async with get_sessionmaker()() as s:
        return await rows_of(s, env_id), await owners_of(s, env_id, kind)


async def _all_rows(env_id, kinds: tuple[str, ...]) -> list[ManagedRecord]:
    async with get_sessionmaker()() as s:
        return [r for r in (await rows_of(s, env_id)).values() if r.kind in kinds]


async def _remember(env_id, service: str, kind: str, external_id, name: str) -> None:
    """Record something Sirdar just created, at once and on its own, so a
    later failure in the same step still knows it is Sirdar's."""
    async with get_sessionmaker()() as s:
        await s.execute(delete(ManagedRecord).where(
            ManagedRecord.environment_id == env_id, ManagedRecord.service == service,
            ManagedRecord.kind == kind))
        s.add(ManagedRecord(environment_id=env_id, service=service, kind=kind,
                            external_id=str(external_id), name=name, origin="created"))
        await s.commit()


async def _forget(row_id) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(delete(ManagedRecord).where(ManagedRecord.id == row_id))
        await s.commit()


# Before deleting by id, the live object must still be what Sirdar made: ids
# can be reused (NPM's are small integers and restart when NPM is rebuilt),
# and an entry can be repurposed by hand. One that no longer matches is only
# forgotten.

SIRDAR_COMMENT = "Managed by Sirdar"


def _left_in_place(row: ManagedRecord, what: str, external_id) -> str:
    return (f"{row.name}: {what} #{external_id} left in place: it no longer matches what "
            "Sirdar made.\n")


def still_sirdars_record(found: DnsRecord, name: str) -> bool:
    """An A record at the name; a comment, when it has one, still Sirdar's."""
    return (found.type == "A" and found.name == name
            and (not found.comment or found.comment.startswith(SIRDAR_COMMENT)))


def still_sirdars_host(found: ProxyHost, name: str) -> bool:
    return found.domain_names == (name.lower(),)


def still_sirdars_certificate(found: Certificate, name: str) -> bool:
    """Sirdar only requests Let's Encrypt certificates for exactly one name
    (domain_names are lower-cased when read)."""
    return found.provider == "letsencrypt" and found.domain_names == (name.lower(),)


# DNS

async def _drop_dns(api: Cloudflare | None, row: ManagedRecord, out: Output,
                    records: list[DnsRecord] | None) -> bool:
    """Delete a created record (when it still matches) and forget the row.
    `records` is the zone as read in this step. True when the record is
    gone; False when it stays (claimed, or no longer Sirdar's)."""
    gone = False
    if row.origin == "created":
        found = next((r for r in records if r.id == row.external_id), None)
        if found is None:
            out(f"{row.name}: already gone\n")
            gone = True
        elif not still_sirdars_record(found, row.name):
            out(_left_in_place(row, "DNS record", row.external_id))
        else:
            deleted = await api.delete(row.external_id)
            out(f"{row.name}: {'deleted the A record' if deleted else 'already gone'}\n")
            gone = True
    else:
        out(f"{row.name}: left in place (claimed, not made by Sirdar)\n")
    await _forget(row.id)
    return gone


async def ensure_dns(ctx: PublishContext, out: Output, *, transport,
                     target: str | None = None) -> None:
    """A records at `target` (DigitalOcean: the load balancer), else at
    Cloudflare's configured public IP."""
    cfg = _need_to_publish(ctx.cloudflare, "Cloudflare")
    public_ip = target or cfg.public_ip
    rows, owners = await _rows_and_owners(ctx.env_id, DNS)
    async with Cloudflare(cfg, transport=transport) as api:
        records = await api.records()
        # Names the environment no longer uses go first (only what Sirdar
        # created is deleted), so they don't hold a place a claim needs.
        dns_rows = {k: r for k, r in rows.items() if k[1] == DNS}
        dropped = set()
        for row in stale_rows(dns_rows, ctx.services):
            if await _drop_dns(api, row, out, records):
                records = [r for r in records if r.id != row.external_id]
            dropped.add((row.service, row.kind))
        rows = {k: r for k, r in rows.items() if k not in dropped}
        plan = [(s, dns_status(s, records, current_row(rows, s, DNS), owners, zone=cfg.zone,
                               public_ip=public_ip)) for s in ctx.services]
        _stop_on_blockers(plan, "DNS records")
        for s, st in plan:
            if st.state == "ok":
                out(f"{s.hostname}: A {public_ip}, unchanged\n")
            elif st.state == "update":
                await api.update_a(st.current.id, name=s.hostname, content=public_ip,
                                   proxied=s.proxied)
                out(f"{s.hostname}: updated to A {public_ip}\n")
            else:
                made = await api.create_a(s.hostname, public_ip, proxied=s.proxied,
                                          comment=f"Managed by Sirdar ({ctx.env_name}/{s.service})")
                await _remember(ctx.env_id, s.service, DNS, made.id, s.hostname)
                out(f"{s.hostname}: created A {public_ip}\n")


async def _check_removable(ctx: PublishContext) -> None:
    """Step 17, read fresh as step 18 does: a production environment's
    records go only once it is retiring and serves no slot (an un-retire
    after the Delete started keeps them). Before any record is touched."""
    async with get_sessionmaker()() as s:
        env = await s.get(Environment, ctx.env_id)
    if env is not None and env.type == "production" and (not env.retiring or env.active_slot):
        raise StepFailed("This production environment is still live (not retiring, or still "
                         "serving a slot). Sirdar removes production's DNS records only once "
                         "it is retiring and serves no slot. Sirdar changed nothing.")


async def remove_dns(ctx: PublishContext, out: Output, *, transport) -> None:
    rows = sorted(await _all_rows(ctx.env_id, (DNS,)), key=lambda r: r.name)
    if not rows:
        out("No DNS records to remove.\n")
        return
    if not any(r.origin == "created" for r in rows):
        for row in rows:
            await _drop_dns(None, row, out, None)
        return
    cfg = _need_to_remove(ctx.cloudflare, "Cloudflare")
    async with Cloudflare(cfg, transport=transport) as api:
        records = await api.records()
        for row in rows:
            await _drop_dns(api, row, out, records)


# Proxy hosts and certificates

def new_host_body(sp: ServicePlan) -> dict:
    return {"domain_names": [sp.hostname], "forward_scheme": "http",
            "forward_host": sp.host_ip, "forward_port": sp.port, "certificate_id": 0,
            "ssl_forced": False, "hsts_enabled": False, "hsts_subdomains": False,
            "http2_support": False, "block_exploits": True, "caching_enabled": False,
            "allow_websocket_upgrade": True, "access_list_id": 0,
            "advanced_config": advanced_config(sp),
            "meta": {"letsencrypt_agree": False, "dns_challenge": False}, "locations": []}


def host_body(host: ProxyHost, sp: ServicePlan, *, certificate_id: int | None = None) -> dict:
    """Read-modify-write: everything the host has (access lists, advanced
    config, ...) with Sirdar's fields on top. The bare name's advanced config
    is Sirdar's (the redirect) and is rewritten."""
    body = {k: host.raw[k] for k in npm.HOST_FIELDS if k in host.raw}
    body["locations"] = body.get("locations") or []
    body.update(forward_scheme="http", forward_host=sp.host_ip, forward_port=sp.port,
                allow_websocket_upgrade=True)
    if sp.service == home.HOME:
        body["advanced_config"] = advanced_config(sp)
    if certificate_id is not None:
        body.update(certificate_id=certificate_id, ssl_forced=True, http2_support=True)
    return body


async def _host_using(api: Npm, cert_id: int) -> int | None:
    """A proxy host that still uses the certificate (read live, so hosts
    deleted earlier in this run are gone from the list)."""
    return next((h.id for h in await api.proxy_hosts() if h.certificate_id == cert_id), None)


def _in_use(name: str, cert_id, host_id: int) -> str:
    return f"{name}: Certificate #{cert_id} left in place: proxy host #{host_id} still uses it.\n"


async def _drop_npm(api: Npm | None, row: ManagedRecord, out: Output) -> bool:
    """Delete what Sirdar created and forget the row. The live host or
    certificate is read first: one that no longer matches what Sirdar made
    is only forgotten. So is a certificate a host that stays (e.g. a claimed
    one) still uses: deleting it would leave NPM pointing at missing files.
    True when the entry is gone; False when it stays."""
    what = "proxy host" if row.kind == PROXY else "certificate"
    if row.origin != "created":
        out(f"{row.name}: left the {what} in place (claimed, not made by Sirdar)\n")
        await _forget(row.id)
        return False
    ext = int(row.external_id)
    if row.kind == PROXY:
        found = next((h for h in await api.proxy_hosts() if h.id == ext), None)
        matches = found is not None and still_sirdars_host(found, row.name)
    else:
        found = next((c for c in await api.certificates() if c.id == ext), None)
        matches = found is not None and still_sirdars_certificate(found, row.name)
    gone = True
    if found is None:
        out(f"{row.name}: already gone: {what} #{ext}\n")
    elif not matches:
        out(_left_in_place(row, what.capitalize(), ext))
        gone = False
    elif row.kind == CERT and (user := await _host_using(api, ext)) is not None:
        out(_in_use(row.name, ext, user))
        gone = False
    else:
        deleted = (await api.delete_host(ext) if row.kind == PROXY
                   else await api.delete_certificate(ext))
        out(f"{row.name}: {'deleted the' if deleted else 'already gone:'} {what} #{ext}\n")
    await _forget(row.id)
    return gone


async def _issued_anyway(api: Npm, hostname: str,
                         certs: list[Certificate]) -> Certificate | None:
    """After a timed-out request (npm.py): NPM may still have issued it. The
    one new Let's Encrypt certificate for exactly this name, absent from the
    list read at the start of the step, is the answer to Sirdar's request."""
    known = {c.id for c in certs}
    new = [c for c in await api.certificates() if c.id not in known
           and c.provider == "letsencrypt" and c.domain_names == (hostname,)
           and c.expires_on is not None]
    return new[0] if len(new) == 1 else None


async def _ensure_certificate(api: Npm, ctx: PublishContext, sp: ServicePlan, host: ProxyHost,
                              certs: list[Certificate], email: str, rows: dict,
                              now: datetime, out: Output) -> tuple[int, int | None]:
    """Spec: keep a covering certificate with more than RENEW_DAYS left;
    renew the host's own Let's Encrypt one when it is closer; else reuse
    another covering one; else request one (HTTP challenge). Returns the
    certificate id and, when a new one replaced Sirdar's earlier one, that
    old id: the caller deletes it once the host has moved off it."""
    current = (next((c for c in certs if c.id == host.certificate_id), None)
               if host.certificate_id else None)
    if current is not None and covers(current, sp.hostname):
        left = days_left(current, now)
        if left is None or left > RENEW_DAYS:
            return current.id, None
        if current.provider == "letsencrypt":
            out(f"{sp.hostname}: certificate #{current.id} expires {_date(current)}; renewing\n")
            renewed = await api.renew_certificate(current.id, sp.hostname, out=out)
            certs[:] = [renewed if c.id == renewed.id else c for c in certs]
            return renewed.id, None
    other = usable_certificate(certs, sp.hostname, now)
    if other is not None:
        out(f"{sp.hostname}: using certificate #{other.id}\n")
        return other.id, None
    out(f"{sp.hostname}: requesting a Let's Encrypt certificate\n")
    try:
        made = await api.request_certificate(sp.hostname, email, out=out)
    except npm.TimedOut:
        made = await _issued_anyway(api, sp.hostname, certs)
        if made is None:
            raise
        out(f"{sp.hostname}: the request timed out, but Nginx Proxy Manager issued "
            f"certificate #{made.id}\n")
    certs.append(made)
    await _remember(ctx.env_id, sp.service, CERT, made.id, sp.hostname)
    old = rows.get((sp.service, CERT))
    if old is not None and old.origin == "created" and old.external_id != str(made.id):
        return made.id, int(old.external_id)
    return made.id, None


async def _delete_replaced(api: Npm, hostname: str, cert_id: int, out: Output) -> None:
    """Sirdar's earlier certificate for the name, already forgotten (the new
    one took its row): deleted unless a host still uses it."""
    try:
        found = next((c for c in await api.certificates() if c.id == cert_id), None)
        if found is None:
            out(f"{hostname}: the old certificate #{cert_id} is already gone\n")
            return
        if not still_sirdars_certificate(found, hostname):
            out(f"{hostname}: Certificate #{cert_id} left in place: it no longer matches what "
                "Sirdar made.\n")
            return
        user = await _host_using(api, cert_id)
        if user is not None:
            out(_in_use(hostname, cert_id, user))
            return
        await api.delete_certificate(cert_id)
        out(f"{hostname}: deleted the old certificate #{cert_id}\n")
    except NpmError:
        out(f"{hostname}: couldn't delete the old certificate #{cert_id}; "
            "it stays in Nginx Proxy Manager\n")


def _updated(drift: list[str], sp: ServicePlan) -> str:
    """What a proxy host update changed, for the log: the bare name's
    redirect gets its own words."""
    if "the redirect" not in drift:
        return f"proxy host now goes to {sp.forward}"
    if drift == ["the redirect"]:
        return "proxy host now redirects to the portal"
    return f"proxy host now goes to {sp.forward} and redirects to the portal"


async def ensure_proxy(ctx: PublishContext, out: Output, *, transport,
                       sleep: Callable[[float], Awaitable[None]], now: datetime,
                       backoff: tuple[int, ...]) -> None:
    cfg = _need_to_publish(ctx.npm, "Nginx Proxy Manager")
    rows, owners = await _rows_and_owners(ctx.env_id, PROXY)
    async with Npm(cfg, transport=transport, sleep=sleep, backoff=backoff) as api:
        hosts = await api.proxy_hosts()
        certs = await api.certificates()
        # Names the environment no longer uses go first, as in ensure_dns.
        npm_rows = {k: r for k, r in rows.items() if k[1] in (PROXY, CERT)}
        dropped = set()
        for row in sorted(stale_rows(npm_rows, ctx.services), key=lambda r: r.kind != PROXY):
            # Hosts before the certificates they use.
            removed = await _drop_npm(api, row, out)
            dropped.add((row.service, row.kind))
            if removed:
                gone = int(row.external_id)
                if row.kind == PROXY:
                    hosts = [h for h in hosts if h.id != gone]
                else:
                    certs = [c for c in certs if c.id != gone]
        rows = {k: r for k, r in rows.items() if k not in dropped}
        plan = [(s, proxy_status(s, hosts, current_row(rows, s, PROXY), owners))
                for s in ctx.services]
        _stop_on_blockers(plan, "proxy hosts")
        for s, st in plan:
            found = st.current
            if st.state == "create":
                found = await api.create_host(new_host_body(s))
                await _remember(ctx.env_id, s.service, PROXY, found.id, s.hostname)
                out(f"{s.hostname}: created a proxy host to {s.forward}\n")
            elif st.state == "update":
                drift = _forward_drift(found, s)
                found = await api.update_host(found.id, host_body(found, s))
                out(f"{s.hostname}: {_updated(drift, s)}\n")
            else:
                out(f"{s.hostname}: proxy host to {s.forward}, unchanged\n")
            cert_id, replaced = await _ensure_certificate(api, ctx, s, found, certs,
                                                          cfg.letsencrypt_email, rows, now, out)
            if (found.certificate_id != cert_id or not found.ssl_forced
                    or not found.http2_support):
                await api.update_host(found.id, host_body(found, s, certificate_id=cert_id))
                out(f"{s.hostname}: HTTPS with certificate #{cert_id}, Force SSL on\n")
            if replaced is not None:
                await _delete_replaced(api, s.hostname, replaced, out)


async def remove_proxy(ctx: PublishContext, out: Output, *, transport,
                       sy_transport=None) -> None:
    """What Sirdar made in either proxy: an environment's rows say where
    (its proxy never changes, but rows outlive nothing they describe)."""
    rows = sorted(await _all_rows(ctx.env_id, (PROXY, CERT)),
                  key=lambda r: (r.kind != PROXY, r.name))
    sy_rows = await _all_rows(ctx.env_id, (SY_HOST,))
    if not rows and not sy_rows:
        out("No proxy hosts or certificates to remove.\n")
        return
    if sy_rows:
        await remove_switchyard(ctx, out, transport=sy_transport)
    if not rows:
        return
    if not any(r.origin == "created" for r in rows):
        for row in rows:
            await _drop_npm(None, row, out)
        return
    cfg = _need_to_remove(ctx.npm, "Nginx Proxy Manager")
    async with Npm(cfg, transport=transport) as api:
        for row in rows:
            await _drop_npm(api, row, out)


# Switchyard hosts: staged changes, one apply per change set

def still_sirdars_sy_host(found: switchyard.Host, ctx: PublishContext, name: str) -> bool:
    """Serves only the name, and Sirdar's notes (when it has them) are this
    environment's."""
    owner = sy_owner(found)
    return found.domains == (name.lower(),) and (owner is None or owner[1] == str(ctx.env_id))


async def _drop_sy(api: Switchyard | None, ctx: PublishContext, row: ManagedRecord,
                   out: Output, hosts: list[switchyard.Host] | None) -> str:
    """Delete (staged) a host Sirdar created when it still matches, and
    forget the row. "deleted", "gone" (already) or "kept"."""
    if row.origin != "created":
        out(f"{row.name}: left the Switchyard host in place (claimed, not made by Sirdar)\n")
        await _forget(row.id)
        return "kept"
    ext = int(row.external_id)
    found = next((h for h in hosts if h.id == ext), None)
    result = "gone"
    if found is None:
        out(f"{row.name}: already gone: Switchyard host #{ext}\n")
    elif not still_sirdars_sy_host(found, ctx, row.name):
        out(_left_in_place(row, "Switchyard host", ext))
        result = "kept"
    elif await api.delete_host(ext):
        out(f"{row.name}: deleted the Switchyard host #{ext}\n")
        result = "deleted"
    else:
        out(f"{row.name}: already gone: Switchyard host #{ext}\n")
    await _forget(row.id)
    return result


def _sy_updated(drift: list[str], sp: ServicePlan) -> str:
    if not drift:
        return "Switchyard host is Sirdar's again"
    if "the upstream" in drift:
        return f"Switchyard host now goes to {sp.forward}"
    if "the redirect" in drift:
        return "Switchyard host now redirects to the portal"
    return f"Switchyard host updated ({_and(drift)})"


def sy_note(ctx: PublishContext, what: str) -> str:
    return f"Sirdar: {ctx.env_name} {what}"


async def _apply(api: Switchyard, ctx: PublishContext, what: str, out: Output) -> None:
    await api.apply(sy_note(ctx, what))
    out(f"Applied in Switchyard: {sy_note(ctx, what)}\n")


async def _apply_after_failure(api: Switchyard, ctx: PublishContext, what: str,
                               out: Output) -> None:
    """A step that staged changes and then failed still applies them, so
    Switchyard's hosts and what Caddy serves agree (as NPM's, which change
    at once); the step's own failure is what it reports."""
    try:
        await _apply(api, ctx, what, out)
    except SwitchyardError as e:
        out(f"Couldn't apply the changes made so far: {e.reason}\n")


async def ensure_switchyard(ctx: PublishContext, out: Output, *, transport,
                            sleep: Callable[[float], Awaitable[None]],
                            what: str = "proxy hosts") -> None:
    """Step 13 through Switchyard: a host per public service (proxy, or the
    bare name's redirect), one apply, then a wait until Caddy has every
    name's certificate. `what` names the change set in the apply's note."""
    cfg = _need_to_publish(ctx.switchyard, "Switchyard")
    rows, owners = await _rows_and_owners(ctx.env_id, SY_HOST)
    async with Switchyard(cfg, transport=transport, sleep=sleep) as api:
        hosts = await api.hosts()
        staged = False
        try:
            # Names the environment no longer uses go first, as in ensure_dns.
            sy_rows = {k: r for k, r in rows.items() if k[1] == SY_HOST}
            dropped = set()
            for row in stale_rows(sy_rows, ctx.services):
                if await _drop_sy(api, ctx, row, out, hosts) == "deleted":
                    staged = True
                    hosts = [h for h in hosts if h.id != int(row.external_id)]
                dropped.add((row.service, row.kind))
            rows = {k: r for k, r in rows.items() if k not in dropped}
            plan = [(s, sy_status(s, hosts, current_row(rows, s, SY_HOST), owners, ctx.env_id))
                    for s in ctx.services]
            _stop_on_blockers(plan, "Switchyard hosts")
            for s, st in plan:
                if st.state == "create":
                    made = await api.create_host(new_sy_body(ctx, s))
                    staged = True
                    await _remember(ctx.env_id, s.service, SY_HOST, made.id, s.hostname)
                    out(f"{s.hostname}: created a Switchyard host ({_sy_target(s)})\n")
                elif st.state == "update":
                    current = await api.host(st.current.id)
                    drift = _sy_drift(current, s)
                    if drift:
                        await api.update_host(current.id, sy_host_body(current, s))
                        staged = True
                    row = current_row(rows, s, SY_HOST)
                    if row is None or row.external_id != str(current.id):
                        await _remember(ctx.env_id, s.service, SY_HOST, current.id, s.hostname)
                    out(f"{s.hostname}: {_sy_updated(drift, s)}\n")
                else:
                    out(f"{s.hostname}: Switchyard host ({_sy_target(s)}), unchanged\n")
        except BaseException:
            if staged:
                await _apply_after_failure(api, ctx, what, out)
            raise
        if staged:
            await _apply(api, ctx, what, out)
        await api.wait_for_certificates([s.hostname for s in ctx.services], out)


async def remove_switchyard(ctx: PublishContext, out: Output, *, transport) -> None:
    rows = sorted(await _all_rows(ctx.env_id, (SY_HOST,)), key=lambda r: r.name)
    if not any(r.origin == "created" for r in rows):
        for row in rows:
            await _drop_sy(None, ctx, row, out, None)
        return
    cfg = _need_to_remove(ctx.switchyard, "Switchyard")
    async with Switchyard(cfg, transport=transport) as api:
        hosts = await api.hosts()
        staged = False
        try:
            for row in rows:
                staged = await _drop_sy(api, ctx, row, out, hosts) == "deleted" or staged
        except BaseException:
            if staged:
                await _apply_after_failure(api, ctx, "remove proxy hosts", out)
            raise
        if staged:
            await _apply(api, ctx, "remove proxy hosts", out)


# Smoke test

async def run_smoke(ctx: PublishContext, out: Output, *, transport,
                    sleep: Callable[[float], Awaitable[None]], attempts: int,
                    delay: float) -> None:
    results = await smoke.run([(s.service, s.hostname) for s in ctx.services], ctx.proxy_ip,
                              transport=transport, sleep=sleep, attempts=attempts, delay=delay,
                              out=out)
    for r in results:
        out(f"{r.url}: {r.detail}\n")
    failed = [r.service for r in results if not r.ok]
    if failed:
        raise StepFailed(f"{len(failed)} of {len(results)} public URLs didn't answer: "
                         f"{', '.join(failed)}.")


# Switch traffic on the LAN (deploy phase 8b): these follow the live app VM;
# spaces stays on the data VM. home (the bare name) goes where portal goes.
APP_SERVICES = (*(s for s in envfile.SERVICES if s != "spaces"), home.HOME)


async def _point(env_id, addresses: dict[str, str]) -> None:
    async with get_sessionmaker()() as s:
        for service, ip in addresses.items():
            await s.execute(update(EnvironmentService).where(
                EnvironmentService.environment_id == env_id,
                EnvironmentService.service == service).values(host_ip=ip))
        await s.commit()


FORWARD_FIELDS = ("forward_scheme", "forward_host", "forward_port", "allow_websocket_upgrade")


async def _fallback(env_id) -> tuple[str | None, dict[str, str]]:
    """The slot live before the switch, and where each service's proxy host
    goes back to on a failure: the live slot's VM for the app services, the
    data VM for spaces. Read from the VM rows, never from the services'
    host_ip, so a retry after an interrupted switch still knows the way
    back. No live slot: the app services have nowhere to go back to."""
    async with get_sessionmaker()() as s:
        live = await s.scalar(select(Environment.active_slot).where(Environment.id == env_id))
    back: dict[str, str] = {}
    if data_ip := await lan_slots.slot_ip(env_id, vms.DATA):
        back["spaces"] = data_ip
    if live and (live_ip := await lan_slots.slot_ip(env_id, live)):
        back.update({service: live_ip for service in APP_SERVICES})
    return live, back


async def _managed_hosts(env_id) -> dict[int, ManagedRecord]:
    return {int(r.external_id): r for r in await _all_rows(env_id, (PROXY,))}


async def _record(ctx: PublishContext, *, transport) -> dict[int, dict]:
    """Host id -> the forward fields of every proxy host Sirdar manages for
    the environment, as the proxy has them now (Switchyard: the upstreams;
    a redirect host has none)."""
    if ctx.proxy == "switchyard":
        return await _record_sy(ctx, transport=transport)
    cfg = _need_to_publish(ctx.npm, "Nginx Proxy Manager")
    rows = await _managed_hosts(ctx.env_id)
    if not rows:
        return {}
    async with Npm(cfg, transport=transport) as api:
        return {h.id: {k: getattr(h, k) for k in FORWARD_FIELDS}
                for h in await api.proxy_hosts()
                if h.id in rows and rows[h.id].name in h.domain_names}


async def _record_sy(ctx: PublishContext, *, transport) -> dict[int, dict]:
    cfg = _need_to_publish(ctx.switchyard, "Switchyard")
    rows = {int(r.external_id): r for r in await _all_rows(ctx.env_id, (SY_HOST,))}
    if not rows:
        return {}
    async with Switchyard(cfg, transport=transport) as api:
        return {h.id: {"upstreams": [dict(u) for u in h.raw.get("upstreams") or []]}
                for h in await api.hosts() if h.id in rows and rows[h.id].name in h.domains}


async def _put_back_sy(ctx: PublishContext, out: Output, recorded: dict[int, dict],
                       back: dict[str, str], *, transport, drop_new: bool) -> list[str]:
    """_put_back for Switchyard: each host's upstreams as recorded, aimed at
    `back`; one apply for all of it."""
    cfg = _need_to_publish(ctx.switchyard, "Switchyard")
    rows = {int(r.external_id): r for r in await _all_rows(ctx.env_id, (SY_HOST,))}
    failed: list[str] = []
    if not rows:
        return failed
    async with Switchyard(cfg, transport=transport) as api:
        staged = False
        for host in await api.hosts():
            row = rows.get(host.id)
            if row is None or row.name not in host.domains:
                continue
            try:
                if host.id not in recorded:
                    if drop_new or row.service not in back:
                        staged = await _drop_sy(api, ctx, row, out, [host]) == "deleted" or staged
                    continue
                if host.type != "proxy":
                    continue                        # a redirect follows no slot
                want = [dict(u) for u in recorded[host.id]["upstreams"]]
                if row.service in back:
                    want = [{**u, "host": back[row.service]} for u in want]
                if [dict(u) for u in host.raw.get("upstreams") or []] == want:
                    continue
                current = await api.host(host.id)
                await api.update_host(host.id, {**current.raw, "upstreams": want})
                staged = True
                out(f"{row.name}: Switchyard host back to "
                    f"{', '.join(u['host'] for u in want)}\n")
            except SwitchyardError as e:
                failed.append(f"{row.name}: {e.reason}")
        if staged:
            try:
                await _apply(api, ctx, "put traffic back", out)
            except SwitchyardError as e:
                failed.append(f"Applying in Switchyard: {e.reason}")
    return failed


async def _put_back(ctx: PublishContext, out: Output, recorded: dict[int, dict],
                    back: dict[str, str], *, transport, drop_new: bool) -> list[str]:
    """Every proxy host Sirdar manages for the environment goes back: the
    forward fields recorded before the switch, with the forward host from
    `back`. A host the switch created goes to `back` too, or (`drop_new`:
    nothing was live, so a failed first switch leaves no proxy hosts behind)
    it is deleted; the certificates it got stay managed, for the next try.
    Each host is its own try: the answer lists the ones that couldn't be put
    back."""
    if ctx.proxy == "switchyard":
        return await _put_back_sy(ctx, out, recorded, back, transport=transport,
                                  drop_new=drop_new)
    cfg = _need_to_publish(ctx.npm, "Nginx Proxy Manager")
    rows = await _managed_hosts(ctx.env_id)
    failed: list[str] = []
    if not rows:
        return failed
    async with Npm(cfg, transport=transport) as api:
        for host in await api.proxy_hosts():
            row = rows.get(host.id)
            if row is None or row.name not in host.domain_names:
                continue
            new = host.id not in recorded
            want = dict(recorded.get(host.id, {}))
            if row.service in back:
                want["forward_host"] = back[row.service]
            try:
                if new and (drop_new or "forward_host" not in want):
                    await _drop_npm(api, row, out)
                    continue
                if all(getattr(host, k) == v for k, v in want.items()):
                    continue
                body = {k: host.raw[k] for k in npm.HOST_FIELDS if k in host.raw}
                body["locations"] = body.get("locations") or []
                body.update(want)
                await api.update_host(host.id, body)
                out(f"{row.name}: proxy host back to {want['forward_host']}\n")
            except NpmError as e:
                failed.append(f"{row.name}: {e.reason}")
    return failed


async def _roll_back(ctx: PublishContext, out: Output, recorded: dict[int, dict],
                     back: dict[str, str], *, transport, drop_new: bool) -> str | None:
    """Our own copy for what couldn't be put back, None when all of it was."""
    where = ctx.proxy_label
    try:
        failed = await _put_back(ctx, out, recorded, back, transport=transport,
                                 drop_new=drop_new)
    except (StepFailed, NpmError, SwitchyardError) as e:
        return f"Sirdar couldn't put the proxy hosts back ({e.reason}): check them in {where}."
    except Exception:
        return f"Sirdar couldn't put the proxy hosts back: check them in {where}."
    if not failed:
        return None
    try:
        kinds = (SY_HOST,) if ctx.proxy == "switchyard" else (PROXY,)
        total = f" of {len(await _all_rows(ctx.env_id, kinds))}"
    except Exception:
        total = ""
    return (f"Sirdar couldn't put {len(failed)}{total} proxy hosts back: check them in "
            f"{where}.\n" + "\n".join(f"  {f}" for f in failed))


# Put-backs still running: the strong reference that keeps one alive when
# the switch that started it stops waiting (a second cancel, or the bound).
_PUTTING_BACK: set[asyncio.Task] = set()
PUT_BACK_WAIT = 120.0       # seconds a cancelled switch keeps waiting for its put-back


async def _wait_for_put_back(rollback: Awaitable[str | None],
                             where: str = "Nginx Proxy Manager") -> tuple[str | None, bool]:
    """Run the put-back as its own task and wait for it through cancels, for
    at most PUT_BACK_WAIT seconds. Returns its copy (or ours, if it is still
    running) and whether a cancel arrived meanwhile; the caller re-raises
    that cancel once the waiting is over."""
    task = asyncio.ensure_future(rollback)
    _PUTTING_BACK.add(task)
    task.add_done_callback(_PUTTING_BACK.discard)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + PUT_BACK_WAIT
    cancelled = False
    while not task.done():
        left = deadline - loop.time()
        if left <= 0:
            break
        try:
            # wait() never cancels the task it waits for.
            await asyncio.wait({task}, timeout=left)
        except asyncio.CancelledError:
            cancelled = True
    if not task.done():
        return f"Sirdar is still putting the proxy hosts back: check them in {where}.", cancelled
    return task.result(), cancelled


async def _home_without_dns(ctx: PublishContext) -> bool:
    """Sirdar manages nothing yet at the current bare name (an environment
    made before the home service, or whose base domain changed, with no
    publish since): a switch leaves it out rather than ask Let's Encrypt for
    a name nothing resolves. The next publish that runs step 12 picks it up.
    A home record, proxy host or certificate Sirdar already manages under
    that name keeps it in, so the switch never drops one as stale."""
    name = next((s.hostname for s in ctx.services if s.service == home.HOME), None)
    if name is None:
        return False
    rows = await _all_rows(ctx.env_id, (DNS, PROXY, CERT))
    return not any(r.service == home.HOME and r.name == name for r in rows)


async def switch_lan(ctx: PublishContext, out: Output, *, npm_transport, smoke_transport,
                     sleep: Callable[[float], Awaitable[None]], now: datetime,
                     backoff: tuple[int, ...], attempts: int, delay: float,
                     sy_transport=None) -> None:
    """Point the environment's proxy hosts at the slot's VM and check the
    public names through the proxy (NPM, or Switchyard: its upstreams, one
    apply); only then record the new addresses. On any exit before that (a
    failure, a cancel), the proxy hosts go back to the slot that was live
    (recorded first: each host's forward fields or upstreams)."""
    sy = ctx.proxy == "switchyard"
    transport = sy_transport if sy else npm_transport
    if ctx.slot is None:
        raise StepFailed("This Switch traffic names no server.")
    ip = await lan_slots.slot_ip(ctx.env_id, ctx.slot)
    if not ip:
        raise StepFailed(f"The {ctx.slot} VM has no address yet. Deploy to it first.")
    live, back = await _fallback(ctx.env_id)
    try:
        recorded = await _record(ctx, transport=transport)
    except (StepFailed, NpmError, SwitchyardError) as e:
        raise StepFailed(f"{e.reason} Sirdar changed nothing.") from None
    waiting = await _home_without_dns(ctx)
    moved = replace(ctx, services=tuple(replace(s, host_ip=ip) if s.service in APP_SERVICES
                                        else s for s in ctx.services
                                        if not (waiting and s.service == home.HOME)))
    out(f"Switching the proxy hosts to {ctx.slot} ({ip}).\n")
    try:
        if sy:
            await ensure_switchyard(moved, out, transport=transport, sleep=sleep,
                                    what=f"switch to {ctx.slot}")
        else:
            await ensure_proxy(moved, out, transport=transport, sleep=sleep, now=now,
                               backoff=backoff)
        await run_smoke(moved, out, transport=smoke_transport, sleep=sleep, attempts=attempts,
                        delay=delay)
        try:
            await _point(ctx.env_id, {service: ip for service in APP_SERVICES})
        except Exception:
            raise StepFailed("Sirdar couldn't save the new addresses in its database.") from None
    except BaseException as e:
        out("Putting traffic back.\n")
        problem, cancelled = await _wait_for_put_back(_roll_back(
            ctx, out, recorded, back, transport=transport, drop_new=live is None),
            ctx.proxy_label)
        if cancelled or not isinstance(e, (StepFailed, NpmError, SwitchyardError)):
            if problem:
                out(problem + "\n")
            if cancelled and not isinstance(e, asyncio.CancelledError):
                raise asyncio.CancelledError from None
            raise
        if problem:
            tail = problem
        elif live is None:
            tail = "No slot was live before, so nothing to put back."
        elif live == ctx.slot:
            tail = f"{ctx.slot} was already live, so traffic still goes to it."
        else:
            tail = "Traffic stays where it was."
        raise StepFailed(f"{e.reason} {tail}") from None
    out(f"Traffic goes to {ctx.slot} ({ip}).\n")


class HttpPublisher:
    """The real publisher: steps 12–14 and 16–17 against Cloudflare, the
    environment's proxy (Switchyard or Nginx Proxy Manager) and the public
    URLs, through outbound.transports(). Waits and the clock are injectable
    for tests."""

    def __init__(self, *, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 now: Callable[[], datetime] | None = None,
                 cert_backoff: tuple[int, ...] = CERT_BACKOFF,
                 smoke_attempts: int = smoke.ATTEMPTS, smoke_delay: float = smoke.DELAY):
        self._sleep = sleep
        self._now = now or (lambda: datetime.now(UTC))
        self._backoff = cert_backoff
        self._smoke_attempts = smoke_attempts
        self._smoke_delay = smoke_delay

    async def run(self, step: str, ctx: PublishContext, out: Output) -> None:
        transports = outbound.transports()
        try:
            match step:
                case "dns":
                    target = None
                    if ctx.cloud:
                        target = await do_envs.lb_ip(ctx.env_id)
                        if not target:
                            raise StepFailed("The load balancer has no address yet. Retry from "
                                             "step 0 (Prepare DigitalOcean).")
                    await ensure_dns(ctx, out, transport=transports["cloudflare"], target=target)
                case "proxy" if ctx.proxy == "switchyard":
                    await ensure_switchyard(ctx, out, transport=transports["switchyard"],
                                            sleep=self._sleep)
                case "proxy":
                    await ensure_proxy(ctx, out, transport=transports["npm"], sleep=self._sleep,
                                       now=self._now(), backoff=self._backoff)
                case "smoke":
                    await run_smoke(ctx, out, transport=transports["smoke"], sleep=self._sleep,
                                    attempts=self._smoke_attempts, delay=self._smoke_delay)
                case "lan_switch":
                    await switch_lan(ctx, out, npm_transport=transports["npm"],
                                     smoke_transport=transports["smoke"], sleep=self._sleep,
                                     now=self._now(), backoff=self._backoff,
                                     attempts=self._smoke_attempts, delay=self._smoke_delay,
                                     sy_transport=transports.get("switchyard"))
                case "unproxy":
                    await remove_proxy(ctx, out, transport=transports["npm"],
                                       sy_transport=transports.get("switchyard"))
                case "undns":
                    await _check_removable(ctx)
                    await remove_dns(ctx, out, transport=transports["cloudflare"])
                case _:
                    raise ValueError(f"{step!r} isn't a publish step")
        except (CloudflareError, NpmError, SwitchyardError) as e:
            raise StepFailed(e.reason) from None
