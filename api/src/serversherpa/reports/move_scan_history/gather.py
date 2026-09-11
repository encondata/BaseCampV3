"""Step 1 of the Move Scan History report: read the initiative, its asset
roster, and the earliest-per-(asset, status) scan progress into plain
dataclasses. Port of V2's `run()` (api/reports/scan_history_report.py)
— see docs/superpowers/specs/2026-09-11-move-scan-history-design.md.

`InitiativeUnavailable` is reused from `move_report.gather` (not
redefined) so `reports/worker.py`'s existing `except InitiativeUnavailable`
clause maps this module's failure onto the same `initiative_unavailable`
run error without any change there.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, Client, Initiative, InitiativeAsset, ProcessedScan, Site, StatusValue,
)
from serversherpa.reports.move_report.gather import InitiativeUnavailable

__all__ = [
    "AssetRow", "InitiativeUnavailable", "PIPELINE_STATUS_KEYS", "ScanHistoryData",
    "ScanHit", "StatusCol", "columns_for", "gather",
]

# V2's DEFAULT_STATUS_ORDER, mapped onto the merged V3 asset status keys
# (migration 0022) — see the design spec's "Status columns" section.
# Included "active or not, in that order" even when the vocabulary lacks
# a key entirely (see _PIPELINE_FALLBACK_LABELS below).
PIPELINE_STATUS_KEYS: tuple[str, ...] = (
    "pre_stage", "rfid_1_cage_exit", "labeled", "rfid_2_loading_dock",
    "pack_logistics", "in_container", "in_transit", "received", "un_pack",
    "rfid_3_staging", "rfid_4_into_cage", "re_racked", "qa", "complete",
)

# V2's status_name literals (DEFAULT_STATUS_ORDER) — used only when a
# pipeline key has no row in status_values (record_type='asset') at all,
# so a pipeline column never silently disappears.
_PIPELINE_FALLBACK_LABELS: dict[str, str] = {
    "pre_stage": "Pre-Stage",
    "rfid_1_cage_exit": "RFID 1 - Cage Exit",
    "labeled": "Labeled",
    "rfid_2_loading_dock": "RFID 2 - Loading Dock",
    "pack_logistics": "Pack / Logistics",
    "in_container": "In Container",
    "in_transit": "In Transit",
    "received": "Received",
    "un_pack": "Un-Pack",
    "rfid_3_staging": "RFID 3 - Staging",
    "rfid_4_into_cage": "RFID 4 - Into Cage",
    "re_racked": "Re-Racked",
    "qa": "QA",
    "complete": "Complete",
}
_FALLBACK_COLOR = "#51606f"  # neutral slate — matches the "other" chip color elsewhere


@dataclass(frozen=True)
class AssetRow:
    asset_id: int          # Asset.legacy_id — the human Asset ID
    serial_number: str
    name: str


@dataclass(frozen=True)
class StatusCol:
    key: str
    label: str
    color: str
    in_pipeline: bool
    scan_count: int         # assets in this move that have reached this status


@dataclass(frozen=True)
class ScanHit:
    status_key: str
    status_label: str
    at: datetime            # tz-aware UTC


@dataclass(frozen=True)
class ScanHistoryData:
    initiative_id: uuid.UUID
    name: str
    client_name: str | None
    scheduled_start: datetime | None
    source_name: str | None
    destination_name: str | None
    assets: list[AssetRow]
    statuses: list[StatusCol]                    # "all" order, in_pipeline flags — see columns_for
    scan_progress: dict[int, list[ScanHit]]       # keyed by AssetRow.asset_id, earliest-first
    total_assets: int
    scanned_assets: int
    completed: int
    completion_pct: int
    last_scan_at: datetime | None


def columns_for(data: ScanHistoryData, mode: str) -> list[StatusCol]:
    """`data.statuses` is already built in "all" order (pipeline keys
    first, then every other status that is either active or was
    actually scanned on this move) with `in_pipeline` flags and
    `scan_count` — both modes are pure filters/re-slices of that one
    list, no extra DB access needed.

    - "all": the whole list, unchanged.
    - "pipeline": the pipeline columns, plus any non-pipeline column
      that was actually scanned on this move (`scan_count > 0`),
      appended in the same (progress_weight, sort_order, label) order
      `gather()` already sorted them in.
    """
    if mode == "all":
        return list(data.statuses)
    if mode == "pipeline":
        pipeline_cols = [c for c in data.statuses if c.in_pipeline]
        extra = [c for c in data.statuses if not c.in_pipeline and c.scan_count > 0]
        return pipeline_cols + extra
    raise ValueError(f"unknown status_columns mode {mode!r}")


def _other_status_sort_key(row: StatusValue) -> tuple[bool, int, str]:
    # progress_weight nulls last, then sort_order, then label
    weight = row.progress_weight
    return (weight is None, weight or 0, row.sort_order, row.label)


async def gather(db: AsyncSession, initiative_id: uuid.UUID) -> ScanHistoryData:
    ini = await db.get(Initiative, initiative_id)
    if ini is None or ini.archived_at is not None:
        raise InitiativeUnavailable(str(initiative_id))

    client = await db.get(Client, ini.client_id) if ini.client_id else None
    origin = await db.get(Site, ini.origin_site_id) if ini.origin_site_id else None
    dest = await db.get(Site, ini.destination_site_id) if ini.destination_site_id else None

    roster = (await db.execute(
        select(InitiativeAsset, Asset)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .where(InitiativeAsset.initiative_id == initiative_id)
        .order_by(Asset.legacy_id))).all()
    assets = [AssetRow(asset_id=a.legacy_id, serial_number=a.serial_number or "",
                       name=a.name or "") for _ia, a in roster]
    asset_uuid_by_legacy = {a.legacy_id: a.id for _ia, a in roster}

    vocab = {s.key: s for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}

    # Joined through InitiativeAsset (filtered by initiative_id) rather
    # than `ProcessedScan.asset_id.in_(asset_uuid_by_legacy.values())` —
    # same grouped result, zero bind parameters, no ceiling on roster
    # size (asyncpg caps IN(...) at 32767 params).
    scan_rows: list[tuple[int, str, datetime]] = []
    if asset_uuid_by_legacy:
        scan_rows = (await db.execute(
            select(Asset.legacy_id, ProcessedScan.status, func.min(ProcessedScan.scanned_at))
            .join(Asset, Asset.id == ProcessedScan.asset_id)
            .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
            .where(
                InitiativeAsset.initiative_id == initiative_id,
                ProcessedScan.match_type == "asset",
                ProcessedScan.status.isnot(None),
                ProcessedScan.archived_at.is_(None),
            )
            .group_by(Asset.legacy_id, ProcessedScan.status))).all()

    counts: dict[str, int] = {}
    scan_progress: dict[int, list[ScanHit]] = {}
    for legacy_id, status_key, at in scan_rows:
        vrow = vocab.get(status_key)
        label = vrow.label if vrow is not None else status_key
        scan_progress.setdefault(legacy_id, []).append(
            ScanHit(status_key=status_key, status_label=label, at=at))
        counts[status_key] = counts.get(status_key, 0) + 1
    for hits in scan_progress.values():
        hits.sort(key=lambda h: h.at)

    pipeline_cols = [StatusCol(
        key=key,
        label=vocab[key].label if key in vocab else _PIPELINE_FALLBACK_LABELS[key],
        color=vocab[key].color if key in vocab else _FALLBACK_COLOR,
        in_pipeline=True,
        scan_count=counts.get(key, 0),
    ) for key in PIPELINE_STATUS_KEYS]

    # Non-pipeline statuses that are either active (the unscanned tail
    # "all" mode shows) or were actually scanned on this move — even if
    # the vocabulary row has since been deactivated, a status a move
    # really passed through must not vanish from the Overview grid (the
    # design spec: pipeline mode "appends any status that was actually
    # scanned … so nothing is hidden"; "all" mode is a superset of
    # pipeline, so it must include it too).
    other_rows = sorted(
        (row for key, row in vocab.items()
         if key not in PIPELINE_STATUS_KEYS and (row.is_active or key in counts)),
        key=_other_status_sort_key)
    other_cols = [StatusCol(key=row.key, label=row.label, color=row.color, in_pipeline=False,
                            scan_count=counts.get(row.key, 0)) for row in other_rows]

    statuses = pipeline_cols + other_cols

    pipeline_keys = {c.key for c in pipeline_cols}
    completion_key = "complete" if "complete" in pipeline_keys else (
        pipeline_cols[-1].key if pipeline_cols else None)
    completed = 0
    if completion_key is not None:
        completed = sum(
            1 for legacy_id in asset_uuid_by_legacy
            if any(h.status_key == completion_key for h in scan_progress.get(legacy_id, ())))

    total_assets = len(assets)
    scanned_assets = len(scan_progress)
    completion_pct = round(completed / total_assets * 100) if total_assets else 0
    last_scan_at = max((h.at for hits in scan_progress.values() for h in hits), default=None)

    return ScanHistoryData(
        initiative_id=ini.id, name=ini.name,
        client_name=client.name if client else None,
        scheduled_start=ini.scheduled_start,
        source_name=origin.name if origin else None,
        destination_name=dest.name if dest else None,
        assets=assets, statuses=statuses, scan_progress=scan_progress,
        total_assets=total_assets, scanned_assets=scanned_assets,
        completed=completed, completion_pct=completion_pct, last_scan_at=last_scan_at)
