"""Small pieces every `/wiki` route module reaches for: a uniform
HTTPException shape (`err`), and the "does this level allow writing?"
check (`is_edit`) route handlers use to turn a level into a 403."""
from __future__ import annotations

from fastapi import HTTPException

from serversherpa.wiki.permissions import level_rank


def err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def is_edit(level: str | None) -> bool:
    return level_rank(level) >= level_rank("edit")
