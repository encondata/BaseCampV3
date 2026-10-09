"""Dashboard data (the Deployments page's spotlight). Every card has one
shape: Production first (or a placeholder), Dev / Beta (placeholders until an
environment of that type exists), the other environments by name, then
DigitalOcean env tags no environment answers to. Each card carries its flow:
live traffic → the middle box (a DigitalOcean load balancer, or Nginx Proxy
Manager on the LAN) → its server(s). DigitalOcean values come from Sirdar's
records (do_environments, do_slots, do_resources) and each account's
inventory (read with that account's token, cached by the token's hash). LAN
values come from the environment's target and the NPM integration's URL.
The infrastructure tree lists every real environment (card order, `id` =
the card's id) with its parts, from the same records and cached inventories,
then each account's resources no Sirdar record names. No token, password or
public database host reaches the response, and no token a cache key."""

import asyncio
import hashlib
import logging
import math
import time
from datetime import UTC, datetime
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.dashboard import certcheck
from sirdar_api.dashboard.demo import demo_dashboard, node
from sirdar_api.db.models import (
    Deployment,
    DoAccount,
    DoEnvironment,
    DoResource,
    Environment,
    EnvironmentService,
)
from sirdar_api.deploy import (
    ConnectFailed,
    certs,
    digitalocean,
    do_accounts,
    do_envs,
    home,
    integrations,
    lan_slots,
    names,
    outbound,
    targets,
    vms,
)
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.deploy.pipeline import KEEPS_STATUS, RETRYABLE_STATUSES

log = logging.getLogger(__name__)

CACHE_SECONDS = 30
FAILURE_SECONDS = 10
_cache: dict[str, tuple[float, dict | str]] = {}
_FIXED = ("production", "dev", "beta")
_LABELS = {"production": "Production", "dev": "Development", "beta": "Beta"}
_DROPLET = {"active": ("running", "Running"), "off": ("stopped", "Stopped"),
            "new": ("provisioning", "Provisioning")}
_TYPE_LABELS = {"dev": "Development", "beta": "Beta", "custom": "Custom",
                "production": "Production"}
_RELEASED = ("succeeded", "adopted")
cert_checker = certcheck.Checker()


def clear_cache() -> None:
    _cache.clear()
    cert_checker.clear()


def _label(env: str) -> str:
    return _LABELS.get(env) or env.replace("-", " ").title()


def _tags(resource: dict) -> list[str]:
    tags = resource.get("tags")
    if not isinstance(tags, list):
        tags = [resource["tag"]] if isinstance(resource.get("tag"), str) else []
    return [t for t in tags if isinstance(t, str)]


def _env_of(resource: dict) -> str | None:
    envs = [t[len("sirdar-env:"):] for t in _tags(resource) if t.startswith("sirdar-env:")]
    env = envs[0] if envs else None
    if env and (env in _FIXED or (names.is_valid_custom_name(env)
                                  and not names.is_reserved_name(env))):
        return env
    return None


def _region(resource: dict) -> str:
    region = resource.get("region")
    slug = region.get("slug") if isinstance(region, dict) else region
    return str(slug).upper() if slug else "—"


def _droplet_status(d: dict) -> tuple[str, str]:
    return _DROPLET.get(d.get("status"), ("unknown", "Unknown"))


def _database_status(d: dict) -> tuple[str, str]:
    return {"online": ("healthy", "Healthy"),
            "creating": ("provisioning", "Provisioning")}.get(d.get("status"),
                                                              ("unknown", "Unknown"))


def _lb_status(d: dict) -> tuple[str, str]:
    return {"active": ("active", "Active"),
            "new": ("provisioning", "Provisioning")}.get(d.get("status"), ("unknown", "Unknown"))


def _private_host(d: dict | None) -> str | None:
    """A database's private host: the public one (and the connection's
    credentials) never reach the dashboard."""
    conn = (d or {}).get("private_connection")
    return conn.get("host") if isinstance(conn, dict) else None


def _droplet_node(d: dict) -> dict:
    status, label = _droplet_status(d)
    v4 = (d.get("networks") or {}).get("v4") or []
    ips = {n.get("type"): n.get("ip_address") for n in v4 if isinstance(n, dict)}
    name = str(d.get("name") or d.get("id"))
    return node(f"droplet-{d.get('id')}", name, "droplet", "Droplet", status, label,
                region=_region(d), endpoint=ips.get("private") or ips.get("public") or "—")


