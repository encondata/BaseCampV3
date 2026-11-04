# Portal Printer Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the kiosk's printer tools to Labels › Printers in the portal: a
Mock-data test label, Factory Reset (logged on /audit, handing off to Full
Printer Setup), and damaged-font detection in Install Fonts. Print Labels
gets a link to Labels › Printers.

**Architecture:** There are two new `labels:view` API routes in
`routes/labels.py`. One fills a template with mock values, sharing one
helper with the kiosk's twin. The other writes an audit row for a reset.
On the portal, the kiosk's `FactoryResetModal` and its hook and wizard
additions are ported back, the alignment dialog gains a second choice, and
`fontStates` gains a `damaged` state.

**Tech Stack:** FastAPI + SQLAlchemy async + pytest (real Postgres), React 18 + TypeScript + vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-11-03-portal-printer-tools-design.md`.
Read it before any task. Its §-numbers are cited below.

## Global Constraints

- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/portal-printer-tools`, branch `portal-printer-tools`. `.env` and `portal/node_modules` are symlinks to the main checkout: never commit or delete them.
- **API tests:** run from `<worktree>/api` with
  `SS_TEST_DB=serversherpa_test_ppt PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest <files> -q`.
  Without `PYTHONPATH`, main's code runs and you get a false green.
- **Portal tests:** run from `<worktree>/portal` with `npx vitest run <files>`. The full gate is `npm test` (about 413 files) and then `npm run build`.
- **Foreground only.** Run every test or suite command in the foreground with a 600000 ms timeout. Never background a suite and end your turn "waiting".
- **Never commit** `api/src/serversherpa/_dev_reload.py`. If it changes, `git checkout -- api/src/serversherpa/_dev_reload.py`.
- **Copy:** American English. Reuse the kiosk's copy word for word wherever the spec says "the kiosk's".
- **Modals:**
  - Use the roomy header (`.eyebrow`, `h3`, `page-hint` description, `rgm-steps` when stepped), sized to content.
  - Corners stay rounded (`portal/src/styles/modalCorners.test.ts`).
  - Dropdowns portal out of `.modal-card` (`modalDropdowns.test.ts`).
  - Use the portal's ComboBox, segmented, ChoiceCard (`components/reports/ReportOptionsLayout`) and chips. No native `<select>`.
- **Modal-with-hook rule.** A component receiving `useZebraPrinter()`'s value keeps it in a ref (`printerRef.current = printer` in render) and keys its effects on `printer.connected`, never on `[printer]`.
- **Test labels carry no `^MM`.** Never call `withPrintMode` in the portal (spec decision 4).
- **Out of scope:** no change to kiosk, Android or iOS code, except Task 1's move of the kiosk route body into a shared helper with unchanged behavior.

## Review Focus

1. **A printer unplugged mid-reset.** The hook drops the handle and `ensureOpen` throws "Printer not connected". The dialog must show "Reconnect the printer to finish setup." with no Try again, and must never hang on "Working…". (Task 4 test)
2. **The picker has nothing to offer.** No active ZPL template, or the tree fails to load. The dialog says so and Print is disabled; nothing throws. (Task 5 test)
3. **Printer DPI unknown** (`identity` null) in mock mode. The DPI segmented control appears, and the printed version follows the picked DPI. (Task 5 test)
4. **A test-render that fails** (422 `template_unconvertible`, or a network error). It shows "Couldn't print the test label (<code>)." and caches nothing, so the next Print retries. (Task 5 test)
5. **A library font with nothing to compare.** That covers `size_bytes` 0, resident, and the builder dialog's size-less entries. It must never read Damaged. (Task 6 test)

---

### Task 1: Shared mock render + `POST /labels/test-render`

**Files:**
- Create: `api/src/serversherpa/labels/mock_render.py` (not `test_*`: pytest would collect it)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`_label_catalog_keys` ~L970, `MOCK_VALUES` / `mock_label_values` ~L1263, `kiosk_label_test_render` ~L1369)
- Modify: `api/src/serversherpa/api/routes/labels.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/deps.py` (`READ_ONLY_EXEMPT_PATHS` ~L138, `FORCED_CHANGE_EXEMPT_PATHS` ~L232)
- Test: `api/tests/test_labels_test_render_api.py` (new); `api/tests/test_kiosk_label_station_api.py` must still pass untouched

