"""Kiosk — the scanning-floor app's own endpoints: 'link with phone'
pairing (unauthenticated on the kiosk side, kiosk:view-gated on the
phone side) and, in Task 4, the signed-in heartbeat that upserts the
kiosk's Device row. Design:
docs/superpowers/specs/2026-09-13-kiosk-web-design.md"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request, Response
from sqlalchemy import case, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, joinedload

from serversherpa.access.resolver import resolve_access
from serversherpa.api.deps import (
    AuthContext, DbSession, client_ip, rate_limit_ip, require_permission,
)
from serversherpa.api.routes.auth import session_response
from serversherpa.api.schemas import (
    HeartbeatIn, HeartbeatOut, KioskAssetOut, KioskAssetsSyncOut, KioskClockInIn,
    KioskClockOutIn, KioskPeopleSyncOut, KioskPersonOut, KioskScanBatchIn,
    KioskScanBatchOut, KioskScanRejected, KioskSetupIn, KioskSetupOut,
    KioskSignOutIn, KioskTimeclockEntry, KioskTimeclockLastEntry,
    KioskTimeclockPerson, KioskTimeclockStatusOut, PairCreateIn, PairCreateOut,
    PairInfoOut, PairPollIn, PairPollOut, SetupOptionInitiative,
    SetupOptionScanType, SetupOptionSite, SetupOptionsOut,
)
from serversherpa.db.models import (
    Asset, AssetModel, Client, Device, Initiative, InitiativeAsset, KioskPairRequest,
    LabelPlaceholder, Person, RawScan, Site, StatusValue, TimeEntry, UserAccount,
    WorkerProfile,
)
from serversherpa.labels.generate.values import (
    CONTAINER_KEYS, AssetRow, Sites, make_model_text, placeholder_values,
)
from serversherpa.services import auth as auth_service
from serversherpa.services import kiosk_pairing as pairing
from serversherpa.services import timeclock
from serversherpa.services.audit import audit
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/kiosk", tags=["kiosk"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


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


async def _allowed_initiatives_with_sites(
    db: AsyncSession,
) -> list[tuple[Initiative, Site | None, Site | None, Client | None]]:
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
    needs, including the status label and client name for display.

    The *filter* matches the portal's move picker in spirit (not-complete,
    not-cancelled moves — see the docstring above); the *scope* is
    deliberately wider than the portal's equivalent. This runs with no
    scope_conditions applied at all: it is gated on kiosk:view only, so any
    signed-in kiosk user sees every active move and its sites, regardless
    of client/initiative anchoring. Applying the portal's scope here would
    leave client/vendor kiosk users staring at an empty list (they hold no
    initiatives:view-shaped scope), and workers are self-anchored rather
    than initiative-anchored, so there is no narrower scope to apply that
    would still let a worker set up a kiosk. See the spec's security notes
    for the accepted-risk writeup."""
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


# ── local-data sync (kiosk:view) ─────────────────────────────────────


async def _label_catalog_keys(db: AsyncSession) -> list[str]:
    """The active label placeholder catalog, minus the container-only
    keys (labels/generate/values.py resolves those to "" for an asset
    row anyway — the runner is asset-only). Same source of truth the
    label generator reads, so the kiosk caches exactly the values a
    generated label would carry."""
    keys = list((await db.scalars(
        select(LabelPlaceholder.key)
        .where(LabelPlaceholder.is_active.is_(True))
        .order_by(LabelPlaceholder.sort_order, LabelPlaceholder.key))).all())
    return [k for k in keys if k not in CONTAINER_KEYS]