def _database_node(d: dict) -> dict:
    status, label = _database_status(d)
    name = str(d.get("name") or d.get("id"))
    return node(f"database-{d.get('id')}", name, "database", "Managed PostgreSQL",
                status, label, region=_region(d), endpoint=_private_host(d) or "—")


def _lb_node(d: dict) -> dict:
    status, label = _lb_status(d)
    name = str(d.get("name") or d.get("id"))
    return node(f"lb-{d.get('id')}", name, "load_balancer", "Load balancer",
                status, label, region=_region(d), endpoint=d.get("ip") or "—")


def _rollup(children: list[dict]) -> tuple[str, str]:
    live = any(c["status"] in ("active", "running", "healthy") for c in children)
    return ("active", "Active") if live else ("inactive", "Inactive")


def other_resources(account: dict, inv: dict | None, managed: set[str], *,
                    single: bool) -> dict | None:
    """One account's DigitalOcean resources that no Sirdar record names
    (do_resources, do_slots), or None when there are none. An account that
    couldn't be read keeps its group (no children, its error as the
    endpoint) when there are two accounts; with one, the error shows above
    the tree as before."""
    gid = f"other:{account['key']}"
    name = ("Other DigitalOcean resources" if single
            else f"Other resources · {account['label']} account")
    if inv is None:
        if single:
            return None
        return node(gid, name, "group", "DigitalOcean account", "unknown", "Unavailable",
                    region="—", endpoint=account["error"] or "—")
    children = []
    for items, make in ((inv["droplets"], _droplet_node), (inv["databases"], _database_node),
                        (inv["load_balancers"], _lb_node)):
        for r in items:
            if str(r.get("id")) in managed:
                continue
            n = make(r)
            n["id"] = f"{gid}:{n['id']}"
            children.append(n)
    if not children:
        return None
    status, label = _rollup(children)
    return node(gid, name, "group", "Not managed by Sirdar", status, label, region="—",
                children=children)


async def _inventory(settings: Settings, refresh: bool, transport=None) -> dict:
    key = hashlib.sha256(settings.deploy_do_token.get_secret_value().encode()).hexdigest()
    hit = _cache.get(key)
    if hit and not refresh:
        age = time.monotonic() - hit[0]
        if isinstance(hit[1], str) and age < FAILURE_SECONDS:
            raise ConnectFailed(hit[1])
        if isinstance(hit[1], dict) and age < CACHE_SECONDS:
            return hit[1]
    try:
        inv = await digitalocean.inventory(
            settings, transport=transport or outbound.transports().get("digitalocean"))
    except ConnectFailed as e:
        _cache[key] = (time.monotonic(), e.reason)
        raise
    _cache[key] = (time.monotonic(), inv)
    return inv


def _env_state(env: Environment) -> str:
    if env.status in ("deploying", "failed"):
        return env.status
    if env.status == "deleting":
        return "deploying"
    return "active" if env.current_sha else "empty"


async def _last_release(db: AsyncSession, env_id) -> Deployment | None:
    return await db.scalar(select(Deployment)
                           .where(Deployment.environment_id == env_id,
                                  Deployment.status.in_(_RELEASED))
                           .order_by(Deployment.finished_at.desc().nulls_last(),
                                     Deployment.created_at.desc())
                           .limit(1))


def _health(cards: list[dict]) -> dict:
    states = {c["state"] for c in cards if c["environment"]}
    if "failed" in states:
        return {"status": "degraded", "label": "A deployment failed"}
    if "active" in states:
        return {"status": "healthy", "label": "Environments deployed"}
    return {"status": "unknown", "label": "No environments deployed"}


def cert_info(when: datetime | None, now: datetime) -> dict | None:
    """A certificate's expiry for the spotlight: amber at 14 days or fewer,
    red once expired."""
    if when is None:
        return None
    left = certs.days_left(when, now)
    days = math.floor(left)
    tone = "bad" if left <= 0 else "warn" if days <= certs.SIRDAR_RENEW_DAYS else "ok"
    return {"days_left": max(0, days), "expires_at": when.isoformat(), "tone": tone}


