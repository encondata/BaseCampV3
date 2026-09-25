"""Live copy of the seeded permission matrix (migration 0009 holds the
frozen snapshot). Used by tests to restore the matrix between runs."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GATE_BYPASS_RANK = 60
TOP_RANK = 100

FULL = ("view", "add", "change", "delete")
_ALL = ["dashboard", "users", "workers", "clients", "partners",
        "attachments", "settings", "access", "audit", "devtools", "sites",
        "assets", "asset_models", "containers", "trucks", "warehouse", "initiatives", "scans",
        "status_rules", "scanning_hardware", "labels", "reports", "time",
        "notifications", "ai", "kiosk"]
# resources that only ever carry `view`, whoever holds them
VIEW_ONLY = ("ai", "kiosk")

# wiki caps at view/add/delete — it never grants `change` (levels within
# a space are governed by wiki_grants, not this resource action); the
# generic FULL/VIEW_ONLY treatment above doesn't fit, so each role's
# wiki tuple is spelled out here and below.
WIKI_ADD_DELETE = ("view", "add", "delete")
WIKI_ADD = ("view", "add")
WIKI_VIEW = ("view",)

DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    "developer":   {**{r: FULL if r not in VIEW_ONLY else ("view",) for r in _ALL},
                    "wiki": WIKI_ADD_DELETE},
    "founder":     {**{r: FULL for r in _ALL if r != "devtools" and r not in VIEW_ONLY},
                    "ai": ("view",), "kiosk": ("view",), "wiki": WIKI_ADD_DELETE},
    "super_admin": {**{r: FULL for r in _ALL if r != "devtools" and r not in VIEW_ONLY},
                    "ai": ("view",), "kiosk": ("view",), "wiki": WIKI_ADD_DELETE},
    "admin": {"dashboard": ("view",), "users": FULL, "workers": FULL,
              "clients": FULL, "partners": FULL, "attachments": FULL,
              "settings": ("view", "change"), "access": ("view", "change"),
              "audit": ("view",), "sites": FULL, "assets": FULL,
              "asset_models": FULL, "containers": FULL, "trucks": FULL,
              "warehouse": FULL, "initiatives": FULL,
              "scans": ("view", "change", "delete"), "status_rules": FULL,
              "scanning_hardware": FULL, "labels": FULL, "reports": FULL,
              "time": FULL, "notifications": FULL, "ai": ("view",),
              "kiosk": ("view",), "wiki": WIKI_ADD_DELETE},
    "staff": {"dashboard": ("view",), "users": ("view", "add", "change"),
              "workers": FULL, "clients": FULL, "partners": FULL,
              "attachments": FULL, "settings": ("view",), "access": ("view",),
              "sites": FULL, "assets": FULL, "asset_models": FULL,
              "containers": FULL, "trucks": FULL, "warehouse": FULL, "initiatives": FULL,
              "scans": ("view",),
              "status_rules": ("view",), "scanning_hardware": ("view",),
              "labels": ("view",), "reports": ("view", "add"), "time": ("view",),
              "kiosk": ("view",), "wiki": WIKI_ADD},
    "client_owner":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",), "assets": ("view",),
                      "initiatives": ("view",), "wiki": WIKI_VIEW},
    "client_admin":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",), "assets": ("view",),
                      "initiatives": ("view",), "wiki": WIKI_VIEW},
    "client_viewer": {"dashboard": ("view",), "clients": ("view",),
                      "assets": ("view",), "initiatives": ("view",),
                      "wiki": WIKI_VIEW},
    "vendor_owner":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",), "wiki": WIKI_VIEW},
    "vendor_admin":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",), "wiki": WIKI_VIEW},
    "vendor_viewer": {"dashboard": ("view",), "partners": ("view",),
                      "wiki": WIKI_VIEW},
    "worker":   {"dashboard": ("view",), "workers": ("view",), "kiosk": ("view",),
                 "wiki": WIKI_VIEW},
    "external": {"wiki": WIKI_VIEW},
}


async def seed_default_grants(session: AsyncSession) -> None:
    for role, grants in DEFAULT_GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                await session.execute(text(
                    "INSERT INTO role_permissions (role, resource, action) "
                    "VALUES (:r, :res, :a) ON CONFLICT DO NOTHING"),
                    {"r": role, "res": resource, "a": action})