@router.get("/sync/assets", response_model=KioskAssetsSyncOut)
async def sync_assets(
    db: DbSession,
    initiative_id: uuid.UUID = Query(...),
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskAssetsSyncOut:
    """Every asset on this move's roster, for the kiosk's local
    (IndexedDB) copy of the move: identity fields (asset ID, name, RFID,
    serial, make/model) plus `label` — the full label placeholder map
    for that asset on this move, computed by the label generator's own
    `placeholder_values` so an offline kiosk renders the same values a
    generated label carries.

    One response, no paging: the whole roster comes down in a single
    fetch (the portal's convention for roster-shaped data — see
    /initiatives/{id}/assets). A roster is hundreds to a few thousand
    rows; at roughly 400-600 bytes per row that is well under a
    megabyte, and the kiosk fetches it once per setup.

    404 `initiative_not_found` for an unknown id; 422 `bad_initiative`
    when the initiative is not a move. Gated on kiosk:view only, like
    the rest of this router (see /kiosk/setup-options' scope note)."""
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None:
        raise _err(404, "initiative_not_found")
    if initiative.initiative_type != "move":
        raise _err(422, "bad_initiative")

    origin = (await db.get(Site, initiative.origin_site_id)
              if initiative.origin_site_id else None)
    destination = (await db.get(Site, initiative.destination_site_id)
                   if initiative.destination_site_id else None)
    sites = Sites(origin=origin, destination=destination)
    catalog_keys = await _label_catalog_keys(db)

    rows = (await db.execute(
        select(Asset, InitiativeAsset, AssetModel)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative.id)
        .order_by(Asset.legacy_id))).all()

    assets: list[KioskAssetOut] = []
    for asset, ia, model in rows:
        make = model.make if model else None
        model_name = model.model if model else None
        asset_row = AssetRow(
            asset_id=asset.id, legacy_id=asset.legacy_id, name=asset.name,
            serial_number=asset.serial_number,
            make=make, model=model_name,
            source_rack=ia.source_rack, source_ru=ia.source_ru,
            source_position=ia.source_position, destination_rack=ia.destination_rack,
            destination_ru=ia.destination_ru,
            destination_position=ia.destination_position)
        # asset_id/make/model/make_model are this endpoint's own top-level
        # fields, computed straight from the asset/model columns (same join
        # rule as values.py) — never read out of `label`, which is filtered
        # to the active placeholder catalog and can lose keys (or the whole
        # catalog) to an admin's edits without touching what the kiosk needs.
        asset_id = str(asset.legacy_id) if asset.legacy_id is not None else ""
        make_model = make_model_text(make or "", model_name or "")
        label = placeholder_values(asset_row, initiative, sites, catalog_keys)
        assets.append(KioskAssetOut(
            id=asset.id, asset_id=asset_id, name=asset.name,
            rfid=asset.rfid_tag, serial_number=asset.serial_number,
            make=make, model=model_name,
            make_model=make_model, label=label))

    return KioskAssetsSyncOut(
        initiative_id=initiative.id, initiative_name=initiative.name,
        generated_at=datetime.now(UTC), assets=assets)


@router.get("/sync/people", response_model=KioskPeopleSyncOut)
async def sync_people(
    db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskPeopleSyncOut:
    """Every non-archived person who has a worker profile or a user
    account, for the kiosk's local copy of the people list — the set a
    kiosk needs to recognize whoever walks up to it.

    Privacy note: this caches names and RFID tags on the kiosk itself
    (IndexedDB, so they survive a reload). That is internal directory
    data, not contact details — no email, phone, or address is sent —
    and the endpoint is gated on kiosk:view, the same gate as the rest
    of this router. Contacts with neither a worker profile nor an
    account (client-side people) are never included. One response, no
    paging: the list is a few hundred rows at most."""
    rows = (await db.execute(
        select(Person,
               WorkerProfile.person_id.isnot(None),
               UserAccount.person_id.isnot(None))
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None),
               (WorkerProfile.person_id.isnot(None))
               | (UserAccount.person_id.isnot(None)))
        .order_by(Person.last_name, Person.first_name))).all()
    return KioskPeopleSyncOut(
        generated_at=datetime.now(UTC),
        people=[KioskPersonOut(id=p.id, display_name=p.display_name,
                               first_name=p.first_name, last_name=p.last_name,
                               preferred_name=p.preferred_name,
                               rfid_tag=p.rfid_tag, is_worker=is_worker,
                               has_account=has_account)
                for p, is_worker, has_account in rows])


# ── scan ingest (kiosk:view) ─────────────────────────────────────────