def certificate_of(results: list[certcheck.HostCert], now: datetime) -> dict | None:
    """An environment's certificate from the live check of its public
    hostnames: the soonest expiry among the hosts that answered (tone
    "unknown" when none did), each host listed. None without hostnames."""
    if not results:
        return None
    hosts = []
    for r in results:
        info = cert_info(r.not_after, now)
        hosts.append({"hostname": r.hostname,
                      "expires_at": info["expires_at"] if info else None,
                      "days_left": info["days_left"] if info else None,
                      "error": None if info else (r.error or certcheck.NO_CONNECT)})
    answered = [r.not_after for r in results if r.not_after is not None]
    summary = (cert_info(min(answered), now) if answered
               else {"days_left": None, "expires_at": None, "tone": "unknown"})
    return {**summary, "hosts": hosts}


async def _public_hostnames(db: AsyncSession, env_ids: list) -> dict:
    """{environment id: [hostname, ...]} in the services' usual order, set values only."""
    order = {s: i for i, s in enumerate(home.SERVICE_ORDER)}
    rows = (await db.execute(select(EnvironmentService.environment_id,
                                    EnvironmentService.service, EnvironmentService.hostname)
                             .where(EnvironmentService.environment_id.in_(env_ids),
                                    EnvironmentService.hostname.is_not(None),
                                    EnvironmentService.hostname != ""))).all()
    found: dict = {}
    for env_id, service, host in sorted(rows, key=lambda r: (order.get(r[1], 99), r[1])):
        found.setdefault(env_id, []).append(host)
    return found


async def _no_checks() -> dict:
    return {}


def _empty_flow() -> dict:
    return {"kind": "none", "middle": {"label": "Not built yet", "sub": "", "status": "unknown"},
            "servers": [{"id": "none", "label": "Server", "sub": "Not built yet",
                         "state": "empty", "health": "unknown", "version": None,
                         "deployed": False}],
            "active_slot": None, "certificate": None, "deploying_slot": None,
            "failed_slot": None}


async def _marks(db: AsyncSession, env: Environment, lan: bool) -> tuple[str | None, str | None]:
    """(deploying slot, failed slot) from the environment's latest deployment
    in a mode that sets its status (a later snapshot, publish or renew
    doesn't clear a failed Update's mark)."""
    latest = await db.scalar(select(Deployment)
                             .where(Deployment.environment_id == env.id,
                                    Deployment.mode.not_in(KEEPS_STATUS))
                             .order_by(Deployment.created_at.desc()).limit(1))
    if latest is None:
        return None, None
    slot = "host" if lan else latest.slot
    if env.status in ("deploying", "deleting") and latest.status == "running":
        return slot, None
    if env.status == "failed" and latest.status in RETRYABLE_STATUSES:
        return None, slot
    return None, None


def _slot_health(row, droplet: dict | None) -> str:
    if droplet is not None and droplet.get("status") != "active":
        return "degraded"
    if row is None or row.last_check_ok is None:
        return "unknown"
    return "healthy" if row.last_check_ok else "degraded"


_RECORD_KINDS = ("load_balancer", "database", "bucket", "droplet")


async def _records(db: AsyncSession, env_id) -> list[DoResource]:
    """The environment's records the dashboard shows, oldest first."""
    return list(await db.scalars(select(DoResource).where(
        DoResource.environment_id == env_id, DoResource.kind.in_(_RECORD_KINDS))
        .order_by(DoResource.created_at)))


def _newest(records: list[DoResource], kind: str, slot: str | None = None) -> DoResource | None:
    found = [r for r in records if r.kind == kind and (slot is None or r.slot == slot)]
    return found[-1] if found else None


