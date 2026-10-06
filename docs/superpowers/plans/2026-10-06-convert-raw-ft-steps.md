# Convert Raw F-T (rename + three steps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the Bulk Actions tool to "Convert Raw F-T" at `/bulk/convert-raw-ft`, and turn its single long page into three wizard steps with the template-columns guide in an always-collapsed panel.

**Architecture:** Move the pane's state and actions into a `useRawFtConvert` hook; render three presentational step components under the shared `WizardHeader` / `WizardFooter`; `lib/ftConvert.ts` is untouched.

**Tech Stack:** React + TypeScript, vitest/testing-library, SheetJS (existing).

Spec: `docs/superpowers/specs/2026-10-06-convert-raw-ft-steps-design.md` (binding copy and step table). The 2026-10-05 spec's reading/suggestion/output rules still apply.

## Global Constraints

- Name `Convert Raw F-T`; card description `Upload a customer's raw F-T, match its columns to ours, and download a file ready for the From-To import.`; card key `convert-raw-ft`; route `/bulk/convert-raw-ft` with `<ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}>`; card `resource: 'initiatives', action: 'change'`, button `Open`. Old route `/bulk/from-to-convert` removed, no redirect.
- Steps (key / label / title / description) exactly as the spec's table.
- Step chrome: `components/common/WizardHeader` and `components/common/WizardFooter` (as `pages/BulkNewMove.tsx` uses them), inside `<div className="portal-page">` with the steps in `<div className="wiz-body">`.
- Template columns guide: `CollapsePanel` (uncontrolled, `defaultOpen` false — NOT `useListCollapse`), title `Our template columns`, badge `<span className="badge-count">{n}</span>`.
- Behavior of reading, suggestions, matching, preview, download (incl. `XLSX.writeFile(..., { compression: true })`) is unchanged; existing assertions about it move with the code.
- Reuse portal idioms; no native `<select>` for data; no new `*-head` CSS selectors; no `localeCompare` / bare `.sort()`.
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.
- Portal checks from `portal/`, foreground: `npx vitest run <files>`, full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: `useRawFtConvert` hook + step components (no page change yet)

**Files:**
- Create: `portal/src/components/bulk/rawFt/useRawFtConvert.ts`
- Create: `portal/src/components/bulk/rawFt/steps.ts` (`RAW_FT_STEPS`)
- Create: `portal/src/components/bulk/rawFt/UploadStep.tsx`, `MatchStep.tsx`, `DownloadStep.tsx`
- Create: `portal/src/components/bulk/rawFt/useRawFtConvert.test.tsx`
- Modify: `portal/src/components/bulk/FromToConvert.tsx` (temporarily re-composed from the hook + the three step components, rendering all three in sequence, so its existing tests stay green and prove the extraction)

