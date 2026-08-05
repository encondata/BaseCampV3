"""0013: vocabulary colours are hex, and rank can be shifted in one statement."""

import re

from sqlalchemy import select, text

from serversherpa.db.models import SiteType, StatusValue, WorkerLevel

HEX = re.compile(r"^#[0-9a-f]{6}$")


async def test_every_status_value_color_is_hex(db):
    rows = (await db.scalars(select(StatusValue))).all()
    assert rows
    for r in rows:
        assert HEX.match(r.color), f"{r.record_type}:{r.key} -> {r.color}"


async def test_status_tokens_mapped_to_their_light_hex(db):
    """Light is the source: it preserves today's light-mode appearance exactly."""
    rows = {(r.record_type, r.key): r.color
            for r in await db.scalars(select(StatusValue))}
    assert rows[("site", "active")] == "#178a4c"          # was c-green
    assert rows[("site", "planned")] == "#0f7c86"         # was c-aqua
    assert rows[("site", "inactive")] == "#51606f"        # was c-slate
    assert rows[("site", "decommissioned")] == "#c03540"  # was c-red
    assert rows[("worker", "standby")] == "#a36207"       # was c-amber


async def test_site_types_seeded_with_hex(db):
    rows = {r.key: r.color for r in await db.scalars(select(SiteType))}
    assert rows["datacenter"] == "#1668a7"
    assert all(HEX.match(c) for c in rows.values())


async def test_worker_levels_keep_their_existing_badge_colors(db):
    """Seeded from the LEVEL_COLORS map being deleted, so badges look identical."""
    rows = {r.level: r.color for r in await db.scalars(select(WorkerLevel))}
    assert rows == {"L1": "#8a93a6", "L2": "#4dd0ff", "L3": "#35e0c8",
                    "L4": "#3ddc84", "L5": "#a78bfa", "L6": "#ffb84d"}


async def test_rank_constraint_is_deferrable_but_not_initially_deferred(db):
    """A single UPDATE ... rank + 1 must not trip the constraint mid-statement.

    condeferred is pinned too: condeferrable alone is true for INITIALLY
    DEFERRED as well, which would defer EVERY rank check to commit time
    application-wide — moving errors off the offending statement and onto
    COMMIT. Deferring must stay opt-in per transaction.
    """
    row = (await db.execute(text(
        "SELECT condeferrable, condeferred FROM pg_constraint "
        "WHERE conname = 'worker_levels_rank_key'"))).one()
    assert row.condeferrable is True
    assert row.condeferred is False


async def test_rank_shift_lands_in_one_statement(db):
    """A bare `rank + 1` shift survives its own transient collisions.

    No SET CONSTRAINTS here, deliberately: being DEFERRABLE is already enough,
    because Postgres checks a deferrable constraint at STATEMENT end rather
    than per row. That is the property the create handler depends on, and this
    is what pins it — against a non-deferrable constraint this UPDATE itself
    raises duplicate key (rank 3 -> 4 hits the row still at 4). Deferring to
    COMMIT would add nothing and would move errors off the offending
    statement; test_rank_constraint_is_deferrable_but_not_initially_deferred
    pins the declaration, this pins the behaviour.
    """
    await db.execute(text("UPDATE worker_levels SET rank = rank + 1 WHERE rank >= 3"))
    await db.flush()
    ranks = [r.rank for r in await db.scalars(
        select(WorkerLevel).order_by(WorkerLevel.rank))]
    assert ranks == [1, 2, 4, 5, 6, 7]
    await db.rollback()
