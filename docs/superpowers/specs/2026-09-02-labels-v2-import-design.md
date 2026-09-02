# V2 label-template import

**Date:** 2026-09-02
**Branch:** `labels`
**Status:** Approved design

## Purpose

Bring the six V2 `label_templates` rows from the V2 SQL backup into V3's
`label_templates` as raw-code templates, translated to V3 conventions where
mappable, landed inactive for review. One CLI command, idempotent, dry-run
capable — the same posture as `import-v2-status-rules`.

## Source data (backup `api/backups/backup_20260825_193157.sql`)

| v2 id | name | printer_type | sites CSV | type |
|---|---|---|---|---|
| 4 | container_manifest | zebra | NULL | manifest |
| 3 | container_manifest | epson | NULL | manifest |
| 7 | Front Asset Tag | Zebra | NULL | asset_front |
| 6 | Amsterdam Destination | Zebra | 6 | asset_top |
| 5 | Vegas Destination | Zebra | 3,1,2,47 | asset_top |
| 8 | Generic Rack and RU | Zebra | 4,16,11,52 | asset_top |

The **epson** row is SKIPPED (logged): V3 has no ESC/POS language and its
name collides with the zebra twin. Five Zebra templates import.

## CLI

`serversherpa import-v2-label-templates --dump <path> [--dry-run]`
- Module `api/src/serversherpa/labels/v2_import.py`; CLI wiring in
  `serversherpa/cli.py` following `import-v2-status-rules`.
- Parses the dump's `INSERT INTO label_templates (...)` statements (reusing
  the shared V2-dump INSERT parsing helpers the status-rules importer uses).
- `--dry-run` prints the full per-template plan (mapped fields, resolved
  sites, translation counts) and writes nothing.
- Summary log: created / updated / skipped counts, per-template notes.

## Field mapping

- `name` ← `template_name`; `kind` = `code`; `description` =
  `"Imported from V2 backup (v2 id <id>)."`
- `label_type`: `asset_top`→`top`, `asset_front`→`front`,
  `manifest`→`container`; unknown → `top` + warning.
- `language_key`: `zebra`/`Zebra` → `zpl` (case-insensitive).
- `dpi_key`: `203`.
- `size_key`: read the template's own `^PW<w>` / `^LL<h>` (first occurrence
  of literal digits); convert to inches at 203 dpi; match against active
  size-vocab rows within ±0.05 in on both dimensions; no match (or
  non-literal `^LL{{...}}`) → `4x2`. The inference and its result are
  logged per template.
- `site_ids`: split the V2 `sites` CSV; resolve each id via
  `Site.source_ref == "backup_20260825_193157:sites/<id>"`; unresolvable
  ids are logged and skipped; NULL/empty → no assignments (global).
- `is_active` = `False` (review posture). `version` starts at 1 on create.
- V2 columns `label_generation_code`, `label_generation_code_json`,
  `created_at`, `updated_at`, `version` are ignored.

## Placeholder translation

Translate V2 token spellings to V3's canonical `{key}`:

- Recognized forms (all quote variants V2's `apply_template` accepted —
  `'` `"` `` ` `` and curly quotes): `{row['<alias>']}`, `{'<alias>'}`,
  and bare `{<alias>}` where `<alias>` is in the alias map (bare form only
  when it is not already a valid V3 token).
- Alias map = exactly V2 `build_label_field_values`'s keys:
  `asset id`/`asset_id`→`asset_id`; `name`/`asset name`/`asset_name`→
  `asset_name`; `asset_serial_number`/`serial_number`/`serial`→
  `serial_number`; `make`→`make`; `model`→`model`;
  `assets.make_model`/`make_model`→`make_model`;
  `source_raw`/`source`→`source_raw`; `source_ru`→`source_ru`;
  `source site`/`source_site`→`source_site`;
  `destination_raw`/`destination`→`destination_raw`;
  `destination_ru`→`destination_ru`;
  `destination site`/`destination_site`→`destination_site`;
  `move date`/`move_date`→`move_date`; `move_name`→`move_name`.
- Everything else is left VERBATIM and counted: handlebars `{{...}}`
  blocks (manifest loops — untranslatable to flat tokens), unknown aliases
  (`asset track`, `asset tpos`, `moves_id`, …). The summary names each
  untranslated token so review knows what to hand-fix in the editor.

## Idempotency

Upsert by `name` (CITEXT-unique). Existing row: update `code`,
`description`, `label_type`, `size_key`, `dpi_key`, `language_key`, and
site assignments to the mapped values — but NEVER touch `is_active`
(re-runs must not deactivate a template the user activated). An update
that changes nothing writes nothing (no version bump, no audit row); a
real change bumps `version` once. A name that
exists with `kind='design'` is skipped with a warning (never clobber a
builder template). Creates and updates run in one transaction; audit rows
(`action="v2_import"`) per create/update.

## Testing

- Unit: translation (each recognized form incl. curly quotes; handlebars
  and unknown aliases untouched), size inference (exact match, tolerance
  match, fallback), site resolution (hit, miss logged), type/language maps.
- End-to-end: a small fixture string holding two INSERT statements (one
  zebra with sites + `{row['asset id']}` tokens, one epson) → run import
  against the test DB → assert created rows' fields, epson skipped,
  re-run idempotent (no version churn when nothing changed), design-kind
  collision skipped, is_active preserved across re-runs.
- Verification: `--dry-run` then real run against the dev DB; eyeball the
  five rows in the Templates list (inactive, sites resolved on the three
  destination tags).

## Out of scope

ESC/POS language support; translating manifest handlebars loops; importing
V2 generation config (`label_generation_code`).
