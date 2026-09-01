# Labels — nav section, template system, and GUI label builder

**Date:** 2026-09-01
**Branch:** `labels`
**Status:** Approved design

## Purpose

BaseCampV3 needs to design, manage, and eventually generate and print physical
labels (asset tags, container labels, rail labels, ID badges) on Zebra (ZPL)
and Brother (ESC/P and P-Touch Template) printers. BasecampV2 did this with a
raw-ZPL `label_templates` table, a polling `label_generator.py` worker that
string-replaced `{placeholders}` into pre-baked `label_info` JSON, and a set of
portal pages. V3 rebuilds this properly: templates are structured designs
edited in a GUI builder, compiled to printer code by one server-side compiler
library, and (in a later phase) pre-generated in bulk for offline printing.

This branch delivers: the Labels nav section with placeholder pages, the
Templates page, the on-screen editor with GUI label builder, the label
vocabularies and placeholder catalog (managed from the Variables dev screen),
and the API module with compilers. Bulk generation and printing are later
phases, but their architecture is fixed here.

## Decisions made during brainstorming

- **Nav:** three items — Print Labels, Templates, Generate Labels. The editor
  is reached from the Templates page, not the nav.
- **Builder v1 elements:** text with inline variables, barcodes (Code 128 /
  Code 39) and QR codes, lines and boxes. No images/logos yet.
- **Preview:** the builder canvas is the live WYSIWYG preview; ZPL can
  additionally be rendered printer-accurately via the Labelary API (proxied
  through our API). Brother preview is canvas-only.
- **Storage:** GUI templates store element-model JSON (source of truth) and
  compile on demand; a separate raw-code template kind holds pasted
  ZPL/Brother source with `{placeholders}` (covers V2 templates).
- **Vocabularies:** label types, sizes, DPIs, and printer languages are all
  DB-driven rows managed in a new Labels tab on the Variables dev screen.
- **Placeholder catalog:** DB-driven, per label type, managed in the same tab.
- **Codegen scope this phase:** ZPL complete (all element types, both DPIs);
  Brother ESC/P and P-Touch get a working text+barcode first pass, refined
  when hardware is available.
- **Compilers live in the API** as a pure-function library. No new worker in
  this phase.
- **Bulk generation (later phase) is a worker**, not on-demand: the printing
  flow downloads pre-generated labels into a browser-side cache (IndexedDB)
  so printing works without internet, and runs can span 3 labels × 10,000+
  assets. The `label-service` worker follows the log-service heartbeat
  pattern (`api/src/serversherpa/system/log_service.py`) and appears on
  System → Processes. It is job-driven (generation runs) plus regeneration on
  watched-data changes — fixing V2's staleness problem rather than
  recreating it.

## Part 1 — Navigation, routes, access

New section in `portal/src/layout/navSections.tsx`, inserted between
**Stakeholders** and **Scanning Hardware**:

| Label | Route | This phase |
|---|---|---|
| Print Labels | `/labels/print` | Placeholder page |
| Templates | `/labels/templates` | Full implementation |
| Generate Labels | `/labels/generate` | Placeholder page |

- All three items use a new access-control resource `labels`, registered the
  same way `scanning_hardware` is.
- Editor routes (not in nav): `/labels/templates/new` and
  `/labels/templates/:id/edit`.
- Placeholders reuse `portal/src/pages/Placeholder.tsx`.
- Nav-position test mirrors `scanningHardwareNav.test.tsx`.

## Part 2 — Data model (Alembic migrations)

### `label_vocab`

One table for all four dropdown vocabularies, discriminated by `kind`:

- `id` PK, `kind` (`type` | `size` | `dpi` | `language`), `key` (unique per
  kind), `label`, `description`, `meta JSONB`, `sort_order`, `is_active`,
  timestamps.
- `meta` per kind — sizes: `{width_in, height_in, has_tab}`; dpis: `{dots}`;
  languages: `{family: "zebra" | "brother"}`; types: `{}`.

Seed rows:

- **Types:** Top Label, Front Label, Rail Label, Container Label.
- **Sizes:** 4x2, 2x1, 4x3 (w/tab, `has_tab: true`), 1x1, 6x4, ID Badge.
- **DPIs:** 203, 300.
- **Languages:** ZPL (zebra), ESC/P (brother), P-Touch Template (brother).

