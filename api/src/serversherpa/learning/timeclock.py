"""Learning at the time clock: what a worker still owes when they badge in
(the `learning` block on the kiosk's status), "Email me the link", and the
admin override that lets them punch anyway.

The station's view is its move: open assignments for the device's
`current_initiative_id`, or the general set (no initiative) when it has
none. `extra` means a manager added the document by hand (source
`manual`). A "day" override covers the person at that site for the rest of
the local day, so the warning stays down until local midnight.

The override checks an admin's credentials at a shared station with the
same primitives as /auth/login: Argon2 against the dummy hash for an
unknown email, the account lockout counters, the account's own disabled
and locked states, and a TOTP code when the account has 2FA (the replay
guard included). No session is opened and no trusted browser counts.
Rank 60+ with a global role is required, as for the kiosk Rolodex.

Punches are never blocked on learning: the kiosk decides whether to warn.
Nothing here commits, except `totp.verify_code`, which commits its own
counters exactly as it does for /auth/totp/verify."""
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import resolve_access
from serversherpa.config import get_settings
from serversherpa.db.models import Device, UserAccount
from serversherpa.learning import emails
from serversherpa.learning.assign import OPEN_STATUSES
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningOverride,
)
from serversherpa.security.passwords import DUMMY_HASH, verify_password
from serversherpa.services import auth as auth_service
from serversherpa.services import totp as totp_service
from serversherpa.services.audit import audit
from serversherpa.services.auth import AuthError

REASONS = ("signing_on_break", "signed_on_paper", "no_phone", "other")
SCOPES = ("punch", "day")
# the audit's `via` on a refused admin sign-in at the station
VIA = "learning_override"


