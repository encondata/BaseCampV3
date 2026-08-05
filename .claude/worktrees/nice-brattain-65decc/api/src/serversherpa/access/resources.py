"""Resource registry — the code-side list of app surfaces access control
knows about. Deploys introduce resources; the DB stores only grants."""

from dataclasses import dataclass, field

ACTIONS: tuple[str, ...] = ("view", "add", "change", "delete")


@dataclass(frozen=True)
class Resource:
    id: str
    label: str
    routes: tuple[str, ...] = ()
    # which scope anchors can see this resource at all (hard gate)
    visible_to: frozenset[str] = field(
        default_factory=lambda: frozenset({"global"}))
    developer_only: bool = False
    always_viewable: bool = False


_RESOURCES = [
    Resource("dashboard", "Dashboard", routes=("/",),
             visible_to=frozenset({"global", "client", "partner", "self"})),
    Resource("users", "Users", routes=("/people/users",)),
    Resource("workers", "Workers", routes=("/people/workers",),
             visible_to=frozenset({"global", "partner", "self"})),
    Resource("clients", "Clients", routes=("/stakeholders/clients",),
             visible_to=frozenset({"global", "client"})),
    Resource("partners", "Partners", routes=("/stakeholders/partners",),
             visible_to=frozenset({"global", "partner"})),
    Resource("attachments", "Files & attachments",
             visible_to=frozenset({"global", "client", "partner"})),
    Resource("settings", "Settings", routes=("/settings",)),
    Resource("access", "Access control", routes=("/access",),
             always_viewable=True),
    Resource("audit", "Audit log", routes=("/audit",)),
    Resource("devtools", "Developer tools", developer_only=True),
]

REGISTRY: dict[str, Resource] = {r.id: r for r in _RESOURCES}
ROUTE_RESOURCE: dict[str, str] = {
    route: r.id for r in _RESOURCES for route in r.routes}