**Interfaces (Produces):**
- `RAW_FT_STEPS: readonly { key: 'upload' | 'match' | 'download'; label: string; title: string; description: string }[]` — values verbatim from the spec table.
- `useRawFtConvert(template: MoveAssetTemplateColumn[])` returns `{ file, busy, error, sheets, sheet, sheetName, headerRow, headerText, rows, columns, mapping, suggested, conversion, matched, serialMatched, usedHeaders, previewColumns, inputRef, onFile(f: File | null): Promise<void>, pickSheet(name: string): void, changeHeaderRow(text: string): void, blurHeaderRow(): void, setTarget(index: number, header: string): void, clearAll(): void, useSuggestions(): void, download(): void, reset(): void }` — `reset()` clears the file and every derived state (same as `onFile(null)` plus clearing the file input's DOM value). Logic is moved verbatim from `FromToConvert.tsx` (readToken race guard, one-frame yield, header-row clamping, etc.).
- `UploadStep({ convert, template })`: drop zone, Reading/error lines, Sheet + Header row controls (when a sheet is loaded), the two template download mini buttons (calling `downloadMoveAssetTemplate('xlsx' | 'csv')`, with the BulkToolPage-style `Download failed — try again.` error on failure), the 20 MB note, and the collapsed `CollapsePanel` guide.
- `MatchStep({ convert, template })`: matched-count line + Clear all / Use suggestions, Serial note, Column matches table (ComboBox portal, Suggested chip) — markup moved from today's pane.
- `DownloadStep({ convert })`: Converted preview table, counts line, `Start over` mini button calling `convert.reset()` then an `onStartOver` prop (the page uses it to go to step 1), and the import hint line. (The Download button itself lives in the page's footer, calling `convert.download()`.)
- Each step takes `convert: ReturnType<typeof useRawFtConvert>`.

- [ ] **Step 1:** Write `useRawFtConvert.test.tsx` (renderHook, real SheetJS workbook as in `FromToConvert.test.tsx`): onFile loads the first data sheet with detected header row and suggestions; setTarget/clearAll/useSuggestions; reset clears file, sheets, mapping and suggested; download calls `XLSX.writeFile` with `{ compression: true }`. Run → FAIL.
- [ ] **Step 2:** Implement the hook, `steps.ts` and the three step components; re-compose `FromToConvert.tsx` from them (Upload + Match + Download rendered in order, plus a temporary `Download converted file` button so its existing tests keep passing unchanged). Run `npx vitest run src/components/bulk` → all pass, existing FromToConvert tests unchanged.
- [ ] **Step 3:** `npx tsc -b`. Commit `refactor(portal): split Convert From-To into a hook and step components`.

---

### Task 2: three-step page, rename, route, card; remove the old pane and page

**Files:**
- Create: `portal/src/pages/BulkConvertRawFt.tsx`, `portal/src/pages/BulkConvertRawFt.test.tsx`
- Delete: `portal/src/pages/BulkFromToConvert.tsx`, `portal/src/pages/BulkFromToConvert.test.tsx`, `portal/src/components/bulk/FromToConvert.tsx`
- Move/convert: `portal/src/components/bulk/FromToConvert.test.tsx` → `portal/src/components/bulk/rawFt/RawFtSteps.test.tsx` (its behavior cases re-targeted at the new page/steps)
- Modify: `portal/src/App.tsx` (route + import), `portal/src/pages/BulkActions.tsx` (card), `portal/src/pages/BulkActions.test.tsx`, `portal/src/styles/bulk.css` (only if needed), header comments in `lib/ftConvert.ts` and `components/FileDropzone.tsx` that name the old route/title

**Interfaces:** Consumes Task 1's hook, steps and components.

- [ ] **Step 1: Tests first.**
  - `BulkConvertRawFt.test.tsx` (mock `getMoveAssetTemplateColumns` / `downloadMoveAssetTemplate` like today's page test): loading line; 403 and generic error lines (existing copy); heading `Step 1 of 3 · Upload the raw F-T` with the step row (Upload / Match / Download); the `Our template columns` panel is collapsed (`aria-expanded="false"`, table hidden) and expands on click showing the guide row (e.g. `SN-1`); Next disabled before a file; template buttons call `downloadMoveAssetTemplate('xlsx')` / `('csv')`.
  - `RawFtSteps.test.tsx` (port every case from the old `FromToConvert.test.tsx`, driving the page through its steps with Next/Back): suggestions + Suggested chip on step 2; free-target rule; chip removal on change; Serial note; Next on step 2 disabled after Clear all; counts line and preview on step 3; footer `Download converted file` calls `XLSX.writeFile` with the workbook, `Acme FT-converted.xlsx` and `{ compression: true }`; Sheet ComboBox and Header row on step 1; Back from step 3 to 2 keeps a manual match; Start over returns to step 1 with no file.
  - `BulkActions.test.tsx`: the `Convert Raw F-T` card shows with initiatives:change and links to `/bulk/convert-raw-ft`.
  Run → FAIL.
- [ ] **Step 2: Implement** `BulkConvertRawFt.tsx`: fetch template columns once (same states/copy as today's page); `const [step, setStep] = useState(0)`; `<WizardHeader steps={RAW_FT_STEPS} current={step} title={meta.title} description={meta.description} />`; in `wiz-body` render the current step and a `WizardFooter`: step 0 `onNext` with `nextDisabled={!convert.sheet || convert.busy}`; step 1 `onBack` + `onNext` with `nextDisabled={convert.matched === 0}`; step 2 `onBack`, `nextLabel="Download converted file"`, `onNext={convert.download}`, `nextDisabled={convert.matched === 0}`, and `DownloadStep onStartOver={() => setStep(0)}`. While loading/failed, `wiz-body` shows only the status line. Header comment naming both specs. Card + route per the Global Constraints; remove the old route, page, pane and their tests; update stale header comments.
- [ ] **Step 3:** `npx vitest run src/components/bulk src/pages/BulkConvertRawFt.test.tsx src/pages/BulkActions.test.tsx src/lib/ftConvert.test.ts`, full `npx vitest run`, `npx tsc -b`, `npm run build` — all pass. `grep -rn "from-to-convert\|Convert a customer" portal/src` returns nothing.
- [ ] **Step 4:** Commit `feat(portal): Convert Raw F-T — three steps, collapsed template columns, /bulk/convert-raw-ft`.