class OverrideRefused(Exception):
    """Right credentials, not allowed to override (403 `override_rank`)."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


# ── what is outstanding ──────────────────────────────────────────────


async def open_items(db: AsyncSession, person_id: uuid.UUID,
                     initiative_id: uuid.UUID | None) -> list[dict]:
    """The person's open assignments for `initiative_id` (the general set
    when None) as `[{title, kind}]`: required first, then by due date and
    title."""
    scope = (LearningAssignment.initiative_id.is_(None) if initiative_id is None
             else LearningAssignment.initiative_id == initiative_id)
    rows = (await db.execute(
        select(LearningDocument.title, LearningAssignment.source, LearningAssignment.due_on)
        .join(LearningDocument, LearningDocument.id == LearningAssignment.document_id)
        .where(LearningAssignment.person_id == person_id, scope,
               LearningAssignment.status.in_(OPEN_STATUSES)))).all()
    rows.sort(key=lambda r: (r.source == "manual", r.due_on is None, r.due_on or date.min,
                             r.title.casefold()))
    return [{"title": r.title, "kind": "extra" if r.source == "manual" else "required"}
            for r in rows]


async def day_override_covers(db: AsyncSession, person_id: uuid.UUID,
                              site_id: uuid.UUID | None, today: date) -> bool:
    return await db.scalar(
        select(LearningOverride.id)
        .where(LearningOverride.person_id == person_id,
               LearningOverride.site_id.is_not_distinct_from(site_id),
               LearningOverride.scope == "day", LearningOverride.local_day == today)
        .limit(1)) is not None


async def outstanding(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID | None,
                      site_id: uuid.UUID | None, today: date) -> list[dict]:
    """What the station warns about: `open_items`, or nothing while a "day"
    override covers (person, site, `today`, the station's local day)."""
    if await day_override_covers(db, person_id, site_id, today):
        return []
    return await open_items(db, person_id, initiative_id)


async def status_block(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID | None,
                       site_id: uuid.UUID | None, today: date) -> dict | None:
    """The status's `learning` block, or None when nothing is outstanding."""
    items = await outstanding(db, person_id, initiative_id, site_id, today)
    if not items:
        return None
    return {"outstanding": items,
            "link_email": await emails.address_for(db, person_id) is not None}


async def send_link(db: AsyncSession, person_id: uuid.UUID,
                    initiative_id: uuid.UUID | None) -> bool:
    """"Email me the link": only while something is open for the station's
    key. One per person per minute (emails.send_link's stage)."""
    if not await open_items(db, person_id, initiative_id):
        return False
    return await emails.send_link(db, person_id, initiative_id) is not None


# ── the admin override ───────────────────────────────────────────────


def _refused(db: AsyncSession, email: str, ip: str | None, serial: str,
             **changes) -> None:
    audit(db, actor_id=None, entity_type="auth", entity_id=email, action="login_failed",
          changes={"via": VIA, "serial": serial, **changes}, ip=ip)


async def verify_admin(db: AsyncSession, *, email: str, password: str,
                       totp_code: str | None, serial: str, ip: str | None) -> UserAccount:
    """The admin behind `email`, proven by password (+ TOTP), rank 60+ with
    a global role. Raises AuthError (`invalid_credentials`,
    `account_disabled`, `account_locked`, `totp_required`, `totp_invalid`,
    `totp_enroll_required`) or OverrideRefused (`override_rank`). A wrong
    password or code counts toward the lockout; the caller commits before
    answering a refusal, so the count sticks. A missing code and a low rank
    never count. On success the failure count restarts, as a login's
    does."""
    settings = get_settings()
    pepper = settings.password_pepper.get_secret_value()
    now = datetime.now(UTC)

    account = await auth_service.load_account(db, email)
    if account is None or account.password_hash is None:
        # burn the same time as a real verification (no enumeration oracle)
        verify_password(DUMMY_HASH, password, pepper=pepper)
        _refused(db, email, ip, serial)
        raise AuthError("invalid_credentials")
    if not verify_password(account.password_hash, password, pepper=pepper):
        auth_service.count_failed_login(account, now)
        _refused(db, email, ip, serial)
        raise AuthError("invalid_credentials")

    # the password is right from here on (see auth.login): the account's
    # own state may show
    auth_service.check_account_usable(account)
    if account.locked_until is not None and account.locked_until > now:
        _refused(db, email, ip, serial)
        raise AuthError("account_locked")

    policy = await totp_service.policy_for(db, account)
    if policy.enabled:
        if account.totp_confirmed_at is not None:
            if not (totp_code or "").strip():
                raise AuthError("totp_required")
            # counts a failure, and the replay guard, and commits
            await totp_service.verify_code(db, account, totp_code, ip=ip)
        elif policy.required:
            # login would make them enroll first; a station can't
            _refused(db, email, ip, serial, reason="totp_enroll_required")
            raise AuthError("totp_enroll_required")

    access = await resolve_access(db, account.person_id)
    if access.max_rank < GATE_BYPASS_RANK or not access.is_global:
        _refused(db, email, ip, serial, reason="override_rank")
        raise OverrideRefused("override_rank")

    account.failed_login_count = 0
    account.locked_until = None
    account.updated_at = now
    return account


async def create_override(db: AsyncSession, *, person_id: uuid.UUID, admin_id: uuid.UUID,
                          device: Device, reason: str, reason_text: str | None, scope: str,
                          today: date, via: str, ip: str | None,
                          operator_id: uuid.UUID | None = None) -> LearningOverride:
    """The override row, with what was outstanding at the station right
    now, and its `learning_override` audit (actor: the admin; on a
    signed-in kiosk, `operator_id` is the session's person)."""
    items = await open_items(db, person_id, device.current_initiative_id)
    row = LearningOverride(
        person_id=person_id, initiative_id=device.current_initiative_id,
        site_id=device.site_id, device_id=device.id, admin_person_id=admin_id,
        reason=reason, reason_text=reason_text, scope=scope, local_day=today,
        outstanding=items)
    db.add(row)
    await db.flush()
    audit(db, actor_id=admin_id, entity_type="learning_override", entity_id=str(row.id),
          action="learning_override",
          changes={"person_id": str(person_id), "reason": reason, "reason_text": reason_text,
                   "scope": scope, "local_day": today.isoformat(),
                   "device_id": str(device.id),
                   "site_id": str(device.site_id) if device.site_id else None,
                   "initiative_id": (str(device.current_initiative_id)
                                     if device.current_initiative_id else None),
                   "outstanding": len(items), "via": via,
                   "operator_id": str(operator_id) if operator_id else None}, ip=ip)
    return row


async def claim_override(db: AsyncSession, override_id: uuid.UUID, *, person_id: uuid.UUID,
                         device_id: uuid.UUID, today: date) -> LearningOverride | None:
    """The override a clock-in names, locked for the punch: that person's,
    made on this device, on `today` (the station's local day), and not
    linked to a punch yet. None otherwise."""
    row = await db.scalar(select(LearningOverride)
                          .where(LearningOverride.id == override_id).with_for_update())
    if (row is None or row.person_id != person_id or row.device_id != device_id
            or row.local_day != today or row.time_entry_id is not None):
        return None
    return row
