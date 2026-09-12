# Container Labels — V3 port of V2's `/labels/containers` (PDF must match V2 exactly)

**Date:** 2026-09-12 · **Status:** approved by standing instruction (copy V2 functionality, V3 UI/UX; the generated PDF must be exactly what V2 generates) · **Branch:** `container-labels`

## What V2 does (all preserved)

Page `portal-v2/src/pages/ContainerLabels.jsx`: pick a move (finished/archived hidden, newest first; summary shows project + container count) → the move's containers (V2 `containers.move_id`) in a table (checkbox, name, type, device count, status chip, per-row **Tag** select: None / Priority / Vendor / Accessories / E-Waste / Warehouse) with search (name/type), select-all over the filtered rows, and a bulk "Set tag" row of buttons for the selected containers → **Generate** builds the PDF in the browser with jsPDF 3 + bwip-js 4 and downloads `Container-Labels-<move name>.pdf`.

PDF (`AVERY_5164`: Letter portrait, 4" × 3.333" labels, 2 × 3 per sheet, marginTop 0.5, marginLeft 0.156, gapX 0.188, gapY 0): **one sheet per container**. Labels 1–5: optional tag image (3.6" wide, 3.6/3.1 tall, centered) + Code 128 barcode of the container name (bwip-js `code128`, scale 3, height 15, no text; drawn 0.6 × label width by 0.7" tall, centered) + the name in Helvetica bold starting at 42 pt and shrinking by 1 pt down to 8 pt until it fits 90% of the label width, drawn `baseline: 'bottom'` — the stack (tag + 0.25 gap, barcode + 0.25 gap, name height = pt/72) is centered vertically in `labelHeight − 0.25`; the move name in 8 pt normal centered 0.1" above the label's bottom edge. Label 6: QR of the name (bwip-js `qrcode`, scale 5, width/height 25, `barcolor` = the tag's qrColor or `000000`) 1" square at top-right inside a 0.25" padding; left column of `Source:` / `Dest:` / `Date:` / `Container:` in 12 pt bold with the value on the next line in normal weight indented 0.2" (cursor steps 0.2 then 0.25; values truncated with "..." to fit up to 0.1" before the QR); a dashed (`[0.1, 0.05]`) grey (150) rule 0.3" above and 0.15" below the centered 11 pt text `RFID TAG HERE` placed 0.35" above the bottom edge, rule width 70% of the label. Move fields: source/destination site names ("N/A" fallback), date = `toLocaleDateString()` of `scheduled_start` ("N/A"), move name fallback `Move #<id>`, container name fallback `Container <id>`. Tag definitions (color, qrColor, image): priority `#f5222d`/`CC0000`, vendor `#1890ff`/`1890ff`, accessories `#722ed1`/`722ed1`, ewaste `#fa8c16`/`e08200`, warehouse `#d4b106`/`b89e00`; images `public/images/{priority,vendor,accessories,e-waste,warehouse}-tag.png` (copied verbatim from V2).

## V3 design

### Data: containers get an initiative (migration 0057, `down_revision = "0056"`)

- `containers.initiative_id uuid NULL` FK `initiatives.id` + index. `ContainerItem` gains `initiative_id`, `initiative_name`; create/update accept `initiative_id` (404 `initiative_not_found` when unknown; clearing allowed); `GET /containers?initiative_id=` filters; `GET /initiatives/{id}/containers` is NOT added (the filter is enough). Container edit modal and detail get an **Initiative** ComboBox (initiatives, newest first, finished ones still selectable); the containers list gets an Initiative column (hidden by default) and facet. Bulk import gains an optional `initiative` column matched by name (unknown → row error) — only if the importer's column machinery makes that a small change; otherwise deferred and noted.
- Migration also seeds the system report definition **"Container Labels"** (`report_type = "container_labels"`, options `{}`), like 0054 did.

### The PDF module — one implementation, two runtimes

- `portal/src/labels/containerLabelSheet.ts`: a line-for-line TypeScript port of V2's `handleGenerate` drawing code, as a pure function `buildContainerLabelPdf(input, adapters) -> jsPDF` where `input = { move: { id, name, sourceSite, destSite, scheduledStart }, containers: [{ id, name, tag: TagKey | null }], tagImages: Record<TagKey, dataUrl> }` and `adapters = { barcode(text) -> dataUrl, qr(text, color) -> dataUrl }`. Constants `AVERY_5164`, `TAG_TYPES` exported. The same jsPDF (`^3.0.4`) and bwip-js (`^4.8.0`) majors as V2 are added to `portal/package.json`. Browser adapters use `bwipjs.toCanvas` + `canvas.toDataURL` (V2's code); Node adapters use `bwipjs.toBuffer` (pure JS PNG) → base64 data URL. Tag PNGs live in `portal/public/images/` (browser loads them via `<img>` → canvas data URL as V2 did; Node reads the files from disk).
- **Exactness proof** (test): the test file embeds V2's original drawing routine verbatim (JS, adapted only to take the same input) and runs BOTH implementations against a recording fake `jsPDF` (every method call with args appended to a log) for several inputs (no tag / each tag / long name that shrinks / names needing truncation / unscheduled move / many containers); the logs must be identical. Plus a real-jsPDF smoke test: N containers → N pages, output starts with `%PDF`, contains the container names and `RFID TAG HERE`.
- Node entry `portal/src/labels/renderContainerLabels.ts` (stdin JSON `{move, containers, tagImages}` → stdout base64 PDF), bundled by `vite.container-labels.config.ts` into `portal/dist-node/render-container-labels.js` (`npm run build:container-labels`, added to `npm run build` like the rack renderer; `dist-node` stays gitignored).

