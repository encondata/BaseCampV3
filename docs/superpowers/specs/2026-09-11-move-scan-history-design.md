# Move Scan History report — V3 port of V2's "Move Scan History Report"

**Date:** 2026-09-11 · **Status:** approved by standing instruction ("copy all V2 functionality, update for V3 UI/UX; no stop between plan and implementation") · **Branch:** `move-scan-history`

## Purpose

V2 (`api/reports/scan_history_report.py`, `portal-v2/src/pages/MoveScanHistoryReport.jsx`) lets a user pick a move and download, as XLSX or PDF, every asset in the move with the first timestamp it reached each status, plus a flat scan-history detail list and completion stats. V3 gets the same report inside the reports framework (definition, queued run, history, inbox, initiative Files attachment) with a roomy, well-designed Generate modal.

## V2 inventory (all preserved unless listed under "Deliberate differences")

- Inputs: a move (V3: any initiative, presented as "move"); output format `xlsx` or `pdf` chosen at generate time.
- Data: move name, client name, scheduled start (`%m/%d/%Y`), source and destination site names; assets on the move (Asset ID, serial number, name) ordered by Asset ID; asset status options ordered by `DEFAULT_STATUS_ORDER` (`Pre-Stage, RFID 1 - Cage Exit, Labeled, RFID 2 - Loading Dock, Pack / Logistics, In Container, In Transit, Received, Un-Pack, RFID 3 - Staging, RFID 4 - Into Cage, Re-Racked, QA, Complete`) then the rest by sort order; scan progress = earliest scan per (asset, status) over processed scans whose status is set; completion = assets that have a scan for the last status column; `completion_pct` rounded.
- XLSX: sheet **Overview** — bold key/value block (Move Name, Client, Date Generated `%m/%d/%Y, %I:%M:%S %p`, Total Assets, Completion `NN%`), blank row, bold header row `Asset ID | Serial Number | Asset Name | <one column per status>`, one row per asset with `%m/%d/%Y %I:%M:%S %p` timestamps or blank; "No assets found in this move" when empty; column widths auto-fit capped at 30. Sheet **Scan History** — bold header `Asset ID | Serial Number | Asset Name | Status Name | Timestamp`, rows sorted by Asset ID then timestamp; "No scan history found" when empty.
- PDF: Letter landscape, 14 mm margins; centered title "Move Scan History Report" with a rule; move name (bold), info lines Client / Scheduled Start ("Not scheduled") / Source / Destination / Total Assets / Completion; section "Status Overview" (Asset ID, Serial #, Asset Name, status columns with `%m/%d %H:%M`, repeated header, zebra rows, 7 pt); section "Scan History Detail" (Asset ID, Serial Number, Asset Name, Status, Timestamp `%m/%d/%Y %I:%M:%S %p`, 8 pt); "No assets found in this move." / "No scan history found."; footer on every page: rule, "Page N of M" (V2: "End of Report" when single page), "Generated: <date>", "Document Tracking ID: <uuid>", and a PDF417 barcode of the tracking id at the right.
- Filenames: `scan-history-<Move-Name>-<YYYY-MM-DDTHH-MM-SS>.xlsx|pdf` (spaces and slashes → `-`).
- Permission: portal access (V3: `reports:view` + the initiative must be visible to the actor).

## V3 design

### Module `api/src/serversherpa/reports/move_scan_history/`

- `report_type = "move_scan_history"`; system definition "Move Scan History" seeded by migration 0054 with options `{ "default_format": "xlsx", "status_columns": "pipeline" }`.
- Run options (validated by `validate_run_options`): `format` (`"xlsx" | "pdf"`, defaults to the definition's `default_format`), `status_columns` (`"pipeline" | "all"`, defaults to the definition's). Definition PATCH accepts both string options (`validate_options`). Unknown keys rejected (`OptionsError`).
- `gather(db, initiative_id) -> ScanHistoryData`: initiative (`initiative_unavailable` when missing/archived), client name, `scheduled_start`, origin/destination site names (move columns; None for other types), assets from `InitiativeAsset` + `Asset` (`asset_id` = `Asset.legacy_id` human Asset ID, `serial_number`, `name`) ordered by `legacy_id`; statuses; scan progress; stats.
  - **Status columns.** `PIPELINE_STATUS_KEYS` = the V2 order mapped to V3 keys: `pre_stage, rfid_1_cage_exit, labeled, rfid_2_loading_dock, pack_logistics, in_container, in_transit, received, un_pack, rfid_3_staging, rfid_4_into_cage, re_racked, qa, complete`. `pipeline` mode = those keys (active or not, in that order, labels from `status_values` record_type `asset`) **plus** any other status key that appears in this move's scans, appended in (`progress_weight` nulls last, `sort_order`, `label`) order. `all` mode = the pipeline keys first, then every other active asset status in that order (V2's "everything" behavior).
  - **Scan progress.** `processed_scans` with `match_type = 'asset'`, `asset_id` in the roster, `status IS NOT NULL`, `archived_at IS NULL`; earliest `scanned_at` per (asset, status); per asset a list ordered by timestamp. Statuses not in the column set are still kept in the detail list.
  - **Completion.** An asset is complete when it has a scan with status `complete` if that column exists, else the last column (V2 used "last column"; `complete` is always last in pipeline mode, so both agree there). `completion_pct = round(completed / total * 100)`.
  - Timestamps are rendered in the system time zone (`America/New_York` default; use the existing notifications `DEFAULT_TIMEZONE` constant or the system config timezone if one exists) — V2 stored naive local times.
