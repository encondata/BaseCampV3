"""Live copy of the seeded roles and permission matrix (migration 0001
holds the frozen snapshot; test_access.py checks the two agree). Tests
use restore_default_roles to reset the matrix between runs."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

FULL = ("view", "add", "change", "delete")
DEPLOY = ("view", "add", "change")   # no delete action on Deploy

# name, label, rank — the portal's global roles at rank >= 60
DEFAULT_ROLES: list[tuple[str, str, int]] = [
    ("developer", "Developer", 100),
    ("founder", "Founder", 100),
    ("super_admin", "Super admin", 80),
    ("admin", "Administrator", 60),
]

DEFAULT_GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    "developer": {"dashboard": ("view",), "users": FULL, "access": FULL,
                  "audit": ("view",), "settings": FULL, "deploy": DEPLOY, "devtools": FULL},
    "founder": {"dashboard": ("view",), "users": FULL, "access": FULL,
                "audit": ("view",), "settings": FULL, "deploy": DEPLOY},
    "super_admin": {"dashboard": ("view",), "users": FULL, "access": ("view", "change"),
                    "audit": ("view",), "settings": ("view", "change"), "deploy": DEPLOY},
    "admin": {"dashboard": ("view",), "users": ("view",), "access": ("view",),
              "audit": ("view",), "settings": ("view",), "deploy": ("view",)},
}


async def restore_default_roles(db: AsyncSession) -> None:
    """Delete every role (cascading user_roles + role_permissions) and
    re-seed the defaults. Does not commit."""
    await db.execute(text("DELETE FROM roles"))
    for name, label, rank in DEFAULT_ROLES:
        await db.execute(
            text("INSERT INTO roles (name, label, rank) VALUES (:n, :l, :r)"),
            {"n": name, "l": label, "r": rank})
    for role, grants in DEFAULT_GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                await db.execute(
                    text("INSERT INTO role_permissions (role, resource, action) "
                         "VALUES (:ro, :re, :a)"),
                    {"ro": role, "re": resource, "a": action})
