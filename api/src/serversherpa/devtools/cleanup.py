"""Data cleanup: remove data that can never be used again, on demand.

A *group* (sign-in leftovers, old history, deleted files) holds several
*categories*. Each category knows how to count what it would remove
(`count`, used by the preview) and how to remove it (`purge`, used by a
run). Later groups plug into the same registry.

A purge deletes in chunks of CHUNK_SIZE rows, each chunk in its own
committed transaction, so a big table never holds one huge transaction.
Stored files are deleted only after the chunk that referenced them has
committed; a failed file delete is counted and logged, never fatal.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import ColumnElement, and_, delete, exists, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from serversherpa.db.models import AuthSession, PasswordResetToken, TrustedDevice
from serversherpa.services import storage

logger = logging.getLogger("serversherpa.devtools.cleanup")

# Rows per committed delete. A module constant so tests can lower it.
CHUNK_SIZE = 5000

MIN_AGE_DAYS = 1
MAX_AGE_DAYS = 3650


class CleanupError(Exception):
    """A request the framework refuses; `code` is the API error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class CategoryResult:
    key: str
    rows_deleted: int = 0
    files_deleted: int = 0
    files_kept: int = 0
    files_failed: int = 0


CountFn = Callable[[AsyncSession, datetime | None], Awaitable[tuple[int, int]]]
PurgeFn = Callable[[async_sessionmaker, datetime | None], Awaitable[CategoryResult]]


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    description: str
    # (rows, stored files) a run would remove right now
    count: CountFn
    purge: PurgeFn


@dataclass(frozen=True)
class Group:
    key: str
    label: str
    description: str
    needs_age: bool
    categories: tuple[Category, ...] = field(default_factory=tuple)


async def cutoff_for(db: AsyncSession, older_than_days: int | None) -> datetime | None:
    """`now() - N days` on the DATABASE clock (so the app server's clock and
    time zone never decide what counts as old). None when no age applies."""
    if older_than_days is None:
        return None
    return await db.scalar(
        text("SELECT now() - make_interval(days => :n)"), {"n": older_than_days})


async def delete_objects(keys: Iterable[str], result: CategoryResult) -> None:
    """Delete stored objects once the rows that used them are gone. Call
    AFTER the chunk commits. A failure is counted and logged; it never
    stops the run and is not retried."""
    for key in keys:
        try:
            await storage.delete_object(key)
        except Exception:
            logger.warning("cleanup: could not delete object %s", key, exc_info=True)
            result.files_failed += 1
        else:
            result.files_deleted += 1


BeforeDelete = Callable[
    [AsyncSession, list[uuid.UUID], CategoryResult], Awaitable[Iterable[str]]]


async def purge_in_chunks(
    maker: async_sessionmaker, model, where: ColumnElement[bool],
    result: CategoryResult, *, before: BeforeDelete | None = None,
) -> None:
    """Delete the `model` rows matching `where`, CHUNK_SIZE at a time.

    Each chunk is one transaction: pick up to CHUNK_SIZE ids, run `before`
    (which fixes up rows that reference them and returns the storage keys
    that become unused), delete the ids, commit. Then the returned keys are
    deleted from storage. Stops when a chunk comes back short. Rows are
    counted in `result` as each chunk commits, so an error mid-run still
    reports what was removed."""
    while True:
        async with maker() as session:
            ids = list((await session.execute(
                select(model.id).where(where).limit(CHUNK_SIZE))).scalars())
            if not ids:
                return
            keys: Iterable[str] = ()
            if before is not None:
                keys = await before(session, ids, result)
            deleted = await session.execute(delete(model).where(model.id.in_(ids)))
            await session.commit()
            result.rows_deleted += deleted.rowcount
        await delete_objects(keys, result)
        if len(ids) < CHUNK_SIZE:
            return


async def _count_rows(db: AsyncSession, model, where: ColumnElement[bool]) -> int:
    return await db.scalar(select(func.count()).select_from(model).where(where)) or 0


# ── sign-in leftovers ────────────────────────────────────────────────

# Expired only. A rotated or revoked session still inside its lifetime is
# kept: refresh-token reuse detection looks it up to spot a replayed token.
#
# An expired session that a kept (unexpired) session still points at through
# replaced_by is kept too. A rotated row must point at its successor
# (auth_sessions_rotation_pair_check), so the pointer cannot be cleared
# without turning a spent token back into a live one. Real rotations share
# one absolute deadline, so this only matters for odd data.
def _expired_sessions() -> ColumnElement[bool]:
    successor = aliased(AuthSession)
    still_needed = exists().where(
        successor.replaced_by == AuthSession.id, successor.expires_at >= func.now())
    return and_(AuthSession.expires_at < func.now(), ~still_needed)


def _spent_reset_links() -> ColumnElement[bool]:
    return or_(PasswordResetToken.used_at.is_not(None),
               PasswordResetToken.expires_at < func.now())


