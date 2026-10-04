"""Publishing an environment (spec Section 2 steps 12–14, Section 3
managed_records): a Cloudflare A record and an Nginx Proxy Manager proxy
host (with its certificate) for every public service, a smoke test of the
public URLs, and their removal when the environment is deleted.

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
Cloudflare and Npm clients."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Environment, ManagedRecord
from sirdar_api.deploy import integrations, outbound
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError, DnsRecord
from sirdar_api.deploy.environments import services_of
from sirdar_api.deploy.integrations import CloudflareConfig, IntegrationError, NpmConfig
from sirdar_api.deploy.npm import (
    RENEW_DAYS,
    Certificate,
    Npm,
    NpmError,
    ProxyHost,
    covers,
    days_left,
)

Output = Callable[[str], None]
DNS, PROXY, CERT = "dns_record", "proxy_host", "certificate"
KIND_INTEGRATION = {DNS: "cloudflare", PROXY: "npm", CERT: "npm"}


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


@dataclass(frozen=True)
class PublishContext:
    env_id: uuid.UUID
    env_name: str
    proxy_ip: str
    services: tuple[ServicePlan, ...]
    cloudflare: CloudflareConfig | None = field(default=None, repr=False)
    npm: NpmConfig | None = field(default=None, repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [v for v in (self.cloudflare.token if self.cloudflare else None,
                            self.npm.password if self.npm else None) if v]


@dataclass(frozen=True)
class Status:
    state: str              # ok | update | create | claimable | conflict
    detail: str
    current: object = field(default=None, compare=False)    # DnsRecord / ProxyHost / Certificate


# ---- context -------------------------------------------------------------------

async def service_plans(db: AsyncSession, env: Environment) -> tuple[ServicePlan, ...]:
    """The public services (those with a hostname), in envfile order."""
    rows = await services_of(db, env.id)
    return tuple(ServicePlan(r.service, r.hostname, r.host_ip, r.port, r.proxied)
                 for r in rows if r.hostname)


async def prepare(db: AsyncSession, env: Environment, settings: Settings) -> PublishContext:
    try:
        cf = await integrations.load_cloudflare(db, settings)
        proxy = await integrations.load_npm(db, settings)
    except IntegrationError as e:
        raise PublishError(e.reason) from None
    return PublishContext(env_id=env.id, env_name=env.name, proxy_ip=env.proxy_ip,
                          services=await service_plans(db, env), cloudflare=cf, npm=proxy)


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


def stale_rows(rows: dict, services) -> list[ManagedRecord]:
    """Managed rows for a service that is no longer public, or under a name
    the environment no longer uses (its base domain changed)."""
    wanted = {s.service: s.hostname for s in services}
    return [r for r in rows.values() if wanted.get(r.service) != r.name]


async def missing_integrations(db: AsyncSession, env: Environment, *,
                               teardown: bool = False) -> list[str]:
    """Integrations a publish (both) or a teardown (those whose created
    entries it must delete) needs but which aren't configured."""
    if teardown:
        rows = await rows_of(db, env.id)
        wanted = {KIND_INTEGRATION[r.kind] for r in rows.values() if r.origin == "created"}
    else:
        wanted = {"cloudflare", "npm"}
    return sorted([k for k in wanted if not await integrations.is_configured(db, k)])


# ---- status ----------------------------------------------------------------------

def in_zone(hostname: str, zone: str) -> bool:
    return hostname == zone or hostname.endswith("." + zone)


def _unmanaged_dns(sp: ServicePlan, records: list[DnsRecord], owners: dict[str, str], *,
                   public_ip: str) -> Status:
    """The name as seen without a managed record of this environment."""
    here = [r for r in records if r.name == sp.hostname]
    others = [r for r in here if r.type != "A"]
    if others:
        return Status("conflict", f"A {others[0].type} record already uses this name.")
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
    if any(r.name == wildcard for r in records):
        return Status("conflict", f"The wildcard {wildcard} covers this name; a record here "
                                  "would override it.")
    return Status("create", f"Sirdar will create A {public_ip}.")