async def _do_flow(db: AsyncSession, env: Environment, row: DoEnvironment, slots: dict,
                   records: list[DoResource], inv: dict | None) -> dict:
    lb = _newest(records, "load_balancer")
    lb_id = lb.do_id if lb else None
    lbs = {str(x.get("id")): x for x in (inv or {}).get("load_balancers", [])}
    droplets = {str(x.get("id")): x for x in (inv or {}).get("droplets", [])}
    if lb_id is None or inv is None:
        status = "unknown"
    elif lb_id not in lbs:
        status = "down"
    else:
        status = "ok" if lbs[lb_id].get("status") == "active" else "warn"
    servers = []
    for slot in env.slots:
        r = slots.get(slot)
        built = bool(r and (r.droplet_id or r.sha))
        state = "live" if slot == env.active_slot else "idle" if built else "empty"
        servers.append({
            "id": slot, "label": slot.title(),
            "sub": r.public_ip if r and r.public_ip else "Not built yet", "state": state,
            "health": _slot_health(r, droplets.get(r.droplet_id) if r and r.droplet_id else None),
            "version": r.image_tag if r else None, "deployed": bool(r and r.sha)})
    deploying, failed = await _marks(db, env, lan=False)
    return {"kind": "load_balancer",
            "middle": {"label": "Load balancer", "sub": row.lb_ip or "Built by the first deploy",
                       "status": status},
            "servers": servers, "active_slot": env.active_slot,
            "certificate": None,    # from the live check (_certificates)
            "deploying_slot": deploying, "failed_slot": failed}


async def _lan_server(db: AsyncSession, settings: Settings, env: Environment) -> tuple[str, str]:
    """(label, address) of a LAN environment's one host: its VM, or its SSH target."""
    if targets.is_vm_target(env.target_id):
        vm = await vms.get_for(db, env)
        return (vm.name, vm.ip or "No address yet") if vm else ("VM", "Not built yet")
    try:
        cfg = targets.ssh_config_for(env.target_id, settings)
        labels = {t["id"]: t["label"] for t in targets.public_targets(settings)}
    # An unreadable deploy-targets.env must not break the dashboard.
    except Exception as e:  # noqa: BLE001
        log.warning("dashboard couldn't read the SSH targets: %s", type(e).__name__)
        cfg, labels = None, {}
    return labels.get(env.target_id, "Host"), cfg.host if cfg else "—"


async def _lan_flow(db: AsyncSession, settings: Settings, env: Environment) -> dict:
    url = (await integrations.config_of(db, "npm")).get("url")
    npm_host = urlsplit(url).hostname if url else None
    label, sub = await _lan_server(db, settings, env)
    live = env.current_sha is not None
    health = ("degraded" if env.status == "failed"
              else "healthy" if live and env.status == "ready" else "unknown")
    deploying, failed = await _marks(db, env, lan=True)
    return {"kind": "proxy",
            "middle": {"label": "Nginx Proxy Manager", "sub": npm_host or "Not set up",
                       "status": "ok" if npm_host else "unknown"},
            "servers": [{"id": "host", "label": label, "sub": sub,
                         "state": "live" if live else "empty", "health": health,
                         "version": _version(env), "deployed": live}],
            "active_slot": "host" if live else None, "certificate": None,
            "deploying_slot": deploying, "failed_slot": failed}


async def _lan_bluegreen_flow(db: AsyncSession, env: Environment, machines: list) -> dict:
    """A LAN Blue/Green environment: Nginx Proxy Manager → its two app VMs
    (orange, purple), each with its slot's commit and last smoke test."""
    url = (await integrations.config_of(db, "npm")).get("url")
    npm_host = urlsplit(url).hostname if url else None
    rows = await lan_slots.slots_of(db, env.id)
    by_role = {m.role: m for m in machines}
    servers = []
    for slot in env.slots:
        r, m = rows.get(slot), by_role.get(slot)
        built = bool(m and m.created) or bool(r and r.sha)
        state = "live" if slot == env.active_slot else "idle" if built else "empty"
        health = ("unknown" if r is None or r.last_check_ok is None
                  else "healthy" if r.last_check_ok else "degraded")
        servers.append({"id": slot, "label": slot.title(),
                        "sub": m.ip if m and m.ip else "Not built yet", "state": state,
                        "health": health, "version": r.image_tag if r else None,
                        "deployed": bool(r and r.sha)})
    deploying, failed = await _marks(db, env, lan=False)
    return {"kind": "proxy",
            "middle": {"label": "Nginx Proxy Manager", "sub": npm_host or "Not set up",
                       "status": "ok" if npm_host else "unknown"},
            "servers": servers, "active_slot": env.active_slot,
            "certificate": None,    # from the live check (_certificates)
            "deploying_slot": deploying, "failed_slot": failed}


def _version(env: Environment) -> str | None:
    return env.image_tag or (env.current_sha[:8] if env.current_sha else None)