@router.post("/scans", response_model=KioskScanBatchOut)
async def ingest_scans(
    body: KioskScanBatchIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskScanBatchOut:
    """Take a batch of scans off a kiosk and write them into `raw_scans`
    — the same inbox the scan-matching worker drains. The kiosk sends
    only scans it already matched against its local copy of the move
    (its `asset_id` rides along as information); the server re-matches
    `scanned_value` from scratch, so a stale local database can never
    mis-attribute a scan.

    Each row is written fresh — `match_attempted_at` NULL, which is
    exactly what `scans/worker.py::run_once` selects on — with
    `device_id` = the kiosk's Device name (the reader/kiosk identity
    string raw_scans has always carried), `operator_id` = the signed-in
    person, `source` = "kiosk", and site / move / checkpoint taken from
    the scan when it carries them and from the kiosk's own setup when it
    does not. The checkpoint lands in both `status` (the FK'd column the
    matcher copies into processed_scans and status rules trigger on) and
    `scan_status` (what the device reported, kept verbatim).

    Idempotent on the kiosk-generated `client_scan_id`: a batch the
    kiosk retries because it never saw the response stores nothing new
    and reports every scan as accepted again, so the kiosk can clear its
    outbox. A scan naming a site, move, checkpoint, or scan type the
    server does not know is rejected on its own (`bad_site` /
    `bad_initiative` / `bad_status` / `bad_scan_type`) and the rest of
    the batch still lands — one bad row from a stale kiosk must not cost
    a truckload of scans. The whole batch fails only on an unknown kiosk
    (404), a malformed body (422), or read-only mode (423 — this writes,
    so it is not exempt).

    A checkpoint is only required to exist, not to still be active: a
    status someone deactivated mid-move must not start dropping scans.
    """
    device = await db.scalar(select(Device).where(Device.serial == body.serial))
    if device is None or device.device_type != "kiosk":
        raise _err(404, "device_not_found")
    now = datetime.now(UTC)

    # One lookup per reference kind for the whole batch, not per scan.
    site_ids = {s.site_id for s in body.scans if s.site_id is not None}
    initiative_ids = {s.initiative_id for s in body.scans if s.initiative_id is not None}
    status_keys = {s.scan_status for s in body.scans if s.scan_status is not None}
    known_sites = set(await db.scalars(
        select(Site.id).where(Site.id.in_(site_ids)))) if site_ids else set()
    known_initiatives = set(await db.scalars(
        select(Initiative.id).where(
            Initiative.id.in_(initiative_ids)))) if initiative_ids else set()
    known_statuses = set(await db.scalars(
        select(StatusValue.key).where(
            StatusValue.record_type == "asset",
            StatusValue.key.in_(status_keys)))) if status_keys else set()
    scan_type_keys = {s.scan_type for s in body.scans}
    known_scan_types = set(await db.scalars(
        select(StatusValue.key).where(
            StatusValue.record_type == "scan",
            StatusValue.key.in_(scan_type_keys)))) if scan_type_keys else set()

    accepted: list[uuid.UUID] = []
    rejected: list[KioskScanRejected] = []
    rows: list[dict] = []
    for scan in body.scans:
        if scan.scan_type not in known_scan_types:
            code = "bad_scan_type"
        elif scan.site_id is not None and scan.site_id not in known_sites:
            code = "bad_site"
        elif (scan.initiative_id is not None
                and scan.initiative_id not in known_initiatives):
            code = "bad_initiative"
        elif scan.scan_status is not None and scan.scan_status not in known_statuses:
            code = "bad_status"
        else:
            code = ""
        if code:
            rejected.append(KioskScanRejected(
                client_scan_id=scan.client_scan_id, code=code))
            continue
        checkpoint = scan.scan_status or device.scan_status
        rows.append({
            "scanned_value": scan.scanned_value,
            "scan_type": scan.scan_type,
            "status": checkpoint,
            "scan_status": checkpoint,
            "scanned_at": scan.scanned_at,
            "device_id": device.name,
            "operator_id": actor.person.id,
            "site_id": scan.site_id or device.site_id,
            "initiative_id": scan.initiative_id or device.current_initiative_id,
            "source": "kiosk",
            "client_scan_id": scan.client_scan_id,
        })
        accepted.append(scan.client_scan_id)

    if rows:
        # DO NOTHING against the partial unique index: a retried batch (or
        # two kiosks racing the same outbox) inserts nothing the second
        # time, and the scan still counts as accepted above.
        await db.execute(pg_insert(RawScan).values(rows).on_conflict_do_nothing(
            index_elements=["client_scan_id"],
            index_where=text("client_scan_id IS NOT NULL")))

    # last_seen_at only: updated_at means "this kiosk's configuration
    # changed", and ingesting scans does not change it.
    device.last_seen_at = now
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="kiosk_scans",
          changes={"accepted": len(accepted), "rejected": len(rejected)})
    await db.commit()
    return KioskScanBatchOut(accepted=accepted, rejected=rejected)


