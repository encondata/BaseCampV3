"""Demo fixture for the Dashboard: mirrors the mockup with ServerSherpa names."""

from datetime import UTC, datetime

_DOT = {"active": "green", "running": "green", "healthy": "green", "available": "green",
        "standby": "blue"}


def node(id_, name, kind, type_label, status, status_label, *, region="NYC3", endpoint="—",
         badge=None, children=None, tone=None) -> dict:
    return {"id": id_, "name": name, "kind": kind, "type_label": type_label, "status": status,
            "status_label": status_label, "region": region, "endpoint": endpoint, "badge": badge,
            "dot": _DOT.get(status, "gray"), "tone": tone, "children": children or []}


def _droplets(prefix: str, first_ip: int, status: str, label: str) -> list[dict]:
    return [node(f"{prefix}-{svc}", f"{prefix}-{svc}", "droplet", "Droplet", status, label,
                 endpoint=f"10.20.0.{first_ip + i}")
            for i, svc in enumerate(("api", "portal", "kiosk", "wiki"))]


def _env_resources(env: str) -> list[dict]:
    return [node(f"{env}-web", f"{env}-web", "droplet", "Droplet", "stopped", "Stopped"),
            node(f"{env}-db", f"{env}-db", "database", "Managed PostgreSQL", "available",
                 "Available", endpoint=f"{env}-db.internal"),
            node(f"{env}-spaces", f"{env}-spaces", "spaces", "Spaces", "available", "Available",
                 endpoint=f"{env}-assets")]


def demo_dashboard() -> dict:
    tree = [
        node("env-production", "Production", "environment", "Environment", "active", "Active",
             children=[
                 node("prod-blue", "Blue", "deployment", "Deployment", "active", "Active",
                      children=_droplets("prod-blue", 10, "running", "Running")),
                 node("prod-green", "Green", "deployment", "Deployment", "standby", "Standby",
                      children=_droplets("prod-green", 20, "standby", "Standby")),
                 node("prod-shared", "Shared production resources", "group", "Shared resources",
                      "healthy", "Healthy", badge="Blue + Green", tone="shared", children=[
                          node("prod-db", "prod-db", "database", "Managed PostgreSQL", "healthy",
                               "Healthy", endpoint="prod-db.internal"),
                          node("prod-spaces", "prod-spaces", "spaces", "Spaces", "available",
                               "Available", endpoint="prod-assets")])]),
        node("env-dev", "Development", "environment", "Environment", "inactive", "Inactive",
             children=_env_resources("dev")),
        node("env-beta", "Beta", "environment", "Environment", "inactive", "Inactive",
             children=_env_resources("beta")),
    ]
    return {
        "demo": True,
        "generated_at": datetime.now(UTC).isoformat(),
        "health": {"status": "healthy", "label": "All systems healthy"},
        "production": {
            "status": "active", "active_slot": "blue",
            "traffic": {"label": "Live traffic", "sub": "External users"},
            "load_balancer": {"label": "Load balancer", "sub": "Blue active", "present": True},
            "slots": [
                {"id": "blue", "label": "Production Blue", "state": "active", "health": "healthy",
                 "version": "v2.8.0", "instances": {"running": 3, "total": 3}, "traffic_pct": 100},
                {"id": "green", "label": "Production Green", "state": "standby",
                 "health": "unknown", "version": "v2.7.9",
                 "instances": {"running": 0, "total": 3}, "traffic_pct": 0},
            ]},
        "environments": [
            {"id": "dev", "label": "Development", "sub": None, "state": "empty",
             "version": None, "last_release": "v2.8.1-dev", "last_release_at": None,
             "action_label": "Deploy to Dev", "environment": None},
            {"id": "beta", "label": "Beta", "sub": None, "state": "empty", "version": None,
             "last_release": "v2.8.1-rc.2", "last_release_at": None,
             "action_label": "Deploy to Beta", "environment": None},
        ],
        "infrastructure": {"source": "demo", "error": None, "tree": tree},
    }