async def _portal_url(db: AsyncSession, env_id) -> str | None:
    """The environment's portal address, for the spotlight's traffic box to open."""
    host = await db.scalar(select(EnvironmentService.hostname).where(
        EnvironmentService.environment_id == env_id, EnvironmentService.service == "portal"))
    return f"https://{host}" if host else None


async def _environment_card(db: AsyncSession, settings: Settings, env: Environment,
                            inventories: dict[str, dict], now: datetime) -> dict:
    last = await _last_release(db, env.id)
    if env.target_id == targets.DO_TARGET:
        row = await do_envs.get(db, env.id)
        do = None
        if row:
            # Read once: the infrastructure tree reuses them (see environment_cards).
            do = {"row": row, "slots": await do_envs.slots_of(db, env.id),
                  "records": await _records(db, env.id)}
            flow = await _do_flow(db, env, row, do["slots"], do["records"],
                                  inventories.get(row.account_key))
        else:
            flow = _empty_flow()
    elif lan_slots.is_bluegreen(env):
        # Read once: the infrastructure tree lists the same VMs (see environment_cards).
        do = {"machines": await vms.machines(db, env)}
        flow = await _lan_bluegreen_flow(db, env, do["machines"])
    else:
        do, flow = None, await _lan_flow(db, settings, env)
    running = await db.scalar(select(Deployment.id).where(
        Deployment.environment_id == env.id, Deployment.status == "running").limit(1))
    return {"id": env.name, "label": env.name,
            "sub": _TYPE_LABELS.get(env.type, env.type.title()), "state": _env_state(env),
            "version": _version(env), "last_release": last.sha[:8] if last else None,
            "last_release_at": (last.finished_at.isoformat()
                                if last and last.finished_at else None),
            "action_label": f"Deploy {env.name}", "environment": env.name,
            "production": env.type == "production", "primary": False,
            "retiring": bool(env.retiring), "running": running is not None,
            "portal_url": await _portal_url(db, env.id), "flow": flow, "_do": do}


def _placeholder(env: str, action_label: str, *, production: bool = False) -> dict:
    return {"id": env, "label": _label(env), "sub": None, "state": "empty", "version": None,
            "last_release": None, "last_release_at": None, "action_label": action_label,
            "environment": None, "production": production, "primary": False,
            "retiring": False, "running": False, "portal_url": None, "flow": _empty_flow()}


async def environment_cards(db: AsyncSession | None, settings: Settings, tagged: list[str],
                            inventories: dict[str, dict], now: datetime, *,
                            refresh: bool = False,
                            built: list[tuple] | None = None) -> list[dict]:
    """Production first (the live one, else a retiring one, else a
    placeholder), Dev / Beta (placeholders until one exists), the rest by
    name, then DigitalOcean env tags no environment answers to. `built`
    (when given) receives (environment, card, reads or None) for every real
    card, in card order: the DigitalOcean records, or a LAN Blue/Green
    environment's VMs ({"machines": [...]}); the reads never reach the card."""
    rows: list[Environment] = []
    hostnames: dict = {}
    if db is not None:
        rows = list(await db.scalars(select(Environment).order_by(Environment.name)))
        hostnames = await _public_hostnames(db, [e.id for e in rows])
    # One bounded, concurrent check of every card's public hostnames, running
    # while the cards are built (it never touches the session).
    checking = asyncio.ensure_future(
        cert_checker.check_all([h for hs in hostnames.values() for h in hs], refresh=refresh)
        if hostnames else _no_checks())

    built = [] if built is None else built

    async def card(e: Environment) -> dict:
        c = await _environment_card(db, settings, e, inventories, now)
        built.append((e, c, c.pop("_do", None)))
        return c

    try:
        prods = sorted((e for e in rows if e.type == "production"), key=lambda e: e.retiring)
        first = prods[0] if prods else None
        cards = [await card(first) if first else
                 _placeholder("production", "Set up Production", production=True)]
        # Only card 0 is the Production card; a retiring production listed later
        # keeps production: true but isn't primary.
        cards[0]["primary"] = True
        for type_, short in (("dev", "Dev"), ("beta", "Beta")):
            typed = [e for e in rows if e.type == type_]
            if typed:
                cards += [await card(e) for e in typed]
            else:
                cards.append(_placeholder(type_, f"Set up {short}"))
        cards += [await card(e) for e in rows if e.type not in ("dev", "beta") and e is not first]
        known = {e.name for e in rows}
        cards += [_placeholder(e, f"Set up {_label(e)}") for e in tagged if e not in known]
    except BaseException:
        checking.cancel()            # its checks still finish and fill the cache
        raise
    checked = await checking
    for env, c, _ in built:
        c["flow"]["certificate"] = certificate_of(
            [checked[h] for h in hostnames.get(env.id, [])], now)
    return cards


