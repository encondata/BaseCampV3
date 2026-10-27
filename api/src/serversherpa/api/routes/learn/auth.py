"""Worker sign-in on the learn site (public): a learning code plus last
name, or the invite's one-click link, starts a learn session; logout ends
it; /me says who is signed in and how.

Abuse limits follow the kiosk move-login pattern (routes/kiosk.py): every
failure writes a `learning_code_failed` audit row keyed on
LEARN_CODE_AUDIT_ID, and a caller's rate_limit_ip bucket (or everyone
together) over the cap waits out the window. A code also locks itself
after `code_max_failures` wrong last names. Every answer to a failed
attempt is the same 401: a wrong code, a wrong last name, and any attempt
on a locked code, whatever name it sends. So a guess can't learn that a
code exists, and a locked code can't be used to keep testing names. All
numbers are learning settings."""
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import DbSession, rate_limit_ip
from serversherpa.api.routes.kiosk import _inet_or_none, move_login_bucket
from serversherpa.db.models import AuditLog, Person
from serversherpa.learning import codes, sessions
from serversherpa.learning.models import LearningCode
from serversherpa.learning.schemas import (
    LearnCodeIn,
    LearnLinkIn,
    LearnMeOut,
    LearnPersonOut,
    LearnSessionOut,
)
from serversherpa.learning.sessions import CurrentLearner
from serversherpa.learning.settings import LearningSettings, load_settings
from serversherpa.services.audit import audit
from serversherpa.services.password_reset import hash_token

router = APIRouter(prefix="/auth")

LEARN_CODE_AUDIT_ID = "learn-code"
FAILED_ACTION = "learning_code_failed"
GLOBAL_LOCK_KEY = "learn-code-global"


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _window(settings: LearningSettings):
    since = datetime.now(UTC) - timedelta(seconds=settings.ip_window_seconds)
    return (AuditLog.entity_type == "auth", AuditLog.entity_id == LEARN_CODE_AUDIT_ID,
            AuditLog.action == FAILED_ACTION, AuditLog.at >= since)


async def _serialize(db: AsyncSession, bucket: str) -> None:
    """Hold the cap check and the failure it records in one critical
    section: without it, concurrent attempts all read the count before any
    of them writes, and a burst slips past the cap. Transaction-scoped
    advisory locks, always global first and then the bucket (one order, so
    no deadlock); the commit or rollback that ends the request frees them.

    The global lock makes sign-in decisions one at a time across the
    deployment, so the critical section is kept to the round trips the
    decision needs: two counts, the code lookup, then either the failure
    row or the session insert and audit, and the commit (no read-backs).
    Throughput is about one sign-in per those round trips; revisit this
    (a counter row for the global cap) if sign-ins ever come in thousands
    at once rather than an 08:00 rush of a few hundred."""
    for key in (GLOBAL_LOCK_KEY, f"learn-code-ip:{bucket}"):
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": key})


async def learn_login_capped(db: AsyncSession, settings: LearningSettings, bucket: str) -> bool:
    """True once `bucket` (or every caller together, over the same window)
    has reached the failure cap."""
    per_bucket = await db.scalar(select(func.count()).select_from(AuditLog).where(
        *_window(settings), AuditLog.changes["bucket"].astext == bucket)) or 0
    if per_bucket >= settings.ip_limit:
        return True
    total = await db.scalar(
        select(func.count()).select_from(AuditLog).where(*_window(settings))) or 0
    return total >= settings.global_limit


async def _failed(db: AsyncSession, ip: str | None, bucket: str, reason: str, *,
                  row: LearningCode | None = None) -> HTTPException:
    """Record the failure (and any lockout change on `row`) and commit, since
    the raised error rolls the request back. The answer never says which
    half was wrong; the audit row does, for whoever investigates."""
    changes = {"reason": reason, "bucket": bucket}
    if row is not None:
        changes["code_id"] = str(row.id)
    audit(db, actor_id=None, entity_type="auth", entity_id=LEARN_CODE_AUDIT_ID,
          action=FAILED_ACTION, changes=changes, ip=ip)
    await db.commit()
    return _err(401, "learn_code_invalid")


def _usable(row: LearningCode, person: Person, now: datetime) -> bool:
    return ((row.expires_at is None or row.expires_at > now)
            and person.archived_at is None)