# ── timeclock (kiosk:view) ───────────────────────────────────────────

# The kiosk punch clock. A worker walks up, is found by badge, RFID, or
# typed name against the synced people list, and is clocked in or out —
# against the move and site from the kiosk's own setup unless the body
# says otherwise. The rows land in `time_entries`, the portal's own time
# tracking, with `source = "kiosk"` and `device_id` naming the kiosk.
#
# Gate: kiosk:view, like the rest of this router — and unlike
# /time/clock-in, which acts strictly on the caller's own person id, these
# act on ANOTHER person. Any kiosk user can therefore punch any worker.
# That is deliberate and matches the physical situation (one shared screen
# on a loading dock, one person tapping it for whoever is in front of
# them); the audit row names the operator, so every punch is attributable.
# See the spec's security notes. Both POSTs write, so neither is
# read-only exempt.


async def _kiosk_device(db: AsyncSession, serial: str) -> Device:
    device = await db.scalar(select(Device).where(Device.serial == serial))
    if device is None or device.device_type != "kiosk":
        raise _err(404, "device_not_found")
    return device


async def _timeclock_person(db: AsyncSession, person_id: uuid.UUID) -> Person:
    """An archived person is 404, not a punchable worker — the kiosk's
    people sync drops them too, so only a stale local cache asks."""
    person = await db.get(Person, person_id)
    if person is None or person.archived_at is not None:
        raise _err(404, "person_not_found")
    return person


def _person_out(person: Person) -> KioskTimeclockPerson:
    return KioskTimeclockPerson(
        id=person.id, display_name=person.display_name,
        first_name=person.first_name, last_name=person.last_name,
        preferred_name=person.preferred_name,
        avatar_url=presign_get(person.avatar_key), rfid_tag=person.rfid_tag)


async def _entry_out(db: AsyncSession, entry: TimeEntry) -> KioskTimeclockEntry:
    initiative = (await db.get(Initiative, entry.initiative_id)
                  if entry.initiative_id else None)
    site = await db.get(Site, entry.site_id) if entry.site_id else None
    return KioskTimeclockEntry(
        id=entry.id, started_at=entry.clock_in_at,
        initiative_id=entry.initiative_id,
        initiative_name=initiative.name if initiative else None,
        site_id=entry.site_id, site_name=site.name if site else None)


async def _status_out(
    db: AsyncSession, person: Person, entry: TimeEntry | None, *,
    last_entry: TimeEntry | None = None,
) -> KioskTimeclockStatusOut:
    return KioskTimeclockStatusOut(
        person=_person_out(person),
        clocked_in=entry is not None,
        entry=await _entry_out(db, entry) if entry is not None else None,
        last_entry=None if last_entry is None else KioskTimeclockLastEntry(
            id=last_entry.id, started_at=last_entry.clock_in_at,
            ended_at=last_entry.clock_out_at,
            minutes=timeclock.worked_minutes(last_entry)))


