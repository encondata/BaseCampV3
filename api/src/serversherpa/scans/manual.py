"""Manual status edits recorded as processed scans. A user changing an
initiative asset's status in the portal is, for history and for the
status-rules engine, the same event as a scanner reporting that status —
so it gets a processed_scans row (scan_type "manual", operator = the
editor) and the rules run right here, in the caller's transaction,
anchored to the initiative being edited. Not a presence read: no site,
no location, and Asset.last_seen_at is left alone."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, InitiativeAsset, ProcessedScan
from serversherpa.status_rules.engine import apply_rules

SOURCE_INITIATIVE_ASSET_EDIT = "initiative_asset_edit"
PORTAL_DEVICE_ID = "portal"


async def record_status_edit(
    db: AsyncSession, *, assoc: InitiativeAsset, asset: Asset, status: str,
    actor_person_id: uuid.UUID,
) -> ProcessedScan:
    """Add (flush, don't commit) the scan and apply rules for it.
    Raises RuleExecutionError when a rule action fails — the caller owns
    the transaction and decides to roll back."""
    now = datetime.now(UTC)
    scan = ProcessedScan(
        scanned_value=asset.serial_number or str(asset.id),
        scan_type="manual", status=status,
        scanned_at=now, processed_at=now,
        device_id=PORTAL_DEVICE_ID, operator_id=actor_person_id,
        site_id=None, location_detail="",
        source=SOURCE_INITIATIVE_ASSET_EDIT, raw_scan_id=None,
        match_type="asset", asset_id=asset.id,
    )
    db.add(scan)
    await db.flush()
    await apply_rules(db, scan, initiative_asset=assoc)
    return scan
