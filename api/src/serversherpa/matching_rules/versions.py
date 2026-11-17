"""Matching-rule versions: drafts, standby, deploy and rollback.

States: draft (being edited) -> standby (checked, not live) or live; live ->
retired when another version is deployed or rolled back to. At most one live
version per place: the partial unique index `matching_rule_versions_one_live`
backs it, and every state change first locks the place's rows so two changes
to one place run one after the other rather than racing to the index.

Nothing here commits: the route audits and commits.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.matching_rules.check import CheckResult, check_flow
from serversherpa.matching_rules.flow import Flow
from serversherpa.matching_rules.models import MatchingRuleVersion
from serversherpa.matching_rules.schemas import check_out

_PLACE_VERSION_KEY = "matching_rule_versions_place_version_key"


class MatchingError(Exception):
    """A refusal the route turns into HTTPException(status, {"code": code, **extra})."""

    def __init__(self, status: int, code: str, **extra) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.extra = extra


async def get_version(db: AsyncSession, version_id: uuid.UUID) -> MatchingRuleVersion:
    version = await db.get(MatchingRuleVersion, version_id)
    if version is None:
        raise MatchingError(404, "version_not_found")
    return version


async def list_versions(db: AsyncSession, place: str) -> list[MatchingRuleVersion]:
    return list(
        (await db.execute(
            select(MatchingRuleVersion)
            .where(MatchingRuleVersion.place == place)
            .order_by(MatchingRuleVersion.version.desc())
        )).scalars().all()
    )


async def create_draft(
    db: AsyncSession,
    *,
    place: str,
    flow: Flow,
    based_on_id: uuid.UUID | None,
    actor_id: uuid.UUID | None,
) -> MatchingRuleVersion:
    """A new draft numbered max+1 for the place. Drafts may fail the check."""
    if based_on_id is not None:
        base = await get_version(db, based_on_id)
        if base.place != place:
            raise MatchingError(422, "wrong_place")
    for _attempt in range(2):
        latest = await db.scalar(
            select(func.max(MatchingRuleVersion.version))
            .where(MatchingRuleVersion.place == place)
        )
        now = datetime.now(UTC)
        row = MatchingRuleVersion(
            place=place,
            version=(latest or 0) + 1,
            state="draft",
            flow=flow.model_dump(mode="json"),
            based_on_id=based_on_id,
            checked=None,
            created_by=actor_id,
            updated_by=actor_id,
            created_at=now,
            updated_at=now,
            state_changed_at=None,
        )
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError as exc:
            # A concurrent save took this number; read the max again once. Any other
            # violation is a real bug (the constraint name is on asyncpg's exception,
            # chained onto SQLAlchemy's DBAPI wrapper).
            asyncpg_exc = exc.orig.__cause__ if exc.orig is not None else None
            if getattr(asyncpg_exc, "constraint_name", None) != _PLACE_VERSION_KEY:
                raise
            continue
        return row
    raise MatchingError(409, "version_conflict")


async def update_draft(
    db: AsyncSession, version: MatchingRuleVersion, flow: Flow, actor_id: uuid.UUID | None
) -> MatchingRuleVersion:
    """Replace a draft's flow. Standby, live and retired versions are never edited.

    The row is locked and re-read first, so a save racing a standby or deploy of
    the same version waits for it and then refuses, rather than changing the flow
    of a version that was checked as it stood."""
    await db.refresh(version, with_for_update=True)
    if version.state != "draft":
        raise MatchingError(409, "not_draft")
    version.flow = flow.model_dump(mode="json")
    version.updated_by = actor_id
    version.updated_at = datetime.now(UTC)
    await db.flush()
    return version


async def _lock_place(db: AsyncSession, place: str) -> list[MatchingRuleVersion]:
    """Lock every version row of the place (in a fixed order, so two lockers can't
    deadlock) and refresh them: a change that waited here sees what the one before
    it committed."""
    return list(
        (await db.execute(
            select(MatchingRuleVersion)
            .where(MatchingRuleVersion.place == place)
            .order_by(MatchingRuleVersion.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )).scalars().all()
    )


async def _checked_change(
    db: AsyncSession, version_id: uuid.UUID, allowed: Sequence[str]
) -> tuple[MatchingRuleVersion, list[MatchingRuleVersion], CheckResult]:
    """Lock the place, re-read the state, then require the check to pass today."""
    version = await get_version(db, version_id)
    rows = await _lock_place(db, version.place)
    if version.state not in allowed:
        raise MatchingError(409, "bad_state", state=version.state)
    res = await check_flow(db, version.place, Flow.model_validate(version.flow))
    if not res.ok:
        raise MatchingError(422, "check_failed", check=check_out(res).model_dump(mode="json"))
    return version, rows, res


def _set_state(
    version: MatchingRuleVersion, state: str, actor_id: uuid.UUID | None, now: datetime
) -> None:
    version.state = state
    version.state_changed_by = actor_id
    version.state_changed_at = now


async def _make_live(
    db: AsyncSession,
    version: MatchingRuleVersion,
    rows: Sequence[MatchingRuleVersion],
    res: CheckResult,
    actor_id: uuid.UUID | None,
) -> int | None:
    now = datetime.now(UTC)
    retired: int | None = None
    live = next((r for r in rows if r.state == "live"), None)
    if live is not None:
        _set_state(live, "retired", actor_id, now)
        # Its own flush: the one-live index is checked per statement, and the unit of
        # work would otherwise order the two UPDATEs by primary key, not by intent.
        await db.flush()
        retired = live.version
    _set_state(version, "live", actor_id, now)
    version.checked = res.summary(now)
    await db.flush()
    return retired


async def make_standby(
    db: AsyncSession, version_id: uuid.UUID, actor_id: uuid.UUID | None
) -> MatchingRuleVersion:
    version, _rows, res = await _checked_change(db, version_id, ("draft",))
    now = datetime.now(UTC)
    _set_state(version, "standby", actor_id, now)
    version.checked = res.summary(now)
    await db.flush()
    return version


async def deploy(
    db: AsyncSession, version_id: uuid.UUID, actor_id: uuid.UUID | None
) -> tuple[MatchingRuleVersion, int | None]:
    """Make a draft or standby version live; returns the retired version's number."""
    version, rows, res = await _checked_change(db, version_id, ("draft", "standby"))
    return version, await _make_live(db, version, rows, res, actor_id)


async def rollback(
    db: AsyncSession, version_id: uuid.UUID, actor_id: uuid.UUID | None
) -> tuple[MatchingRuleVersion, int | None]:
    """Make a retired version live again; it must still pass today's test set."""
    version, rows, res = await _checked_change(db, version_id, ("retired",))
    return version, await _make_live(db, version, rows, res, actor_id)