@router.get("/timeclock/{person_id}", response_model=KioskTimeclockStatusOut)
async def timeclock_status(
    person_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskTimeclockStatusOut:
    """Is this person on the clock right now, and since when? The kiosk
    polls this to show the avatar and the running elapsed time.

    When there is no open entry, `last_entry` carries their most
    recently CLOSED entry (ordered by `clock_out_at`), so the "Not
    clocked in" card can say "Last clock-out {time}" — null when they
    have never punched out at all. While clocked in, `last_entry` is
    left null; the card has the open entry to show instead."""
    person = await _timeclock_person(db, person_id)
    entry = await timeclock.open_entry_for(db, person.id)
    last_entry = (None if entry is not None
                  else await timeclock.last_closed_entry_for(db, person.id))
    return await _status_out(db, person, entry, last_entry=last_entry)


@router.post("/timeclock/clock-in", response_model=KioskTimeclockStatusOut)
async def timeclock_clock_in(
    body: KioskClockInIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskTimeclockStatusOut:
    """Open a time entry for the worker at the kiosk. Site and move come
    from the body when given and from the kiosk's setup otherwise; an id
    the server does not know is 422 (`bad_site` / `bad_initiative`)
    rather than 404, since the kiosk may simply be holding a stale copy
    of a setup. 409 `already_clocked_in` carries the open entry's id so
    the kiosk can offer "clock out" instead.

    Always stamped `datetime.now(UTC)` — there is no `at` (see
    `KioskClockInIn`'s docstring): back-dating a punch stays a portal
    action, behind `time:change` + `adjust_reason`, never a kiosk one."""
    device = await _kiosk_device(db, body.serial)
    person = await _timeclock_person(db, body.person_id)
    site_id = body.site_id or device.site_id
    initiative_id = body.initiative_id or device.current_initiative_id
    if site_id is not None and await db.get(Site, site_id) is None:
        raise _err(422, "bad_site")
    if initiative_id is not None and await db.get(Initiative, initiative_id) is None:
        raise _err(422, "bad_initiative")

    open_entry = await timeclock.open_entry_for(db, person.id)
    if open_entry is not None:
        raise _err(409, "already_clocked_in", entry_id=str(open_entry.id))

    now = datetime.now(UTC)
    try:
        entry = await timeclock.create_open_entry(
            db, person_id=person.id, initiative_id=initiative_id, site_id=site_id,
            clock_in_at=now, created_by=actor.person.id,
            source="kiosk", device_id=device.id)
    except timeclock.AlreadyClockedIn:
        # the one-open-entry index caught a punch that raced the check above
        racing = await timeclock.open_entry_for(db, person.id)
        raise _err(409, "already_clocked_in",
                   entry_id=str(racing.id) if racing else None) from None

    device.last_seen_at = now
    audit(db, actor_id=actor.person.id, entity_type="time_entry",
          entity_id=str(entry.id), action="kiosk_clock_in",
          changes={"person_id": str(person.id),
                   "site_id": str(site_id) if site_id else None,
                   "initiative_id": str(initiative_id) if initiative_id else None,
                   "device_id": str(device.id)})
    await db.commit()
    return await _status_out(db, person, entry)


@router.post("/timeclock/clock-out", response_model=KioskTimeclockStatusOut)
async def timeclock_clock_out(
    body: KioskClockOutIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskTimeclockStatusOut:
    """Close the worker's open entry (which graduates it to `pending`,
    the timesheet-approval queue — exactly what self-service clock-out
    does). `last_entry` comes back so the kiosk can say "Clocked out
    after 3h 12m" without another call.

    Always stamped `datetime.now(UTC)` — there is no `at` (see
    `KioskClockOutIn`'s docstring), so there is nothing left to validate
    against `clock_in_at` and no `bad_time` error to raise."""
    device = await _kiosk_device(db, body.serial)
    person = await _timeclock_person(db, body.person_id)
    entry = await timeclock.open_entry_for(db, person.id)
    if entry is None:
        raise _err(409, "not_clocked_in")

    now = datetime.now(UTC)
    changes = timeclock.close_open_entry(entry, clock_out_at=now, now=now)
    device.last_seen_at = now
    audit(db, actor_id=actor.person.id, entity_type="time_entry",
          entity_id=str(entry.id), action="kiosk_clock_out",
          changes={**changes, "person_id": str(person.id),
                   "device_id": str(device.id)})
    await db.commit()
    return await _status_out(db, person, None, last_entry=entry)
