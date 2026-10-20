# Label Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WYSIWYG label builder in the portal whose templates (parent + 203/300/600 DPI children, versions, clone, typed-name delete) print byte-identically from the portal and the laptop kiosk, with per-field rules (split, strip, max/trim, number padding, expected length, alignment, bold, inverted, per-field fonts) and real sample values.

**Architecture:** The pure Python label package `serversherpa.labels` (already shared with the laptop edge from `api/src`) gains a design schema v2, a field catalog with a value pipeline, and a v2 ZPL compiler. The API gains the template tree (parent/children/versions), the font library's families, per-DPI generated labels and the new sync fields. The portal gets a new builder (model, canvas, panels, page) and a tree list; the old design editor is removed, keeping only the raw-code editor. The kiosk/edge gates on the schema version and uses the shared catalog for values.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic, `fontTools` (new, for font metrics), React + TypeScript + Vitest (portal, jsdom), FastAPI + SQLite (edge), WebUSB / raw 9100 ZPL.

**Spec:** `docs/superpowers/specs/2026-10-19-label-builder-design.md` (facts and file:line references: `docs/superpowers/research/2026-10-19-label-builder-recon.md`).

## Global Constraints

- Portal and kiosk output is byte-identical: both call `serversherpa.labels.render.render_template` on the same design JSON and the same field values; a fixture test renders the rebuilt Vegas tag both ways.
- Value pipeline order, fixed: Split → Strip → Max characters (trim front/rear) → Number padding (leading zeros to expected length, integer part only) → alignment inside the reserved width. Hide-when-empty tests the value after Strip and trim.
- Split breaks on `.` only; the sample value fixes the piece count; missing pieces print blank; extra pieces are ignored; one Split definition per field per template; every placement has its own formatting.
- Fonts: exactly these families, all TrueType, 8.3 object names: Swiss 721 Condensed Bold = `TT0003M_.TTF` (resident: never pushed to a printer, drawn on the canvas with Roboto Condensed Bold over the real file's metrics), Roboto Condensed, Roboto, Oswald, Roboto Mono, IBM Plex Mono, Atkinson Hyperlegible, Source Sans 3 (each Regular + Bold where the family has one). Font samples in the dropdown: `0O 1Il 7`.
- Bold on a family with no Bold file: overprint one dot to the right, except on an inverted element, where the font width is widened by 15% instead.
- Inverted: filled black box = reserved box + padding (default horizontal 0.25 × font size, vertical 0.10 × font size, editable in dots), text in reverse; a blank value prints no box.
- Text compiles to `^FT x,baseline`; `^FB{reserved},1,0,{C|R},0` only for center/right alignment; never `^FB` for left-aligned single-line fields; multi-line static text uses `^FB`. Barcodes, QR and shapes use `^FO`. QR: error correction M; magnification capped at 10 (600 DPI prints at the cap, centered, with a warning in the builder).
- Three DPI children (203, 300, 600) on create; one active template per (family, label_type, dpi); Replace… swaps atomically; children named `"<parent> · <dpi>"`, kept old children `"<parent> · <dpi> Old"` (then ` Old 2`, …); child versions `v<parent>.<edits>`; parent delete requires the typed name and lists children + generated-label count.
- Sample values are stored on the template row (`samples`) and never sent to kiosks. The Label Station test label renders the plan's picked template with the portal's mock values.
- A design carries `"schema": 2`; an edge whose compiler supports a lower schema reports `template_unsupported` and prints nothing from it.
- Templates list readable with `labels:view`; design/edit/delete/clone/versions/replace need rank ≥ 80 (`actor.access.max_rank >= 80`) on top of the existing `labels:*` permissions.
- Keyboard: ⌘/Ctrl per spec §5; `/` focuses field search; ⌘K stays the command palette; the sidebar toggle is already ⌘\ (main `ede042e2`).
- American English in copy; modals use the report-generate header, size to content, rounded corners; portal lists follow the list idioms (column floors, chips); natural sort via `naturalCompare`, never `localeCompare` or bare `.sort()`.
- Never stage `.env`, `.venv`, `node_modules`, `.superpowers/`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never contact a real printer. Migrations continue from 0099 (check every worktree and the dev DB before numbering).

## Review Focus

1. A roster value with no dots (`ORD1-F01`) on a Split field — pieces 2..n print blank, nothing errors (Task 1).
2. A value containing `^`, `~` or `_` reaching a code field — hex-escaped behind `^FH_`, never a printer command (Task 3).
3. The parent saved while a child is customized — the child is kept and flagged, never overwritten (Task 5).
4. A kiosk sync with a v2 design reaching an edge that only knows v1 — a visible `template_unsupported`, not a blank or `^A0` label (Task 12).
5. Two active templates for one family/type/DPI after a Replace race — refused with `active_conflict` (Task 5).

---

### Task 1: Field rules — the value pipeline, in Python and TypeScript, pinned to one fixture file

**Files:**
- Create: `api/src/serversherpa/labels/field_rules.py`, `api/src/serversherpa/labels/fixtures/field_rules.json`, `portal/src/labels/fieldRules.ts`
- Test: `api/tests/test_label_field_rules.py`, `portal/src/labels/fieldRules.test.ts`

**Interfaces:**
- Produces (Python, stdlib only):
  - `class FieldRules(TypedDict, total=False)`: `display: Literal['text','number','barcode','qr']`, `expected_length: int`, `max_chars: int`, `trim: Literal['front','rear']`, `strip: str`, `strip_where: Literal['front','rear','anywhere']`.
  - `split_value(value: str) -> list[str]` — `value.split('.')`; `''` → `['']`.
  - `piece(value: str, index: int) -> str` — 0-based piece or `''` when missing.
  - `apply_rules(value: str, rules: FieldRules) -> str` — Strip → Max/Trim → Number padding. Strip `front` removes the value while the string starts with it, `rear` while it ends with it, `anywhere` every occurrence. Trim `front` keeps the last `max_chars`, `rear` the first. Number padding: when `display == 'number'` and `expected_length`, left-pad the integer part (text before the first `.`) with `0` to `expected_length`.
  - `is_blank(value: str, rules: FieldRules) -> bool` — blank after Strip and Max/Trim (before padding).
- Produces (TS, same names camelCased): `splitValue`, `piece`, `applyRules(value: string, rules: FieldRules): string`, `isBlank`, `export interface FieldRules { display?: 'text'|'number'|'barcode'|'qr'; expectedLength?: number; maxChars?: number; trim?: 'front'|'rear'; strip?: string; stripWhere?: 'front'|'rear'|'anywhere' }`.
- Fixture `field_rules.json`: `{"cases": [{"name": str, "value": str, "rules": {snake_case keys}, "expected": str, "blank": bool}]}`; the TS test maps snake_case keys to camelCase.

- [ ] **Step 1: Write the fixture** with at least these cases (exact values): `000123` strip `0` front → `123`; `123` number expected 6 → `000123`; `000123` strip `0` front + number expected 6 → `000123`; `3.5` number expected 2 → `03.5`; `07C` number expected 3 → `07C`; `lvn-hm1w2-vc1-c1n7` max 10 trim rear → `lvn-hm1w2-`; same max 10 trim front → `2-vc1-c1n7`; `10482` strip `4` anywhere → `1082`; `` → `` with blank true; `0` strip `0` front → `` blank true; `12` number expected 1 → `12` (never truncates).
- [ ] **Step 2: Write the failing tests.** Python: `test_fixture_cases` parametrized over the file; `test_split_and_piece` (`split_value('14.01.07C.02.03') == ['14','01','07C','02','03']`, `piece('ORD1-F01', 1) == ''`, `piece('', 0) == ''`). TS: the same two, reading the JSON with `import cases from '../../../api/src/serversherpa/labels/fixtures/field_rules.json'` (configure `resolveJsonModule`/vite JSON import if not already on).
- [ ] **Step 3:** Run `cd api && SS_TEST_DB=serversherpa_test_lb PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_label_field_rules.py` and `npm --prefix portal test -- --run src/labels/fieldRules.test.ts` — FAIL (modules missing).
- [ ] **Step 4:** Implement both modules.
- [ ] **Step 5:** Both commands PASS. **Step 6:** Commit `feat(labels): field rules pipeline shared by portal and compiler`.

### Task 2: Field catalog, field values, the fields route, move code, and the kiosk sync fields

**Files:**
- Create: `api/src/serversherpa/labels/fields.py`, `api/migrations/versions/0100_initiative_code.py`
- Modify: `api/src/serversherpa/db/models.py` (`Initiative.code`), `api/src/serversherpa/api/schemas.py` (`InitiativeCreateIn`/`Out` gain `code: str | None`; `KioskAssetOut`, `KioskLabelContextOut`), `api/src/serversherpa/api/routes/initiatives.py` (accept/return `code`), `api/src/serversherpa/api/routes/kiosk.py` (`_assets_body`), `api/src/serversherpa/api/routes/labels.py` (new route), `portal/src/components/initiatives/InitiativeFields.tsx` + `InitiativeEditModal.tsx` (a Code input next to Name), `portal/src/lib/api.ts`
- Test: `api/tests/test_label_fields.py`, `api/tests/test_kiosk_label_inputs_sync.py` (extend), `api/tests/test_initiatives_api.py` (extend), `portal/src/components/initiatives/InitiativeEditModal.test.tsx` (extend)

**Interfaces:**
- `fields.py` (pure; imports only stdlib and `labels.field_rules`):
  - `FIELD_GROUPS: list[FieldGroup]` where `FieldGroup = {"key": str, "label": str, "label_types": list[str], "fields": list[FieldDef]}` and `FieldDef = {"key": str, "label": str, "kind": Literal['text','number','date'], "mock": str}`. Groups and keys, exactly: `asset` (Asset): `asset_id`, `asset_name`, `serial_number`, `rfid_tag`, `pod_number`, `asset_status`, `has_rails`, `location_detail`; `model` (Make & model): `make_model`; `move_row` (On this move): `source_rack`, `source_ru`, `source_position`, `source_pod`, `destination_rack`, `destination_ru`, `destination_position`, `destination_pod`, `priority_wave`, `disposition`, `owner`, `cable_data_1`..`cable_data_6`, `cable_mgmt_1`, `cable_mgmt_2`, `vendor_involved`, `roster_status`; `move` (Move): `move_name`, `move_code`, `move_date`, `move_date_long`; `sites` (Sites): `origin_site_name`, `origin_site_code`, `destination_site_name`, `destination_site_code`; `container` (Container, label_types `container`,`container_info`): `container_name`, `container_id`, `label_tag`, `container_rfid_tag`, `container_type`, `container_status`. `asset`, `model`, `move_row` apply to `top`, `front`, `rail`; `move` and `sites` to all types. From-To columns are dynamic keys `ft:<header>` (not in `FIELD_GROUPS`).
  - `MOCK_VALUES: dict[str, str]` — one mock per catalog key (reuse the kiosk's existing `MOCK_VALUES` where keys overlap; `destination_rack` mock is `14.01.07C.02.03`, `source_rack` `09.01.05D.02.10`).
  - `field_values(payload: dict, context: dict) -> dict[str, str]` — every catalog key for the payload's type plus `ft:<header>` for each key in `payload.get("raw_ft") or {}`. `payload` is the kiosk sync asset item shape (Task 2 extends it: see below) or the container item; `context` is `label_context` (`move_name`, `move_code`, `move_day` ISO or None, `source_site`, `source_site_code`, `destination_site`, `destination_site_code`). Rules: `source_ru`/`destination_ru` are the bare number text (`14`, `3.5`, from `*_ru_raw` via `Decimal` normalize); `move_date` `%m/%d/%Y`; `move_date_long` `DD-MON-YYYY`; booleans → `Yes`/`No`/``; statuses use the label (`asset_status_label`, `roster_status_label` in the payload); missing → `''`.
  - `asset_payload(asset, roster_row, model, status_labels: dict) -> dict` and `container_payload(container, ...) -> dict` live in `api/src/serversherpa/labels/generate/payloads.py` (ORM side; NOT pure) and must produce exactly the sync item shape.
- Kiosk sync additions on `KioskAssetOut`: `pod_number`, `asset_status`, `asset_status_label`, `has_rails: bool | None`, `location_detail`, `owner`, `cable_info: dict | None` (parsed JSON or `{"text": <free text>}`), `vendor_involved: bool | None`, `roster_status`, `roster_status_label`, `raw_ft: dict | None`. `KioskLabelContextOut` gains `move_code`, `source_site_code`, `destination_site_code`.
- Route `GET /labels/fields?label_type=top` (labels:view) → `{"groups": FieldGroup[] filtered by label_type, "ft_headers": sorted union of raw_ft keys across initiative_assets (natural order)}`.
- `initiatives.code`: `CITEXT NULL`, unique when set (partial unique index), max 32 chars, stripped; `POST/PATCH /initiatives` accept it; portal form shows "Code" beside Name.

- [ ] **Step 1: Write failing tests.** `test_label_fields.py`: `test_catalog_keys_are_unique_and_grouped`; `test_field_values_from_a_sync_item` (a hand-built item + context → exact dict incl. `ft:Notes`); `test_mock_values_cover_every_key`; `test_ru_text_is_bare` (`"14.0"` → `14`, `"3.50"` → `3.5`). `test_kiosk_label_inputs_sync.py`: `test_sync_item_carries_the_builder_fields` (seed owner, cable_info JSON, raw_ft, has_rails, site codes, move code; assert each on the item/context) and `test_field_values_match_portal_payload` (`field_values(item, ctx) == field_values(asset_payload(...), ctx)` for 3 seeded assets). `test_initiatives_api.py`: `test_move_code_round_trips_and_is_unique`. `GET /labels/fields` test: top excludes the container group, container includes it; `ft_headers` lists `Notes`.
- [ ] **Step 2:** Run those files — FAIL. **Step 3:** Migration 0100 + models + schemas + routes + `fields.py` + `payloads.py` + portal Code input (+ `api.ts` type). **Step 4:** Run the files plus `tests/test_kiosk_sync_api.py`, `tests/test_kiosk_label_templates_sync.py`, `tests/test_kiosk_station_key.py`; portal `src/components/initiatives` — PASS. **Step 5:** Commit `feat(labels): field catalog and values; move code; sync carries the builder fields`.

### Task 3: Design schema v2 and the v2 ZPL compiler

**Files:**
- Modify: `api/src/serversherpa/labels/model.py`, `api/src/serversherpa/labels/zpl.py`, `api/src/serversherpa/labels/compile.py`, `api/src/serversherpa/labels/render.py`, `api/src/serversherpa/labels/brother_escp.py`, `api/src/serversherpa/labels/brother_ptouch.py` (ignore v2-only properties)
- Create: `api/src/serversherpa/labels/fonts.py`, `api/src/serversherpa/labels/fixtures/vegas_v2.json`, `api/src/serversherpa/labels/fixtures/vegas_v2_300.zpl`
- Test: `api/tests/test_labels_design_v2.py`, `api/tests/test_labels_zpl_v2.py`

**Interfaces:**
- `fonts.py` (pure): `FAMILIES: dict[str, Family]` with slugs `swiss721-cond-bold`, `roboto-condensed`, `roboto`, `oswald`, `roboto-mono`, `ibm-plex-mono`, `atkinson-hyperlegible`, `source-sans-3`; `Family = {"label": str, "objects": {"regular": str, "bold": str | None}, "resident": bool, "mono": bool}` with object names `TT0003M_.TTF` (regular; bold None; resident), `ROBOCO_R.TTF`/`ROBOCO_B.TTF`, `ROBOTO_R.TTF`/`ROBOTO_B.TTF`, `OSWALD_R.TTF`/`OSWALD_B.TTF`, `ROBOMO_R.TTF`/`ROBOMO_B.TTF`, `PLEXMO_R.TTF`/`PLEXMO_B.TTF`, `ATKINS_R.TTF`/`ATKINS_B.TTF`, `SRCSAN_R.TTF`/`SRCSAN_B.TTF`. `font_object(family: str, weight: str) -> tuple[str, bool]` → (object name, `faux_bold` = weight is bold and the family has no bold file). `DEFAULT_FAMILY = "swiss721-cond-bold"`.
- Design v2 JSON (validated by `parse_design`; v1 stays accepted when `schema` is absent or 1):
  ```json
  {"schema": 2, "size": {"w": 4, "h": 2},
   "splits": {"destination_rack": {"pieces": ["NAP","Sector","POD","Row","Rack"]}},
   "elements": [
     {"id":"e1","type":"field","field":"destination_rack","piece":2,"x":1.33,"y":0.03,"w":0.5,"h":0.37,"rotation":0,"locked":false,"hideWhenEmpty":false,
      "display":"text","font":{"family":"swiss721-cond-bold","weight":"regular"},"sizePt":24,"baselineIn":0.30,"inverted":false,"invertPad":{"x":0.067,"y":0.033},
      "expectedLength":3,"align":"left","maxChars":3,"trim":"rear","strip":null,"stripWhere":"front"},
     {"id":"e2","type":"text","content":"Name:","font":{...},"sizePt":10,"baselineIn":0.12,"inverted":false,"align":"left","lines":1,"x":..,"y":..,"w":..,"h":..},
     {"id":"e3","type":"barcode","field":"asset_id","symbology":"code128","moduleIn":0.0133,"showText":true,"x":..,"y":..,"w":..,"h":..},
     {"id":"e4","type":"qr","field":"asset_id","x":..,"y":..,"w":..,"h":..},
     {"id":"e5","type":"line","strokeIn":0.017,...}, {"id":"e6","type":"box","strokeIn":0.01,"fill":true,...}]}
  ```
  `piece` is absent for a whole-field element; `field` elements with `display` `barcode`/`qr` are allowed (same as a barcode/qr element bound to a field); `text` static elements have no rules. `parse_design` returns dataclasses `FieldEl`, `TextEl` (v2 adds `font`, `baseline_in`, `inverted`, `invert_pad`), `BarcodeEl` (+ `field`), `QrEl` (+ `field`), `LineEl`, `BoxEl` (+ `fill`), and `Design.schema`, `Design.splits`.
- `zpl.compile_zpl(design, dpi, values: dict[str,str] | None, *, font_objects=None) -> str` (signature unchanged; v2 branch when `design.schema == 2`). For v2:
  - value of a field element = `apply_rules(piece(values[field], piece) if piece is not None else values.get(field, ''), rules)`; `values is None` → the token form `{field}` / `{field:piece}` (kiosk-intact mode is not needed for v2; raise `ValueError("v2 designs render with values")`).
  - hidden when `hideWhenEmpty and is_blank(...)`; inverted + blank → nothing.
  - text/field: `^FT{x},{y+baseline}` + (`^FB{w},1,0,{C|R},0` only when align ≠ left) + `^A@{rot},{h},{w},E:{object}` where `h = round(sizePt*dpi/72)`, `w = h` (or `round(h*1.15)` when faux bold on an inverted element) + (`^FR` when inverted) + `^FH_^FD…^FS`; faux bold (not inverted): the same field emitted twice, the second at `x+1`. Inverted: before the text, `^FO{bx},{by}^GB{bw},{bh},{bh}^FS` where the box is the reserved box plus `invertPad` (dots).
  - reserved width in dots = `w` (the element box; the browser sized it); the compiler never measures text.
  - barcode: `^BY{module}` + `^BC{rot},{h},{Y|N},N,N` / `^B3…`; qr: `^BQ{rot},2,{mag}` with `mag = min(10, max(1, round(w_dots/21)))` (21 modules at version 1; use the data length to pick the version: ≤ 25 chars → 21 modules, else 25) and `^FDQM,{data}` (error correction M).
  - header: `^XA^PW^LL^CI28` (unchanged), footer `^XZ`.
- `render.render_template(template, values, *, width_in, height_in, dots)` unchanged signature; passes values through for v2.
- Brother compilers: v2 designs compile with the same text/barcode/qr/line/box as v1 (fonts, inverted, pads ignored); a test proves no exception.

- [ ] **Step 1: Author the Vegas v2 fixture** `vegas_v2.json` from the recon's element inventory (§4b): 1200×600 @ 300 → inches (`x/300`), pieces NAP/Sector/POD/Row/Rack of `destination_rack`, `destination_ru` as Number expected 2, banner cells inverted with `invertPad` matching the old 20/10/20-dot pads, captions as static text, Name/Serial/Model fields, the rule as a line, Code 128 `asset_id` with `moduleIn` 4/300, QR `asset_id` with `w = h = 147/300`, the two rotated (270) site-code and move-date fields. Baselines: `baselineIn = 0.72 × sizePt/72` (the recon's measured ratio).
- [ ] **Step 2: Write failing tests.** `test_labels_design_v2.py`: `test_v1_designs_still_parse`, `test_v2_parses_every_element_type`, `test_v2_rejects_unknown_piece_and_bad_rules` (piece index ≥ pieces → DesignError; `maxChars` 0 → DesignError), `test_schema_defaults_to_1`. `test_labels_zpl_v2.py`: `test_field_text_uses_ft_baseline_and_named_font` (one element → exact string `^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS` inside the label), `test_center_alignment_uses_fb` (`^FB150,1,0,C,0`), `test_inverted_emits_box_then_reverse` (`^FO…^GB…^FS` precedes `^FR`), `test_inverted_blank_prints_nothing`, `test_faux_bold_overprints_one_dot` and `test_faux_bold_on_inverted_widens` (`^A@N,100,115,…`), `test_number_padding_and_split_pieces` (values `destination_rack='14.01.07C.02.03'` → the five pieces appear; `destination_ru='3.5'` expected 2 → `03.5`), `test_hide_when_empty`, `test_qr_uses_mode_m_and_caps_magnification_at_10` (at 600 DPI), `test_values_are_hex_escaped` (`X^XZ~JR` → `_5e`, `_7e`), `test_vegas_fixture_renders_to_golden` (`compile_zpl(vegas, 300, MOCK_VALUES) == vegas_v2_300.zpl`; write the golden from the first green run and review it by eye against the recon layout), `test_brother_compilers_accept_v2`.
- [ ] **Step 3:** Run both files — FAIL. **Step 4:** Implement. **Step 5:** PASS, plus `tests/test_label_core.py tests/test_labels_zpl.py tests/test_labels_design_model.py tests/test_container_zpl_templates.py tests/test_kiosk_label_templates_sync.py`. **Step 6:** Commit `feat(labels): design schema v2 and the v2 ZPL compiler (fonts, inverted, split, rules)`.

### Task 4: Font library families, seeding, metrics

**Files:**
- Create: `api/migrations/versions/0101_label_font_families.py`, `api/src/serversherpa/labels/font_seed.py`, `api/src/serversherpa/labels/font_metrics.py`
- Modify: `api/src/serversherpa/db/models.py` (`LabelFont`: `family: str | None`, `weight: str | None`, `resident: bool`, `source_url: str | None`), `api/src/serversherpa/api/routes/labels.py` (fonts routes), `api/src/serversherpa/api/schemas.py` (`LabelFontOut`), `api/src/serversherpa/cli.py` (`seed-label-fonts`), `api/pyproject.toml` (`fonttools>=4.50`)
- Test: `api/tests/test_label_fonts_api.py` (extend), `api/tests/test_label_font_seed.py`

**Interfaces:**
- `font_seed.SOURCES: dict[tuple[str,str], str]` — pinned GitHub raw URLs (google/fonts repo, OFL/Apache files) for the 14 open files; `async def seed(db, *, fetch=httpx) -> list[str]`: downloads each missing (family, weight), uploads through the same storage path `upload_label_font` uses, with `name` = the object name from `labels.fonts`, `display_name` = `"<Family label> <Regular|Bold>"`, `family`, `weight`; creates the resident Swiss row (`name` `TT0003M_.TTF`, `resident=True`, no storage object) when absent. Idempotent.
- `font_metrics.metrics(ttf_bytes: bytes) -> dict` → `{"unitsPerEm": int, "ascent": int, "descent": int, "advances": {chr: int for codepoints 32..126}}` via `fontTools.ttLib.TTFont`.
- Routes: `GET /labels/fonts` includes the new fields; `GET /labels/fonts/{id}/metrics` (labels:view) → the metrics dict (works for the resident row only when its file is in the library; else 404 `no_font_file`); `GET /labels/fonts/{id}/content` refuses `resident` rows with 403 `font_not_servable` (the browser must not receive it) — the kiosk route `/kiosk/labels/fonts/{id}/content` likewise never serves a resident font and the kiosk fonts list marks it `resident: true`.
- CLI: `serversherpa seed-label-fonts` (typer command) runs `seed`.

- [ ] **Step 1: Write failing tests.** `test_label_font_seed.py` with a fake fetch: `test_seed_creates_fourteen_files_and_the_resident_row` (names and families exact), `test_seed_is_idempotent`. `test_label_fonts_api.py`: `test_metrics_route_returns_advances` (a tiny TTF built in the test with fontTools), `test_resident_font_content_is_refused`, `test_kiosk_fonts_list_marks_resident`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (migration 0101, models, seed, metrics, routes, CLI). **Step 4:** PASS plus `tests/test_kiosk_label_station_api.py`. **Step 5:** Commit `feat(labels): font families, seeding of the builder fonts, metrics route`.

### Task 5: Template tree — parents, DPI children, versions, clone, replace, typed delete

**Files:**
- Create: `api/migrations/versions/0102_label_template_tree.py`, `api/src/serversherpa/labels/templates_tree.py`
- Modify: `api/src/serversherpa/db/models.py` (`LabelTemplate` + `LabelTemplateVersion`), `api/src/serversherpa/api/routes/labels.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/labels/kiosk_templates.py`, `api/src/serversherpa/api/routes/kiosk.py` (test-render for v2)
- Test: `api/tests/test_label_template_tree_api.py`, `api/tests/test_kiosk_label_templates_sync.py` (extend), `api/tests/test_kiosk_label_station_api.py` (extend)

**Interfaces:**
- Columns on `label_templates`: `parent_id uuid NULL FK label_templates ON DELETE CASCADE`, `schema_version int NOT NULL DEFAULT 1`, `samples jsonb NOT NULL DEFAULT '{}'`, `dpis text[] NOT NULL DEFAULT '{203,300,600}'` (parents), `generated_from_version int NULL`, `child_edits int NOT NULL DEFAULT 0`, `customized bool NOT NULL DEFAULT false`, `is_old bool NOT NULL DEFAULT false`. New table `label_template_versions(id, template_id FK CASCADE, version int, child_edits int, design jsonb, code text, samples jsonb, summary text, note text DEFAULT '', created_by, created_at)`, unique `(template_id, version, child_edits)`.
- `templates_tree.py` (DB logic, one function per operation; every write goes through here):
  - `create_parent(db, *, name, description, label_type, size_key, language_key, design, samples, site_ids, actor_id) -> LabelTemplate` — parent row `dpi_key='300'` (the design DPI shown in the builder), `schema_version=2`, then `generate_children(parent)`.
  - `generate_children(db, parent) -> list[LabelTemplate]` — for each dpi in `parent.dpis` without a child: child row `name=f"{parent.name} · {dpi}"`, `parent_id`, `dpi_key=dpi`, same type/size/language, `design` copy, `samples` empty, `generated_from_version=parent.version`, `is_active=parent.is_active`.
  - `save_parent(db, parent, *, design, samples, summary, actor_id) -> ParentSaveResult` — bumps `parent.version`, writes a version row, regenerates every child with `customized=False` (design copy, `generated_from_version`), leaves customized children untouched; returns `{"out_of_date": [child ids]}` (customized children with `generated_from_version < parent.version`).
  - `save_child(db, child, *, design, summary, actor_id)` — `customized=True`, `child_edits += 1`, version row.
  - `update_from_parent(db, child, actor_id) -> LabelTemplate` — renames the child `"{parent.name} · {dpi} Old"` (` Old 2`… on collision), `is_old=True`, `is_active=False`, then `generate_children` makes the fresh child; returns it.
  - `add_dpi(db, parent, dpi)`, `delete_child(db, child)` (removes the dpi from `parent.dpis`), `delete_parent(db, parent, typed_name) -> DeleteSummary` (422 `name_mismatch` unless `typed_name == parent.name`; cascades children and generated labels; returns counts), `clone(db, parent, new_name, actor_id)`, `versions(db, template) -> list`, `restore(db, template, version, child_edits, actor_id)`, `replace(db, new_parent, old_template_ids, actor_id)` (one transaction: deactivate the old rows, activate the parent and children; `assert_single_active` guards).
  - `assert_single_active(db, *, family, label_type, dpi_key, exclude_id)` → raises `ActiveConflict(names)` → 422 `active_conflict`. Family of a child = its parent's name; of a legacy row = `family_name(row.name)`.
- Routes (all under `/labels/templates`; mutations need `labels:*` + rank ≥ 80 via a new `require_rank(80)` dependency in `api/deps.py`): `GET /tree` → `[ParentOut{…, children: [ChildOut]}]` (ParentOut adds `dpis`, `schema_version`, `samples`, `children`; ChildOut adds `dpi_key`, `generated_from_version`, `child_edits`, `customized`, `out_of_date` (computed), `is_old`); `POST /` (v2 body creates a parent + children; v1/code bodies unchanged); `PATCH /{id}` (parent → `save_parent`; child → `save_child`; response carries `out_of_date`); `POST /{id}/update-from-parent`; `POST /{id}/dpis` `{dpi}`; `DELETE /{id}` child → `delete_child`; `DELETE /{id}` parent with body `{typed_name}` → `delete_parent` (the existing deactivate stays at `POST /{id}/deactivate`); `POST /{id}/clone` `{name}`; `GET /{id}/versions`; `GET /{id}/versions/{version}/{child_edits}`; `POST /{id}/versions/{version}/{child_edits}/restore`; `POST /{id}/replace` `{old_template_ids}`; `POST /{id}/activate` (guarded).
- Sync: `move_template_set` includes children (never parents); `family` for a child = parent name; `KioskLabelTemplateOut` gains `schema_version` and never includes `samples`. Kiosk `test-render` accepts v2 designs using `fields.MOCK_VALUES` + `field_values`-shaped mocks.

- [ ] **Step 1: Write failing tests** (`test_label_template_tree_api.py`): `test_create_parent_makes_three_children_named_by_dpi`; `test_parent_save_regenerates_uncustomized_children_and_flags_customized`; `test_update_from_parent_keeps_old_child_nested_and_inactive` (name `… · 300 Old`, second time `… · 300 Old 2`); `test_delete_parent_requires_typed_name_and_cascades` (422 then 204, children and a generated label gone, summary counts); `test_delete_child_removes_dpi_and_add_dpi_restores_it`; `test_clone_copies_parent_and_children`; `test_versions_list_and_restore_bumps_version`; `test_replace_swaps_atomically_and_refuses_a_second_active` (`active_conflict`); `test_mutations_need_rank_80` (a labels:change user at rank 60 → 403); `test_tree_readable_with_labels_view`. Sync tests: `test_sync_sends_children_with_parent_family_and_no_samples`; `test_test_render_handles_v2`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS plus `tests/test_labels_*` and `tests/test_kiosk_label_*`. **Step 5:** Commit `feat(labels): template tree with DPI children, versions, clone, replace, typed delete`.

### Task 6: Generated labels per DPI; Generate modal DPI; Print page filter

**Files:**
- Create: `api/migrations/versions/0103_generated_labels_per_dpi.py`
- Modify: `api/src/serversherpa/labels/generate/runner.py`, `select.py`, `jobs.py`, `api/src/serversherpa/api/routes/labels.py` (runs/preview/generated take `dpi_key`), `api/src/serversherpa/api/schemas.py`, `portal/src/pages/GenerateLabels.tsx` (+ its generate modal: a DPI select 203/300/600, default the last used from `localStorage` key `labels.generate.dpi`, else 300), `portal/src/pages/PrintLabels.tsx` (filter rows to the connected printer's `identity.dpi`; a DPI column when no printer), `portal/src/lib/api.ts`
- Test: `api/tests/test_label_generate_runner.py`, `test_label_generate_api.py` (extend), `portal/src/pages/GenerateLabels.test.tsx`, `PrintLabels.test.tsx` (extend)

**Interfaces:** unique index on `generated_labels` becomes `(entity_type, entity_id, coalesce(initiative_id), label_type, dpi_key)`; `POST /labels/generate/runs` body gains `dpi_key: str = '300'`; `select_template` gains `dpi_key` and prefers a child at that DPI (parents never selected; v1 rows matched by `dpi_key` as today); `GET /labels/generated?dpi_key=`.

- [ ] **Step 1:** Failing tests: `test_runs_generate_per_dpi_and_keep_other_dpis`; `test_select_prefers_the_child_at_the_run_dpi`; portal `shows a DPI choice defaulting to 300 and remembers it`; `print page filters to the connected printer's DPI`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS plus the label suites. **Step 5:** Commit `feat(labels): generated labels per DPI; Generate chooses a DPI; Print filters by printer`.

### Task 7: Portal builder model, undo, metrics, shortcuts (pure TS)

**Files:**
- Create: `portal/src/labels/builder/model.ts`, `history.ts`, `metrics.ts`, `shortcuts.ts`, `align.ts`, `geometry.ts`, `zplPreview.ts`
- Test: one `*.test.ts` per file under `portal/src/labels/builder/`

**Interfaces:**
- `model.ts`: `DesignV2`, `ElementV2` union mirroring Task 3's JSON exactly (camelCase as in the JSON); `newDesign(size)`, `addElement(d, el)`, `updateElement(d, id, patch)`, `removeElements(d, ids)`, `duplicate(d, ids, offsetIn=0.05)`, `reorder(d, id, 'back'|'forward'|'toBack'|'toFront')`, `addSplit(d, fieldKey, sample) -> DesignV2` (pieces named `Piece 1..n`), `renamePiece`, `placementsOf(d, fieldKey) -> ElementV2[]`, `validate(d) -> Problem[]`.
- `history.ts`: `createHistory(initial, cap=100)` with `push`, `undo`, `redo`, `canUndo/canRedo`, coalescing a drag into one entry via `beginGesture/endGesture`.
- `metrics.ts`: `interface FontMetrics { unitsPerEm; ascent; descent; advances: Record<string, number> }`; `loadFont(family, weight, fetchBytes) -> Promise<{face: FontFace|null, metrics: FontMetrics}>` (resident family: metrics from `GET /labels/fonts/{id}/metrics`, face = Roboto Condensed Bold); `reservedWidthIn(metrics, sizePt, expectedLength, display)` (widest advance for text, digit `0`-`9` max for number), `baselineIn(metrics, sizePt)`, `textWidthIn(metrics, sizePt, text)`. Measurement never touches `canvas` (jsdom-safe).
- `shortcuts.ts`: `SHORTCUTS: Shortcut[]` (`{id, keys, mac, win, label, when: 'canvas'|'always'}`) listing every binding of spec §5 with `/` for field search; `matchShortcut(e: KeyboardEvent, platform) -> Shortcut | null`; a test proves no two shortcuts share keys and ⌘K is absent.
- `align.ts`: `align(elements, 'left'|'center'|'right'|'top'|'middle'|'bottom', labelSize)` (one element → to the label), `distribute(elements, 'h'|'v')`, `matchSize(elements, 'w'|'h')`.
- `geometry.ts`: `snap(v, step)`, `clampToLabel`, `hitTest`, `marqueeSelect`, resize math for the eight handles with the per-type rules (text: height drives `sizePt`, width follows expected length; barcode: width snaps to modules; qr: square snapped to magnification steps given dpi).
- `zplPreview.ts`: `previewRequest(design, dpi, samples, fontIds)` → body for `POST /labels/templates/compile` (v2) and `POST /labels/preview/zpl` (with `font_ids`).

- [ ] **Step 1:** Failing tests per module (model round-trips the Vegas fixture JSON from `api/src/serversherpa/labels/fixtures/vegas_v2.json`; undo coalesces a gesture; metrics computes `reservedWidthIn` for expected 3 at 24 pt with a fake metrics object; shortcut uniqueness; align/distribute numeric cases; resize rules).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(portal): label builder model, history, metrics, shortcuts, alignment`.

### Task 8: Portal builder canvas

**Files:**
- Create: `portal/src/components/labels/builder/Canvas.tsx`, `CanvasElement.tsx`, `Rulers.tsx`, `CanvasToolbar.tsx`, `portal/src/styles/labelBuilder.css`
- Test: `portal/src/components/labels/builder/Canvas.test.tsx`

**Interfaces:** `<Canvas design dpi zoom showSamples values selection onSelect onChange history metricsFor />` — SVG in dots at `zoom` px/dot; renders text with the loaded font face (`style={{fontFamily}}`), the reserved box outline, red overflow when `textWidthIn > reserved`, inverted boxes, barcode/QR placeholders, rotation about the element box center, lock, eight handles, marquee, ⇧-click, drag with axis lock (⇧), ⌥-drag duplicate, arrow nudges, grid/snap/rulers toggles, zoom (fit, 1:1, steps), space-drag pan. `CanvasToolbar` holds tools, zoom, grid/snap/rulers, align group, Field names / Sample values.

- [ ] **Step 1:** Failing tests (RTL + jsdom with a fake `metricsFor`): renders every Vegas element; click selects, ⇧-click adds, marquee selects three; drag moves by the snapped delta; the POD element shows its reserved width not its sample width; overflow class appears when the sample exceeds the box; align buttons call `align` with the selection; keyboard nudge by 1 and 10 dots.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + `npm --prefix portal test -- --run src/styles` (guardrails). **Step 5:** Commit `feat(portal): label builder canvas`.

### Task 9: Portal field panel, picker, placed-fields table, properties panel

**Files:**
- Create: `portal/src/components/labels/builder/FieldPanel.tsx`, `FieldPicker.tsx`, `PlacedFieldsTable.tsx`, `PropertiesPanel.tsx`, `FontSelect.tsx`, `LoadFromAssetModal.tsx`
- Modify: `portal/src/lib/api.ts` (`listLabelFields`, `loadSampleAsset(initiativeId, assetId)` → `GET /kiosk/sync/assets`-shaped values via a new `GET /labels/sample-values?initiative_id&asset_id` route added in this task to `routes/labels.py`, labels:view)
- Test: one `*.test.tsx` per component

**Interfaces:** `FieldPanel` (groups from `/labels/fields`, samples editable inline, unused first then used greyed with `×n`, search focused by `/`, the **+** opens `FieldPicker` with static text/line/box then fields); `PlacedFieldsTable` (one row per placement, split pieces nested under a parent row, columns Field | Display | Font | B | Inv | Expected | Max | Trim | Strip, selection synced with the canvas, Tab/⇧Tab step); `PropertiesPanel` (every property of Task 3's JSON; multi-selection applies to all; `FontSelect` renders each family in its own face with `0O 1Il 7`, resident shown as "Swiss 721 Condensed Bold" with the Roboto stand-in); `LoadFromAssetModal` (move picker → asset search → fills `samples`).

- [ ] **Step 1:** Failing tests: field ordering/greying/count; picker adds a second copy; table nests pieces and selects; properties edits patch the element (display type change to Split creates pieces from the sample `14.01.07C.02.03` → 5 rows); font select lists eight families; load-from-asset fills samples.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(portal): builder panels: fields, picker, placed fields, properties`.

### Task 10: Portal builder page, save/versions, test print, preview, new-template modal, routing, retire the old editor

**Files:**
- Create: `portal/src/pages/LabelBuilder.tsx`, `portal/src/components/labels/builder/NewTemplateModal.tsx`, `VersionsModal.tsx`, `BuilderTopBar.tsx`
- Modify: `portal/src/App.tsx` (`/labels/templates/new` and `/labels/templates/:id/edit` → `LabelBuilder` with `minRank={80}`; `/labels/templates/:id/code` → the existing `LabelTemplateEditor` kept for `kind=code` only), `portal/src/pages/LabelTemplateEditor.tsx` (code mode only), delete `EditorCanvas.tsx`, `ElementPalette.tsx`, `PropertiesPanel.tsx` (old), `GenerationRulesPanel.tsx` and their tests; `portal/src/lib/api.ts` (tree/versions/clone/replace/delete/dpis endpoints), `api/src/serversherpa/api/routes/labels.py` (`/preview/zpl` accepts `font_ids`, prepends `~DY` downloads for non-resident fonts, rewrites `^A@…,E:TT0003M_.TTF` to `^A0…` for Labelary; dpmm map gains 600 → 24)
- Test: `portal/src/pages/LabelBuilder.test.tsx`, `NewTemplateModal.test.tsx`, `VersionsModal.test.tsx`, `api/tests/test_labels_preview_api.py`

**Interfaces:** `NewTemplateModal`: name, type, size list + Custom… (width/height in `in`/`mm`, "Save this size to the list" → `POST /labels/vocab`), creates the parent. Top bar: name, type·size chip, "Parent (203 · 300 · 600)" or "Child · 300" chip, version chip, undo/redo, Versions, Clone, Test print (⌘P, USB via the existing print hook), Save (⌘S; parent save shows the out-of-date prompt per child: "Update now" → `update-from-parent`, "Keep"), dirty guard (`beforeunload` + in-app prompt). Preview panel: Labelary PNG with fonts embedded.

- [ ] **Step 1:** Failing tests: page loads a parent and renders the three panels; ⌘S saves and bumps the version chip; the out-of-date prompt appears when the save response lists a child; ⌘P calls the print hook with v2 ZPL from the compile route; NewTemplateModal custom size posts inches; a rank-60 user is redirected from `/labels/templates/new`; API preview test: `font_ids` prepend `~DY`, the resident font is rewritten to `^A0`, 600 DPI maps to 24 dpmm.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; remove the old editor files and update `LabelTemplates.tsx` links (code templates keep "Edit as raw ZPL"). **Step 4:** Full portal suite + `tsc -b` + build. **Step 5:** Commit `feat(portal): label builder page; retire the old design editor`.

### Task 11: Portal templates list tree

**Files:**
- Modify: `portal/src/pages/LabelTemplates.tsx` (tree rows, chips From parent / Customized / Out of date / Kept · inactive, DPI column "All" when 203·300·600 present else the ones present, row menus per spec §4.9, read-only without rank 80), `portal/src/lib/api.ts`
- Create: `portal/src/components/labels/DeleteTemplateModal.tsx` (lists children + generated-label count, typed name gate), `ReplaceTemplateModal.tsx` (pick the old active rows of the same family/type, confirm)
- Test: `LabelTemplates.test.tsx` (extend), the two modal tests

- [ ] **Step 1:** Failing tests: tree renders children under the expanded parent with exact chip texts; "All" vs "203 · 300"; delete modal disables the button until the typed name matches; replace modal calls `/replace` with the old ids; rank-60 sees no menus/New.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, guardrails, build. **Step 5:** Commit `feat(portal): template list as a tree with versions, replace and typed delete`.

### Task 12: Kiosk and edge — schema gate, field values, resident fonts, the station test label

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/labels/generate.py` (values from `serversherpa.labels.fields.field_values(item, label_context)`; `SUPPORTED_SCHEMA = 2`; a design with `schema > SUPPORTED_SCHEMA` → error `template_unsupported`), `kiosk_laptop/edge/src/edge/labels/runner.py` (status counts `unsupported`), `kiosk/src/lib/api.ts` (types: `schema_version`, `resident` fonts), `kiosk/src/lib/stationPrinter.ts` (`neededFonts` excludes resident fonts; `readFonts` check still lists them as present-or-missing without install), `kiosk/src/components/setup/PrinterStep.tsx` (a missing resident font is a red row "Printer is missing its built-in font TT0003M_.TTF" with no install button), `kiosk/src/components/setup/TestLabelModal.tsx` (mock label = the plan's template: `getLabelPlan({dpi, kind})` → template id → the downloaded template; fallback to today's rule), `kiosk/src/pages/PrintingStation.tsx` + `printQueue.ts` (`template_unsupported` → "This laptop needs an update to print this template."), `kiosk_laptop/edge/src/edge/routes/labels.py` (status exposes `unsupported`)
- Test: `kiosk_laptop/edge/tests/test_label_generate.py`, `test_label_runner.py`, `test_label_routes.py` (extend); kiosk `stationPrinter.test.ts`, `PrinterStep.test.tsx`, `TestLabelModal.test.tsx`, `printQueue.test.ts` (extend)

- [ ] **Step 1:** Failing tests: edge renders a v2 fixture asset to the same bytes as `render_template` (the Vegas fixture + a sync-shaped item); `schema 3` → `template_unsupported` rows and `unsupported` count; a v1 design still renders; kiosk: resident font never installed, missing resident is red without a button; test label uses the plan's template id; the station shows the update message.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Full edge suite; full kiosk suite + build. **Step 5:** Commit `feat(kiosk): v2 designs on the edge, schema gate, resident fonts, plan-based test label`.

### Task 13: Built-in template rebuilds and the end-to-end parity fixture

**Files:**
- Create: `api/src/serversherpa/labels/builtin_templates.py` (the five v2 designs as Python dicts: `VEGAS_DESTINATION` from `fixtures/vegas_v2.json`, `AMSTERDAM_DESTINATION`, `GENERIC_RACK_AND_RU`, `FRONT_ASSET_TAG`, `SWITCH_FRONT_TAG`, each with samples), `api/src/serversherpa/cli.py` command `seed-label-templates` (creates each as an **inactive** parent + children when no parent of that name exists; idempotent), `api/tests/test_builtin_templates.py`, `kiosk_laptop/edge/tests/test_vegas_parity.py`
- Modify: `docs/superpowers/specs/2026-10-19-label-builder-design.md` §4.11 (add the operator steps: seed, physical print on the ZD421, Replace)

- [ ] **Step 1:** Failing tests: every built-in parses as v2 and compiles at 203/300/600 without warnings except the documented QR cap at 600; the Vegas template rendered by the portal path (`render_template` with `field_values(asset_payload(...))`) equals the edge path (`generate.render_job` from the sync item) byte for byte for three seeded assets; the seed command creates five inactive parents with children and is idempotent.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(labels): the five label templates rebuilt as v2 designs; seed command; parity fixture`.