# ---- the infrastructure tree: every environment's parts ------------------------------

_BAD = ("not_found", "degraded", "stopped", "expired")
_LIVE = ("active", "running", "healthy")
_SERVER_KINDS = ("droplet", "server")


def _env_rollup(children: list[dict], *, unreadable: bool) -> tuple[str, str]:
    """Active only from a server or slot; the proxy and the certificate can
    only degrade it (an expired certificate, or one no host answered for
    while a server is live). An account that couldn't be read is Unknown."""
    live = any(c["kind"] in _SERVER_KINDS and c["status"] in _LIVE for c in children)
    unchecked = any(c["kind"] == "certificate" and c["status"] == "unknown" for c in children)
    if any(c["status"] in _BAD for c in children) or (live and unchecked):
        return "degraded", "Degraded"
    if unreadable:
        return "unknown", "Unknown"
    return ("active", "Active") if live else ("inactive", "Inactive")


def _found(inv: dict | None, item: dict | None, status) -> tuple[str, str]:
    """A recorded resource's status: Unknown when its account couldn't be
    read, Not found when the inventory doesn't have it."""
    if inv is None:
        return "unknown", "Unknown"
    if item is None:
        return "not_found", "Not found"
    return status(item)


def _days(n: int) -> str:
    return f"{n} day{'' if n == 1 else 's'} left"


def _cert_node(env_name: str, cert: dict | None) -> dict | None:
    """The certificate part: the live check's soonest expiry, amber
    ("expiring") inside the renewal window."""
    if cert is None:
        return None
    if cert["tone"] == "unknown" or cert["days_left"] is None:
        status, label = "unknown", "Couldn't check"
    elif cert["tone"] == "bad":
        status, label = "expired", "Expired"
    else:
        status = "expiring" if cert["tone"] == "warn" else "healthy"
        label = _days(cert["days_left"])
    soonest = next((h["hostname"] for h in cert["hosts"]
                    if h["expires_at"] and h["expires_at"] == cert["expires_at"]), "—")
    return node(f"{env_name}:certificate", "Certificate", "certificate", "TLS certificate",
                status, label, region="—", endpoint=soonest)


def _public_ip(d: dict | None) -> str | None:
    v4 = ((d or {}).get("networks") or {}).get("v4") or []
    return next((n.get("ip_address") for n in v4
                 if isinstance(n, dict) and n.get("type") == "public"), None)


def _slot_part(env: Environment, row: DoEnvironment, slot: str, r, rec: DoResource | None,
               droplets: dict, inv: dict | None, region: str) -> tuple[dict, str | None]:
    """One slot's droplet: the slot's own record, else (a droplet that never
    became ready) the do_resources record made for that slot. Its status is
    the droplet's power state, Degraded when it runs but fails its check."""
    droplet_id = (r.droplet_id if r else None) or (rec.do_id if rec else None)
    nid = f"{env.name}:slot-{slot}"
    if not droplet_id:
        return node(nid, slot.title(), "droplet", f"Droplet · {row.droplet_size}", "inactive",
                    "Not built yet", region=region), None
    found = droplets.get(str(droplet_id))
    status, label = _found(inv, found, _droplet_status)
    if status == "running" and r is not None and _slot_health(r, found) == "degraded":
        status, label = "degraded", "Degraded"
    word = "live" if slot == env.active_slot else "idle"
    size = (found or {}).get("size_slug") or row.droplet_size
    return node(nid, f"{slot.title()} ({word})", "droplet", f"Droplet · {size}", status, label,
                region=region, endpoint=(r.public_ip if r else None) or _public_ip(found) or "—",
                badge=r.image_tag if r else None), str(droplet_id)


