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


def _server(id_, label, sub, state, health, version) -> dict:
    return {"id": id_, "label": label, "sub": sub, "state": state, "health": health,
            "version": version, "deployed": version is not None}


def _do_flow(lb_ip, servers, active, days) -> dict:
    return {"kind": "load_balancer",
            "middle": {"label": "Load balancer", "sub": lb_ip, "status": "ok"},
            "servers": servers, "active_slot": active,
            "certificate": {"days_left": days, "expires_at": "2027-01-04T12:00:00+00:00",
                            "tone": "ok" if days > 14 else "warn"},
            "deploying_slot": None, "failed_slot": None}


def _card(id_, label, sub, state, version, release, action, production, flow) -> dict:
    return {"id": id_, "label": label, "sub": sub, "state": state, "version": version,
            "last_release": release, "last_release_at": None, "action_label": action,
            "environment": None, "production": production, "primary": production,
            "retiring": False, "running": False, "flow": flow}


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
        "environments": [
            _card("production", "Production", "Production", "active", "v2.8.0", "v2.8.0",
                  "Deploy production", True, _do_flow("203.0.113.10", [
                      _server("blue", "Blue", "10.20.0.10", "live", "healthy", "v2.8.0"),
                      _server("green", "Green", "10.20.0.20", "idle", "unknown", "v2.7.9")],
                      "blue", 64)),
            _card("dev", "Development", "Development", "active", "v2.8.1-dev", "v2.8.1-dev",
                  "Deploy to Dev", False, _do_flow("203.0.113.20", [
                      _server("orange", "Orange", "10.30.0.10", "live", "healthy", "v2.8.1-dev"),
                      _server("purple", "Purple", "10.30.0.11", "idle", "healthy", "v2.8.2-dev")],
                      "orange", 12)),
            _card("uat", "UAT", "Custom", "active", "v2.8.1-rc.2", "v2.8.1-rc.2", "Deploy to UAT",
                  False, {"kind": "proxy",
                          "middle": {"label": "Nginx Proxy Manager", "sub": "10.10.48.6",
                                     "status": "ok"},
                          "servers": [_server("host", "Lab box", "10.10.48.63", "live",
                                              "healthy", "v2.8.1-rc.2")],
                          "active_slot": "host", "certificate": None, "deploying_slot": None,
                          "failed_slot": None}),
        ],
        "infrastructure": {"source": "demo", "error": None, "tree": tree, "accounts": []},
    }
