"""Per-item visibility for notes and Notes & files attachments.

    everyone  anyone who can see the host record (clients included)
    internal  global (staff) actors only
    admin     global actors at Admin rank (60) or higher

Spec: docs/superpowers/specs/2026-10-08-note-file-visibility-design.md
"""

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import AccessInfo

VISIBILITY_LEVELS: tuple[str, ...] = ("everyone", "internal", "admin")


def visible_levels(access: AccessInfo) -> tuple[str, ...]:
    """The levels this actor may read (and therefore set)."""
    if not access.is_global:
        return ("everyone",)
    if access.max_rank >= GATE_BYPASS_RANK:
        return VISIBILITY_LEVELS
    return ("everyone", "internal")


def can_set_visibility(access: AccessInfo, level: str) -> bool:
    return level in visible_levels(access)
