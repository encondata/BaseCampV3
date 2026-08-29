"""Live copy of the seeded permission matrix (migration 0009 holds the
frozen snapshot). Used by tests to restore the matrix between runs."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GATE_BYPASS_RANK = 60
TOP_RANK = 100

FULL = ("view", "add", "change", "delete")
_ALL = ["dashboard", "users", "workers", "clients", "partners",
        "attachments", "settings", "access", "audit", "devtools", "sites",
        "assets", "asset_models", "containers", "initiatives", "scans",
        "time", "notifications"]

DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    "developer":   {r: FULL for r in _ALL},
    "founder":     {r: FULL for r in _ALL if r != "devtools"},
    "super_admin": {r: FULL for r in _ALL if r != "devtools"},
    "admin": {"dashboard": ("view",), "users": FULL, "workers": FULL,
              "clients": FULL, "partners": FULL, "attachments": FULL,
              "settings": ("view", "change"), "access": ("view", "change"),
              "audit": ("view",), "sites": FULL, "assets": FULL,
              "asset_models": FULL, "containers": FULL, "initiatives": FULL,
              "scans": ("view", "change", "delete"), "time": FULL,
              "notifications": FULL},
    "staff": {"dashboard": ("view",), "users": ("view", "add", "change"),
              "workers": FULL, "clients": FULL, "partners": FULL,
              "attachments": FULL, "settings": ("view",), "access": ("view",),
              "sites": FULL, "assets": FULL, "asset_models": FULL,
              "containers": FULL, "initiatives": FULL, "scans": ("view",),
              "time": ("view",)},
    "client_owner":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",), "assets": ("view",)},
    "client_admin":  {"dashboard": ("view",), "clients": ("view", "change"),
                      "attachments": ("view",), "assets": ("view",)},
    "client_viewer": {"dashboard": ("view",), "clients": ("view",),
                      "assets": ("view",)},
    "vendor_owner":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",)},
    "vendor_admin":  {"dashboard": ("view",), "partners": ("view", "change"),
                      "workers": ("view",)},
    "vendor_viewer": {"dashboard": ("view",), "partners": ("view",)},
    "worker":   {"dashboard": ("view",), "workers": ("view",)},
    "external": {},
}


async def seed_default_grants(session: AsyncSession) -> None:
    for role, grants in DEFAULT_GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                await session.execute(text(
                    "INSERT INTO role_permissions (role, resource, action) "
                    "VALUES (:r, :res, :a) ON CONFLICT DO NOTHING"),
                    {"r": role, "res": resource, "a": action})
