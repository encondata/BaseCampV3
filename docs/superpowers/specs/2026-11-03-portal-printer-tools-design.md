# Portal printer tools from the kiosk — design

Date: 2026-11-03 · Branch: `portal-printer-tools` · Status: for Jimmy's approval

## Why

Jimmy: "I want to bring in the kiosk test label printing, full printer setup,
factory reset and font install." The kiosk grew printer tools after the
portal's Labels › Printers page was ported to it (a414ac11). This brings the
kiosk's additions back, so the portal can do over WebUSB everything the
kiosk can.

## What exists today (the gap)

| Tool | Portal today | Kiosk | Work here |
|---|---|---|---|
| Test label printing | Alignment label on Labels › Printers (`AlignmentTestModal`) and in Print Labels › Print settings | Label Station test labels (`kiosk/src/components/setup/TestLabelModal.tsx`): Alignment label **or** Mock-data label (a real template filled with sample values by the API's renderer, `POST /kiosk/labels/test-render`). Android and iOS have the same two choices | Add the Mock-data label |
| Full printer setup | `PrinterSetupModal` wizard | The same wizard, ported from the portal, plus `initialConfig` / `intro` props so a factory reset can hand over its fresh `^HH` | Add those two props (for factory reset) |
| Factory reset | none | `kiosk/src/components/printers/FactoryResetModal.tsx` (web/laptop only) | Port it, with a portal-side audit route |
| Font install | `InstallFontsModal`: library upload/remove, Install all missing, Reinstall, remove from printer, built-in fonts | Web kiosk: disabled ("Managed from the portal"). Android/iOS: also flag **damaged** fonts and reinstall them | Add damaged-font detection |

## Decisions Jimmy made

1. **Placement.** All four tools live on Labels › Printers (Zebra tab). They are
   not duplicated on Print Labels. Print Labels' Step 3 "Printer" card gets a
   **Printer tools** link to Labels › Printers, at the bottom of the card
   (mockup approved).
2. **Mock-data label.** It is a second choice in the existing test label dialog.
   **You pick the template** from a list of active templates. It prints the
   template's version at the printer's DPI (mockup approved).
3. **Factory reset** is the kiosk's dialog as it is, with the same steps and copy.
   It ends in Full Printer Setup, seeded with the configuration read after the
   reset. Every run, completed or failed, is written to the Audit page
   (mockup and playback approved).
4. **Print mode.** Test labels carry no `^MM` and follow the mode saved on the
   printer, the same as Print Labels. A test label therefore prints exactly the
   way real labels will. Forcing a per-label mode in Print Labels is a
   separate, still-unrequested item (see [[portal-print-mode-gap]]).
5. **Damaged fonts.** Install Fonts flags a library font whose size on the
   printer differs from the library's size, and offers Reinstall, the way
   Android and iOS do.

## Design

### 1. Labels › Printers page (`portal/src/pages/Printers.tsx`)

Tool rows, in this order (titles, descriptions and buttons as shown):

| Row | Description | Button | Gate |
|---|---|---|---|
| Test Labels *(was Test Label Alignment)* | Print an alignment or sample-data label and dial in offsets. | Print test label | printer connected |
| Install Fonts | Push the house label fonts to the printer's storage. | Manage fonts | none (as today) |
| Full Printer Setup | Guided first-time configuration for a new Zebra printer. | Start setup | printer connected |
| Factory Reset | Restore the printer's factory defaults, then set it up again. | Reset printer (danger style, `btn-solid btn-danger`) | printer connected |

The Factory Reset row's title, description and button text are the kiosk's,
word for word. Rows reuse the existing `dir-row` / `zp-tool-row` markup. The
kiosk's `ToolRow` already supports a `danger` flag; the portal's `ZEBRA_TOOLS`
gains the same flag.

State follows the kiosk's `UsbPrinterTools`. A `fromReset` holder carries the
post-reset configuration into the setup wizard, and closing either dialog
re-reads identity and status (`refreshStatus`).

### 2. Test Labels dialog (extends `components/printers/AlignmentTestModal.tsx`)

The dialog is renamed to **Test labels**. Header: eyebrow "Printers", h3 "Test
labels". Description: "Print an alignment label or a label with sample data,
then adjust the offsets and reprint until it lines up. The same offsets are
used by Print Labels."

- **Choice cards** (the portal's `ChoiceCard` from `ReportOptionsLayout`, radio
  group "Test label"), with the kiosk's copy:
  - Alignment label: "Concentric boxes filling the whole label."
  - Mock-data label: "A real template filled with sample values."
- **Alignment label:** exactly today's behavior (size ComboBox, DPI segmented,
  concentric-box SVG preview, `alignmentLabelZpl`).