def _do_parts(env: Environment, do: dict, inv: dict | None) -> tuple[list[dict], set[str]]:
    """Sirdar's records for the environment (read once, with its card) joined
    to its account's cached inventory: no DigitalOcean call of its own.
    Returns the parts and the DigitalOcean ids they show."""
    row, slots, records = do["row"], do["slots"], do["records"]
    region = row.region.upper()
    by_id = {kind: {str(x.get("id")): x for x in (inv or {}).get(kind, [])}
             for kind in ("droplets", "databases", "load_balancers")}
    parts: list[dict] = []
    shown: set[str] = set()
    if lb := _newest(records, "load_balancer"):
        found = by_id["load_balancers"].get(lb.do_id)
        status, label = _found(inv, found, _lb_status)
        parts.append(node(f"{env.name}:lb", lb.name, "load_balancer", "Load balancer", status,
                          label, region=region,
                          endpoint=(found or {}).get("ip") or row.lb_ip or "—"))
        shown.add(lb.do_id)
    for slot in env.slots:
        part, droplet_id = _slot_part(env, row, slot, slots.get(slot),
                                      _newest(records, "droplet", slot), by_id["droplets"], inv,
                                      region)
        parts.append(part)
        if droplet_id:
            shown.add(droplet_id)
    if database := _newest(records, "database"):
        found = by_id["databases"].get(database.do_id)
        status, label = _found(inv, found, _database_status)
        size = (found or {}).get("size") or row.db_size
        parts.append(node(f"{env.name}:database", database.name, "database",
                          f"Managed PostgreSQL · {size}", status, label, region=region,
                          endpoint=_private_host(found) or row.db_host or "—"))
        shown.add(database.do_id)
    if bucket := _newest(records, "bucket"):
        # Spaces isn't in the inventory: the bucket is listed, not checked.
        parts.append(node(f"{env.name}:bucket", bucket.name, "spaces", "Spaces bucket",
                          "unknown", "Not checked", region=region))
    return parts, shown


_HEALTH = {"healthy": ("healthy", "Healthy"), "degraded": ("degraded", "Degraded")}


def _bluegreen_parts(env: Environment, flow: dict, machines: list) -> list[dict]:
    """Nginx Proxy Manager, the data VM and both app VMs. The data VM is a
    "database" part: it holds the data, and only an app VM makes the
    environment Active."""
    middle = flow["middle"]
    ok = middle["status"] == "ok"
    parts = [node(f"{env.name}:npm", "Nginx Proxy Manager", "proxy", "Reverse proxy",
                  "active" if ok else "unknown", "Active" if ok else "Not set up",
                  region="LAN", endpoint=middle["sub"] if ok else "—")]
    data = next((m for m in machines if m.role == vms.DATA), None)
    if data is not None:
        parts.append(node(f"{env.name}:data", data.name, "database", "Data VM",
                          "active" if data.created else "inactive",
                          "Built" if data.created else "Not built yet", region="LAN",
                          endpoint=data.ip or "—"))
    vm_names = {m.role: m.name for m in machines}
    for s in flow["servers"]:
        live = ", live" if s["state"] == "live" else ""
        status = (("inactive", "Not built yet") if s["state"] == "empty"
                  else _HEALTH.get(s["health"], ("unknown", "Unknown")))
        parts.append(node(f"{env.name}:{s['id']}",
                          vm_names.get(s["id"]) or vms.vm_name(env.name, s["id"]), "server",
                          f"App VM ({s['label']}{live})", *status, region="LAN",
                          endpoint=s["sub"], badge=s["version"]))
    return parts


def _lan_parts(env: Environment, flow: dict) -> list[dict]:
    """Nginx Proxy Manager and the one host, as the card's flow shows them."""
    middle, server = flow["middle"], flow["servers"][0]
    ok = middle["status"] == "ok"
    health = _HEALTH.get(server["health"], ("unknown", "Unknown"))
    kind = "VM" if targets.is_vm_target(env.target_id) else "SSH host"
    return [node(f"{env.name}:npm", "Nginx Proxy Manager", "proxy", "Reverse proxy",
                 "active" if ok else "unknown", "Active" if ok else "Not set up", region="LAN",
                 endpoint=middle["sub"] if ok else "—"),
            node(f"{env.name}:server", server["label"], "server", kind, *health, region="LAN",
                 endpoint=server["sub"] or "—", badge=server["version"])]


