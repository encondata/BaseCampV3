# Generated serials on asset import — design

Date: 2026-10-02. Branch `generated-serials`. Approved by Jimmy in chat. Closes To-Do #38 (Feature Parity 293, Gaps 16).

## Goal

When a From-To import row (From-To import page or the Create-a-move wizard's assets step) has no serial number, the importer gives it one in the form `gnrtd-xxxxxx` (6 random lowercase hex characters), unique within the uploaded file and across every asset in the database, so the asset has something to print on a label and to scan.

## Decisions

| Question | Decision |
|---|---|
| Always on, or a choice | Keep the "Generate serial numbers" checkbox, **on by default** on both screens. Unticked, a blank serial is still a row error (unchanged). |
| Format | `gnrtd-` + 6 lowercase hex characters (`secrets.token_hex(3)`), e.g. `gnrtd-3f9a0c`. Lowercase matches how every imported serial is stored. |
| Uniqueness | Against every serial in the uploaded file (given or generated) and every row of `assets.serial_number` (archived included; the column is CITEXT, so the check is case-insensitive). Collisions are redrawn. |
| Asset name | No longer required for generation. A row with no serial and no name imports; its name falls back to the generated serial (existing fallback). |
| Re-uploading a sheet | **Reuse by name** (Jimmy, 2026-10-02): before drawing, a blank-serial row whose (lowercased) asset name matches exactly one asset on this move's roster that already has a `gnrtd-` serial reuses that serial, so the re-upload updates the asset instead of creating a duplicate. Ambiguous cases draw fresh: two roster assets with that name, or two blank-serial rows in the file with that name. A reused serial is not marked generated; the row gets the note `Serial gnrtd-xxxxxx reused from the existing asset with the same name`. The Create-a-move path has no roster yet, so it always draws. |
| Check vs import | The check (validate run) shows a sample generated serial; the real import draws its own at write time. The import report's existing "generated serial" column shows what was saved. |

## Server (`api/src/serversherpa/imports/move_assets.py`)

- Remove the V2 `generate_serial(asset_name)` (`name.13digits`).
- Add `GENERATED_SERIAL_PREFIX = "gnrtd-"` and `new_generated_serial() -> str` returning `"gnrtd-" + secrets.token_hex(3)`.
- `parse_row(..., generate_serials)`: a blank serial with `generate_serials=True` → `status "ok"`, `serial_number ""`, `serial_generated True`, `asset_name` = the lowercased name or `""` (filled later). With `generate_serials=False` → the existing error "Missing required field: Serial Number". The "Cannot generate serial: Asset Name is also blank" error is removed.
- New `async assign_generated_serials(db, rows, *, draw=new_generated_serial) -> None`: for every ok row with `serial_generated` and an empty serial, assign a serial that is not among the file's other serials (lowercased) nor any `assets.serial_number`; redraw on collision (batch-check each round's candidates with one `SELECT … WHERE serial_number IN (…)` query; candidates in the same round must also differ from each other). Set `asset_name` to the serial when it is empty. `draw` is injectable so tests can force collisions.
- `assign_generated_serials` takes `initiative_id: uuid.UUID | None`; when given, it applies the reuse-by-name rule above before drawing (one roster query for `gnrtd-` assets on that move).
- `run_import` calls `assign_generated_serials(db, rows, initiative_id=initiative_id)` first, before `_lookups`, so the validate and write runs and both callers (import worker, move-setup worker) get it.

## Portal

- `portal/src/pages/ImportMoveAssets.tsx` and `portal/src/components/moveSetup/AssetsStep.tsx`: `generateSerials` state defaults to `true`.
- `portal/src/components/imports/ImportUploadFields.tsx`: the checkbox description becomes "Rows with a blank serial number get one generated (gnrtd-xxxxxx), unique across every asset."

## Tests

- Rows: generation flags the row (blank serial, `serial_generated`), works without a name, checkbox off still errors; `new_generated_serial()` matches `^gnrtd-[0-9a-f]{6}$`.
- `assign_generated_serials` (DB): unique against an existing asset (forced collision via `draw` proves the redraw), against another row's given serial in the same file, and among generated rows; blank name falls back to the serial.
- `run_import` (validate and write) produces `gnrtd-` serials and the created assets carry them.
- Portal: both screens render the checkbox checked by default and send `generate_serials=true`.

## Tracker (after merge)

Feature Parity 293 and Gaps 16 → Complete; To-Do #38 → Done.
