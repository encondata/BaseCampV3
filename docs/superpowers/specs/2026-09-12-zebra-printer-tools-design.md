# Zebra Printer Tools — `/labels/printers` › Zebra tab (test label, font install, guided setup)

**Date:** 2026-09-12 · **Status:** approved (Jimmy: tools for the browser-connected printer only, no registry; a V3 font library; a guided configuration wizard; modals dynamically sized with a good UI/UX; the test label reuses the Print Labels alignment options) · **Branch:** `zebra-printer-tools`

## What exists today

- `portal/src/pages/Printers.tsx` is a placeholder: a Zebra / Brother tab strip over three inert rows — **Test Label Alignment** ("Print a calibration label and dial in offsets."), **Install Fonts** ("Push the house label fonts to the printer's storage."), **Full Printer Setup** ("Guided first-time configuration for a new Zebra printer.") — each with a "Coming soon" chip. Tests in `Printers.test.tsx` pin those three titles and the chip count.
- Print Labels (2026-09-12) delivered the pieces this page builds on: `portal/src/labels/zebraUsb.ts` (pure WebUSB transport over `UsbDeviceLike` + `Clock`: request/open/close/ensureOpen, `sendRaw`, `~HS` queued-format polling), `portal/src/lib/useZebraPrinter.ts` (page-scoped hook: `supported/connected/productName/notice/connect/disconnect/send/waitForIdle`), `portal/src/lib/printLabels.ts` (`readPrintSettings`/`writePrintSettings` on localStorage key `labels.print.settings`, `alignmentTestZpl`, `applyPrintSettings`), and `PrintSettingsModal`'s alignment section (size ComboBox × DPI segmented → `alignmentTestZpl`).
- V2 had no equivalent of these tools; its kiosk service only connected and printed. The imported V2 templates reference printer-resident fonts: `Front Asset Tag` uses `^A@N,25,,E:85620388.TTF` and three destination templates alias `^CWK,E:TT0003M_.TTF` (Zebra's built-in Swiss 721). No TTF files exist in V2, so fonts must be uploaded by an admin.
- Files upload today through `POST /attachments` (entity-anchored, MinIO via `services/storage.py` `put_object/get_object/delete_object/presign_get`). Fonts are not entity-anchored, so they get their own small table and routes.

## Design

### Page: `/labels/printers` › Zebra tab

The tab keeps its strip and becomes a working page in the Print Labels chrome:

- **Printer card** (`plabels-step`-style bordered card, full width): status dot + "Printer connected · ZD421" / "No printer connected", **Connect via USB** (`btn-solid`) or **Disconnect** (`btn-ghost`), the V2 hint about powering the printer on, and the unsupported-browser text when WebUSB is absent. Once connected the card shows **identity chips** from `~HI` (model, firmware, DPI derived from dots/mm: 6→150, 8→203, 12→300, 24→600, memory) and **health chips** from the full `~HS` parse (Paper out · Head open · Paused · Ribbon out · Over/under temperature · Buffer full, red when set; "N labels queued" when > 0; "Ready" green when nothing is set) with a **Refresh status** `mini-btn`. A **Known printers** line lists devices the browser already authorized (`navigator.usb.getDevices()`), each with a Connect button that opens that device without the chooser.
- **Tools list** (`dir-list`, the three rows keep their titles/descriptions): the "Coming soon" chip becomes an action button per row — **Print test label**, **Manage fonts**, **Start setup** — disabled with the hint "Connect a printer first" until a printer is connected (font *library* management is allowed without a printer: the Manage fonts button stays enabled but the install column says "Connect a printer to install").
- Brother tab unchanged (`dir-empty`).
- Notices (connect/disconnect/errors) use the same `plabels-notice` strip as Print Labels.

### Transport additions (`portal/src/labels/zebraUsb.ts`, pure, tested with the fake device)

- `readText(device, { firstTimeoutMs = 2000, drainTimeoutMs = 250, maxReads = 8 }, clock)` — the generic read-with-drain the `~HS` poll already does, returning the concatenated text (`''` when nothing arrives).
- `query(device, command, opts?, clock?)` — `sendRaw` then `readText`.
- `sendBytes(device, bytes: Uint8Array, { chunkSize = 65536, onProgress?, clock? })` — chunked `transferOut` for object downloads.
- Parsers (each tolerant of missing/garbled input, returning `null` rather than throwing):
  - `parseHostIdentification(text)` → `{ model, firmware, dotsPerMm, memory, dpi }` from `<STX>model,firmware,dpmm,memory[,x]<ETX>`.
  - `parseHostStatus(text)` → `{ paperOut, paused, labelLength, formatsQueued, bufferFull, partialFormat, corruptRam, underTemp, overTemp, headOpen, ribbonOut, thermalTransfer, printMode, labelWaiting, labelsRemaining }` from the three STX strings (string 1 fields b,c,dddd,eee,f,h,j,k,l; string 2 fields o,p,q,r,t,uuuuuuuu). `parseHostStatusQueued` stays as the thin wrapper Print Labels uses.
  - `parseDirectory(text)` → `{ objects: [{ name, bytes }], bytesFree }` from `^HW` output (lines `* NAME.EXT <bytes>` or `NAME.EXT <bytes>`, and the `<n> bytes free` line).
  - `parseConfiguration(text)` → `{ darkness, printSpeed, tearOff, printMode, mediaType, printMethod, printWidth, labelLength, firmware, raw: Record<label, value> }` from `^HH` output (each line = value, run of spaces, upper-case label; unknown labels kept in `raw`).
- Command builders (`portal/src/labels/zebraCommands.ts`, pure): `HOST_IDENTIFICATION = '~HI'`, `HOST_STATUS = '~HS'`, `configurationQuery() = '^XA^HH^XZ'`, `directoryQuery(drive = 'E') = '^XA^HW<drive>:*.*^XZ'`, `deleteObject(drive, name)`, `downloadFontHeader(drive, name, totalBytes) = '~DY<drive>:<name>,B,T,<bytes>,,'` (the TTF bytes follow immediately), `calibrate() = '~JC'`, `setDarkness(n) = '~SD<nn>'` (0–30, zero-padded), `setPrintSpeed(ips) = '^XA^PR<ips>^XZ'` (2–14), `setMediaTracking(mode) = '^XA^MN<W|M|N|A>^XZ'`, `setPrintMode(mode) = '^XA^MM<T|P|C|R>^XZ'`, `setPrintMethod(m) = '^XA^MT<D|T>^XZ'`, `setLabelSize(widthDots, lengthDots | null) = '^XA^PW<w>^LL<l>^XZ'` (`^LL` only when a length is given — the wizard passes it only on continuous media, since on gap/mark media the printer measures the label length itself), `saveSettings() = '^XA^JUS^XZ'`, `factoryDefaults() = '^XA^JUF^XZ'`, `printConfigurationLabel() = '~WC'`, plus `fontObjectName(filename)` (upper-cases, validates Zebra 8.3: `^[A-Z0-9_]{1,8}\.TTF$`) and `isTrueType(bytes)` (`00 01 00 00` or `true` magic).
- `useZebraPrinter` gains `query(command)`, `sendBytes(bytes, onProgress)`, `identify()` (→ parsed `~HI`), `status()` (→ parsed `~HS`), `knownDevices()` / `connectTo(device)` (WebUSB `getDevices()`), and a `log` of `{ at, command, response }` entries (capped at 200) that the setup wizard renders.

### Font library (API)

- Migration **0060** `label_fonts`: `id uuid pk`, `name citext UNIQUE` (the printer-side object name, e.g. `85620388.TTF`), `display_name text`, `storage_key text`, `size_bytes bigint`, `content_type text` (`font/ttf`), `uploaded_by` FK people (nullable), `created_at`, `deleted_at` (soft delete). Resource `labels` gates it: list/content `labels:view`, upload `labels:add`, delete `labels:delete`. Audit rows for upload and delete.
- `GET /labels/fonts` → `[{ id, name, display_name, size_bytes, uploaded_by_name, created_at, used_by: [{ template_id, template_name }] }]` — `used_by` scans active templates' `code` for `E:<NAME>` (cheap: templates are few).
- `POST /labels/fonts` (multipart `file`, optional `name`) → 201 `LabelFontOut`; name defaults to `fontObjectName(filename)`; 422 `invalid_font_name` (not 8.3 `.TTF`), 422 `not_a_truetype_font` (magic), 413 `file_too_large` (> 2 MB), 409 `font_name_taken` (case-insensitive, among non-deleted). Stored at `label-fonts/<uuid>.ttf`.
- `DELETE /labels/fonts/{id}` → 204 (soft delete; object left in MinIO like attachments).
- `GET /labels/fonts/{id}/content` → the TTF bytes (`font/ttf`, `Content-Disposition: attachment; filename=<name>`), read through `get_object` so the browser never needs MinIO access.
- Portal client: `listLabelFonts`, `uploadLabelFont(file, name?)`, `deleteLabelFont(id)`, `getLabelFontBytes(id)` (→ `Uint8Array`).

### Modals (all roomy header + content-sized cards; Escape only when `!e.defaultPrevented`)

- **Test label alignment** (`AlignmentTestModal`, `width: min(760px, 96vw)`, `overflow: visible` for the ComboBox): eyebrow "Printers", title "Test label alignment", description "Prints concentric boxes 25 dots apart so you can dial in the offsets. The same offsets are used by Print Labels." Left column: Size (`ComboBox` over active sizes, default `4x2`) and DPI (`segmented` 203/300 preselected from the printer's identity, editable), Vertical offset / Horizontal offset (dots, same hints as the settings modal, free text clamped on blur). Right column: a small SVG preview of the boxes at the chosen size. Footer: **Print test label** (`btn-solid`), **Save offsets** (`mini-btn`, writes `labels.print.settings` via `writePrintSettings`, disabled until changed), Done. Uses `alignmentTestZpl` + `applyPrintSettings(zpl, settings, { singleCopy: true })` exactly like Print Labels.
- **Install fonts** (`InstallFontsModal`, `width: min(1100px, 96vw)`): eyebrow "Printers", title "Install fonts", description "Fonts referenced by label templates must live on the printer's E: drive. Upload TrueType fonts here once, then install them on each printer." Two columns:
  - **Font library** (`DataTable`: Name (`mono`), Display name, Size (`mono`), Used by (chips of template names or "—"), Uploaded (relative time), Remove). Above it an **Upload TTF** control (`<input type="file" accept=".ttf">`, a Name field prefilled from the filename, upper-cased and validated live with the 8.3 rule, Upload button; errors from the API shown inline). Remove asks inline ("Remove NAME from the library? Printers keep their copy.").
  - **On the printer**: when connected, the E: directory (`DataTable`: Name, Size, State chip: "Installed" green when the library has it too, "Printer only" slate, "Missing" amber for library fonts not on the printer) plus "N KB free"; per library font an **Install** / **Reinstall** button and a **Remove from printer** button; **Install all missing** at the top. Install = fetch bytes → `sendRaw(header)` then `sendBytes(ttf, onProgress)` → wait 500 ms → re-read the directory; the row shows a progress bar during transfer and "Installed ✓" / an error afterward. When no printer is connected the column shows "Connect a printer to install fonts." Footer: Done.
- **Full printer setup** (`PrinterSetupModal`, `width: min(980px, 96vw)`, with the `rgm-steps` indicator Identify › Media › Print quality › Save & verify):
  1. **Identify** — identity chips, health chips, and a **Current configuration** grid parsed from `^HH` (Darkness, Print speed, Print mode, Media type, Print method, Print width, Label length, Firmware). Buttons: Refresh, Next.
  2. **Media** — Media tracking (`ChoiceCard` radios: Gap/notch `W`, Black mark `M`, Continuous `N`), Print method (Direct thermal `D` / Thermal transfer `T`), Print mode (Tear-off `T` / Peel `P` / Cutter `C`), Label size (size ComboBox × the printer's DPI → `^PW`/`^LL`), and **Calibrate media** (`~JC`, with the hint that the printer feeds a few labels). **Apply** sends the chosen commands (only the ones changed from the current configuration), waits 750 ms, re-reads `^HH`, and marks each applied value confirmed ✓ or "printer reports X" when it differs. Back / Next.
  3. **Print quality** — Darkness (range 0–30 with the number beside it, `~SD`), Print speed (range 2–14 ips, `^PR`). Apply with the same confirm-by-re-read. Back / Next.
  4. **Save & verify** — **Save to printer** (`^JUS`, required to survive a power cycle; the step says so), **Print configuration label** (`~WC`), **Print alignment test** (opens the alignment modal's logic inline: size × DPI + Print), and **Restore factory defaults** (`^JUF`, guarded by an inline "Type RESET to confirm"). Done.
  A **Command log** disclosure at the bottom of every step lists `{time, command, response}` from the hook's log (mono, newest last, Copy button).

### Page test ids / copy

- Row buttons: "Print test label", "Manage fonts", "Start setup"; disabled hint "Connect a printer first" (test label + setup only).
- Health chip labels: Ready, Paper out, Head open, Paused, Ribbon out, Over temperature, Under temperature, Buffer full, "N labels queued".

### Testing

- Transport: `readText` (single packet, multi-packet drain, nothing → `''`), `query`, `sendBytes` chunking + progress with a fake device recording chunk sizes, every parser against captured-format samples (a ZD421 `~HI` string, a three-string `~HS`, a `^HW` listing with two objects and a free line, a `^HH` block with the eight known labels plus an unknown one) and against garbage/empty input.
- Commands: each builder's exact string; `fontObjectName` accepts `85620388.TTF`/`tt0003m_.ttf`, rejects `longername.ttf`, `a.otf`, `bad name.ttf`; `isTrueType` on both magics and on PNG bytes.
- Hook: `query` returns parsed text, `identify`/`status` parse, `knownDevices`/`connectTo`, the log cap.
- API: migration head single; upload happy path (bytes in MinIO stub, row, audit) and each 4xx; list with `used_by` computed from a template referencing `E:NAME.TTF`; delete soft; content streams bytes; permissions per action.
- Modals: alignment (DPI preselected from identity, Print sends the transformed ZPL, Save offsets writes storage), fonts (upload validation + API calls, directory states, install sends header + bytes and re-lists, remove from printer sends `^ID`), setup (each Apply sends only changed commands and re-reads; factory reset guard; step navigation; log renders).
- Page: rows gated on connection, known printers connect, health chips from a mocked status, Brother tab untouched, nav test unchanged.
- Live: connect a Zebra in Chrome; identity/health chips; alignment print; upload the `85620388.TTF` Jimmy supplies and install it, confirm it appears in the E: listing; run the setup wizard end to end and print the configuration label. Without hardware: everything but the physical prints via a stubbed `navigator.usb`.

## Deliberate limits

- Only the printer connected to this browser (WebUSB, Chrome/Edge on https or localhost); no server-side printer registry or per-printer profiles.
- Offsets are shared with Print Labels (one localStorage setting per browser), by design.
- ZPL commands only (no SGD `! U1 setvar` paths); settings persist on the printer only after Save (`^JUS`).
- Fonts: TTF only, ≤ 2 MB, Zebra 8.3 names; the built-in `TT0003M_.TTF` needs no upload (the printer-side listing shows it).

## Out of scope

Brother tools; printer fleet/registry; network (TCP 9100) printers; label-template font pickers (the editor keeps raw `^A@`/`^CW`); Windows/Linux WebUSB driver setup guide (the V2 kiosk guide remains the reference).
