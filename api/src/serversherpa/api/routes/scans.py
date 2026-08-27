"""Scans — the read side of raw_scans (paged inbox, Audit-style server
filters) and processed_scans (full denormalized list). Raw scans are
read-only by design: rows arrive from future kiosk/reader ingest and
leave via the future matcher/pruner — nothing here mutates them."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Query
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import ProcessedScanItem, RawScanItem
from serversherpa.db.models import (
    Asset, Container, Person, ProcessedScan, RawScan, Site, StatusValue,
)

router = APIRouter(prefix="/scans", tags=["scans"])

FALLBACK_COLOR = "#51606f"


async def _vocab(db: DbSession) -> tuple[dict, dict]:
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("scan", "processed_scan"))))).all()
    scan_types = {s.key: (s.label, s.color)
                  for s in rows if s.record_type == "scan"}
    match_types = {s.key: (s.label, s.color)
                   for s in rows if s.record_type == "processed_scan"}
    return scan_types, match_types


async def _people_names(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Person.id, Person.first_name + " " + Person.last_name)
        .where(Person.id.in_(ids)))).all())


async def _site_names(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(ids)))).all())


def _raw_context(s: RawScan | ProcessedScan, scan_types: dict,
                 people: dict, sites: dict) -> dict:
    st_label, st_color = scan_types.get(
        s.scan_type, (s.scan_type, FALLBACK_COLOR))
    return {
        "scanned_value": s.scanned_value,
        "scan_type": s.scan_type,
        "scan_type_label": st_label, "scan_type_color": st_color,
        "scanned_at": s.scanned_at, "device_id": s.device_id,
        "operator_id": s.operator_id,
        "operator_name": people.get(s.operator_id),
        "site_id": s.site_id, "site_name": sites.get(s.site_id),
        "location_detail": s.location_detail, "source": s.source,
    }


@router.get("/raw", response_model=list[RawScanItem])
async def list_raw_scans(
    db: DbSession,
    actor: AuthContext = require_permission("scans", "view"),
    device_id: str | None = None,
    operator_id: uuid.UUID | None = None,
    site_id: uuid.UUID | None = None,
    scan_type: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    value: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[RawScanItem]:
    query = (select(RawScan).order_by(RawScan.scanned_at.desc(),
                                      RawScan.id.desc())
             .limit(limit).offset(offset))
    if device_id is not None:
        query = query.where(RawScan.device_id == device_id)
    if operator_id is not None:
        query = query.where(RawScan.operator_id == operator_id)
    if site_id is not None:
        query = query.where(RawScan.site_id == site_id)
    if scan_type is not None:
        query = query.where(RawScan.scan_type == scan_type)
    if since is not None:
        query = query.where(RawScan.scanned_at >= since)
    if until is not None:
        query = query.where(RawScan.scanned_at <= until)
    if value is not None:
        # CITEXT: ILIKE-equivalent case-insensitive substring
        query = query.where(RawScan.scanned_value.ilike(f"%{value}%"))

    scans = list(await db.scalars(query))
    scan_types, _ = await _vocab(db)
    people = await _people_names(db, {s.operator_id for s in scans})
    sites = await _site_names(db, {s.site_id for s in scans})
    return [RawScanItem(id=s.id, created_at=s.created_at,
                        **_raw_context(s, scan_types, people, sites))
            for s in scans]


@router.get("/processed", response_model=list[ProcessedScanItem])
async def list_processed_scans(
    db: DbSession,
    actor: AuthContext = require_permission("scans", "view"),
) -> list[ProcessedScanItem]:
    scans = list(await db.scalars(
        select(ProcessedScan).order_by(ProcessedScan.scanned_at.desc(),
                                       ProcessedScan.id)))
    scan_types, match_types = await _vocab(db)
    people = await _people_names(
        db, {s.operator_id for s in scans} | {s.person_id for s in scans})
    sites = await _site_names(db, {s.site_id for s in scans})

    asset_ids = {s.asset_id for s in scans if s.asset_id}
    assets = dict((await db.execute(
        select(Asset.id, Asset.name).where(Asset.id.in_(asset_ids))
    )).all()) if asset_ids else {}
    container_ids = {s.container_id for s in scans if s.container_id}
    containers = dict((await db.execute(
        select(Container.id, Container.name)
        .where(Container.id.in_(container_ids))
    )).all()) if container_ids else {}

    def matched_name(s: ProcessedScan) -> str | None:
        if s.match_type == "asset":
            return assets.get(s.asset_id)
        if s.match_type == "container":
            return containers.get(s.container_id)
        return people.get(s.person_id)

    out = []
    for s in scans:
        m_label, m_color = match_types.get(
            s.match_type, (s.match_type, FALLBACK_COLOR))
        out.append(ProcessedScanItem(
            id=s.id, raw_scan_id=s.raw_scan_id,
            match_type=s.match_type,
            match_type_label=m_label, match_type_color=m_color,
            asset_id=s.asset_id, container_id=s.container_id,
            person_id=s.person_id, matched_name=matched_name(s),
            processed_at=s.processed_at, archived_at=s.archived_at,
            created_at=s.created_at,
            **_raw_context(s, scan_types, people, sites)))
    return out
