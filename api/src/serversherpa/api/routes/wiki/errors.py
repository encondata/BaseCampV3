"""Small pieces every `/wiki` route module reaches for: a uniform
HTTPException shape (`err`, plus the ones everyone raises — `not_found`,
`forbidden` and `conflict`), and the "does this level allow writing?" check
(`is_edit`) route handlers use to turn a level into a 403."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from serversherpa.wiki.permissions import level_rank


def err(status: int, code: str, message: str | None = None, **extra: Any) -> HTTPException:
    """`detail = {"code": code, "message": message, **extra}` — `message`
    is left out when not given, and `extra` carries any structured detail
    a client acts on (e.g. the offending setting keys)."""
    detail: dict[str, Any] = {"code": code}
    if message is not None:
        detail["message"] = message
    return HTTPException(status_code=status, detail={**detail, **extra})


def not_found() -> HTTPException:
    return err(404, "not_found", "Not found.")


def conflict() -> HTTPException:
    """409 for a tree operation that raced another one (spec §9)."""
    return err(409, "conflict", "That item changed while you were working. Try again.")


def forbidden(needed: str) -> HTTPException:
    """403 for a caller who can see the thing but lacks `needed` on it."""
    return err(403, "forbidden", f"You need {needed} access to do that.")


def is_edit(level: str | None) -> bool:
    return level_rank(level) >= level_rank("edit")
