"""Status provenance — when did a row's status become its current value,
and what set it (a scan or a person's edit)?

One generic endpoint behind every list's status-chip hover popup. Two
candidate sources, most recent wins:

- audit_log: the latest row for the entity whose `changes.status.to`
  matches the asked-about status (a portal edit).
- processed_scans: for asset-backed rows, the latest matched scan that
  reported this status — carrying the scan type (rfid/barcode/manual),
  device, and site.

initiative_asset rows are audited on their PARENT initiative without a
per-asset marker, so their edit history isn't row-addressable — those
resolve to the underlying asset's scan trail only.
"""

import uuid

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import CurrentUser, DbSession
from serversherpa.api.schemas import StatusProvenanceOut
from serversherpa.db.models import (
    Asset, AuditLog, Client, Initiative, InitiativeAsset, Partner, Person,
    ProcessedScan, Site, StatusValue, TimeEntry, WorkerProfile,
)

router = APIRouter(prefix="/status", tags=["status"])

# entity_type -> the resource whose view permission gates the lookup
ENTITY_RESOURCE: dict[str, str] = {
    "asset": "assets",
    "initiative_asset": "initiatives",
    "container": "containers",
    "site": "sites",
    "worker": "workers",
    "initiative": "initiatives",
    "client": "clients",
    "partner": "partners",
    "time_entry": "time",
}

# How many recent audit rows to scan for a status transition before
# giving up — bounded so a chatty entity can't make hovers expensive.
AUDIT_SCAN_LIMIT = 200

# entity_type -> the column to row-scope against, for the entity types whose
# resource carries a SCOPE_COLUMNS entry (access/scope.py). A row outside
# the actor's scope 404s exactly like a nonexistent one — never a 403,
# which would leak that the id belongs to someone else. Worker entity ids
# are person ids, probed via the worker's profile row like workers.py's
# _check_worker_scope (a worker without a profile is out of scope for any
# non-global actor).
SCOPE_PROBE_COLUMN = {
    "initiative": Initiative.id,
    "asset": Asset.id,
    "client": Client.id,
    "partner": Partner.id,
    "worker": WorkerProfile.person_id,
}


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


@router.get("/provenance", response_model=StatusProvenanceOut)
async def status_provenance(
    user: CurrentUser,
    db: DbSession,
    entity_type: str = Query(min_length=1, max_length=40),
    entity_id: uuid.UUID = Query(),
    status: str = Query(min_length=1, max_length=80),
) -> StatusProvenanceOut:
    resource = ENTITY_RESOURCE.get(entity_type)
    if resource is None:
        raise _err(422, "unknown_entity_type")

    # A worker hovering the status chip on their OWN time entry shouldn't
    # need the `time` resource grant (workers don't hold time:view) — only
    # looking up someone else's entry falls back to the normal gate.
    own_time_entry = False
    if entity_type == "time_entry":
        time_entry = await db.get(TimeEntry, entity_id)
        if time_entry is None:
            raise _err(404, "not_found")
        own_time_entry = time_entry.person_id == user.person.id

    if not own_time_entry and not user.access.can(resource, "view"):
        raise HTTPException(status_code=403, detail={"code": "forbidden"})

    # initiative_asset rows resolve to their asset for the scan trail;
    # their audit rows live on the parent initiative un-addressably.
    asset_id: uuid.UUID | None = None
    audit_entity: tuple[str, str] | None = (entity_type, str(entity_id))
    if entity_type == "initiative_asset":
        assoc = await db.get(InitiativeAsset, entity_id)
        if assoc is None:
            raise _err(404, "not_found")
        asset_id = assoc.asset_id
        audit_entity = None
    elif entity_type == "asset":
        asset_id = entity_id

    # Row-scope probe: initiative/asset/client/partner/worker rows carry a
    # scope column, so a foreign row must 404 (never 403) for a non-global
    # actor. initiative_asset resolves to its parent initiative and probes
    # that.
    probe_col = SCOPE_PROBE_COLUMN.get(entity_type)
    scope_target_id = entity_id
    if entity_type == "initiative_asset":
        probe_col = Initiative.id
        scope_target_id = assoc.initiative_id
    if probe_col is not None:
        cond = scope_conditions(resource, user.access, user.person.id)
        if cond is not None:
            visible = await db.scalar(
                select(probe_col).where(
                    probe_col == scope_target_id, cond))
            if visible is None:
                raise _err(404, "not_found")

    # candidate 1: the latest audited edit that set this status
    edit_at = None
    edit_actor_id = None
    if audit_entity is not None:
        rows = await db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == audit_entity[0],
                   AuditLog.entity_id == audit_entity[1])
            .order_by(AuditLog.at.desc())
            .limit(AUDIT_SCAN_LIMIT))
        for row in rows:
            change = row.changes.get("status")
            if isinstance(change, dict) and change.get("to") == status:
                edit_at = row.at
                edit_actor_id = row.actor_person_id
                break

    # candidate 2: the latest matched scan that reported this status
    scan = None
    if asset_id is not None:
        scan = await db.scalar(
            select(ProcessedScan)
            .where(ProcessedScan.asset_id == asset_id,
                   ProcessedScan.status == status)
            .order_by(ProcessedScan.scanned_at.desc())
            .limit(1))

    use_scan = scan is not None and (edit_at is None or scan.scanned_at >= edit_at)

    if use_scan and scan is not None:
        st = await db.scalar(select(StatusValue).where(
            StatusValue.record_type == "scan",
            StatusValue.key == scan.scan_type))
        site_name = None
        if scan.site_id is not None:
            site_name = await db.scalar(
                select(Site.name).where(Site.id == scan.site_id))
        return StatusProvenanceOut(
            status=status, changed_at=scan.scanned_at, source="scan",
            scan_type=scan.scan_type,
            scan_type_label=st.label if st else scan.scan_type,
            scan_type_color=st.color if st else None,
            device_id=scan.device_id or None, site_name=site_name)

    if edit_at is not None:
        actor_name = None
        if edit_actor_id is not None:
            actor_name = await db.scalar(
                select(Person.first_name + " " + Person.last_name)
                .where(Person.id == edit_actor_id))
        return StatusProvenanceOut(
            status=status, changed_at=edit_at, source="edit",
            actor_name=actor_name)

    return StatusProvenanceOut(status=status)
