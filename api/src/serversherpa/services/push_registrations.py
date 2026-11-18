"""A personal phone's push registration and its push key, plus the one
eligibility rule for a personal phone (shared by the portal's "Personal
device of" and the app's "This is my phone").

- `register` creates or replaces the device's one registration and returns a
  new push key: 256 random bits, handed to the phone once, stored only as its
  sha256. Replacing the row replaces the key.
- `verify_key` checks `Authorization: PushKey <registration id>.<key>` and
  accepts it only while the registration is live, by the same rules the
  sender uses (notifications.push.live_registrations).
- `drop_for_device` / `drop_for_person` delete registrations, which kills
  their keys. Every writer of `devices.personal_person_id` drops the
  device's row; losing access (demoted, disabled, blacklisted) or an
  admin's revoke-all for the person drops the person's rows, and the
  system-wide revoke-all drops every row (drop_all). A password change and
  Forget fingerprint leave push alone.

Never logs a push key or an FCM token: ids and reasons only. Nothing here
commits.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import AccessInfo, resolve_access
from serversherpa.db.models import Device, Person, PushRegistration, UserAccount
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE

logger = logging.getLogger(__name__)

SCHEME = "PushKey"
PROVIDER = "fcm"
# compared against when the registration id is unknown, so a miss costs the
# same hash-and-compare as a wrong key
_NO_HASH = hashlib.sha256(b"no registration").hexdigest()


class PersonNotFound(LookupError):
    """personal_refusal was given an id no person has."""


def refusal_for(person: Person, account: UserAccount | None,
                access: AccessInfo | None) -> str | None:
    """The one eligibility rule for a personal phone, shared by the portal's
    PUT and its picker's candidate list and by the app's "This is my phone":
    a login account that is not disabled, a person who is not archived, not
    a move's hidden kiosk identity, and kiosk:view. `access` is only read
    once the rest has passed."""
    if account is None:
        return "no_account"
    if account.disabled_at is not None or person.archived_at is not None:
        return "account_disabled"
    if person.source == KIOSK_MOVE_SOURCE:
        return "move_identity"
    if access is None or not access.can("kiosk", "view"):
        return "no_kiosk_view"
    return None


async def personal_refusal(db: AsyncSession, person_id: uuid.UUID) -> str | None:
    """Why `person_id` can't have a personal phone, or None when they can
    (refusal_for). Raises PersonNotFound for an unknown id."""
    person = await db.get(Person, person_id)
    if person is None:
        raise PersonNotFound(person_id)
    account = await db.get(UserAccount, person_id)
    # without access the rule never passes, so this is the cheap refusal
    # or "no_kiosk_view", which only the resolved access can settle
    early = refusal_for(person, account, None)
    if early != "no_kiosk_view":
        return early
    return refusal_for(person, account, await resolve_access(db, person_id))


def _hash(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


async def _free_token(db: AsyncSession, token: str, *, keep_device: uuid.UUID) -> None:
    """FCM tokens are unique: a token another device's row still holds is
    stale there (the app moved or was reinstalled), so that row goes."""
    gone = (await db.execute(
        delete(PushRegistration)
        .where(PushRegistration.token == token, PushRegistration.device_id != keep_device)
        .returning(PushRegistration.id, PushRegistration.device_id)
        .execution_options(synchronize_session=False))).all()
    for row in gone:
        logger.info("push registration %s on device %s dropped: token_moved",
                    row.id, row.device_id)


class TokenConflict(Exception):
    """Another device's row took the same FCM token at the same moment, twice
    over. Carries no token (an IntegrityError's text would)."""


async def _with_token(db: AsyncSession, token: str, device_id: uuid.UUID, write):
    """Run `write()` (one statement that stores `token` on `device_id`'s row)
    after freeing the token, in a savepoint. Two devices storing one token at
    once collide on its unique index: the loser's savepoint rolls back and
    it frees and writes once more, now seeing the winner's committed row.
    A second collision is TokenConflict; the IntegrityError (whose text holds
    the token) never leaves here."""
    for attempt in range(2):
        try:
            async with db.begin_nested():
                await _free_token(db, token, keep_device=device_id)
                return await write()
        except IntegrityError:
            if attempt:
                raise TokenConflict from None
    raise AssertionError("unreachable")


async def register(db: AsyncSession, device: Device, person_id: uuid.UUID, *,
                   token: str, platform: str = "android",
                   ) -> tuple[PushRegistration, str]:
    """Create or replace `device`'s registration for `person_id` with this
    FCM `token`, and return it with its new push key (the raw key: shown to
    the phone once, never stored or logged). Any earlier key stops working.
    The caller has checked the device is personal to the person. Raises
    TokenConflict when the token can't be taken over (see _with_token)."""
    raw = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    device_id = device.id
    values = {"person_id": person_id, "platform": platform, "provider": PROVIDER,
              "token": token, "secret_hash": _hash(raw), "updated_at": now,
              "last_error": None}
    stmt = (pg_insert(PushRegistration)
            .values(device_id=device_id, created_at=now, **values)
            .on_conflict_do_update(index_elements=[PushRegistration.device_id], set_=values)
            .returning(PushRegistration.id))

    async def write():
        return await db.scalar(stmt)

    registration_id = await _with_token(db, token, device_id, write)
    row = await db.get(PushRegistration, registration_id, populate_existing=True)
    logger.info("push registration %s on device %s registered", registration_id, device_id)
    return row, raw


async def update_token(db: AsyncSession, registration: PushRegistration, token: str) -> bool:
    """The phone's FCM token rotated: store the new one (the key stays).
    A guarded UPDATE: False when the row is gone (deleted since the key was
    checked). Raises TokenConflict like register."""
    registration_id, device_id = registration.id, registration.device_id
    stmt = (update(PushRegistration).where(PushRegistration.id == registration_id)
            .values(token=token, updated_at=datetime.now(UTC), last_error=None)
            .execution_options(synchronize_session=False))

    async def write():
        return (await db.execute(stmt)).rowcount

    return await _with_token(db, token, device_id, write) == 1


async def drop_for_device(db: AsyncSession, device_id: uuid.UUID, *, reason: str) -> bool:
    """Delete the device's registration (its key dies with it). Returns
    whether there was one."""
    gone = (await db.execute(
        delete(PushRegistration).where(PushRegistration.device_id == device_id)
        .returning(PushRegistration.id)
        .execution_options(synchronize_session=False))).scalars().all()
    for registration_id in gone:
        logger.info("push registration %s on device %s dropped: %s",
                    registration_id, device_id, reason)
    return bool(gone)


async def drop_for_person(db: AsyncSession, person_id: uuid.UUID, *, reason: str) -> int:
    """Delete every registration the person holds. Returns how many."""
    gone = (await db.execute(
        delete(PushRegistration).where(PushRegistration.person_id == person_id)
        .returning(PushRegistration.id)
        .execution_options(synchronize_session=False))).scalars().all()
    for registration_id in gone:
        logger.info("push registration %s of person %s dropped: %s",
                    registration_id, person_id, reason)
    return len(gone)


async def drop_all(db: AsyncSession, *, reason: str) -> int:
    """Delete every registration (the system-wide revoke-all). Returns how many."""
    gone = (await db.execute(
        delete(PushRegistration).returning(PushRegistration.id)
        .execution_options(synchronize_session=False))).scalars().all()
    if gone:
        logger.info("%d push registrations dropped: %s", len(gone), reason)
    return len(gone)


def _parse(header: str) -> tuple[uuid.UUID, str] | None:
    scheme, _, credentials = header.partition(" ")
    if scheme != SCHEME:
        return None
    registration_id, dot, raw = credentials.strip().partition(".")
    if not dot or not raw or "." in raw:
        return None
    try:
        return uuid.UUID(registration_id), raw
    except ValueError:
        return None


async def verify_key(db: AsyncSession, header: str) -> PushRegistration | None:
    """The registration an `Authorization: PushKey <registration id>.<key>`
    header proves, or None: a malformed header, an unknown id, a wrong key,
    or a registration that is not live (the device is no longer personal to
    the registration's person, its kiosk registration has expired, or it is
    a Zebra or a shared station: live_registrations' rules)."""
    # imported here: notifications.push imports services.biometric, which
    # imports this module
    from serversherpa.notifications.push import live_registrations

    parsed = _parse(header)
    if parsed is None:
        return None
    registration_id, raw = parsed
    row = await db.get(PushRegistration, registration_id)
    matched = hmac.compare_digest(_hash(raw), row.secret_hash if row else _NO_HASH)
    if row is None or not matched:
        return None
    live = await live_registrations(db, row.person_id, datetime.now(UTC))
    return row if any(r.id == row.id for r in live) else None
