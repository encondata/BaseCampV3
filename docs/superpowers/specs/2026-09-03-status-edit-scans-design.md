# Manual status edits recorded as processed scans

**Date:** 2026-09-03
**Branch:** `status-edit-scans` off `main`
**Status:** Approved design

## Purpose

When a user changes an asset's status from the Initiative full-detail page
(Edit list → status), the change must be recorded in `processed_scans` —
with the acting user and every field the model requires — so manual edits
carry the same history as real scans AND flow through the status-rules
engine that keeps dependent fields in sync. Any API status change on an
initiative asset gets this, not just the dialog.

## Background facts (as-built)

- `PATCH /initiatives/assets/{assoc_id}` (`api/routes/initiatives.py`
  `update_initiative_asset`, gate `initiatives:change`) applies
  `InitiativeAssetUpdateIn` (incl. `status`, validated against the merged
  `asset` status vocabulary by `_check_asset_status`), audits changed
  fields as `asset_update` on the parent initiative, commits.
- `processed_scans` (`ProcessedScan`): `scanned_value`, `scan_type` (FK to
  `status_values` record_type `scan` — seeded `rfid`/`barcode`/`manual`),
  `status` (nullable, FK'd to the `asset` vocabulary), `scanned_at`,
  `device_id`, `operator_id` (the person who ran the scanner), `site_id`,
  `location_detail`, `source`, `raw_scan_id` (nullable), `match_type`
  (`asset`), `asset_id`, `processed_at`. CHECK: asset matches need
  `asset_id`. Only `scans/worker.py::process_raw_scan` inserts today; it
  then calls `status_rules.engine.apply_rules(db, scan)`.
- `apply_rules` loads enabled rules for `(scan.status, match_type)`,
  builds a `Context` (`_build_context`) — for asset matches it resolves
  the asset's containing container and "the in-progress initiative"
  (`Initiative.status == "in_progress"`, nearest scheduled start) into
  `ctx.initiative_asset` / `ctx.initiative` — evaluates conditions, runs
  actions, records `StatusRuleExecution`; a failing action raises
  `RuleExecutionError(rule_id, rule_name, exc)`.
- The status-provenance hover (`routes/status_provenance.py`) already
  considers the latest `processed_scans` row reporting a status (carrying
  scan type + operator), and the Admin → Scans page lists processed scans
  with `source`/`device_id`.
- No migration is needed: every column and vocabulary value exists.
  (Migration numbering note: 0045 is taken by unmerged AI work on
  `admin-controls`; this feature adds none.)

## API

### `scans/manual.py` (new)

```python
SOURCE_INITIATIVE_ASSET_EDIT = "initiative_asset_edit"
PORTAL_DEVICE_ID = "portal"

async def record_status_edit(
    db: AsyncSession, *, assoc: InitiativeAsset, asset: Asset,
    status: str, actor_person_id: uuid.UUID,
) -> ProcessedScan:
```

Builds and adds (flushes, does not commit) one `ProcessedScan`:

| column | value |
|---|---|
| `scanned_value` | `asset.serial_number` or `str(asset.id)` when blank |
| `scan_type` | `"manual"` |
| `status` | the NEW status |
| `scanned_at`, `processed_at` | `now(UTC)` (same instant) |
| `device_id` | `"portal"` |
| `operator_id` | `actor_person_id` |
| `site_id` / `location_detail` | `None` / `""` — a status edit is not a presence read |
| `source` | `"initiative_asset_edit"` |
| `raw_scan_id` | `None` |
| `match_type` / `asset_id` | `"asset"` / `asset.id` |

then calls `apply_rules(db, scan, initiative_asset=assoc)` and returns
the scan. `Asset.last_seen_at` is NOT touched (unlike worker scans).

### Engine change (`status_rules/engine.py`)

`apply_rules(db, scan, *, initiative_asset: InitiativeAsset | None = None)`
and `_build_context(db, scan, *, initiative_asset=None)`: when an
`initiative_asset` is given, the context uses it and its parent
`Initiative` (loaded via `db.get`) instead of the in-progress lookup.
Worker callers pass nothing → behavior unchanged.

### Route change (`update_initiative_asset`)

After the setattr loop and audit, if `"status" in changes` (i.e. the
status actually changed to a non-null value — `None` is already rejected
with 422 `unknown_status`):

```python
asset = await db.get(Asset, assoc.asset_id)
try:
    await record_status_edit(db, assoc=assoc, asset=asset,
                             status=assoc.status,
                             actor_person_id=actor.person.id)
except RuleExecutionError as err:
    await db.rollback()
    raise _err(409, "rule_failed", rule_name=err.rule_name,
               reason=str(err.__cause__ or err))
await db.commit()
```

Ordering: the edit is applied first, then the scan + rules, so rules see
the new status and may further mutate `assoc`/`asset`; the response is
built after commit from `_initiative_asset_rows`, reflecting rule
side-effects. Same-value status writes and edits of other fields record
nothing. (Check `RuleExecutionError`'s attribute names in
`status_rules/engine.py` and use them verbatim.)

## Portal

- `AssetEditDialog.tsx`: map `rule_failed` →
  `Rule '<rule_name>' failed: <reason>` (the `ApiError.detail` carries
  both) in its existing error mapping; other codes unchanged.
- No other UI work: provenance hover and Admin → Scans surface the rows
  as-is (scan type **Manual**, operator = the editor, source
  `initiative_asset_edit`).

## Error handling

- Rule action failure → 409 `rule_failed` `{code, rule_name, reason}`;
  transaction rolled back — no status change, no scan, no audit row.
- Unknown status → existing 422 `unknown_status` (before anything runs).
- Asset row missing (should be impossible via FK) → treated as no-scan;
  edit still saves.

## Testing

- API (`tests/test_initiative_status_scans_api.py`): status change
  inserts exactly one processed scan with the table above (operator =
  actor, `manual`, `portal`, source, null site/location, no raw id);
  unchanged status / other-field edits insert none; `last_seen_at`
  untouched; a rule on that trigger status (`set_asset_status` action)
  fires within the same request against the EDITED initiative (assert
  `StatusRuleExecution` row + asset status) even when another initiative
  is `in_progress`; a failing action (unknown status param) → 409
  `rule_failed` with the rule name and nothing persisted; provenance
  endpoint for the asset reports the manual scan with the editor.
- Engine unit: `_build_context` with an explicit `initiative_asset`
  ignores the in-progress lookup.
- Portal: `AssetEditDialog` renders the rule-failure message from a 409.
- Live: edit a status on NAP11 Hall Migration → Admin → Scans shows the
  manual row; provenance hover shows Manual · by Claude Dev.

## Out of scope

Bulk-import status writes, the Assets page's lifecycle-status edits,
container/person manual scans, retry/queue semantics (synchronous by
design), and any migration.
