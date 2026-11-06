"""Crate estimate for Bulk Actions › Create a move in steps.

A starting point for the crate count, worked out from the From-To check:

- A crate holds two stacks of 10U. A device of 2U or more stays whole in
  one stack (never split across stacks or crates); 1U devices fill gaps.
- A device over 10U is the sole occupant of a crate.
- Racks (model category `rack`) ship standalone and are left out; server
  nodes (form factor or category `node`) ride inside their chassis and are
  left out.
- A device with no matched model, or whose model has no RU size (or 0U),
  counts as 2U.
- Stacks are packed first-fit, largest first. The crates needed get 25%
  added, rounded up, then the wizard's crate cap applies.

Each serial counts once (a file can list one twice). Error rows are left
out: they never become assets."""

import math
import uuid
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AssetModel
from serversherpa.imports.naming import CRATE_MAX

STACK_RU = 10
STACKS_PER_CRATE = 2
UNKNOWN_RU = 2
HEADROOM = 1.25


def crates_needed(sizes: Iterable[int]) -> int:
    """Crates for these device sizes, before headroom."""
    big = 0
    ones = 0
    stacks: list[int] = []            # free RU left in each open stack
    for ru in sorted(sizes, reverse=True):
        if ru > STACK_RU:
            big += 1
        elif ru == 1:
            ones += 1
        else:
            for i, free in enumerate(stacks):
                if free >= ru:
                    stacks[i] = free - ru
                    break
            else:
                stacks.append(STACK_RU - ru)
    spare = sum(stacks)
    if ones > spare:
        stacks.extend([0] * math.ceil((ones - spare) / STACK_RU))
    return big + math.ceil(len(stacks) / STACKS_PER_CRATE)


def with_headroom(crates: int) -> int:
    return math.ceil(crates * HEADROOM - 1e-9)


async def estimate(db: AsyncSession, details: list[dict]) -> dict:
    """The estimate for a check job's result rows (move_assets details)."""
    seen: set[str] = set()
    model_ids: list[str | None] = []
    for d in details:
        if d.get("status") not in ("created", "updated", "review"):
            continue
        serial = (d.get("serial_number") or "").lower()
        if serial and serial in seen:
            continue
        seen.add(serial)
        model_ids.append(d.get("model_id") if d.get("status") != "review" else None)

    wanted = {uuid.UUID(m) for m in model_ids if m}
    models: dict[str, tuple[int | None, str | None, str | None]] = {}
    if wanted:
        rows = await db.execute(
            select(AssetModel.id, AssetModel.ru_size, AssetModel.category,
                   AssetModel.form_factor).where(AssetModel.id.in_(wanted)))
        models = {str(i): (ru, cat, ff) for i, ru, cat, ff in rows}

    sizes: list[int] = []
    racks = nodes = unknown = 0
    for m in model_ids:
        ru, cat, ff = models.get(m, (None, None, None)) if m else (None, None, None)
        if cat == "rack":
            racks += 1
        elif cat == "node" or ff == "node":
            nodes += 1
        elif not ru or ru < 1:
            unknown += 1
            sizes.append(UNKNOWN_RU)
        else:
            sizes.append(ru)

    needed = crates_needed(sizes)
    suggested = with_headroom(needed)
    return {
        "crates": min(suggested, CRATE_MAX),
        "uncapped": suggested,
        "needed": needed,
        "devices": len(sizes),
        "ru": sum(sizes),
        "over_10u": sum(1 for s in sizes if s > STACK_RU),
        "unknown_size": unknown,
        "racks": racks,
        "nodes": nodes,
    }