def _dead_trusted_browsers() -> ColumnElement[bool]:
    return or_(TrustedDevice.revoked_at.is_not(None),
               TrustedDevice.expires_at < func.now())


async def _count_sessions(db: AsyncSession, _cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, AuthSession, _expired_sessions()), 0


async def _release_replaced_by(
    session: AsyncSession, ids: list[uuid.UUID], _result: CategoryResult,
) -> Iterable[str]:
    """auth_sessions.replaced_by is a NO ACTION self-reference, so a row
    about to go cannot still be pointed at. Whatever points at one is an
    expired row that a later chunk deletes (a rotation chain): clear its
    pointer, and its rotated_at with it (the pair check). It is expired, so
    it cannot be used in the meantime. Kept rows are never in this set; see
    _expired_sessions."""
    await session.execute(
        update(AuthSession).where(AuthSession.replaced_by.in_(ids))
        .values(replaced_by=None, rotated_at=None))
    return ()


async def _purge_sessions(maker: async_sessionmaker, _cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("sessions")
    await purge_in_chunks(maker, AuthSession, _expired_sessions(), result,
                          before=_release_replaced_by)
    return result


async def _count_reset_links(db: AsyncSession, _cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, PasswordResetToken, _spent_reset_links()), 0


async def _purge_reset_links(maker: async_sessionmaker, _cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("reset_links")
    await purge_in_chunks(maker, PasswordResetToken, _spent_reset_links(), result)
    return result


async def _count_trusted_browsers(db: AsyncSession, _cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, TrustedDevice, _dead_trusted_browsers()), 0


async def _purge_trusted_browsers(
    maker: async_sessionmaker, _cutoff: datetime | None,
) -> CategoryResult:
    result = CategoryResult("trusted_browsers")
    await purge_in_chunks(maker, TrustedDevice, _dead_trusted_browsers(), result)
    return result


# ── the registry ─────────────────────────────────────────────────────

# Ordered; history and deleted fill in as their categories land.
GROUPS: dict[str, Group] = {g.key: g for g in (
    Group(
        key="signin", label="Sign-in leftovers",
        description="Sign-in records that have expired or been used up and can never "
                    "be used again.",
        needs_age=False,
        categories=(
            Category(
                key="sessions", label="Expired sessions",
                description="Portal and kiosk sessions past their expiry. Rotated or "
                            "revoked sessions still inside their lifetime stay, because "
                            "refresh-token reuse detection needs them.",
                count=_count_sessions, purge=_purge_sessions),
            Category(
                key="reset_links", label="Used or expired password-reset links",
                description="Password-reset links that were already used or have passed "
                            "their expiry.",
                count=_count_reset_links, purge=_purge_reset_links),
            Category(
                key="trusted_browsers", label="Expired or revoked trusted browsers",
                description="Remembered browsers whose trust has expired or was revoked, "
                            "so they ask for a two-factor code again anyway.",
                count=_count_trusted_browsers, purge=_purge_trusted_browsers),
        )),
    Group(
        key="history", label="Old history",
        description="Finished work and old records past the age you choose.",
        needs_age=True),
    Group(
        key="deleted", label="Deleted files",
        description="Files, notes and fonts that were deleted and are past the age you "
                    "choose, along with their stored copies.",
        needs_age=True),
)}


def validate_age(older_than_days: int | None) -> int:
    if (older_than_days is None
            or not MIN_AGE_DAYS <= older_than_days <= MAX_AGE_DAYS):
        raise CleanupError("invalid_age")
    return older_than_days


async def preview(db: AsyncSession, older_than_days: int) -> list[dict]:
    """Every group's categories with what a run would remove right now.
    Counts only, never row data."""
    cutoff = await cutoff_for(db, older_than_days)
    out = []
    for group in GROUPS.values():
        categories = []
        for category in group.categories:
            rows, files = await category.count(db, cutoff if group.needs_age else None)
            categories.append({
                "key": category.key, "label": category.label,
                "description": category.description, "rows": rows, "files": files})
        out.append({
            "key": group.key, "label": group.label, "description": group.description,
            "needs_age": group.needs_age, "categories": categories})
    return out


async def run(
    maker: async_sessionmaker, group_key: str, category_keys: list[str],
    older_than_days: int | None,
) -> list[CategoryResult]:
    """Purge the chosen categories of one group, in the group's own order.
    Raises CleanupError for an unknown group/category or a bad age."""
    group = GROUPS.get(group_key)
    if group is None:
        raise CleanupError("unknown_category")
    # the age is checked first: it is the cheaper mistake to fix, and it keeps
    # the answer the same while a group's categories are still being added
    cutoff = None
    if group.needs_age:
        days = validate_age(older_than_days)
        async with maker() as session:
            cutoff = await cutoff_for(session, days)
    chosen = set(category_keys)
    if not chosen or not chosen <= {c.key for c in group.categories}:
        raise CleanupError("unknown_category")
    return [await category.purge(maker, cutoff)
            for category in group.categories if category.key in chosen]
