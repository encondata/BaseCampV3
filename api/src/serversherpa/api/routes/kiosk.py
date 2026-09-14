"""Kiosk — the scanning-floor app's own endpoints: 'link with phone'
pairing (unauthenticated on the kiosk side, kiosk:view-gated on the
phone side) and, in Task 4, the signed-in heartbeat that upserts the
kiosk's Device row. Design:
docs/superpowers/specs/2026-09-13-kiosk-web-design.md"""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from serversherpa.access.resolver import resolve_access
from serversherpa.api.deps import (
    AuthContext, DbSession, client_ip, rate_limit_ip, require_permission,
)
from serversherpa.api.routes.auth import session_response
from serversherpa.api.schemas import (
    HeartbeatIn, HeartbeatOut, PairCreateIn, PairCreateOut, PairInfoOut, PairPollIn, PairPollOut,
)
from serversherpa.db.models import Device, KioskPairRequest, UserAccount
from serversherpa.services import auth as auth_service
from serversherpa.services import kiosk_pairing as pairing
from serversherpa.services.audit import audit

router = APIRouter(prefix="/kiosk", tags=["kiosk"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


# ── pairing: kiosk side (no auth) ───────────────────────────────────

@router.post("/pair", response_model=PairCreateOut, status_code=201)
async def create_pair(body: PairCreateIn, request: Request, db: DbSession) -> PairCreateOut:
    try:
        row, token = await pairing.create_request(
            db, serial=body.serial, name=body.name, ip=rate_limit_ip(request))
    except pairing.PairError as exc:
        raise _err(429, exc.code) from None
    return PairCreateOut(code=row.code, poll_token=token,
                         link_url=pairing.link_url(row.code), expires_at=row.expires_at)


@router.post("/pair/{code}/poll", response_model=PairPollOut)
async def poll_pair(
    code: str, body: PairPollIn, request: Request, response: Response, db: DbSession,
) -> PairPollOut:
    row = await pairing.get_by_code(db, code)
    if row is None:
        raise _err(404, "pair_not_found")
    if not pairing.poll_token_matches(body.poll_token, row.poll_token_hash):
        raise _err(403, "pair_forbidden")
    now = datetime.now(UTC)
    status = pairing.effective_status(row, now)
    if status != "approved":
        return PairPollOut(status=status)

    account = await db.scalar(
        select(UserAccount).options(joinedload(UserAccount.person))
        .where(UserAccount.person_id == row.approved_by))
    access = await resolve_access(db, row.approved_by) if account is not None else None
    usable = (account is not None and account.disabled_at is None
              and account.person.archived_at is None
              and access is not None and access.can("kiosk", "view"))
    if not usable:
        denied = await db.execute(
            update(KioskPairRequest)
            .where(KioskPairRequest.id == row.id, KioskPairRequest.status == "approved")
            .values(status="denied", updated_at=now))
        if denied.rowcount == 1:
            audit(db, actor_id=None, entity_type="kiosk_pair", entity_id=row.code,
                  action="kiosk_pair_claim_denied",
                  changes={"serial": row.serial,
                           "approved_by": str(row.approved_by) if row.approved_by else None},
                  ip=client_ip(request))
            await db.commit()
        else:
            await db.rollback()
        return PairPollOut(status="denied")

    claimed = await db.execute(
        update(KioskPairRequest)
        .where(KioskPairRequest.id == row.id, KioskPairRequest.status == "approved")
        .values(status="claimed", updated_at=now))
    if claimed.rowcount != 1:
        await db.rollback()
        return PairPollOut(status="expired")   # someone else already claimed it

    result = await auth_service.start_session(
        db, account, ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        audit_action="login_pair", access=access)
    return PairPollOut(status="approved", session=session_response(result, response))


# ── pairing: phone side (kiosk:view) ────────────────────────────────

@router.get("/pair/{code}", response_model=PairInfoOut)
async def pair_info(
    code: str, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> PairInfoOut:
    row = await pairing.get_by_code(db, code)
    if row is None:
        raise _err(404, "pair_not_found")
    return PairInfoOut(code=row.code, kiosk_name=row.kiosk_name, serial=row.serial,
                       status=pairing.effective_status(row, datetime.now(UTC)),
                       expires_at=row.expires_at)


async def _decide(
    db: AsyncSession, code: str, actor: AuthContext, *, new_status: str, action: str,
) -> None:
    row = await pairing.get_by_code(db, code)
    if row is None:
        raise _err(404, "pair_not_found")
    now = datetime.now(UTC)
    if pairing.effective_status(row, now) != "pending":
        raise _err(409, "pair_not_pending")
    values: dict = {"status": new_status, "updated_at": now}
    if new_status == "approved":
        values["approved_by"] = actor.person.id
    decided = await db.execute(
        update(KioskPairRequest)
        .where(KioskPairRequest.id == row.id, KioskPairRequest.status == "pending")
        .values(**values))
    if decided.rowcount != 1:
        await db.rollback()
        raise _err(409, "pair_not_pending")
    audit(db, actor_id=actor.person.id, entity_type="kiosk_pair",
          entity_id=row.code, action=action,
          changes={"serial": row.serial, "kiosk_name": row.kiosk_name})
    await db.commit()


@router.post("/pair/{code}/approve", status_code=204)
async def approve_pair(
    code: str, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> None:
    await _decide(db, code, actor, new_status="approved", action="kiosk_pair_approved")


@router.post("/pair/{code}/deny", status_code=204)
async def deny_pair(
    code: str, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> None:
    await _decide(db, code, actor, new_status="denied", action="kiosk_pair_denied")


# ── heartbeat (kiosk:view) ──────────────────────────────────────────

REGISTRATION_SOON = timedelta(days=7)   # same threshold as the Kiosk Devices page


def registration_state(token_expires_at: datetime | None, now: datetime) -> str:
    if token_expires_at is None:
        return "none"
    if token_expires_at <= now:
        return "expired"
    return "soon" if token_expires_at - now <= REGISTRATION_SOON else "ok"


@router.post("/heartbeat", response_model=HeartbeatOut)
async def heartbeat(
    body: HeartbeatIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> HeartbeatOut:
    """Upsert this kiosk's Device row by serial and stamp last_seen_at.
    Creation is audited once (self_register); later beats are telemetry.
    Register/Renew (token_expires_at) stays a portal admin action."""
    now = datetime.now(UTC)
    device = await db.scalar(select(Device).where(Device.serial == body.serial))
    if device is None:
        device = Device(device_type="kiosk", name=body.name, serial=body.serial,
                        sub_type=body.mode, version=body.version,
                        raw_info=dict(body.raw_info), last_seen_at=now)
        db.add(device)
        await db.flush()
        audit(db, actor_id=actor.person.id, entity_type="device",
              entity_id=str(device.id), action="self_register",
              changes={"serial": body.serial, "name": body.name, "sub_type": body.mode})
    elif device.device_type != "kiosk":
        raise _err(409, "serial_conflict")
    else:
        device.name = body.name
        device.sub_type = body.mode
        device.version = body.version
        device.raw_info = {**(device.raw_info or {}), **body.raw_info}
        device.last_seen_at = now
        device.updated_at = now
    await db.commit()
    return HeartbeatOut(device_id=device.id, name=device.name,
                        registration=registration_state(device.token_expires_at, now),
                        token_expires_at=device.token_expires_at)