**Interfaces:**
- Produces, in `serversherpa.labels.mock_render`:
  - `async def label_catalog_keys(db: AsyncSession) -> list[str]` (moved from kiosk's `_label_catalog_keys`, same query);
  - `def mock_label_values(catalog_keys: list[str], generation_rules: dict | None) -> dict[str, str]` (moved verbatim);
  - `class MockRenderError(Exception)`;
  - `async def render_mock_label(db: AsyncSession, template: LabelTemplate) -> str`: the values branch (`design_schema >= 2` → `mock_field_values(...)`, else `mock_label_values(...)`), the size/DPI vocab lookup and `render_label`. It raises `MockRenderError` where the kiosk route raised `template_unconvertible`, and logs the same warning.
  - `kiosk.py` keeps the names `MOCK_VALUES`, `mock_label_values` and `_label_catalog_keys` as imports or aliases, because tests and other kiosk routes use them.
- Produces, over HTTP: `POST /labels/test-render`, body `LabelTestRenderIn{template_id: uuid.UUID, dpi_key: str}`, returning 200 `LabelTestRenderOut{zpl: str, template_name: str}`.

- [ ] **Step 1: Write the failing tests** in `test_labels_test_render_api.py`. Fixtures: `login` from `tests.test_sites_api`, `make_tree` from `tests.test_kiosk_label_templates_sync`, `_tpl` and `SIZE_META` patterns from `test_kiosk_label_station_api.py`; for a badge child, copy a badge design from `tests/test_label_people_badge.py`.
  - `test_code_template_renders_mock_values`: a code template `"^XA^FD{asset_name} {serial_number} {destination_ru}^FS^XZ"` (top, 4x2, 203, zpl, active) → 200 and `{"zpl": "^XA^FDSAMPLE-SERVER-01 SN0000001 U12^FS^XZ", "template_name": <name>}`.
  - `test_design_with_rules_matches_render_label`: the kiosk's `test_test_render_matches_render_label_with_rules` without the move → equals `render_label(tpl, expected_values, …)`.
  - `test_v2_child_uses_builder_mock_values`: a `make_tree(..., samples={"asset_id": "SAMPLE-ONLY-777"})` child at 203 → equals `render_template(child, values, width_in=4, height_in=2, dots=203)` as the kiosk's `test_test_render_handles_v2` builds it, and `"SAMPLE-ONLY" not in zpl`.
  - `test_badge_child_renders`: an `id_badge` tree child → 200, `"{" not in zpl`.
  - `test_refusals`: unknown id, inactive, `is_old=True` child, and a tree parent → each 404 `template_not_found`; `language_key="ptouch"` → 422 `not_zpl`; `dpi_key` "300" on a 203 row → 422 `dpi_mismatch`, with `template_dpi_key` "203" in the body, the way the kiosk returns it.
  - `test_unconvertible_is_422`: a design template whose `size_key` isn't in the vocab → 422 `template_unconvertible`.
  - `test_needs_labels_view`: a signed-in user without `labels:view` → 403. Use the permission pattern in `tests/test_label_fonts_api.py`.
  - `test_works_during_read_only_mode`: mirror the kiosk's `test_test_render_works_during_read_only_mode`.
- [ ] **Step 2: Run them and confirm they fail** (404 for the route): `… -m pytest tests/test_labels_test_render_api.py -q`.
- [ ] **Step 3: Create `mock_render.py` and point the kiosk route at it.** The kiosk route keeps its own move and template-set checks and its `dpi_mismatch`, then calls `render_mock_label`, mapping `MockRenderError` to 422 `template_unconvertible`.
- [ ] **Step 4: Add the schemas and the route** in `routes/labels.py`. Checks, in this order:
  1. The row exists, is active, isn't `is_old`, and isn't `is_tree_parent`; otherwise 404 `template_not_found`.
  2. `language_key == "zpl"`; otherwise 422 `not_zpl`.
  3. The DPI matches; otherwise 422 `dpi_mismatch` with `template_dpi_key`.
  4. Render; `MockRenderError` becomes 422 `template_unconvertible`.

  Gate it with `require_permission("labels", "view")`. Add `"/labels/test-render"` to `READ_ONLY_EXEMPT_PATHS` with a one-line comment, like the kiosk twin's, and to the `FORCED_CHANGE_EXEMPT_PATHS` subtraction beside `/labels/images/raster`.
- [ ] **Step 5: Run the new tests and the kiosk suite and confirm all pass:** `… -m pytest tests/test_labels_test_render_api.py tests/test_kiosk_label_station_api.py tests/test_kiosk_label_templates_sync.py -q`.
- [ ] **Step 6: Commit:** `feat(labels): POST /labels/test-render fills any active ZPL template with the kiosk's mock values (shared helper)`.

### Task 2: `POST /labels/printer-events`

**Files:**
- Modify: `api/src/serversherpa/api/routes/labels.py`, `api/src/serversherpa/api/schemas.py` (beside `KioskPrinterEventIn` ~L3936), `api/src/serversherpa/api/deps.py`
- Test: `api/tests/test_label_printer_events_api.py` (new, modeled on `tests/test_kiosk_printer_events_api.py`)

**Interfaces:**
- Produces: `POST /labels/printer-events`, body `LabelPrinterEventIn`, returning 204 with an empty body.
  - `event`: `Literal["factory_reset"]`.
  - `outcome`: `Literal["completed","failed"]`.
  - `printer_model`, `printer_firmware`, `printer_serial`: `str | None`, `max_length=120`.
  - `calibrated`: `bool = False`.
  - `failed_step`: `str | None`, `max_length=60`.
  - `error`: `str | None`, `max_length=500`.
- The audit row it writes: `entity_type="label_printer"`, `entity_id=printer_serial` (may be None), `action="printer_factory_reset"` (`f"printer_{event}"`), and `changes` holding only the non-null fields among outcome, printer_model, printer_firmware, printer_serial, calibrated, failed_step and error.

- [ ] **Step 1: Write the failing tests.**
  - `test_completed_reset_writes_one_audit_row`: posts a completed event with model `"ZD421-203dpi ZPL"`, firmware `"V92.21.16Z"`, serial `"D2J000001"` and `calibrated: True`. Expect 204 and exactly one row with action `printer_factory_reset`, entity_type `label_printer`, entity_id `"D2J000001"`, the actor's person id and that `changes`.
  - `test_failed_reset_carries_the_step_and_error`: `failed_step` `"restart"` and `error` `"The printer did not come back. Power-cycle it, reconnect, and try again."` are stored.
  - `test_null_fields_are_left_out`: with no serial, model or firmware, `entity_id is None` and none of those keys is in `changes`.
  - `test_needs_labels_view`: 403 without the permission.
  - `test_read_only_mode_still_accepts_the_report`: mirrors the kiosk test.
  - `test_the_row_shows_up_on_the_audit_page`: mirrors the kiosk test.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the schema and route**, the way `record_printer_event` in `routes/kiosk.py` does but without a device. Add the path to `READ_ONLY_EXEMPT_PATHS` and to the `FORCED_CHANGE_EXEMPT_PATHS` subtraction beside `/kiosk/printer-events`, with the same reason in the comment.
- [ ] **Step 4: Run the new tests and the kiosk printer-events tests and confirm they pass:** `… -m pytest tests/test_label_printer_events_api.py tests/test_kiosk_printer_events_api.py -q`.
- [ ] **Step 5: Commit:** `feat(labels): POST /labels/printer-events records a portal factory reset on /audit`.

### Task 3: Hook `ensureOpen` + wizard seed props

**Files:**
- Modify: `portal/src/labels/zebraUsb.ts` (`UsbDeviceLike` L21), `portal/src/lib/useZebraPrinter.ts`, `portal/src/components/printers/PrinterSetupModal.tsx`
- Test: `portal/src/lib/useZebraPrinter.test.tsx`, `portal/src/components/printers/PrinterSetupModal.test.tsx`

**Interfaces:**
- Produces: `UsbDeviceLike.serialNumber?: string` (readonly).
- `ZebraPrinter` gains `device?: UsbDeviceLike | null` and `ensureOpen(): Promise<void>`. Port both from `kiosk/src/lib/useZebraPrinter.ts`, which differs from the portal's only by these and the `mounted` guards. `ensureOpen` throws `Error('Printer not connected')` with no held device, and otherwise delegates to `zebraUsb.ensureOpen`.
- `PrinterSetupModal` gains the props `initialConfig?: PrinterConfiguration | null` and `intro?: string`, ported from `kiosk/src/components/printers/PrinterSetupModal.tsx`. With a seed it skips the read-on-mount and seeds media and quality from it; `intro` replaces the "Printers" eyebrow.

- [ ] **Step 1: Write the failing tests.**
  - In the hook test:
    - `ensureOpen rejects with "Printer not connected" before connect`.
    - `ensureOpen reopens and re-claims a device the browser closed`: connect, set the fake's `opened = false`, call `ensureOpen()`, and expect the open and claim calls again.
    - `a printer opened after unmount is closed, not adopted`: port the kiosk's `it.each(['connect','connectTo'])`, expecting `dev.log` to equal `['open','claim','release','close']`.
  - In the wizard test:
    - `a seeded configuration skips the read and starts from it`: `initialConfig` set means `printer.query` is never called with `^XA^HH^XZ` on mount, and the Media choices show the seeded print mode.
    - `intro replaces the eyebrow`: shows `"Printers · After factory reset"`.
- [ ] **Step 2: Run them and confirm they fail:** `npx vitest run src/lib/useZebraPrinter.test.tsx src/components/printers/PrinterSetupModal.test.tsx`.
- [ ] **Step 3: Port the hook additions and the wizard props** from the kiosk files named above.
- [ ] **Step 4: Run the same files plus `src/pages/Printers.test.tsx src/pages/PrintLabels.test.tsx src/pages/LabelBuilder.test.tsx` and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(printers): hook ensureOpen and device, unmount-safe open; setup wizard can start from a given configuration`.

### Task 4: Factory Reset dialog + Printers row + audit labels

**Files:**
- Create: `portal/src/components/printers/FactoryResetModal.tsx`, `portal/src/components/printers/FactoryResetModal.test.tsx`
- Modify: `portal/src/lib/api.ts` (beside `listLabelFonts` ~L5885), `portal/src/pages/Printers.tsx`, `portal/src/pages/Printers.test.tsx`, `portal/src/styles/printers.css`, `portal/src/lib/auditFormat.ts`, `portal/src/lib/auditFormat.test.ts`

**Interfaces:**
- Consumes: Task 3's `ZebraPrinter.ensureOpen`, `device`, and `PrinterSetupModal`'s `initialConfig` / `intro`. Task 2's route.
- Produces:
  - `export interface LabelPrinterEvent { event: 'factory_reset'; outcome: 'completed' | 'failed'; printer_model: string | null; printer_firmware: string | null; printer_serial: string | null; calibrated: boolean; failed_step: string | null; error: string | null }`.
  - `export async function postLabelPrinterEvent(body: LabelPrinterEvent): Promise<boolean>`, which never throws, like the kiosk's `postPrinterEvent`.
  - `FactoryResetModal` props `{ printer: ResetPrinter; identity: HostIdentification | null; onDone(config: PrinterConfiguration | null): void; onClose(): void }`, where `ResetPrinter = Pick<ZebraPrinter, 'send' | 'query' | 'identify' | 'waitForIdle' | 'ensureOpen' | 'productName' | 'device'>`.

- [ ] **Step 1: Port the kiosk's 13 FactoryResetModal tests** from `kiosk/src/components/printers/FactoryResetModal.test.tsx` into the new test file.
  - Mock `../../lib/api`'s `postLabelPrinterEvent` instead of `postPrinterEvent`.
  - Drop the identity mock.
  - The report test expects `{ event: 'factory_reset', outcome: 'completed', printer_model: 'ZD421-203dpi ZPL', printer_firmware: 'V92.21.16Z', printer_serial: 'D2J000001', calibrated: true, failed_step: null, error: null }`, with the fake printer's `device: { serialNumber: 'D2J000001' }`.
  - Add `an unplugged printer asks to reconnect and offers no Try again` (Review Focus 1): `ensureOpen` rejects with `Error('Printer not connected')`. Expect `"Reconnect the printer to finish setup."` and no "Try again" button.
- [ ] **Step 2: Write the Printers page and audit tests.**
  - Printers page:
    - `the Factory Reset row is last, gated on a connection, with the danger button` checks the title, `"Restore the printer's factory defaults, then set it up again."` and "Reset printer" with class `btn-danger`.
    - `a finished reset opens Full Printer Setup with the reset's configuration` checks that the setup dialog shows the eyebrow "Printers · After factory reset".
  - `auditFormat`: `actionLabel` gives `'Printer factory reset'` for `printer_factory_reset`, and `entityLabel` gives `'label printer'` for `label_printer`.
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement.**
  - Port `FactoryResetModal.tsx` from the kiosk file: same constants, steps, copy and footer order. The report is built from `identity` and `printer.device?.serialNumber ?? null`.
  - `Printers.tsx`: add `danger?: boolean` to `ZEBRA_TOOLS`, add the `reset` row, and add a `fromReset` state that hands off into `PrinterSetupModal`, as `kiosk/src/pages/PrinterTools.tsx` does.
  - `printers.css`: copy the `.zp-reset-card` width rule, `.zp-check`, `.zp-reset-steps`, `.zp-reset-step` (and `.is-pending`) and the `.btn-solid.btn-danger` re-assert from `kiosk/src/styles/kiosk.css` L833–862, minus the `.kiosk-shell` rules. Swap `var(--paper-line)` for whatever border token `printers.css` already uses.
  - `auditFormat.ts`: add both labels.
- [ ] **Step 5: Run the new and touched test files plus `src/styles/modalCorners.test.ts src/styles/roundedScrollbars.test.ts` and confirm they pass.**
- [ ] **Step 6: Commit:** `feat(printers): Factory Reset on Labels › Printers — the kiosk's reset, logged on /audit, then Full Printer Setup`.

### Task 5: Test labels dialog — Mock-data label

**Files:**
- Create: `portal/src/labels/testLabelTemplates.ts`, `portal/src/labels/testLabelTemplates.test.ts`
- Modify: `portal/src/components/printers/AlignmentTestModal.tsx`, `AlignmentTestModal.test.tsx`, `portal/src/lib/api.ts`, `portal/src/pages/Printers.tsx`, `Printers.test.tsx`, `portal/src/pages/PrintLabels.tsx`, `PrintLabels.test.tsx`

**Interfaces:**
- Consumes: Task 1's route; `listLabelTemplateTree()` (`lib/api.ts` ~L5704); `vocabOfKind(vocab, 'type')` and `isPersonLabelType` (`lib/labels.ts`).
- Produces:
  - `export async function renderTestLabel(templateId: string, dpiKey: string): Promise<{ zpl: string; template_name: string }>`, which throws `ApiError` via `errorFrom`.
  - In `testLabelTemplates.ts`:
    - `export interface MockTemplateOption { key: string; family: string; labelType: string; label: string; versions: Record<string, LabelTemplate> }`, where `versions` is keyed by `dpi_key`.
    - `export function mockTemplateOptions(tree: LabelTemplateTreeNode[], typeLabels: Record<string, string>): MockTemplateOption[]`:
      - printable rows are a node's `children` when it is a tree parent (`!parent_id && (schema_version ?? 1) >= 2`), else the node itself;
      - keep rows with `is_active && !is_old && language_key === 'zpl'`;
      - group by `family` + `label_type`, with `key = \`${family}|${labelType}\``;
      - `label = \`${family} · ${typeLabels[labelType] ?? labelType}\``;
      - natural-sort by label (`naturalCompare` from `lib/naturalSort`); groups with no row are dropped.
    - `export function versionAt(option: MockTemplateOption, dpiKey: string): LabelTemplate | null`.
    - `export function noVersionText(option: MockTemplateOption, dpiKey: string): string`, which returns `\`"${family}" is only available at ${dpis} DPI, so it can't print on this ${dpiKey} DPI printer.\``. `dpis` is the option's DPI keys, natural-sorted and joined with " or ".
  - `AlignmentTestModal` gains the props `loadTemplates: () => Promise<LabelTemplateTreeNode[]>` and `renderLabel: (templateId: string, dpiKey: string) => Promise<{ zpl: string; template_name: string }>`. `Printers.tsx` passes `listLabelTemplateTree` and `renderTestLabel`. The `alignmentLabelZpl` export stays exactly as it is (`BuilderPrinterModal` imports it).

- [ ] **Step 1: Write the `testLabelTemplates` tests.**
  - `groups by family and label type`: two label types sharing a family give two options, and the labels read `"Generic Rack and RU · Top"`.
  - `lists only active, current, ZPL printable rows`: inactive, `is_old`, `ptouch` and a childless tree parent are all dropped.
  - `a builder parent offers its DPI children`.
  - `versionAt picks the row at the DPI or null`.
  - `noVersionText` equals `'"Front Tag" is only available at 203 DPI, so it can\'t print on this 300 DPI printer.'`.
- [ ] **Step 2: Write the dialog tests.**
  - `the dialog is "Test labels" with Alignment label and Mock-data label choices`, using the kiosk's two card descriptions.
  - `alignment is unchanged`: the existing tests keep passing, renamed only where the dialog title changed.
  - `mock-data prints the picked template's version at the printer's DPI with the stored offsets and no ^MM`: `renderLabel` is called with (child id, "203"), and `onPrint` gets `applyPrintSettings(zpl, {...stored, verticalOffset, horizontalOffset}, { singleCopy: true })` with no `^MM` in it.
  - `Reprint reuses the rendered label`: `renderLabel` is called once for two prints.
  - `no version at the printer's DPI disables Print and says why`.
  - `no templates`: an empty tree, or `loadTemplates` rejecting, shows `"No active templates to print."` and Print is disabled (Review Focus 2).
  - `unknown printer DPI shows the DPI picker in mock mode and prints that DPI's version` (Review Focus 3).
  - `a failed render shows the code and caches nothing`: the first `renderLabel` rejects with `ApiError` code `template_unconvertible`. Expect `"Couldn't print the test label (template_unconvertible)."`, and a second Print calls `renderLabel` again (Review Focus 4).
  - `a badge says photos and logos print blank`: the preview line ends with `"Photos and logos print blank."`.
  - Success notice: `"Mock-data label (<template_name>) sent to the printer."`.
- [ ] **Step 3: Write the page tests.**
  - Printers: `the first row is "Test Labels"`, with description `"Print an alignment or sample-data label and dial in offsets."` and button "Print test label".
  - PrintLabels: `Step 3 links to Labels › Printers`, a link named "Printer tools" with `href` `/labels/printers`.
- [ ] **Step 4: Run them and confirm they fail.**
- [ ] **Step 5: Implement.**
  - Write `testLabelTemplates.ts` and `renderTestLabel`.
  - Dialog changes:
    - Header: eyebrow "Printers", h3 "Test labels", `aria-label="Test labels"`, and the spec §2 description.
    - A `ChoiceCard` radio group "Test label".
    - In mock mode, a template ComboBox. The tree is loaded once, on the first switch to mock.
    - The DPI segmented control shows in mock mode only when `printerDpi` is null.
    - The preview line reads `Prints ${row.name} at ${dpiKey} DPI with sample values, filled in by the portal.` and gets ` Photos and logos print blank.` added when `isPersonLabelType(labelType)`.
    - The rendered ZPL is cached by row id in a ref, and a failure caches nothing.
    - The error notice reads `Couldn't print the test label (${code}).`, where `code` is the `ApiError`'s code or the error's message.
  - Printers row: retitle it, with the new description.
  - PrintLabels Step 3: add `<p className="page-hint"><Link to="/labels/printers">Printer tools</Link></p>` as the card's last child.
- [ ] **Step 6: Run the touched files plus `src/styles/modalDropdowns.test.ts src/components/labels/builder/BuilderPrinterModal.test.tsx` and confirm they pass.**
- [ ] **Step 7: Commit:** `feat(printers): Test labels prints a mock-data label from a template you pick; Print Labels links to Printer tools`.

### Task 6: Damaged fonts in Install Fonts

**Files:**
- Modify: `portal/src/components/printers/InstallFontsModal.tsx` (`fontStates` L26, `installAllMissing` ~L130, library rows ~L200, batch button ~L308)
- Test: `portal/src/components/printers/InstallFontsModal.test.tsx`

**Interfaces:**
- Produces:
  - `FontState` becomes `'installed' | 'missing' | 'damaged' | 'printer-only'`.
  - `fontStates(library: (Pick<LabelFont, 'name' | 'resident'> & { size_bytes?: number })[], listing, zListing?)`. A library font is `damaged` when it is on E:, not resident, has `size_bytes > 0`, and the E: object's `bytes !== size_bytes`. `BuilderPrinterModal` passes no sizes, so it never sees `damaged`.
  - `export function fontBatchLabel(missing: number, damaged: number): string` returns:
    - "Install 2 missing fonts";
    - "Reinstall 1 damaged font";
    - "Install 1 missing font, reinstall 1 damaged font";
    - "Install all missing" when both are 0.

- [ ] **Step 1: Write the failing tests.**
  - `the real ZT220 listing of a pushed font reads Installed`: parse the spec §6 "after" reply verbatim with `parseDirectory`, against library `ROBOTO_R.TTF` with `size_bytes: 146768`. Expect `installed`.
  - `the same line at a smaller size reads Damaged`: replace `146768` with `120000` in that reply. Expect `damaged`.
  - `nothing to compare never reads Damaged` (Review Focus 5): cover `size_bytes: 0`, `resident: true`, and an entry without `size_bytes`.
  - `fontBatchLabel` wording for the four cases.
  - In the modal:
    - a damaged font shows a red "Damaged" chip (`c-red`) and its row action reads "Reinstall";
    - the batch button installs the missing and damaged fonts and reads "Install 1 missing font, reinstall 1 damaged font".
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `installAllMissing` covers `missing` and `damaged`, and the batch button is disabled when both counts are 0.
- [ ] **Step 4: Run the file plus `src/components/labels/builder/BuilderPrinterModal.test.tsx` and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(printers): Install Fonts flags a font whose size on the printer isn't the library's and reinstalls it`.

### Task 7: Gates and live verification (controller)

- [ ] **Step 1:** In `<worktree>/portal`, run `npm test` (all pass) and then `npm run build` (exit 0).
- [ ] **Step 2:** In `<worktree>/api`, run the API files Tasks 1–2 touched, plus `tests/test_kiosk_label_station_api.py tests/test_kiosk_printer_events_api.py tests/test_read_only_mode*.py tests/test_auth_forced_change*.py` (any that exist). All pass.
- [ ] **Step 3: Live verify** on a worktree portal dev server (port 5174 per the dev-workflow memory; API from the worktree on another port), signed in as claude-dev, using the stubbed `navigator.usb` recipe in the zebra-printer-tools memory.
  - Test labels, both choices, with a real active template (e.g. Generic Rack and RU at 203 and 300).
  - Factory Reset: a full run on the stub, the restart wait, a failure with Try again, the hand-off into setup, and the row on /audit.
  - Install Fonts, with a stub `^HW` reply that makes one font damaged.
  - The Printer tools link.
  - Screenshots of each new or changed dialog, with the corners checked.
- [ ] **Step 4:** Report what was verified against the stub and what still needs a real Zebra over WebUSB (printing, factory reset).