def environment_nodes(built: list[tuple], inventories: dict[str, dict],
                      labels: dict[str, str]) -> tuple[list[dict], set[str]]:
    """One node per real card, in card order, `id` = the card's id; and the
    DigitalOcean ids those nodes show (everything else is "other")."""
    out, shown = [], set()
    for env, card, do in built:
        type_label = _TYPE_LABELS.get(env.type, env.type.title())
        unreadable = False
        if env.target_id == targets.DO_TARGET:
            children, region = [], "—"
            if do:
                row = do["row"]
                inv = inventories.get(row.account_key)
                children, ids = _do_parts(env, do, inv)
                shown |= ids
                unreadable = inv is None
                region = row.region.upper()
                type_label += f" · {labels.get(row.account_key, row.account_key.title())} account"
        elif do is not None:
            children, region = _bluegreen_parts(env, card["flow"], do["machines"]), "LAN"
        else:
            children, region = _lan_parts(env, card["flow"]), "LAN"
        if cert := _cert_node(env.name, card["flow"]["certificate"]):
            children.append(cert)
        status, label = _env_rollup(children, unreadable=unreadable)
        portal = urlsplit(card["portal_url"]).hostname if card["portal_url"] else None
        out.append(node(card["id"], card["label"], "environment", type_label, status, label,
                        region=region, endpoint=portal or "—", children=children))
    return out, shown


async def _read_accounts(db: AsyncSession, settings: Settings, refresh: bool,
                         infra: dict) -> list[tuple[str, str, dict]]:
    """(key, label, inventory) for each account whose inventory was read;
    every account with a token (or an unreadable one) is listed in
    infra["accounts"] with its error."""
    read: list[tuple[str, str, dict]] = []
    for key in do_accounts.KEYS:
        row = await db.get(DoAccount, key)
        label = row.label if row else key.title()
        try:
            resolved = await digitalocean.resolve(db, settings, key)
        except IntegrationError as e:          # a stored token that won't decrypt
            infra["accounts"].append({"key": key, "label": label, "error": e.reason})
            continue
        if not targets.is_configured("digitalocean", resolved):
            continue
        try:
            read.append((key, label, await _inventory(resolved, refresh)))
            infra["accounts"].append({"key": key, "label": label, "error": None})
        except ConnectFailed as e:
            infra["accounts"].append({"key": key, "label": label, "error": e.reason})
    return read


async def build_dashboard(settings: Settings, *, db: AsyncSession | None = None,
                          demo: bool = False, refresh: bool = False) -> dict:
    if demo:
        return demo_dashboard()
    infra: dict = {"source": "none", "error": None, "tree": [], "accounts": []}
    read: list[tuple[str, str, dict]] = []
    if db is not None:
        read = await _read_accounts(db, settings, refresh, infra)
    elif targets.is_configured("digitalocean", settings):
        # No database (unit callers): the server's SIRDAR_DEPLOY_DO_TOKEN only.
        infra["accounts"].append({"key": "production", "label": "Production", "error": None})
        try:
            read = [("production", "Production", await _inventory(settings, refresh))]
        except ConnectFailed as e:
            infra["accounts"][0]["error"] = e.reason
    if infra["accounts"]:
        infra["source"] = "digitalocean"
    failed = [a for a in infra["accounts"] if a["error"]]
    if len(infra["accounts"]) == 1 and failed:
        infra["error"] = failed[0]["error"]
    elif failed:
        infra["error"] = " ".join(f"{a['label']} account: {a['error']}" for a in failed)
    inventories = {key: inv for key, _, inv in read}
    every = [r for _, _, inv in read for kind in ("droplets", "databases", "load_balancers")
             for r in inv[kind]]
    tagged = sorted({e for r in every if (e := _env_of(r)) and e not in _FIXED})
    built: list[tuple] = []
    envs = await environment_cards(db, settings, tagged, inventories, datetime.now(UTC),
                                   refresh=refresh, built=built)
    managed: set[str] = set()
    if db is not None:
        labels = {a.key: a.label for a in await db.scalars(select(DoAccount))}
        infra["tree"], managed = environment_nodes(built, inventories, labels)
    single = len(infra["accounts"]) == 1
    for account in infra["accounts"]:
        group = other_resources(account, inventories.get(account["key"]), managed,
                                single=single)
        if group:
            infra["tree"].append(group)
    return {"demo": False, "generated_at": datetime.now(UTC).isoformat(),
            "health": _health(envs), "environments": envs, "infrastructure": infra}