def dns_status(sp: ServicePlan, records: list[DnsRecord], row: ManagedRecord | None,
               owners: dict[str, str], *, zone: str, public_ip: str) -> Status:
    if not in_zone(sp.hostname, zone):
        return Status("conflict", f"{sp.hostname} isn't in the Cloudflare zone {zone}.")
    if row is not None:
        mine = next((r for r in records if r.id == row.external_id
                     and r.name == sp.hostname), None)
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
        return Status("create", "Sirdar's record is gone; it will be created again.")
    if status.state == "claimable":
        return Status("conflict",
                      "Sirdar's record is gone and another A record now uses this name.")
    return status


def _forward_drift(host: ProxyHost, sp: ServicePlan) -> list[str]:
    checks = (("the scheme", host.forward_scheme, "http"),
              ("the forward host", host.forward_host, sp.host_ip),
              ("the forward port", host.forward_port, sp.port),
              ("WebSockets", host.allow_websocket_upgrade, True))
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
        return Status("create", "Sirdar's proxy host is gone; it will be created again.")
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
    Cloudflare and NPM, changes nothing. A section whose integration isn't
    configured or can't be read reports "unknown" and says why."""
    transports = outbound.transports()
    services = await service_plans(db, env)
    rows = await rows_of(db, env.id)
    now = datetime.now(UTC)
    out: dict = {"publish": env.publish, "proxy_ip": env.proxy_ip,
                 "cloudflare": {"configured": False, "zone": None, "public_ip": None,
                                "error": None},
                 "npm": {"configured": False, "url": None, "error": None}}
    dns: dict[str, Status] = {}
    proxies: dict[str, Status] = {}
    certs: dict[str, Status] = {}

    try:
        cf = await integrations.load_cloudflare(db, settings)
    except IntegrationError as e:
        cf, out["cloudflare"]["error"] = None, e.reason
    if cf is not None:
        out["cloudflare"].update(configured=True, zone=cf.zone, public_ip=cf.public_ip)
        try:
            async with Cloudflare(cf, transport=transports["cloudflare"]) as api:
                records = await api.records()
        except CloudflareError as e:
            out["cloudflare"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, DNS)
            dns = {s.service: dns_status(s, records, current_row(rows, s, DNS), owners,
                                         zone=cf.zone, public_ip=cf.public_ip)
                   for s in services}

    try:
        proxy_cfg = await integrations.load_npm(db, settings)
    except IntegrationError as e:
        proxy_cfg, out["npm"]["error"] = None, e.reason
    if proxy_cfg is not None:
        out["npm"].update(configured=True, url=proxy_cfg.url)
        try:
            async with Npm(proxy_cfg, transport=transports["npm"]) as api:
                hosts = await api.proxy_hosts()
                all_certs = await api.certificates()
        except NpmError as e:
            out["npm"]["error"] = e.reason
        else:
            owners = await owners_of(db, env.id, PROXY)
            for s in services:
                status = proxy_status(s, hosts, current_row(rows, s, PROXY), owners)
                proxies[s.service] = status
                certs[s.service] = cert_status(status.current, all_certs, s.hostname, now)

    out["services"] = [{
        "service": s.service, "hostname": s.hostname, "forward": s.forward,
        "dns": _entry(dns.get(s.service), current_row(rows, s, DNS), "record_id"),
        "proxy": _entry(proxies.get(s.service), current_row(rows, s, PROXY), "host_id"),
        "certificate": _cert_entry(certs.get(s.service)),
    } for s in services]
    out["stale"] = [{"service": r.service, "kind": r.kind, "name": r.name, "origin": r.origin}
                    for r in stale_rows(rows, services)]
    return out


async def claim(db: AsyncSession, env: Environment, state: dict) -> list[str]:
    """Record every claimable DNS record and proxy host in `state` (from
    inspect) as claimed. Certificates are never claimed. Writes only
    Sirdar's database; the caller audits and commits."""
    claimed: list[str] = []
    for svc in state["services"]:
        for key, kind, id_key in (("dns", DNS, "record_id"), ("proxy", PROXY, "host_id")):
            entry = svc[key]
            if entry["state"] != "claimable":
                continue
            db.add(ManagedRecord(environment_id=env.id, service=svc["service"], kind=kind,
                                 external_id=str(entry[id_key]), name=svc["hostname"],
                                 origin="claimed"))
            claimed.append(f"{key}:{svc['hostname']}")
    await db.flush()
    return claimed