- `xlsx.py`: `build_workbook(data, generated_at) -> bytes` exactly as the V2 sheets, with three extra key/value rows in the Overview block after Client: Scheduled Start, Source, Destination (V2's PDF had them; the XLSX lacked them).
- `pdf.py` + `templates/move_scan_history.html` (Jinja2 + WeasyPrint, reuse `move_report.render.render_pdf_async` and its `cssstr` filter): `@page { size: Letter landscape; margin: 14mm 14mm 30mm }`, `@bottom-left` "Page N of M", `@bottom-center` "Generated: <date>  ·  Document Tracking ID: <run id>", `@bottom-right` the PDF417 barcode as a `data:image/png;base64` `content: url(...)` sized ~55×15 mm. The **Document Tracking ID is the run id** (V2 minted a random uuid; the run id is traceable). `barcode.py`: `pdf417_png(text) -> bytes` via the `pdf417gen` package (add to `pyproject.toml`; Pillow is already present through WeasyPrint/openpyxl). "End of Report" is a line after the last section rather than a footer swap (CSS margin boxes cannot branch on page count).
- `build(db, run)`: gather → xlsx or pdf per `format` → `ReportResult(content, filename, content_type)` with `Move Scan History - {initiative name} - {YYYY-MM-DD HHMM}.{ext}` (V3 filename house style; V2's `scan-history-…` name is not kept).
- Preview endpoint for the modal: `GET /reports/move-scan-history/preview?initiative_id=…` (`reports:view` + initiative scope, 404 `initiative_not_found`) → `{ initiative: {id, name, client_name, scheduled_start, source_name, destination_name}, total_assets, scanned_assets, completed, completion_pct, last_scan_at, statuses: [{key, label, scan_count, in_pipeline}] }` computed by `gather` (statuses in `all` order with `in_pipeline` flags so the modal can render both column modes).
- Registry: registered beside `move_report` and `site_move_survey`.

### Portal

- `GenerateReportModal` grows a roomier shell for **every** report type: card width `min(980px, 96vw)`, a header block with an eyebrow "Generate report", the definition name and description, and the step indicator (Pick initiative → Options → Progress). The pick step gets a two-column layout: the existing dir-search + type filter + grouped list on the left, a "Selected initiative" summary card on the right (name, client, type/status chips, scheduled dates, source → destination, asset count) — empty-state copy when nothing is picked. Move Report's sections step and the survey options render inside the same shell unchanged in behavior.
- `MoveScanHistoryOptions` (options step for this type), two columns:
  - Left — **Preview** card fed by the preview endpoint: initiative name + client, Source → Destination, Scheduled start, KPI tiles (`.dash-kpis`): Assets, Scanned, Complete, Completion % with a progress bar; "Last scan" line; loading/empty/error states (`pf-notice` / `pf-error`). Zero assets shows "This move has no assets yet — the report will say so." and still allows generating (V2 did).
  - Right — **Format** as two large selectable cards (radio semantics, `.segmented`-like `on` state): "Excel workbook — Overview and Scan History sheets" and "PDF document — landscape, printable, with a document tracking barcode" (default from the definition's `default_format`); **Status columns** `.segmented` "Pipeline" / "All statuses" with a chip strip previewing the columns (chips `c-slate`, `custom` color from the status vocabulary when available, count badge from `scan_count`; extra scanned statuses in pipeline mode shown with an "also scanned" hint); **Notify me** Switch; Back / Generate.
- History tab and inbox already handle xlsx and pdf downloads.
- `EditDefinitionModal` for this type: "Default format" `.segmented` (Excel / PDF) and "Status columns" `.segmented` (Pipeline / All) — no company field, no Files.

### Testing

- API: gather (ordering by Asset ID, earliest-per-status dedupe, null-status scans ignored, archived scans ignored, pipeline vs all columns, extra scanned status appended, completion by `complete`, empty move), xlsx cells (block rows, header row, timestamp format, detail sort, empty sheets), pdf (HTML contains title/sections/rows; PDF bytes start with `%PDF`; barcode PNG decodes as an image; page count ≥ 1 via WeasyPrint `Document`), preview endpoint (scope 404, payload shape), run creation with `format`/`status_columns` and rejection of unknown values, worker stores xlsx and pdf with the right content types, migration seeds the definition.
- Portal: modal shell header/steps; pick-step summary card; scan-history options (format cards default from definition, status column chips switch with the segmented, preview KPIs render from the mocked endpoint, error/empty states, run payload `{format, status_columns}`); EditDefinitionModal segmented controls patch the two options; guardrail green; existing Move Report and survey tests still pass.
- Live: generate both formats for "NAP11 Hall Migration (demo)" (102 assets with scans), open the xlsx cells and the PDF page count/footer.

## Deliberate differences from V2

- Queued run + history/inbox download instead of a synchronous stream; the file is also attached to the initiative's Files.
- Document Tracking ID = the run id; "End of Report" is an in-body closing line; page footer always "Page N of M".
- `status_columns` option (pipeline vs all) — V2 always listed every status option. Pipeline mode still appends any status that was actually scanned so nothing is hidden.
- XLSX Overview block gains Scheduled Start / Source / Destination rows.
- V3 filename house style.
- Timestamps rendered in the system time zone.

## Out of scope

Per-status filtering, date-range filtering, CSV export, e-mail delivery.
