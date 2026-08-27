# Scan status — design

**Date:** 2026-08-27
**Status:** approved
**Scope:** Scans record *what status the asset was scanned to be*. New nullable `status` column on `raw_scans` and `processed_scans` using the **existing asset/move status vocabulary** (user-confirmed), surfaced as the **first column of every scan-history list** and as a column on both Admin → Scans tabs. Recording/display only — applying the status to assets/rosters remains the deferred matcher's job.

## Decisions

- Vocabulary: the existing `status_values` record_type **`asset`** — the same set the roster and assets use ("Loaded in system", "Labeled", …). One vocabulary across scan → matcher → roster.
- Nullable: a bare presence read (unattended dock reader) carries no status; NULL renders `—`.
- Scan history column order becomes: **Status · Scanned · Method · Device · Operator · Site · Location**.

## 1. Schema — migration `0026_scan_status.py`

- `ALTER TABLE raw_scans ADD COLUMN status text` and the same on `processed_scans`, each with the house generated-discriminator composite FK into `status_values`:
  - `raw_scans`: generated column `status_record_type text GENERATED ALWAYS AS ('asset') STORED` + FK `raw_scans_status_fkey (status_record_type, status) → status_values(record_type, key)`.
  - `processed_scans` already HAS a generated `scan_type_record_type` and `match_record_type`; add `status_record_type` the same way + `processed_scans_status_fkey`.
  - Composite FKs are `MATCH SIMPLE` — NULL `status` skips the check (the containers.container_type precedent).
- No index (filtered client-side; add later if a server filter needs it).
- Downgrade: drop the FKs + both column pairs.
- `status/registry.py`: extend the existing `asset` StatusRecordType's `sources` with `("raw_scans", "status")` and `("processed_scans", "status")` (it already spans two tables since the 0022 merge; usage counting sums across all).
- Models: `status: Mapped[str | None]` + the generated `status_record_type` mirror on both classes.

## 2. API

- `RawScanItem`, `ProcessedScanItem`, `AssetScanItem` each gain `status: str | None`, `status_label: str | None`, `status_color: str | None` (label/color null when status null). `_vocab`'s return grows to three maps — update its three call sites together.
- routes/scans.py: `_vocab` grows an `asset` statuses map (fetch `record_type IN ('scan','processed_scan','asset')` in the same single query); `_raw_context` emits the three new fields with `(None, None)` labels for NULL status. All three endpoints pick it up through the shared helpers.
- `GET /scans/raw` gains an optional `status` scalar filter (matches the existing filter param pattern) — cheap, symmetric with `scan_type`.

## 3. Portal

- `RawScanRow` / `ProcessedScanRow` / `AssetScanRow` mirror the three new fields.
- **ScanHistoryTable**: `Status` becomes the first column — house status chip (`chip.custom` with `status_color`/`status_label`), `—` when null. Then the existing columns unchanged.
- **Admin → Scans**:
  - Raw tab: new column `{ key: 'status', label: 'Scan status', width: '1.1fr', default: true }` placed after the primary value column (i.e., first data column), chip-rendered; `rawScanCellText`/`rawScanSearchText` extended; column menu filters it like any column.
  - Processed tab: same column addition after `match`; `processedScanCellText`/`processedScanSearchText` extended.
  - CSV exports on both tabs gain a `Scan status` column (label text, `''` blank).
- No god-edit on scan status (scans stay read-only / PATCH surface unchanged).

## 4. Seed data refresh

Update dev rows in place: assign a weighted mix of the real `asset` vocabulary keys to ~80% of `raw_scans` and `processed_scans` rows (leave ~20% NULL so the `—` path shows). Use the actual keys from `status_values WHERE record_type='asset'` — do not hardcode guesses.

## 5. Testing

- **API** (`test_scans_model.py` + `test_scans_api.py`): FK rejects an unknown status key; NULL status allowed; the three endpoints denormalize `status_label`/`status_color` and emit nulls for NULL status; raw `status` filter works.
- **Portal** (`scans.test.ts`): cellText/searchText cover the new key incl. `—`/null fallbacks.
- Browser: chip renders first in all three history surfaces and in both admin tabs; column menu filter on the new column; CSV includes it; `—` rows render.

## Out of scope

- Applying the status to assets/rosters (matcher phase); scan-status-specific vocabulary (deliberately rejected — one vocabulary); server-side status filter on `/scans/processed` (client-side list).
