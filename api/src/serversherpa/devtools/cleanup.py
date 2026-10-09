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

from sqlalchemy import (
    ColumnElement,
    String,
    and_,
    cast,
    delete,
    exists,
    false,
    func,
    or_,
    select,
    text,
    union,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from serversherpa.db.models import (
    Attachment,
    AuthSession,
    Client,
    EmailOutbox,
    GeneratedLabel,
    ImportJob,
    LabelFont,
    LabelGenerationRun,
    Notification,
    Partner,
    PasswordResetToken,
    Person,
    ReportRun,
    SpecLookupJob,
    StatusRuleExecution,
    TrustedDevice,
)
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


class CleanupFailed(CleanupError):
    """A run raised partway. `results` holds what was already committed
    (finished categories plus the failing one's chunks so far); `message`
    is a short description of the error for the audit row."""

    def __init__(self, results: list["CategoryResult"], cause: BaseException):
        super().__init__("cleanup_failed")
        self.results = results
        self.message = f"{type(cause).__name__}: {cause}".splitlines()[0][:300]


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
# (session, candidate keys) -> the keys a kept row still uses
StillUsed = Callable[[AsyncSession, set[str]], Awaitable[set[str]]]


async def purge_in_chunks(
    maker: async_sessionmaker, model, where: ColumnElement[bool],
    result: CategoryResult, *, before: BeforeDelete | None = None,
    still_used: StillUsed | None = None,
) -> None:
    """Delete the `model` rows matching `where`, CHUNK_SIZE at a time.

    Each chunk is one transaction: pick up to CHUNK_SIZE ids, run `before`
    (which fixes up rows that reference them and returns the candidate
    storage keys), delete the ids, then, when `still_used` is given, ask it
    which of the candidate keys a kept row still uses (it runs after the
    delete, in the same transaction, so the rows just deleted do not count).
    Those keys are kept and counted in `files_kept`; the rest are deleted
    from storage after the commit. Stops when a chunk comes back short.

    `result` is updated as each chunk commits. If anything raises, the
    exception carries it as `partial_result` so the caller can report what
    was already removed."""
    try:
        while True:
            async with maker() as session:
                ids = list((await session.execute(
                    select(model.id).where(where).limit(CHUNK_SIZE))).scalars())
                if not ids:
                    return
                keys: list[str] = []
                if before is not None:
                    keys = list(dict.fromkeys(await before(session, ids, result)))
                deleted = await session.execute(delete(model).where(model.id.in_(ids)))
                if deleted.rowcount == 0 and len(ids) >= CHUNK_SIZE:
                    # a full chunk that removed nothing would be selected
                    # again forever
                    raise RuntimeError(
                        f"cleanup made no progress on {model.__tablename__}")
                kept = 0
                if still_used is not None and keys:
                    used = await still_used(session, set(keys))
                    kept = len(used)
                    keys = [k for k in keys if k not in used]
                await session.commit()
                result.rows_deleted += deleted.rowcount
                result.files_kept += kept
            await delete_objects(keys, result)
            if len(ids) < CHUNK_SIZE:
                return
    except Exception as exc:
        exc.partial_result = result  # type: ignore[attr-defined]
        raise


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


# ── stored files: who still uses a key ───────────────────────────────

# Each table that holds a storage key, as (model, key column, "this row
# is a kept row" filter or None). Soft-deleted attachments and fonts do
# not count: nothing can reach their object any more.
def _key_sources() -> list[tuple[type, ColumnElement, ColumnElement | None]]:
    return [
        (Attachment, Attachment.storage_key, Attachment.deleted_at.is_(None)),
        (ReportRun, ReportRun.storage_key, None),
        (ImportJob, ImportJob.file_key, None),
        (Person, Person.avatar_key, None),
        (Client, Client.logo_key, None),
        (Partner, Partner.logo_key, None),
        (LabelFont, LabelFont.storage_key, LabelFont.deleted_at.is_(None)),
    ]


async def keys_in_use(db: AsyncSession, keys: set[str]) -> set[str]:
    """Which of `keys` a kept row still references. Call it AFTER deleting
    the rows whose keys you are asking about, in the same transaction, so
    those rows do not count as users of their own file."""
    keys = {k for k in keys if k}
    if not keys:
        return set()
    found: set[str] = set()
    for _model, column, alive in _key_sources():
        query = select(column).where(column.in_(keys))
        if alive is not None:
            query = query.where(alive)
        found.update((await db.scalars(query)).all())
    return found


async def _count_unused_keys(
    db: AsyncSession, model, key_column, where: ColumnElement[bool],
) -> int:
    """How many distinct stored objects a purge of `model` rows matching
    `where` would delete: their keys, minus any key a row that is NOT being
    purged still uses. Approximate in one way: a run deletes in chunks and
    sees rows of later chunks as kept, so an object shared by purged rows
    that straddle a chunk boundary is counted here once but shows as
    "kept" in the run's own totals until the last of them goes."""
    kept = []
    for src_model, column, alive in _key_sources():
        query = select(column).where(column.is_not(None), column != "").correlate(None)
        if alive is not None:
            query = query.where(alive)
        if src_model is model:
            # the purged rows of this very table are not kept rows. IS NOT
            # TRUE (not NOT): a NULL test result must still count as kept.
            query = query.where(where.is_not(True))
        kept.append(query)
    return await db.scalar(
        select(func.count(func.distinct(key_column)))
        .where(where, key_column.is_not(None), key_column != "",
               key_column.not_in(union(*kept)))) or 0


def _chunk_keys(model, key_column) -> BeforeDelete:
    """A `before` hook: the chunk's stored objects, to be filtered through
    keys_in_use once the rows are gone."""
    async def keys(session: AsyncSession, ids: list[uuid.UUID], _result: CategoryResult):
        return (await session.scalars(
            select(key_column).where(model.id.in_(ids), key_column.is_not(None),
                                     key_column != ""))).all()
    return keys


# ── old history ──────────────────────────────────────────────────────

# Terminal statuses, taken from the workers (and the CHECK constraints where
# a table has one). Never queued, running, sending, preview or draft rows.
MAIL_DONE = ("sent", "failed", "skipped")                  # mail/delivery.py
IMPORT_DONE = ("completed", "failed", "cancelled")         # imports/worker.py _finish
REPORT_DONE = ("completed", "failed")                      # reports/worker.py _finish
LABEL_RUN_DONE = ("completed", "failed", "canceled")       # label_generation_runs_status_check
SPEC_JOB_DONE = ("done", "failed")                         # spec_lookup_jobs_status_check

# A finished status with a time: both must hold, so a row with no finish
# time is never old enough.
def _old_mail(cutoff: datetime) -> ColumnElement[bool]:
    return and_(EmailOutbox.status.in_(MAIL_DONE), EmailOutbox.created_at < cutoff)


# Read or hidden. An approval card still waiting (state pending/open) stays
# whatever its age: the inbox popover is where it is decided.
def _old_notifications(cutoff: datetime) -> ColumnElement[bool]:
    return and_(
        or_(Notification.read_at.is_not(None), Notification.dismissed_at.is_not(None)),
        Notification.created_at < cutoff,
        func.coalesce(Notification.payload["state"].astext, "").not_in(("pending", "open")))


# A Create-a-move draft (kind move_setup) points at its From-To file check
# (a move_assets job) through payload.assets.check_job_id, which is not an FK.
# A check a kept draft still points at stays, however old it is. A draft that
# is itself being purged does not count as kept.
def _old_imports(cutoff: datetime) -> ColumnElement[bool]:
    draft = aliased(ImportJob)
    draft_goes = and_(draft.status.in_(IMPORT_DONE), draft.finished_at < cutoff)
    needed = exists().where(
        draft.kind == "move_setup",
        draft.payload["assets"]["check_job_id"].astext == cast(ImportJob.id, String),
        func.coalesce(draft_goes, false()).is_(False))
    return and_(ImportJob.status.in_(IMPORT_DONE), ImportJob.finished_at < cutoff, ~needed)


def _old_reports(cutoff: datetime) -> ColumnElement[bool]:
    return and_(ReportRun.status.in_(REPORT_DONE), ReportRun.finished_at < cutoff)


def _old_label_runs(cutoff: datetime) -> ColumnElement[bool]:
    return and_(LabelGenerationRun.status.in_(LABEL_RUN_DONE),
                LabelGenerationRun.finished_at < cutoff)


def _old_spec_lookups(cutoff: datetime) -> ColumnElement[bool]:
    return and_(SpecLookupJob.status.in_(SPEC_JOB_DONE), SpecLookupJob.finished_at < cutoff)


def _old_rule_logs(cutoff: datetime) -> ColumnElement[bool]:
    return StatusRuleExecution.executed_at < cutoff


async def _count_mail(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, EmailOutbox, _old_mail(cutoff)), 0


async def _purge_mail(maker: async_sessionmaker, cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("mail")
    await purge_in_chunks(maker, EmailOutbox, _old_mail(cutoff), result)
    return result


async def _count_notifications(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, Notification, _old_notifications(cutoff)), 0


async def _purge_notifications(
    maker: async_sessionmaker, cutoff: datetime | None,
) -> CategoryResult:
    result = CategoryResult("notifications")
    await purge_in_chunks(maker, Notification, _old_notifications(cutoff), result)
    return result


async def _count_imports(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    where = _old_imports(cutoff)
    return (await _count_rows(db, ImportJob, where),
            await _count_unused_keys(db, ImportJob, ImportJob.file_key, where))


async def _purge_imports(maker: async_sessionmaker, cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("imports")
    await purge_in_chunks(maker, ImportJob, _old_imports(cutoff), result,
                          before=_chunk_keys(ImportJob, ImportJob.file_key),
                          still_used=keys_in_use)
    return result


async def _count_reports(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    where = _old_reports(cutoff)
    return (await _count_rows(db, ReportRun, where),
            await _count_unused_keys(db, ReportRun, ReportRun.storage_key, where))


async def _purge_reports(maker: async_sessionmaker, cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("reports")
    await purge_in_chunks(maker, ReportRun, _old_reports(cutoff), result,
                          before=_chunk_keys(ReportRun, ReportRun.storage_key),
                          still_used=keys_in_use)
    return result


async def _count_label_runs(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, LabelGenerationRun, _old_label_runs(cutoff)), 0


async def _unlink_generated_labels(
    session: AsyncSession, ids: list[uuid.UUID], _result: CategoryResult,
) -> Iterable[str]:
    """generated_labels.run_id is a NO ACTION reference to the run. The
    labels are the product and are never deleted: they just stop pointing at
    a run that no longer exists."""
    await session.execute(
        update(GeneratedLabel).where(GeneratedLabel.run_id.in_(ids)).values(run_id=None))
    return ()


async def _purge_label_runs(maker: async_sessionmaker, cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("label_runs")
    await purge_in_chunks(maker, LabelGenerationRun, _old_label_runs(cutoff), result,
                          before=_unlink_generated_labels)
    return result


async def _count_spec_lookups(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, SpecLookupJob, _old_spec_lookups(cutoff)), 0


# spec_suggestions.job_id is ON DELETE SET NULL: the suggestions survive.
async def _purge_spec_lookups(maker: async_sessionmaker, cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("spec_lookups")
    await purge_in_chunks(maker, SpecLookupJob, _old_spec_lookups(cutoff), result)
    return result


async def _count_rule_logs(db: AsyncSession, cutoff: datetime | None) -> tuple[int, int]:
    return await _count_rows(db, StatusRuleExecution, _old_rule_logs(cutoff)), 0


async def _purge_rule_logs(maker: async_sessionmaker, cutoff: datetime | None) -> CategoryResult:
    result = CategoryResult("rule_logs")
    await purge_in_chunks(maker, StatusRuleExecution, _old_rule_logs(cutoff), result)
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
        needs_age=True,
        categories=(
            Category(
                key="mail", label="Sent, failed and skipped mail",
                description="Outgoing email that is done: sent, failed for good, or skipped "
                            "because no mail server is set up. Queued and sending mail stays.",
                count=_count_mail, purge=_purge_mail),
            Category(
                key="notifications", label="Read or hidden notifications",
                description="Inbox items someone already read or hid. Unread items and "
                            "approval requests still waiting for an answer stay.",
                count=_count_notifications, purge=_purge_notifications),
            Category(
                key="imports", label="Finished import jobs",
                description="Completed, failed and canceled imports, with the file that was "
                            "uploaded. Their result reports go too, so a finished From-To "
                            "import can no longer be downloaded or have its review rows "
                            "reprocessed. A file check that a move still being set up "
                            "uses stays. A file another job still uses stays.",
                count=_count_imports, purge=_purge_imports),
            Category(
                key="reports", label="Report runs",
                description="Finished report runs and their generated file. A file that is "
                            "also a move's attachment stays; only the run record goes.",
                count=_count_reports, purge=_purge_reports),
            Category(
                key="label_runs", label="Label generation runs",
                description="Finished label generation runs. The labels they made all stay; "
                            "they just no longer name the run.",
                count=_count_label_runs, purge=_purge_label_runs),
            Category(
                key="spec_lookups", label="Finished spec lookups",
                description="Finished spec lookup jobs. Their suggestions stay. The AI spec "
                            "lookup page's month totals and last error only count jobs "
                            "that are still here.",
                count=_count_spec_lookups, purge=_purge_spec_lookups),
            Category(
                key="rule_logs", label="Status rule run logs",
                description="The log of each time a status rule ran, including failed scans. "
                            "The rules themselves and the audit log stay.",
                count=_count_rule_logs, purge=_purge_rule_logs),
        )),
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

    Raises CleanupError for an unknown group/category (an empty list
    included) or a bad age, before anything is deleted. If a purge fails
    partway it raises CleanupFailed, whose `results` are the counts already
    committed; earlier chunks and categories stay deleted."""
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
    results: list[CategoryResult] = []
    try:
        for category in group.categories:
            if category.key in chosen:
                results.append(await category.purge(maker, cutoff))
    except Exception as exc:
        partial = getattr(exc, "partial_result", None)
        if partial is not None:
            results.append(partial)
        raise CleanupFailed(results, exc) from exc
    return results
