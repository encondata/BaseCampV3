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
    Resource("users", "Users", routes=("/people/users",),
             # "self" so a per-person override can let an external-anchored
             # contact see their own /external row — no role grants "users"
             # by default for self/client/partner anchors, so this alone
             # doesn't widen anyone's access.
             #
             # Write-side note: visible_to gates the whole resource, not
             # individual actions — a users:change/add/delete override
             # handed to a non-global (self/client/partner-anchored)
             # person would pass require_permission() here too, not just
             # view. The users-router's mutating endpoints (reset-password,
             # disable/enable/unlock, profile PATCH, create) enforce rank
             # only and have no row-level scope, so they each additionally
             # require actor.access.is_global outright rather than relying
             # on this hard gate to keep non-global actors out.
             visible_to=frozenset({"global", "self"})),
    Resource("workers", "Workers", routes=("/people/workers",),
             visible_to=frozenset({"global", "partner", "self"})),
    Resource("clients", "Clients", routes=("/stakeholders/clients",),
             visible_to=frozenset({"global", "client"})),
    Resource("partners", "Partners", routes=("/stakeholders/partners",),
             visible_to=frozenset({"global", "partner"})),
    Resource("sites", "Sites", routes=("/sites",),
             # internal-only: no client/partner-anchored actor may see this
             # resource, even via a per-person override — the hard gate in
             # resolver.py blocks on visible_to before overrides are read.
             visible_to=frozenset({"global"})),
    Resource("assets", "Assets", routes=("/assets",),
             # client-visible: client org roles see their own org's assets
             # read-only via SCOPE_COLUMNS; writes are globally anchored.
             visible_to=frozenset({"global", "client"})),
    Resource("asset_models", "Makes / Models", routes=("/assets/models",),
             # internal-only: the catalog (incl. the knowledge field) is house
             # IP. Asset payloads embed a read-only model summary instead.
             visible_to=frozenset({"global"})),
    Resource("containers", "Containers", routes=("/logistics/containers",),
             # internal-only, like sites — no client/partner visibility.
             visible_to=frozenset({"global"})),
    Resource("trucks", "Trucks / Shipments", routes=("/logistics/trucks",),
             visible_to=frozenset({"global"})),
    Resource("warehouse", "Warehouse", routes=("/logistics/warehouse",),
             visible_to=frozenset({"global"})),
    Resource("initiatives", "Initiatives", routes=("/initiatives",),
             # client-visible: client org roles see their own org's
             # initiatives read-only via SCOPE_COLUMNS (the client
             # work-history view); writes stay globally anchored.
             visible_to=frozenset({"global", "client"})),
    Resource("scans", "Scans", routes=("/admin/scans",),
             # internal-only Admin forensic surface, same posture as audit.
             visible_to=frozenset({"global"})),
    Resource("status_rules", "Status rules", routes=("/admin/status-rules",),
             # internal-only Admin automation surface, same posture as scans.
             visible_to=frozenset({"global"})),
    Resource("scanning_hardware", "Scanning hardware",
             routes=("/hardware/fixed-readers", "/hardware/kiosks",
                     "/hardware/routers"),
             # internal-only: device fleet records are house operations data.
             visible_to=frozenset({"global"})),
    Resource("labels", "Labels",
             routes=("/labels/print", "/labels/templates", "/labels/generate",
                     "/labels/printers"),
             visible_to=frozenset({"global"})),
    Resource("reports", "Reports", routes=("/reports",),
             visible_to=frozenset({"global"})),
    Resource("time", "Time", routes=("/people/time",),
             visible_to=frozenset({"global"})),
    Resource("attachments", "Files & attachments",
             visible_to=frozenset({"global", "client", "partner"})),
    Resource("settings", "Settings", routes=("/settings",)),
    Resource("access", "Access control", routes=("/access",),
             always_viewable=True),
    Resource("audit", "Audit log", routes=("/audit",)),
    Resource("devtools", "Developer tools", developer_only=True),
    Resource("notifications", "Notifications", routes=("/system/notifications",)),
    # /ai/chat is a backend API endpoint, not a frontend page route (unlike
    # the routes= entries above), so it's left out of the route map.
    # The AI tools' flat can()-based gate (see ai/tools.py) is safe only
    # because this resource keeps the default visible_to = {"global"} — it
    # has no scope-aware row filtering, so do not widen visible_to here.
    Resource("ai", "AI assistant"),
    # The kiosk app (kiosk/): who may sign in to a kiosk (password login
    # with client="kiosk", approving a phone pairing, the heartbeat).
    # Not a portal page, so no routes. Workers are self-anchored, hence
    # "self" in visible_to; no client/partner role holds it by default.
    Resource("kiosk", "Kiosk", visible_to=frozenset({"global", "self"})),
]

REGISTRY: dict[str, Resource] = {r.id: r for r in _RESOURCES}
ROUTE_RESOURCE: dict[str, str] = {
    route: r.id for r in _RESOURCES for route in r.routes}
