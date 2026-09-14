"""Kiosk — the scanning-floor app's own endpoints: 'link with phone'
pairing (unauthenticated on the kiosk side, kiosk:view-gated on the
phone side) and, in Task 4, the signed-in heartbeat that upserts the
kiosk's Device row. Design:
docs/superpowers/specs/2026-09-13-kiosk-web-design.md"""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import case, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, joinedload

from serversherpa.access.resolver import resolve_access
from serversherpa.api.deps import (
    AuthContext, DbSession, client_ip, rate_limit_ip, require_permission,
)
from serversherpa.api.routes.auth import session_response
from serversherpa.api.schemas import (
    HeartbeatIn, HeartbeatOut, KioskSetupIn, KioskSetupOut, KioskSignOutIn, PairCreateIn,
    PairCreateOut, PairInfoOut, PairPollIn, PairPollOut, SetupOptionInitiative,
    SetupOptionScanType, SetupOptionSite, SetupOptionsOut,
)
from serversherpa.db.models import (
    Client, Device, Initiative, KioskPairRequest, Site, StatusValue, UserAccount,
)
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
KIOSK_AUTO_REGISTER_DAYS = 30   # matches the portal's Register default (devices.py::register_device)


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
    A sign-in beat (body.sign_in) records who is now signed in
    (session_person_id/session_login_method/session_started_at, cleared
    by /kiosk/sign-out) and also auto-registers the kiosk for
    KIOSK_AUTO_REGISTER_DAYS when its registration is none, expired, or
    within REGISTRATION_SOON of expiring; Register/Renew in the portal
    remain available for admins."""
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
    if body.sign_in:
        device.session_person_id = actor.person.id
        device.session_login_method = body.login_method
        device.session_started_at = now
        if registration_state(device.token_expires_at, now) in ("none", "expired", "soon"):
            device.registered_at = now
            device.token_expires_at = now + timedelta(days=KIOSK_AUTO_REGISTER_DAYS)
            audit(db, actor_id=actor.person.id, entity_type="device",
                  entity_id=str(device.id), action="register",
                  changes={"days": KIOSK_AUTO_REGISTER_DAYS,
                           "token_expires_at": device.token_expires_at.isoformat(),
                           "source": "kiosk_sign_in"})
    await db.commit()
    return HeartbeatOut(device_id=device.id, name=device.name,
                        registration=registration_state(device.token_expires_at, now),
                        token_expires_at=device.token_expires_at)


@router.post("/sign-out", status_code=204)
async def sign_out(
    body: KioskSignOutIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> None:
    """Clear this kiosk's signed-in session, if it's still this person's.
    Always 204 — a missing device or someone else's session is not an
    error, since the kiosk is about to drop its own token either way."""
    device = await db.scalar(select(Device).where(Device.serial == body.serial))
    if device is None:
        return
    if device.session_person_id is not None and device.session_person_id != actor.person.id:
        return
    device.session_person_id = None
    device.session_login_method = None
    device.session_started_at = None
    device.updated_at = datetime.now(UTC)
    await db.commit()


# ── setup wizard (kiosk:view) ────────────────────────────────────────

# Terminal/historical keys from the initiative status vocabulary seeded in
# migrations/versions/0016_initiatives.py (record_type="initiative"):
# planned / scheduled / in_progress / on_hold are active work; completed
# and cancelled are done and excluded from the kiosk's move list.
HISTORICAL_INITIATIVE_STATUSES = ("completed", "cancelled")


async def _initiative_status_labels(db: AsyncSession) -> dict[str, str]:
    rows = await db.execute(
        select(StatusValue.key, StatusValue.label)
        .where(StatusValue.record_type == "initiative"))
    return dict(rows.all())


async def _allowed_initiatives_with_sites(db: AsyncSession) -> list:
    """Move initiatives that are not complete or historical, each paired
    with its origin (source) and destination Site rows and its Client, all
    via outer joins — any of these can be absent (a move that hasn't had
    its sites or client set yet). Ordered with in-progress moves first,
    then everything else, then by the earliest scheduled_start (nulls
    last), then by name."""
    Origin = aliased(Site)
    Dest = aliased(Site)
    in_progress_first = case((Initiative.status == "in_progress", 0), else_=1)
    return list((await db.execute(
        select(Initiative, Origin, Dest, Client)
        .outerjoin(Origin, Initiative.origin_site_id == Origin.id)
        .outerjoin(Dest, Initiative.destination_site_id == Dest.id)
        .outerjoin(Client, Initiative.client_id == Client.id)
        .where(Initiative.initiative_type == "move",
               Initiative.archived_at.is_(None),
               Initiative.status.not_in(HISTORICAL_INITIATIVE_STATUSES))
        .order_by(in_progress_first, Initiative.scheduled_start.is_(None),
                  Initiative.scheduled_start, Initiative.name))).all())


async def _active_scan_types(db: AsyncSession) -> list[StatusValue]:
    return list((await db.scalars(
        select(StatusValue)
        .where(StatusValue.record_type == "asset", StatusValue.is_active.is_(True))
        .order_by(StatusValue.sort_order, StatusValue.label))).all())


@router.get("/setup-options", response_model=SetupOptionsOut)
async def setup_options(
    db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> SetupOptionsOut:
    """Move initiatives that are not complete or historical (see
    HISTORICAL_INITIATIVE_STATUSES) and active asset status values, for the
    Kiosk Setup wizard's card pickers. Workers hold kiosk:view but not
    initiatives:view, so they cannot call /initiatives directly; this
    endpoint gives the kiosk only the narrow slice of that data the wizard
    needs, including the status label and client name for display."""
    rows = await _allowed_initiatives_with_sites(db)
    scan_types = await _active_scan_types(db)
    status_labels = await _initiative_status_labels(db)
    return SetupOptionsOut(
        initiatives=[
            SetupOptionInitiative(
                id=i.id, name=i.name, status=i.status,
                status_label=status_labels.get(i.status, i.status),
                client_name=client.name if client else None,
                scheduled_start=(i.scheduled_start.isoformat()
                                if i.scheduled_start else None),
                scheduled_end=i.scheduled_end.isoformat() if i.scheduled_end else None,
                source_site=SetupOptionSite(id=origin.id, name=origin.name) if origin else None,
                destination_site=(SetupOptionSite(id=dest.id, name=dest.name)
                                  if dest else None))
            for i, origin, dest, client in rows],
        scan_types=[SetupOptionScanType(key=s.key, label=s.label, color=s.color)
                   for s in scan_types])


@router.post("/setup", response_model=KioskSetupOut)
async def kiosk_setup(
    body: KioskSetupIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskSetupOut:
    """Stamps this kiosk's Device row (found by serial) with the move, the
    move's source or destination site, and the scan type chosen in the
    Kiosk Setup wizard. Not read-only exempt — this is a write."""
    device = await db.scalar(select(Device).where(Device.serial == body.serial))
    if device is None or device.device_type != "kiosk":
        raise _err(404, "device_not_found")
    initiative = await db.get(Initiative, body.initiative_id)
    if (initiative is None or initiative.initiative_type != "move"
            or initiative.status in HISTORICAL_INITIATIVE_STATUSES
            or initiative.archived_at is not None):
        raise _err(422, "bad_initiative")
    scan_type = await db.get(StatusValue, ("asset", body.scan_status))
    if scan_type is None or not scan_type.is_active:
        raise _err(422, "bad_scan_status")
    if body.site_id == initiative.origin_site_id:
        site_role = "source"
    elif body.site_id == initiative.destination_site_id:
        site_role = "destination"
    else:
        raise _err(422, "bad_site")
    site = await db.get(Site, body.site_id)
    if site is None:
        raise _err(422, "bad_site")

    device.current_initiative_id = initiative.id
    device.site_id = site.id
    device.scan_status = scan_type.key
    device.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="kiosk_setup",
          changes={"initiative_id": str(initiative.id), "site_id": str(site.id),
                   "scan_status": scan_type.key})
    await db.commit()
    return KioskSetupOut(device_id=device.id, initiative_id=initiative.id,
                         initiative_name=initiative.name,
                         site_id=site.id, site_name=site.name, site_role=site_role,
                         scan_status=scan_type.key, scan_status_label=scan_type.label)
