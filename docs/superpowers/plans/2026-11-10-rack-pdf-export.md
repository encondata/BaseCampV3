# Rack diagram Export PDF — plan

Spec: agreed with Jimmy in chat on 2026-11-10 (Harbor Master SS-475, sheet To-Do #21). No separate spec file — the decisions are copied verbatim below.

## Global Constraints

- The rack popup (`portal/src/components/initiatives/RackViewModal.tsx`) gets an **Export PDF** button beside the existing **Print layout** button. Print layout stays exactly as it is.
- Clicking Export PDF **downloads a PDF file straight away** — no print dialog, no new tab.
- The PDF holds **the same sheet Print layout produces** (`portal/src/lib/rackPrint.ts` `buildRackPrintHtml`): the heading `Rack <rack> — <Source|Destination>`, every elevation frame shown on screen (FRONT, FRONT · NODES, REAR, REAR · NODES) captioned with its heading when there is more than one frame, the device list beside the elevations (group headings when grouped, category swatch, name, make/model, RU text, child indent, `! ` prefix for orphans), and the legend (each category swatch + Verified + Planned). One page, fitting both Letter and A4 (content 7.2in wide, at most 9.3in tall, 0.5in+ margins), like the print sheet.
- File name: `<Move name> - <Rack name> (<Source|Destination>).pdf`, e.g. `NAP11 Migration - A1 (Source).pdf`. Characters a file name can't hold (`/ \ : * ? " < > |` and control characters) become `-`. Trim surrounding whitespace on each part.
- Built in the browser: jsPDF (already a dependency, `jspdf` ^3.0.4) plus **svg2pdf.js pinned to exactly `2.8.1`** (new dependency, MIT). Rack drawings stay vector, text stays selectable. **No server changes.**
- The popup opens from two places and both must pass the move name: `portal/src/pages/InitiativeDetail.tsx` (~line 1348, the initiative's name) and `portal/src/pages/MoveDashboard.tsx` (~line 591, the move's name).
- Rack line-work styles (`.rack-post`, `.rack-cap`, `.rack-interior`, `.rack-u-hairline`, `.rack-u-label`, `.rack-block-label`, `.rack-faceplate-ghost`, `.rack-empty-label`) currently live only as CSS text in rackPrint.ts `SHEET_CSS`. The PDF must draw them identically; do not hand-copy the values into a second place — make one source both use.
- American English in all copy and comments. Every new screen state follows the existing `mini-btn` look; no new styling idioms.

## Task 1: Export PDF button

**Files:**
- `portal/package.json` / `package-lock.json`: add `"svg2pdf.js": "2.8.1"` (exact). Run `npm install` inside this worktree's `portal/` (its own node_modules — do NOT symlink to the main checkout's).
- New `portal/src/lib/rackPdf.ts`:
  - `rackPdfFileName(moveName: string, rackName: string, sideLabel: string): string` — the file-name rule above. An empty/blank move name falls back to `Move`.
  - `exportRackPdf(input)` — input mirrors `buildRackPrintHtml`'s (`rackName`, `sideLabel`, `frames`, `listRows`, `grouped`, `legend`) but frames carry the live `SVGSVGElement` (plus heading) instead of outerHTML, and adds `moveName`. Load `jspdf` and `svg2pdf.js` with dynamic `import()` so they stay out of the main bundle. Clone each SVG, apply the shared rack line-work styles as presentation attributes on the clone (svg2pdf does not see app CSS), draw with `doc.svg(clone, { x, y, width, height })`, draw heading/captions/list/legend with jsPDF text and rects (Courier family, matching the print sheet's monospace), then `doc.save(rackPdfFileName(...))`.
  - Keep the layout math (positions/sizes for heading, frames, list rows, legend, the scale-to-fit) in a pure, exported function so it is unit-testable without jsPDF.
- `portal/src/lib/rackPrint.ts`: move the rack line-work rules into one exported structure that both `SHEET_CSS` (generated text, same output as today) and rackPdf.ts use.
- `portal/src/components/initiatives/RackViewModal.tsx`: new required prop `moveName: string`. Add `Export PDF` button (`mini-btn`, beside Print layout). It reads frames from the rendered DOM the same way `handlePrint` does. While running, the button is disabled and reads `Exporting…`. If the export throws, show a one-line `role="alert"` message in the footer: `Couldn't make the PDF. Use Print layout instead.`
- Both callers pass the move name.

**Tests (vitest, `cd portal && npx vitest run <files>`):**
- `rackPdf.test.ts`: file name for a normal case (`NAP11 Migration`, `A1`, `Source` → `NAP11 Migration - A1 (Source).pdf`), each illegal character replaced, blank move name → `Move - …`, whitespace trimmed; layout function keeps everything inside 7.2in × 9.3in and scales down a tall list.
- `rackPrint.test.ts` keeps passing unchanged (SHEET_CSS output identical).
- RackViewModal tests: Export PDF button renders; clicking it calls the exporter (mock `../../lib/rackPdf`) with the move name, rack, side label and the frames; the button shows `Exporting…` while pending; a rejected export shows the alert.
- Update existing RackViewModal / InitiativeDetail / MoveDashboard tests for the new prop.

**Done when:** targeted tests pass, then the full portal suite (`cd portal && npm test`, FOREGROUND, timeout 600000 ms) and `npm run build` pass. Also produce a real PDF once from a small Node/vitest harness or by hand and render it with `pdftoppm -png -r 80` to confirm the frames, list and legend all appear on one page — attach the PNG path in the report.