async def _sign_in(db: AsyncSession, request: Request, row: LearningCode, person: Person,
                   raw_ip: str, ip: str | None, via: str, now: datetime) -> LearnSessionOut:
    row.last_used_at = now
    # the address the caps key on (rate_limit_ip), not the spoofable leftmost
    # X-Forwarded-For entry
    token, session = await sessions.start_session(
        db, code=row, person_id=person.id, ip=raw_ip,
        user_agent=request.headers.get("user-agent"))
    audit(db, actor_id=person.id, entity_type="learning_code", entity_id=str(row.id),
          action="sign_in", changes={"via": via}, ip=ip)
    await db.commit()
    return LearnSessionOut(token=token, expires_at=session.expires_at,
                           person=LearnPersonOut(first_name=person.first_name))


@router.post("/code", response_model=LearnSessionOut)
async def code_sign_in(body: LearnCodeIn, request: Request, db: DbSession) -> LearnSessionOut:
    settings = await load_settings(db)
    raw_ip = rate_limit_ip(request)
    ip = _inet_or_none(raw_ip)
    bucket = move_login_bucket(raw_ip)
    await _serialize(db, bucket)
    if await learn_login_capped(db, settings, bucket):
        raise _err(429, "rate_limited")
    now = datetime.now(UTC)
    found = None
    if codes.is_well_formed(body.code):
        # the person comes in the same query, so a wrong code and a wrong
        # name cost the same round trips; the row lock serializes counting
        found = (await db.execute(
            select(LearningCode, Person)
            .join(Person, Person.id == LearningCode.person_id)
            .where(LearningCode.fingerprint == codes.fingerprint(body.code),
                   LearningCode.revoked_at.is_(None))
            .with_for_update(of=LearningCode))).first()
    row, person = found if found is not None else (None, None)
    # compared for every attempt (an unknown code against ""), so no path
    # skips the work; a locked code never looks at the result
    stored_name = person.last_name if person is not None else ""
    name_ok = codes.last_name_matches(stored_name, body.last_name)
    if row is None or not _usable(row, person, now):
        reason = "unknown_code" if row is None else "code_unusable"
        raise await _failed(db, ip, bucket, reason, row=row)
    if row.locked_until is not None and row.locked_until > now:
        # the same 401 whatever the name; no lock extension, no session
        raise await _failed(db, ip, bucket, "code_locked", row=row)
    if not name_ok:
        row.failed_count += 1
        if row.failed_count >= settings.code_max_failures:
            row.locked_until = now + timedelta(seconds=settings.code_lockout_seconds)
            row.failed_count = 0
        raise await _failed(db, ip, bucket, "wrong_last_name", row=row)
    row.failed_count = 0
    row.locked_until = None
    return await _sign_in(db, request, row, person, raw_ip, ip, "code", now)


@router.post("/link", response_model=LearnSessionOut)
async def link_sign_in(body: LearnLinkIn, request: Request, db: DbSession) -> LearnSessionOut:
    """The invite's one-click link. Its token is unguessable, so a code
    locked by someone guessing at it doesn't lock its owner's link."""
    settings = await load_settings(db)
    raw_ip = rate_limit_ip(request)
    ip = _inet_or_none(raw_ip)
    bucket = move_login_bucket(raw_ip)
    await _serialize(db, bucket)
    if await learn_login_capped(db, settings, bucket):
        raise _err(429, "rate_limited")
    now = datetime.now(UTC)
    found = (await db.execute(
        select(LearningCode, Person)
        .join(Person, Person.id == LearningCode.person_id)
        .where(LearningCode.link_token_hash == hash_token(body.token),
               LearningCode.revoked_at.is_(None)))).first()
    if found is None or not _usable(*found, now):
        raise await _failed(db, ip, bucket, "invalid_link",
                            row=found[0] if found is not None else None)
    row, person = found
    return await _sign_in(db, request, row, person, raw_ip, ip, "link", now)


@router.post("/logout", status_code=204)
async def logout(actor: CurrentLearner, db: DbSession) -> None:
    """End the learn session. An account bearer has none here: the portal
    session is the portal's to end."""
    if actor.session is not None:
        actor.session.revoked_at = datetime.now(UTC)
        await db.commit()


@router.get("/me", response_model=LearnMeOut)
async def me(actor: CurrentLearner, db: DbSession) -> LearnMeOut:
    person = actor.user.person if actor.user is not None else await db.get(Person, actor.person_id)
    return LearnMeOut(person_id=actor.person_id, first_name=person.first_name,
                      via="code" if actor.session is not None else "account")
