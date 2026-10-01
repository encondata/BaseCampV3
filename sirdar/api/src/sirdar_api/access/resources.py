"""Everything Sirdar can grant. One row per resource; actions are fixed."""

from dataclasses import dataclass

ACTIONS: tuple[str, ...] = ("view", "add", "change", "delete")


@dataclass(frozen=True)
class Resource:
    id: str
    label: str
    developer_only: bool = False   # hard gate: only the developer role, no override reaches it


REGISTRY: dict[str, Resource] = {r.id: r for r in (
    Resource("dashboard", "Dashboard"),
    Resource("users", "Users"),
    Resource("access", "Roles & access"),
    Resource("audit", "Audit log"),
    Resource("settings", "Settings"),
    Resource("devtools", "Developer tools", developer_only=True),
)}
