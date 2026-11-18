"""The inbox's shared query and writes, called by the portal's /notifications/inbox
routes and the app's /kiosk/notifications routes, so the two can't drift.

Every helper acts on one person's own rows. Writes add to the session and
signal the person's open portal tabs but never commit; the route does.
Errors are HTTPException with a `detail.code`, like the routes'."""

import base64
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification
from serversherpa.notifications.kinds import CATEGORY_KEYS, KINDS
from serversherpa.notifications.live import signal_inbox
from serversherpa.notifications.push import on_read_or_hidden

INBOX_LIMIT = 50        # default page size, and the bell's
INBOX_MAX_LIMIT = 100


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def not_found() -> HTTPException:
    return _err(404, "notification_not_found")


def encode_cursor(created_at: datetime, id: uuid.UUID) -> str:
    """The cursor for the row a page ended on: base64url, unpadded, of
    "<created_at ISO>|<id>". Clients pass it back verbatim as `cursor`."""
    stamp = created_at.astimezone(UTC).isoformat()
    return base64.urlsafe_b64encode(f"{stamp}|{id}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    """(created_at, id) of the row the previous page ended on. Anything
    `encode_cursor` could not have made is a 422 `invalid_cursor`,
    including a timestamp with no UTC offset (it would be read as local time)."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        stamp, separator, row_id = raw.partition("|")
        created_at = datetime.fromisoformat(stamp)
        if not separator or created_at.tzinfo is None:
            raise ValueError(cursor)
        return created_at.astimezone(UTC), uuid.UUID(row_id)
    except (ValueError, OverflowError):
        raise _err(422, "invalid_cursor") from None


async def list_page(db: AsyncSession, person_id: uuid.UUID, *, unread_only: bool = False,
                    category: str | None = None, cursor: str | None = None,
                    limit: int = INBOX_LIMIT) -> tuple[int, int, list[Notification], str | None]:
    """(unread_count, total, page rows, next_cursor) of the person's live (not
    hidden) notifications, newest first. `limit` is clamped to 1..100;
    `category` is a kinds-registry category (a kind the registry does not list
    belongs to none, so it only shows unfiltered); `cursor` is the previous
    page's `next_cursor`."""
    if category is not None and category not in CATEGORY_KEYS:
        raise _err(422, "invalid_category")
    after = decode_cursor(cursor) if cursor is not None else None
    limit = max(1, min(limit, INBOX_MAX_LIMIT))

    live = (Notification.person_id == person_id, Notification.dismissed_at.is_(None))
    filters = []
    if unread_only:
        filters.append(Notification.read_at.is_(None))
    if category is not None:
        filters.append(Notification.kind.in_(
            [kind for kind, info in KINDS.items() if info.category == category]))
    # Both counts in one statement over the live rows: the overall unread
    # count, whatever the filters, and the total the filters leave.
    unread, total = (await db.execute(
        select(func.count().filter(Notification.read_at.is_(None)),
               func.count().filter(*filters) if filters else func.count())
        .select_from(Notification).where(*live))).one()

    q = select(Notification).where(*live, *filters)
    if after is not None:
        # a row comparison on the full sort key: rows sharing a created_at are
        # neither skipped nor repeated across the page boundary
        q = q.where(tuple_(Notification.created_at, Notification.id) < tuple_(*after))
    rows = (await db.scalars(
        q.order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(limit + 1))).all()          # one past the page: is there another?
    page = list(rows[:limit])
    next_cursor = (encode_cursor(page[-1].created_at, page[-1].id)
                   if len(rows) > limit else None)
    return int(unread or 0), int(total or 0), page, next_cursor


async def own_live(db: AsyncSession, person_id: uuid.UUID,
                   notification_id: uuid.UUID) -> Notification:
    """The person's own live (not hidden) notification, or 404 notification_not_found."""
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id, Notification.person_id == person_id,
        Notification.dismissed_at.is_(None)))
    if row is None:
        raise not_found()
    return row


async def mark_read(db: AsyncSession, person_id: uuid.UUID, notification_id: uuid.UUID) -> None:
    row = await own_live(db, person_id, notification_id)
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
        await signal_inbox(db, person_id)
        await on_read_or_hidden(db, [row.id], person_id)


async def mark_unread(db: AsyncSession, person_id: uuid.UUID,
                      notification_id: uuid.UUID) -> None:
    row = await own_live(db, person_id, notification_id)
    if row.read_at is not None:
        row.read_at = None
        await signal_inbox(db, person_id)


async def hide(db: AsyncSession, person_id: uuid.UUID, notification_id: uuid.UUID) -> None:
    """Soft dismiss: the row is kept (retention policy TBD), just hidden. Hiding
    a row that is already hidden changes nothing."""
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id, Notification.person_id == person_id))
    if row is None:
        raise not_found()
    if row.dismissed_at is None:
        row.dismissed_at = datetime.now(UTC)
        await signal_inbox(db, person_id)
        await on_read_or_hidden(db, [row.id], person_id)