Codegen keys off well-known `key` values (`zpl`, `escp`, `ptouch`; DPI
`dots`); the vocab rows control what the UI offers. Deactivating a row hides
it from new-template dropdowns but never breaks existing templates.

### `label_placeholders`

- `id` PK, `key` (unique), `label`, `description`, `sample_value`,
  `applies_to` (array of label-type keys), `sort_order`, `is_active`,
  timestamps.
- Seeded from V2's field mapping (`helper_scripts/label_generator.py`
  `build_label_field_values`): asset id, asset name, serial number, make,
  model, make_model, source raw/RU/site, destination raw/RU/site, move name,
  move date — plus container fields (container name/id) for the Container
  type. One canonical key each (V2's alias explosion is not carried over).
- `sample_value` drives editor previews and compile sample mode.

### `label_templates`

- `id` PK, `name`, `description`, `label_type` (vocab type key), `size_key`,
  `dpi_key`, `language_key`, `kind` (`design` | `code`), `design JSONB`
  (element model; null when `kind = code`), `code TEXT` (raw source with
  `{placeholders}`; null when `kind = design`), `version` (int, starts 1,
  bumped on every update), `is_active`, `created_by`, timestamps.
- Delete is deactivation. Mutations write to the existing audit log.
- No site scoping (V2's CSV `sites` column is dropped; add a proper join
  later if a real need appears).

### `generated_labels` (designed now, migrated in the Generate phase)

- Entity ref (asset/container), label type key, template id + version,
  language key, dpi key, compiled code, `generated_at`, `stale` flag.
- Written by the future `label-service` worker; bulk-downloaded by the print
  page into IndexedDB.

### Element model (the `design` JSON)

Device-independent **inches** so one design compiles to 203 or 300 DPI:

```json
{
  "size": { "w": 4.0, "h": 2.0 },
  "elements": [
    { "id": "e1", "type": "text", "x": 0.1, "y": 0.1, "w": 2.0, "h": 0.3,
      "rotation": 0, "content": "SN: {serial_number}", "fontSizePt": 10,
      "bold": false, "align": "left" },
    { "id": "e2", "type": "barcode", "x": 0.1, "y": 0.6, "w": 3.0, "h": 0.8,
      "rotation": 0, "symbology": "code128", "data": "{asset_id}",
      "showText": true },
    { "id": "e3", "type": "qr", "x": 3.2, "y": 0.2, "w": 0.7, "h": 0.7,
      "data": "{asset_id}" },
    { "id": "e4", "type": "line", "x": 0, "y": 0.5, "w": 4.0, "h": 0,
      "strokeIn": 0.01 },
    { "id": "e5", "type": "box", "x": 0.05, "y": 0.05, "w": 3.9, "h": 1.9,
      "strokeIn": 0.02 }
  ]
}
```

- `rotation` ∈ {0, 90, 180, 270}.
- `data`/`content` may mix literals and `{placeholder}` tokens.
- Barcode symbologies v1: `code128`, `code39`.

## Part 3 — API module (`api/src/serversherpa/labels/`)

Structured like the existing domain modules: SQLAlchemy models, Pydantic
schemas, FastAPI router registered alongside the others, service layer,
tests.

### Endpoints

All behind the `labels` resource; vocab and placeholder mutations are
god-gated to match the rest of the Variables surface.

- `GET /labels/vocab?kind=` / `POST /labels/vocab` / `PATCH /labels/vocab/{id}`
  — includes usage counts (templates referencing each key) so deactivating an
  in-use value is visible.
- `GET /labels/placeholders` / `POST` / `PATCH /labels/placeholders/{id}`.
- `GET /labels/templates` (filters: type, size, language, dpi, active,
  search) / `GET /labels/templates/{id}` / `POST` / `PATCH` (bumps version) /
  `DELETE` (deactivates).
- `POST /labels/templates/compile` — body: either element JSON (`design`
  kind) or raw code (`code` kind), plus size/dpi/language keys and mode.
  Modes: `placeholders` (emit `{key}` tokens inline — the form stored and
  later fed to generation; for raw code this is the identity) and `sample`
  (substitute each placeholder's `sample_value` — used by the editor code
  panel and Labelary preview). Returns `{ code }`. Validation errors return
  per-element messages.
- `POST /labels/preview/zpl` — Labelary proxy: ZPL + size + dpi in, rendered
  PNG out. The portal never calls Labelary directly (no CORS, no client-side
  external dependency). Failures degrade gracefully (editor shows
  "printer preview unavailable"; canvas preview is unaffected).

### Compiler package (`labels/compilers/`)

Pure functions, no DB access — shared by the compile endpoint now and the
generation worker later.

- `model.py` — parse/validate element JSON into typed dataclasses; the single
  validator every compiler consumes.
- `zpl.py` — complete v1: `^XA`/`^XZ`, `^PW`/`^LL` from size × DPI, text via
  `^A0` + `^FO` + `^FD` with rotation, `^BC` (Code 128), `^B3` (Code 39),
  `^BQ` (QR), `^GB` boxes and lines; ZPL control characters (`^ ~`) escaped
  in literal text while `{placeholder}` tokens pass through untouched in
  placeholders mode.
- `brother_escp.py`, `brother_ptouch.py` — first pass: text + barcodes,
  documented as approximate until verified against hardware.

### API tests

- Golden-file compiler tests: element JSON in → exact code out, per language,
  at both DPIs, both modes.
- Endpoint tests following existing module patterns (auth gating, CRUD,
  version bump on update, filter behavior, compile validation errors).

## Part 4 — Portal UI

### Templates list (`/labels/templates`)

Standard directory-list pattern (as in `pages/Sites.tsx` / `pages/Variables.tsx`):
search, facets (type, size, language, DPI, active), column picker, CSV
export, read-only row expansion showing a template summary card, Edit button.
**New template** asks design vs. raw-code kind, then routes to the editor.

### Editor (`/labels/templates/new`, `/labels/templates/:id/edit`)

Full-page builder:

- **Top bar:** template name, type/size/DPI/language selectors (vocab-driven),
  Save, dirty indicator. Changing size redraws the canvas outline; changing
  DPI/language only changes compilation.
- **Left rail:** element palette (Text, Barcode, QR, Line, Box) and a layers
  list with reorder and delete.
- **Canvas:** SVG-rendered WYSIWYG at zoom. Label outline from the selected
  size (4x3 draws its tab), drag/resize handles, snap grid, arrow-key nudge,
  click-select. Undo/redo via an in-page history stack over the element
  model.
- **Properties panel:** numeric x/y/w/h/rotation plus per-type props for the
  selection. Text content and barcode/QR data fields get a placeholder picker
  filtered to the template's label type, showing label + sample value.
- **Code panel (collapsible):** debounced `compile` (sample mode) output,
  read-only for design templates. For ZPL, a **Printer preview** button
  fetches the Labelary PNG and shows it beside the canvas.
- **Raw-code kind:** same page, mono-font textarea instead of canvas/palette,
  placeholder-insert helper, same Labelary preview for ZPL.

Page-local state like the rest of the portal; API client functions added to
`portal/src/lib/api.ts`.

### Variables dev screen

Fifth tab **Labels** in `pages/Variables.tsx` with an inner segmented
control: **Types / Sizes / DPI / Languages / Placeholders**. Each pane is the
existing list-plus-edit-modal pattern (per-pane facets/columns, usage counts,
active toggles), with edit modals following `StatusEditModal` and friends.

### Portal tests

- Nav test: Labels section exists, sits between Stakeholders and Scanning
  Hardware, correct items/resources.
- Variables Labels-tab test (tab renders, panes switch).
- Element-model reducer tests (add/move/resize/delete, undo/redo).
- Editor smoke test with compile endpoint mocked.

## Out of scope (later phases)

- **Generate Labels page + `label-service` worker:** job-driven bulk
  generation into `generated_labels`, regeneration on data change, heartbeat
  on System → Processes.
- **Print Labels page:** bulk-download generated labels to IndexedDB;
  offline printing flow; printer discovery/queues.
- **Images/logos in templates**, additional barcode symbologies.
- **Refined Brother codegen** verified against real hardware.
- **Template site scoping**, if ever needed.

## Error handling summary

- Compile validation errors are per-element and surfaced inline in the editor.
- Labelary proxy failure degrades to canvas-only preview with a notice.
- Deactivated vocab values stay valid on existing templates; usage counts
  warn before deactivation.
- Raw-code templates are compiled only by placeholder substitution; unknown
  `{tokens}` are left intact at compile time and resolve to empty at
  generation time (logged), matching V2 behavior without the quote-variant
  explosion.