- **Mock-data label:**
  - **Template picker.** A ComboBox (auto-portals in the modal) listing active
    templates, natural-sorted, from `GET /labels/templates/tree`.
    - **Grouping (my call).** One option per **family + label type**. That is
      the key Labels › Templates' one-active rule and its Replace… use
      (`templates_tree._conflicts`). Grouping by family alone could leave two
      active versions at the printer's DPI.
    - **Option label.** The family name, with the label type's label after it
      (for example "Generic Rack and RU · Top").
    - **What's listed.** An option is listed when the group has an active,
      non-Old, **ZPL** (`language_key = zpl`) printable row at any DPI. Brother
      (`escp`, `ptouch`) templates are never listed, because these are Zebra
      tools. Builder parents are never printed themselves; their DPI children
      are.
    - **Every label type is listed, ID badges (`id_badge`) and custom types
      included** (Jimmy). A badge's sample label fills its text fields with
      the builder's mock worker. Its photo and logo print blank, because
      sample values carry no pictures. For a badge, the preview line adds
      "Photos and logos print blank." (my call)
  - **Which version prints.** The group's active, non-Old ZPL row whose
    `dpi_key` equals the printer's DPI (`~HI`).
    - **DPI unreadable.** The dialog's DPI segmented control picks the DPI, as
      alignment does today. The control shows in mock mode only when `~HI`
      couldn't be read (my call).
    - **No version at that DPI.** The preview column says so, in the kiosk's
      wording ("…is only available at 203 DPI, so the mock-data label is
      skipped.") adapted to "this printer", and Print is disabled.
  - **Preview column.** One line of text, like the kiosk: "Prints <template> at
    <dpi> DPI with sample values, filled in by the portal." There is no rendered
    image (Jimmy did not ask for one).
  - **Printing.** It calls the new `POST /labels/test-render` (below), caches the
    returned ZPL per template id for Reprint, then sends
    `applyPrintSettings(zpl, {…stored, offsets}, { singleCopy: true })`. That is
    the same offset shift the alignment label uses, with **no** `withPrintMode`
    (decision 4).
- **Offsets, Save offsets and Done** are unchanged. They still read and write
  `labels.print.settings`, shared with Print Labels.
- **Errors** use the kiosk's pattern: "Couldn't print the test label (<code>)."
  where the code comes from `ApiError` (`template_unconvertible`, …).
- The label builder's Printer dialog keeps importing `alignmentLabelZpl` from
  this file. That export must not move or change.

### 3. API: `POST /labels/test-render` (new, `routes/labels.py`)

- Body: `{ template_id: uuid, dpi_key: str }`. Returns `{ zpl, template_name }`.
- Gate: `labels:view`, like Labels › Printers.
- Rules mirror `POST /kiosk/labels/test-render`, minus the move:
  - 404 `template_not_found` if the template doesn't exist, isn't active, is
    Old, or is a builder parent (not a printable row). (my call)
  - 422 `not_zpl` if its `language_key` isn't `zpl`. (my call)
  - 422 `dpi_mismatch` if `dpi_key` isn't the template's own.
  - 422 `template_unconvertible` if it can't render.
- Values: a schema-2 design gets `mock_field_values(label_type, design_field_keys(design))`.
  Anything else gets `mock_label_values(catalog_keys, generation_rules)`. The
  output is rendered by the generator's own `render_label`.
- **Shared, not copied.** The kiosk route's render body moves into one helper
  (in `serversherpa/labels/`, or wherever `mock_label_values` ends up) that both
  routes call. The kiosk route's behavior and tests stay unchanged.
- It is a read made through POST, so it is exempt from read-only mode the same
  way the kiosk twin is. (The builder confirms how that twin is exempted and
  mirrors it.) Like `/labels/images/raster`, it is also subtracted from
  `FORCED_CHANGE_EXEMPT_PATHS`, because it is not part of signing in. (my call)

### 4. Factory reset (port `kiosk/src/components/printers/FactoryResetModal.tsx`)

- `portal/src/components/printers/FactoryResetModal.tsx` is a port with the
  same steps, constants, copy, phases (Confirm, Reset, Setup), retry rules,
  StrictMode-safe `aliveRef`, and "Cancel first, autofocused" footer. The steps
  are:
  1. `^JUF`.
  2. The restart wait. It polls every 2 s for up to 45 s, calling `ensureOpen`
     and then `~HI`.
  3. Optional calibration: `~JC` and wait for idle.
  4. `^JUS`.
  5. `^HH`, then hand the configuration to the setup wizard.
- **The hook** (`portal/src/lib/useZebraPrinter.ts`) gains what the kiosk's has:
  - `ensureOpen()`, which uses the shared `ensureOpen` in `labels/zebraUsb.ts`.
  - `device`.
  - The unmounted-while-opening guards (the `mounted` ref).
- **The setup wizard** (`PrinterSetupModal.tsx`) gains the kiosk's
  `initialConfig` and `intro` props. With a seed it skips the read-on-mount
  and starts from the seeded media and quality choices. Its eyebrow becomes
  "Printers · After factory reset".
- **Reporting.** When the run ends (completed or failed), the dialog fires a
  `POST /labels/printer-events` and never awaits it. It then shows the
  kiosk's line: "Recorded in the portal.", or "Couldn't record this reset in
  the portal — tell an admin." if the call failed. Like `postPrinterEvent`,
  the client helper resolves to a boolean and never throws.

### 5. API: `POST /labels/printer-events` (new)

- Body, mirroring `KioskPrinterEventIn` without `serial`:
  - `event: "factory_reset"` and `outcome: "completed" | "failed"`;
  - `printer_model`, `printer_firmware`, `printer_serial` (all optional);
  - `calibrated`, `failed_step` and `error`, with the same caps.
  - `printer_serial` is the WebUSB `serialNumber` when the browser reports one.
    `UsbDeviceLike` gains an optional `serialNumber` for this.
- Gate: `labels:view`. Returns 204.
- Writes one audit row:
  - `entity_type="label_printer"`, `entity_id=printer_serial` (or null);
  - `action=f"printer_{event}"` (so `printer_factory_reset`);
  - `changes` = the non-null fields, as the kiosk route does.
- Exempt from read-only mode, for the kiosk route's reason: the reset already
  happened, and the row records it. Add it to `READ_ONLY_EXEMPT_PATHS`, and to
  the `FORCED_CHANGE_EXEMPT_PATHS` subtraction beside `/kiosk/printer-events`.
- Portal `auditFormat.ts`: add `printer_factory_reset: 'Printer factory reset'`
  and `label_printer: 'label printer'`. `entityHref` returns null (there is no
  printer page).

### 6. Damaged fonts (`components/printers/InstallFontsModal.tsx`)

- `parseDirectory` already returns `bytes` per object, and `LabelFont` has
  `size_bytes`.
- `fontStates` gains a `damaged` state for a library font that is on E:, not
  resident, has `size_bytes > 0`, and has an E: size different from
  `size_bytes`. This is the Android/iOS `damagedFonts` rule (cut-short
  download).
- In the library table, a damaged font shows a red **Damaged** chip and its
  row action reads **Reinstall**. The modal's batch button covers missing and
  damaged fonts together. Its label follows Android/iOS: "Install 2 missing
  fonts", "Reinstall 1 damaged font", or "Install 1 missing font, reinstall 1
  damaged font". With nothing to install, it keeps today's "Install all
  missing" text, disabled. (my call)
- **Verified on hardware (2026-11-03, with Jimmy's OK).** `ROBOTO_R.TTF` from
  the library (146,768 bytes) was pushed to the office ZT220 (10.10.48.90)
  with the portal's exact header (`~DYE:ROBOTO_R.TTF,B,T,146768,,` + bytes).
  `^HW` then listed `* E:ROBOTO_R.TTF    146768`, the file's exact byte
  count. Free space dropped by 146,944 bytes (flash blocks), but the listing
  shows the real size. The font was then removed with `^IDE:ROBOTO_R.TTF`,
  and the listing matched the original again. The captured replies, before
  and after, verbatim:

  ```
  before: '\x02\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960          \r\n* E:TEXT.ZPL         5          \r\n* E:TT0003M_.TTF    160676       K  \r\n\r\n-  32346624 bytes free E: ONBOARD FLASH \r\n\x03'
  after:  '\x02\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960          \r\n* E:ROBOTO_R.TTF    146768          \r\n* E:TEXT.ZPL         5          \r\n* E:TT0003M_.TTF    160676       K  \r\n\r\n-  32199680 bytes free E: ONBOARD FLASH \r\n\x03'
  ```

  The "after" reply goes into the portal's tests as a real-reply fixture.
  Built from it, a cut-short copy (same line, smaller size) must read
  Damaged ([[feedback-install-troubleshoot-perfect]]).

### 7. Print Labels: link and known printers (`portal/src/pages/PrintLabels.tsx`)

The Step 3 "Printer" card gets two additions. Nothing else on Print Labels
changes.

- **Printer tools link.** One router `Link` to `/labels/printers`, reading
  **Printer tools**, as the last line of the card.
- **Known printers** (Jimmy, 2026-11-03: "add the known printers option from
  the /labels/printers to the /labels/print page"). This is the same row as
  Labels › Printers. While no printer is connected and the browser has
  printers it already allowed (`printer.knownDevices()`), it shows "Known
  printers:" and then one `mini-btn` per device: "Connect <productName>",
  or "Connect Zebra printer" when the name is missing. Clicking one calls
  `printer.connectTo(device)`, with no chooser. It sits right after the
  Connect via USB button. The list loads on mount and again whenever the
  printer disconnects, so a printer allowed during this visit shows up
  after a Disconnect (my call; Labels › Printers loads it only on mount).

## Non-goals and anti-goals

- No printer tools are duplicated on Print Labels beyond the link.
- No `^MM` on test labels or on Print Labels' prints.
- Network or Bluetooth printers in the portal: WebUSB only, as today.
- No rendered picture in the mock-data preview, and no other extras Jimmy
  hasn't asked for.
- No change to the kiosk, Android or iOS apps, except moving the kiosk
  test-render route's body into a shared helper with unchanged behavior.
- No printer registry and no Brother tools.

## Constraints (house rules that apply)

- Modals use the roomy header (eyebrow, h3, description, `rgm-steps` where
  there are steps) and are sized to their content. Corners stay rounded on
  every modal (check `modalCorners.test.ts` and a screenshot). Dropdowns in a
  dialog must portal (`modalDropdowns.test.ts`).
- Reuse the portal's controls (ComboBox, segmented, ChoiceCard, chips,
  `pf-form`). No raw native selects.
- **Modal-with-hook rule.** A modal that receives `useZebraPrinter()` keeps it
  in a ref and keys its effects on `printer.connected`.
- All copy in American English. The kiosk's copy is reused where the tool is
  the kiosk's.
- Printer replies are tested against real captured replies where they exist
  (`kiosk/src/lib/realPrinterReplies.test.ts` has the ZT220 set).

## Testing and verification

- **Unit tests** (vitest, the existing files extended):
  - the Printers page rows and gating;
  - the Test labels dialog, both choices, plus the no-version-at-DPI and
    error paths;
  - FactoryResetModal, ported from the kiosk's tests (full run, reboot retry,
    a failed step with Try again, report outcomes, the seeded hand-off);
  - the hook's `ensureOpen`;
  - `fontStates` damaged cases, plus the batch button wording;
  - the Print Labels link;
  - `auditFormat`.
- **API tests:**
  - `/labels/test-render`: 200 for code, schema-2 and badge templates; 404 for
    inactive, Old, parent or unknown; 422 for not ZPL, DPI mismatch and
    unconvertible; and 403 without `labels:view`;
  - `/labels/printer-events`: the audit row's shape, null fields dropped,
    read-only exemption, 403 without the permission;
  - the kiosk test-render tests still pass after the refactor.
- **Gates:** the portal's `npm test` (about 5,357 tests) and `npm run build`,
  plus the API tests for the touched routes.
- **Live verify in the portal** with the stubbed `navigator.usb` recipe from
  [[zebra-printer-tools-feature]]:
  - each dialog's flow, the reset's restart wait, the seeded setup, and the
    audit row on /audit;
  - a mock-data label against a real active template.
- **Real hardware:**
  - WebUSB can't be automated, so printing and factory reset on a real Zebra
    are Jimmy's to try.
  - The report says plainly which flows were checked on a real printer and
    which only against the stub.
  - Never send a write to an office printer without Jimmy's OK.

## Questions answered during review

1. *May I push one library font to an office printer?* Yes. Done; see §6.
2. *Badge templates in the mock-data list?* Include them; their photo and logo
   print blank (§2).

## Left to the builder

- Whether the shared render helper lives in `serversherpa/labels/` or beside
  `mock_label_values`.
- Exact test file layout.
- The Factory Reset dialog's CSS: copy the kiosk's `zp-reset-*` rules from
  `kiosk/src/styles/kiosk.css` into `portal/src/styles/printers.css`.