### Report module `api/src/serversherpa/reports/container_labels/`

- `report_type = "container_labels"`; run options `{ container_ids: [uuid…] (≥1), tags: { container_id: TagKey } }` validated (`validate_run_options`; unknown tag key → problem; every id must belong to the run's initiative → `container_not_on_initiative`); definition options `{}`.
- `gather`: initiative (name, scheduled_start, origin/destination site names), the containers in the given order; `build`: JSON → `container_label_renderer.render(payload)` (subprocess of `report_node_bin` on `dist-node/render-container-labels.js`, mirroring `rack_renderer.py` incl. the missing-bundle error) → PDF bytes → `ReportResult(content, "Container Labels - {initiative} - {stamp}.pdf", "application/pdf")`. Tag images are read by the Node side from `portal/public/images` (path passed in the payload), so the API needs no image copies.
- Registered in the registry; runs through the existing report worker (attachment on the initiative + inbox), so any surface can queue container labels.

### Portal

- New page `/labels/containers` ("Container Labels", nav under Labels after Generate Labels; `labelsNav.test` order updated): roomy header (eyebrow Labels / title / description "Avery 5164 sheets: one page per container with five barcode labels and one QR info label."); **Step 1 · Initiative** card (picker with `InitiativeSummary`, container count); **Step 2 · Containers** card: standard directory list of the initiative's containers — checkbox column with select-all over the filtered rows, `.dir-search` (name/type), columns Name / Type / Assets / Status chip / **Tag** (a compact `.segmented`-style tag picker or ComboBox per row, colored chip when set), selection count, and a bulk **Set tag** `.segmented` for the selected rows (None … Warehouse); **Step 3 · Generate** card: summary (containers selected, tags in use, sheets = selected count) and two actions: **Download PDF** (browser-side, instant, exact V2 behavior, filename `Container-Labels-<initiative name>.pdf`) and **Generate as report** (queues the report run; progress + attachment via the existing report history/inbox; disabled hint when the definition is missing).
- Reports › Available lists "Container Labels"; its Generate modal uses a `ContainerLabelsOptions` step that reuses the page's container list + tag controls (so Reports users get the same flow).
- Container edit modal: Initiative field. Containers list: Initiative column/facet.

### Testing

- API: migration (column, seed, single head 0057), containers API `initiative_id` round trip + filter + 404, run option validation, gather order, build with a stub renderer (payload shape incl. tags and image dir) and the real bundle when present (skipped if `dist-node` is absent), worker stores the PDF.
- Portal: the exactness log test; real jsPDF smoke; page tests (picker filter, list select-all over filtered rows, per-row and bulk tags, download calls `save` with the right name, report queue posts `{container_ids, tags}`); ContainerLabelsOptions in the Generate modal; edit modal initiative field; nav order; guardrail green.
- Live: assign two containers to the NAP11 demo, download the PDF from the page and open it; queue the report and confirm the worker attaches the same PDF.

## Deliberate differences from V2

- The same drawing code also runs server-side (report run) so other surfaces can request the PDF; the browser download stays the primary, instant path.
- Containers link to an initiative explicitly (`containers.initiative_id`), as V2's `move_id` did; V3 had no link before.
- Tag choices remain per-generation (not stored), as in V2.

## Out of scope

Storing tags on containers; ZPL container labels through the label worker (the `container` label type exists; wiring it into Generate Labels is a follow-up); RFID encoding.

## Addendum 2026-09-12 — the label tag lives on the container

Jimmy: the tag chosen per container (Priority / Vendor / Accessories / E-Waste / Warehouse) should be read from the container and saved back to it when changed, so the Container Labels page is no longer the only place that knows it.

- **Data (migration 0058, `down_revision = "0057"`):** `containers.label_tag text NULL` with a CHECK constraint on the five keys (`priority, vendor, accessories, ewaste, warehouse`). `ContainerItem.label_tag: TagKey | None`; create/update accept `label_tag` (null clears; anything else → 422 `bad_label_tag`). Bulk import: optional `label tag` column mapped by key or label (unknown → row error) if the importer's column machinery makes it small; otherwise deferred and noted.
- **Container Labels page:** the pick list's tag column shows each container's stored `label_tag`. Changing a tag (per row or bulk Set tag) PATCHes the container immediately (`{label_tag}`) — optimistic update, error strip + revert on failure — so the next visit, the report run, and the containers page all agree. The run options still carry `tags` (explicit per-run values), built from the stored tags at generate time.
- **/logistics/containers:** list gets a "Label tag" column (colored `chip custom` with the tag's color, hidden by default? — no: visible by default, it is operational) and a facet; the edit modal gets a **Label tag** control (a `.segmented`-style picker or ComboBox over the five keys + None, colored chip preview); the detail block shows it. `TAG_TYPES` in `portal/src/labels/containerLabelSheet.ts` stays the single source of labels/colors; the portal exports a `LABEL_TAG_OPTIONS` helper from it for pickers.
- **API tests:** migration/CHECK, create/patch/clear/422, list shows it. **Portal tests:** page initializes tags from containers and PATCHes on change (row + bulk), reverts on failure; edit modal round trip; list column/facet; detail row.
