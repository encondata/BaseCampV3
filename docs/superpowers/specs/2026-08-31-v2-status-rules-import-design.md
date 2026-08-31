# V2 status-rules import

**Date:** 2026-08-31
**Status:** Approved design
**Builds on:** `2026-08-31-scan-matching-status-rules-design.md` (the V3 engine this imports into).

## Summary

A one-off-but-re-runnable CLI importer that extracts the live V2
process-engine rules from the V2 SQL backup
(`api/backups/backup_20260825_193157.sql` — 16 rules, 37 actions, 4
conditions, including production hand-edits absent from V2's seed
scripts) and translates them into V3 `status_rules` rows. Three small
typed actions are added to the catalog so the non-truck rules translate
at full fidelity; the schema-driven portal editor picks them up with no
UI work.

Expected outcome on the real backup: **13 rules imported (disabled), 3
skipped** (two truck GPS rules and "Container Assigned to Truck" — V3
has no trucks).

## 1. Catalog additions

New typed actions in `api/src/serversherpa/status_rules/catalog.py`:

| action_type | params | effect |
|---|---|---|
| `clear_asset_location` | — | `assets.location_detail = ''` (V3's NOT-NULL equivalent of V2's clear) |
| `clear_asset_site` | — | `assets.site_id = NULL` |
| `set_asset_location_from_container` | — | `assets.location_detail = <containing container's name>`; skip reason `not_in_container` when the asset is in no container |

Amended action:

- `set_asset_location_from_scan` gains a required `fields` param
  (choice: `site` | `location` | `both`). `site` copies only
  `assets.site_id ← scan.site_id`; `location` only
  `assets.location_detail ← scan.location_detail`; `both` copies both.
  **Apply-time default is `both`** (`params.get("fields", "both")`) so
  any pre-existing rule rows with empty params keep working; the schema
  endpoint lists the param as required so the editor always sets it.
  Rationale: V2 rules copy site or location individually — RFID dock
  readers report an empty location, and copying both would blank a
  racked asset's location on a dock read.

Context change in `engine.py`'s `_build_context`: for **asset** matches,
also resolve the asset's containment — `container_assets` row for the
asset (unique per asset) joined to `containers` — into `ctx.container`.
For container matches `ctx.container` remains the matched container.
This powers `set_asset_location_from_container` and makes `container.*`
condition fields meaningful on asset scans. Document the dual meaning in
the Context docstring.

All additions surface automatically via `GET /status-rules/schema`.

## 2. Importer

`api/src/serversherpa/status_rules/v2_import.py` + typer command
`serversherpa import-v2-status-rules <backup.sql>` (house pattern:
`people/v2_import.py` / `import-v2-workers`).

### Parsing

The backup is INSERT-format. Parse `INSERT INTO
process_engine_rules|process_engine_conditions|process_engine_actions
(...) VALUES (...)` statements plus `status_options (id, name)` for the
V2 id→name map. No other tables are read.

### Translation

- **Trigger**: `trigger_status_id` → V2 `status_options` name → V3
  asset-vocab key via an explicit name→key table in code (e.g.
  `Pre-Stage → pre_stage`, `RFID 1 - Cage Exit → rfid_1_cage_exit`,
  `Complete → complete`). Every resolved key is verified against live
  `status_values (record_type='asset')` at import time; an unmapped or
  missing key skips the rule with a report line. `trigger_match_type` is
  `asset` for every importable rule (`moves_assets_list` rules and
  "Asset Packed In Container").
- **Skips**: rules with `trigger_table='trucks'` and rule "Scan Type 48:
  Container Assigned to Truck" (its actions reference trucks) — V3 has
  no trucks. Reported as skipped with reason.
- **Conditions**: the live backup's 4 conditions all belong to skipped
  rules; the importer still maps `scans_processed.scan_match_category
  equals <x>` → absorbed by V3's `trigger_match_type`, and any other
  condition drops the rule with a report line (safe default — a rule
  imported without its gate could over-fire).
- **Actions** (per-action; a rule with zero mappable actions is
  skipped, one with some mappable actions imports partially and the
  drops are reported):

| V2 action | V3 action |
|---|---|
| `set_status moves_assets_list.asset_status <id>` | `set_initiative_asset_status {status}` |
| `set_status assets.status <id>` | `set_asset_status {status}` |
| `set_field moves_assets_list.source_verified/destination_verified true` | `set_initiative_asset_verified {side, value: true}` |
| `copy_field assets.site ← trigger.scan_site` | `set_asset_location_from_scan {fields: site}` |
| `copy_field assets.location ← trigger.scan_location` | `set_asset_location_from_scan {fields: location}` |
| `expression concat_if_exists(destination_raw, RU+destination_ru) → assets.location` | `set_asset_location_from_initiative {side: destination}` |
| `set_field assets.location template "{…destination_raw} RU:{…destination_ru}"` | `set_asset_location_from_initiative {side: destination}` |
| `clear_field assets.location` | `clear_asset_location` |
| `clear_field assets.site` | `clear_asset_site` |
| `set_field assets.location ← container.container_name` | `set_asset_location_from_container` |
| anything else | dropped + reported |

- Status values inside actions map through the same id→name→key table.
  Data wins over prose: rule 26's action sets asset status `8` (Racked)
  although its description mentions 44/Pending Client Handover — it
  imports as `racked`, with a report note.
- Known cosmetic fidelity difference (report note, not a translation
  failure): V3 composes rack/RU as `R12 RU42`; V2's template produced
  `R12 RU:42`.

### Write semantics

- **Upsert by rule name.** First import inserts with
  `enabled = false` (regardless of V2's flag — rules are reviewed and
  enabled in `/admin/status-rules`; the worker picks up enables within
  its 60s rule-cache TTL). Re-runs update
  name/description/trigger/priority and replace children wholesale, but
  **preserve the rule's current `enabled` flag**.
- `priority` and `description` copy through as-is; `created_by` is NULL
  (no actor on the CLI), and no audit rows are written — same posture as
  the other V2 importers.
- The command prints a report: imported / updated / partial (rule +
  dropped action + reason) / skipped (rule + reason), then exits 0.
  Parse or DB errors exit non-zero without partial commits (one
  transaction for the whole import).

## 3. Testing

- Catalog: apply() tests for the three new actions (including
  `not_in_container` skip) and the `fields` param variants incl. the
  empty-params default.
- Engine: context test pinning containment resolution for asset matches
  (asset in a container → `ctx.container` set; not in one → None).
- Importer: unit tests against an embedded fixture of real INSERT lines
  from the backup — full translation of a representative rule, the
  skip/partial/report paths, idempotent re-run (update-in-place, child
  replacement, enabled preservation), unknown-status skip.
- End-to-end: import the fixture, enable one rule, run the worker's
  `process_raw_scan` on a matching raw scan, assert the V2-derived
  actions fired.
- Manual: run the importer against the real backup on the dev DB and
  eyeball the 13/3 report + the rules in `/admin/status-rules`.

## Out of scope

- Trucks (entity and rules) — V3 has none.
- V2 execution history / audit-log import.
- Importing the V2 `logic` (AND/OR) column — V2's engine ignored it and
  the live conditions all belong to skipped rules.
- Any generic `clear_field`/`set_field` engine capability — the catalog
  stays typed.
