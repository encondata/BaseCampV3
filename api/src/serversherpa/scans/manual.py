"""Manual status edits recorded as processed scans. A user changing an
initiative asset's status in the portal is, for history and for the
status-rules engine, the same event as a scanner reporting that status —
so it gets a processed_scans row (scan_type "manual", operator = the
editor) and the rules run right here, in the caller's transaction,
anchored to the initiative being edited. Not a presence read: no site,
no location, and Asset.last_seen_at is left alone.

A status set by "Update assets in bulk" is the same event without a
roster row to anchor it: record_asset_status_edit lets the engine resolve
the initiative context the way it does for a scanner read.

Either caller rolls back on a RuleExecutionError; stamp_rule_failure then
leaves the error execution row the rules admin UI shows."""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, InitiativeAsset, ProcessedScan, StatusRuleExecution
from serversherpa.status_rules.engine import RuleExecutionError, apply_rules

logger = logging.getLogger(__name__)

SOURCE_INITIATIVE_ASSET_EDIT = "initiative_asset_edit"
SOURCE_ASSET_BULK_UPDATE = "asset_bulk_update"
PORTAL_DEVICE_ID = "portal"


async def record_status_edit(
    db: AsyncSession, *, assoc: InitiativeAsset, asset: Asset, status: str,
    actor_person_id: uuid.UUID,
) -> ProcessedScan:
    """Add (flush, don't commit) the scan and apply rules for it.
    Raises RuleExecutionError when a rule action fails — the caller owns
    the transaction and decides to roll back."""
    scan = await _add_scan(db, asset=asset, status=status, actor_person_id=actor_person_id,
                           source=SOURCE_INITIATIVE_ASSET_EDIT)
    await apply_rules(db, scan, initiative_asset=assoc)
    return scan


async def record_asset_status_edit(
    db: AsyncSession, *, asset: Asset, status: str, actor_person_id: uuid.UUID | None,
    source: str,
) -> ProcessedScan:
    """The same scan row as record_status_edit, for an asset whose status
    was set outside any roster (e.g. bulk update): no initiative anchor, so
    the rules engine resolves its context as for a scanner read. Flushes,
    never commits; raises RuleExecutionError when a rule action fails."""
    scan = await _add_scan(db, asset=asset, status=status, actor_person_id=actor_person_id,
                           source=source)
    await apply_rules(db, scan)
    return scan


async def _add_scan(db: AsyncSession, *, asset: Asset, status: str,
                    actor_person_id: uuid.UUID | None, source: str) -> ProcessedScan:
    now = datetime.now(UTC)
    scan = ProcessedScan(
        scanned_value=asset.serial_number or str(asset.id),
        scan_type="manual", status=status,
        scanned_at=now, processed_at=now,
        device_id=PORTAL_DEVICE_ID, operator_id=actor_person_id,
        site_id=None, location_detail="",
        source=source, raw_scan_id=None,
        match_type="asset", asset_id=asset.id,
    )
    db.add(scan)
    await db.flush()
    return scan


async def stamp_rule_failure(err: RuleExecutionError) -> None:
    """A failing rule on a status-edit path (a roster status edit, a bulk
    asset update) rolls back the caller's whole transaction — no scan, no
    status change — which leaves no trace for the rules admin UI. Stamp an
    error execution row in a FRESH, short-lived transaction (the caller's
    session was just rolled back and the scan never committed), mirroring
    scans/worker.py::_stamp_error. Best-effort: any failure here is logged
    and swallowed so it never masks the error the caller reports."""
    from serversherpa.db.engine import get_sessionmaker

    try:
        async with get_sessionmaker()() as fresh:
            fresh.add(StatusRuleExecution(
                rule_id=err.rule_id, rule_name=err.rule_name,
                processed_scan_id=None, conditions_met=True,
                actions_applied=[], error=str(err)[:2000]))
            await fresh.commit()
    except Exception:
        logger.exception("failed to record rule-failure execution")
