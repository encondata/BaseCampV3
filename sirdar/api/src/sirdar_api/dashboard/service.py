"""Dashboard data. There are no deployment records yet (deploy step 2), so
production and the environments are derived: everything is empty, and only the
DigitalOcean inventory (grouped by sirdar-* tags) is real."""

import hashlib
import time
from datetime import UTC, datetime

from sirdar_api.config import Settings
from sirdar_api.dashboard.demo import demo_dashboard, node
from sirdar_api.deploy import ConnectFailed, digitalocean, names, targets

CACHE_SECONDS = 30
FAILURE_SECONDS = 10
_cache: dict[str, tuple[float, dict | str]] = {}
_FIXED = ("production", "dev", "beta")
_LABELS = {"production": "Production", "dev": "Development", "beta": "Beta"}
_DROPLET = {"active": ("running", "Running"), "off": ("stopped", "Stopped"),
            "new": ("provisioning", "Provisioning")}


def clear_cache() -> None:
    _cache.clear()


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


def _slot_of(resource: dict) -> str | None:
    slots = [t[len("sirdar-slot:"):] for t in _tags(resource) if t.startswith("sirdar-slot:")]
    return slots[0] if slots and slots[0] in ("blue", "green") else None


def _region(resource: dict) -> str:
    region = resource.get("region")
    slug = region.get("slug") if isinstance(region, dict) else region
    return str(slug).upper() if slug else "—"


def _droplet_node(d: dict) -> dict:
    status, label = _DROPLET.get(d.get("status"), ("unknown", "Unknown"))
    v4 = (d.get("networks") or {}).get("v4") or []
    ips = {n.get("type"): n.get("ip_address") for n in v4 if isinstance(n, dict)}
    name = str(d.get("name") or d.get("id"))
    return node(f"droplet-{d.get('id')}", name, "droplet", "Droplet", status, label,
                region=_region(d), endpoint=ips.get("private") or ips.get("public") or "—")


def _database_node(d: dict) -> dict:
    ok = d.get("status") == "online"
    host = ((d.get("private_connection") or {}).get("host")
            or (d.get("connection") or {}).get("host") or "—")
    name = str(d.get("name") or d.get("id"))
    return node(f"database-{d.get('id')}", name, "database", "Managed PostgreSQL",
                "healthy" if ok else "unknown", "Healthy" if ok else "Unknown",
                region=_region(d), endpoint=host)


def _lb_node(d: dict) -> dict:
    ok = d.get("status") == "active"
    name = str(d.get("name") or d.get("id"))
    return node(f"lb-{d.get('id')}", name, "load_balancer", "Load balancer",
                "active" if ok else "unknown", "Active" if ok else "Unknown",
                region=_region(d), endpoint=d.get("ip") or "—")


def _rollup(children: list[dict]) -> tuple[str, str]:
    live = any(c["status"] in ("active", "running", "healthy") for c in children)
    return ("active", "Active") if live else ("inactive", "Inactive")


def build_tree(inv: dict) -> list[dict]:
    """Environment nodes (production, dev, beta, then custom by name), then Untagged."""
    envs: dict[str, dict] = {}
    untagged: list[dict] = []
    for kind, items, make in (("droplet", inv["droplets"], _droplet_node),
                              ("database", inv["databases"], _database_node),
                              ("lb", inv["load_balancers"], _lb_node)):
        for r in items:
            n, env = make(r), _env_of(r)
            if env is None:
                untagged.append(n)
                continue
            bucket = envs.setdefault(env, {"blue": [], "green": [], "shared": [], "rest": []})
            if env == "production" and "sirdar-shared" in _tags(r):
                bucket["shared"].append(n)
            elif env == "production" and kind == "droplet" and _slot_of(r):
                bucket[_slot_of(r)].append(n)
            elif env == "production" and kind != "droplet":
                bucket["shared"].append(n)
            else:
                bucket["rest"].append(n)
    tree = []
    for env in sorted(envs, key=lambda e: (_FIXED.index(e) if e in _FIXED else 3, e)):
        b = envs[env]
        children: list[dict] = []
        if env == "production":
            for slot in ("blue", "green"):
                status, label = _rollup(b[slot])
                children.append(node(f"prod-{slot}", slot.title(), "deployment", "Deployment",
                                     status, label, children=b[slot]))
            if b["shared"]:
                status, label = _rollup(b["shared"])
                children.append(node("prod-shared", "Shared production resources", "group",
                                     "Shared resources", status, label, badge="Blue + Green",
                                     children=b["shared"]))
        children += b["rest"]
        status, label = _rollup(children)
        tree.append(node(f"env-{env}", _label(env), "environment", "Environment", status, label,
                         children=children))
    if untagged:
        tree.append(node("untagged", "Untagged", "group", "Untagged resources", "unknown",
                         "Unknown", children=untagged))
    return tree


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
        inv = await digitalocean.inventory(settings, transport=transport)
    except ConnectFailed as e:
        _cache[key] = (time.monotonic(), e.reason)
        raise
    _cache[key] = (time.monotonic(), inv)
    return inv


async def build_dashboard(settings: Settings, *, demo: bool = False,
                          refresh: bool = False) -> dict:
    if demo:
        return demo_dashboard()
    infra: dict = {"source": "none", "error": None, "tree": []}
    inv: dict = {"droplets": [], "databases": [], "load_balancers": []}
    if targets.is_configured("digitalocean", settings):
        infra["source"] = "digitalocean"
        try:
            inv = await _inventory(settings, refresh)
            infra["tree"] = build_tree(inv)
        except ConnectFailed as e:
            infra["error"] = e.reason
    has_lb = any(_env_of(lb) == "production" for lb in inv["load_balancers"])
    customs = sorted({e for r in (*inv["droplets"], *inv["databases"], *inv["load_balancers"])
                      if (e := _env_of(r)) and e not in _FIXED})
    envs = [{"id": e, "label": _label(e), "state": "empty", "version": None,
             "last_release": None,
             "action_label": {"dev": "Deploy to Dev", "beta": "Deploy to Beta"}.get(
                 e, f"Deploy to {_label(e)}")} for e in (*_FIXED[1:], *customs)]
    slots = [{"id": s, "label": f"Production {s.title()}", "state": "empty", "health": "unknown",
              "version": None, "instances": {"running": 0, "total": 0}, "traffic_pct": 0}
             for s in ("blue", "green")]
    return {
        "demo": False,
        "generated_at": datetime.now(UTC).isoformat(),
        "health": {"status": "unknown", "label": "No environments deployed"},
        "production": {
            "status": "inactive", "active_slot": None,
            "traffic": {"label": "Live traffic", "sub": "External users"},
            "load_balancer": {"label": "Load balancer",
                              "sub": "Configured" if has_lb else "Not configured",
                              "present": has_lb},
            "slots": slots},
        "environments": envs,
        "infrastructure": infra,
    }
