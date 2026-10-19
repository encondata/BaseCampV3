# Label Station Printing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a laptop Label Station's Kiosk Setup adds two steps:
- **Step 4:** Top or Front.
- **Step 5:** pick a printer (USB, or network by scan or typed IP), check DPI, status and fonts with green checks, install missing fonts, print test labels (alignment or mock data), and set offsets.

Every check must be green to finish. "Finish anyway" is offered to user-account sessions only.

**Architecture:**
- **API:** adds two kiosk-scoped routes: a font download, limited to fonts the move's templates use, and a test-label render that fills a template with mock values using the portal's own renderer.
- **Edge:** adds a network printer transport: a subnet scan for port 9100, plus raw query and send to a printer IP. The station's label settings join the laptop's shared setup.
- **Kiosk:** wraps USB (`useZebraPrinter`) and network (edge) behind one printer interface, and builds the two steps on it. The station settings are reported to the portal as a `label_station` config section.

**Tech Stack:** FastAPI (API), FastAPI + sqlite3 + asyncio sockets (edge), React + Vitest (kiosk).

**Spec:** `docs/superpowers/specs/2026-10-19-label-station-printing-design.md` (phase 1 = §4)

## Global Constraints

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/label-station-printer`, branch `label-station-printer`.

**Setup**, only if something is missing:
- `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`
- `npm --prefix kiosk ci && npm --prefix portal ci`
- API tests need two symlinks, removed after committing and never staged:
  - `api/.venv` → `/Users/jrh1812/Developer/BaseCampV3/api/.venv`
  - `.env` → `/Users/jrh1812/Developer/BaseCampV3/.env`

**Git:** stage by explicit path only. Never stage `.superpowers/`, `.venv`, `node_modules` or `.env`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites:** run every suite in the FOREGROUND with a 600000 ms timeout.
- API: `cd api && SS_TEST_DB=serversherpa_test_label_station PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider <files>`
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`
- Kiosk: `npm --prefix kiosk test -- --run`, then `npm --prefix kiosk run build`
- Portal: `npm --prefix portal test -- --run <files>`, then `npm --prefix portal run build`

**Rules:**
- No portal migration.
- Edge `SCHEMA_STEPS` is append-only.
- Copy is American English.
- Reuse kiosk idioms and the existing Printer tools pieces:
  - `PrinterHealth`/`healthChips`, and `AlignmentTestModal`'s `alignmentInsets` box routine;
  - `applyPrintSettings` (the `^LS`/`^LT` shift);
  - `portal/src/labels/zebraCommands.ts` (`directoryQuery` `^XA^HWE:*.*^XZ`, `downloadFontHeader` `~DY`) and `zebraUsb.ts` parsers;
  - the setup `ChoiceCard`s and step header style;
  - the report-generate modal header pattern, with modals sized to their content.

**Fixed values (spec):**
- Label kinds: `top` (listed first, the default) and `front`. Card copy: Top is "4x2 today; the template's size decides", Front is "2x1".
- **Printer types:**
  - **USB:** WebUSB, with already-allowed printers offered first.
  - **Network** (laptop only): a subnet scan for TCP **9100**, plus a typed IP.
- **Checks, each a row with a green check:**
  - **Printer answers:** `~HI`.
  - **DPI:** from `~HI`. Passes when at least one downloaded template of the chosen kind has `dpi_key` equal to the printer's DPI. Top means `label_type` `top`; Front means `front`.
  - **Status:** `~HS` reports no paper out, head open or pause.
  - **Fonts:** every printer-installed font that those templates reference is present on `E:`.
- **Finishing:**
  - Every check must be green.
  - "Finish anyway" appears only when the session is a user account. A move-password session (the kiosk auth state has `kioskMove`) never sees it.
  - Paper, head and pause problems show what to fix and a **Recheck** button.
- **Font install:** install any missing font through the new kiosk font route, then re-check. A needed font that isn't in the library stays red with "Upload it in the portal's font library".
- **Test labels modal:**
  - **Alignment:** 4x2 or 2x1, defaulting to 4x2 for Top and 2x1 for Front, at the printer's DPI.
  - **Mock-data label:** a Top station uses "Generic Rack and RU"; a Front station uses its Front template, picked at the printer's DPI. A template only at another DPI is skipped with a note.
  - **Offsets:** after a print, horizontal and vertical offset inputs (dots, may be negative) plus **Reprint**.
- **Storage:**
  - The station's label settings live in the laptop's shared setup on the edge: `label_kind`, a printer object (`type: usb|network`, `ip?`, `model`, `serial?`), `dpi`, `offset_x`, `offset_y`.
  - They are also reported in the kiosk config document as section `label_station`.

## Review Focus

1. **The network printer transport can't be aimed at anything beyond printers.**
   - It sends only to private LAN IPv4 addresses (RFC 1918) on port 9100. Loopback, link-local and public addresses are refused.
   - It needs an edge session.
   - Reads are size- and time-bounded.

   (Task 2.)
2. **Fonts are scoped to the move.** The kiosk font route serves only fonts named by the move's active templates. A move-password session can't fetch any other font. (Task 1.)
3. **"Finish anyway" never shows for a move-password session,** even if every other check failed. (Task 3.)
4. **One printer interface for both transports.** The checks, font install and test prints run the same code for USB and network, and the same ZPL is sent either way. (Task 3.)
5. **Mock test label fidelity.** The test label's ZPL comes from the portal's `render_label`, never from the kiosk filling placeholders itself. (Tasks 1, 3.)

---

### Task 1: API — kiosk font download and test-label render

**Files:**
- Create: `api/src/serversherpa/labels/template_fonts.py`
- Modify: `api/src/serversherpa/api/routes/kiosk.py` and `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_kiosk_label_station_api.py`

**Interfaces:**
- `def fonts_used(code: str) -> set[str]` returns the printer-installed font object names a compiled template references:
  - `^A@...,E:NAME.TTF` and `^A@...E:NAME.TTF` variants;
  - `^CW` with an `E:` font;
  - a case-insensitive match that returns `NAME.TTF` as stored in `label_fonts.name`.
- `GET /kiosk/labels/fonts?initiative_id=` returns `{"fonts": [{"id","name","size"}]}`:
  - the fonts the move's template set references (use `move_template_set` + `template_code` from `labels/kiosk_templates.py`) that exist in `label_fonts` and aren't deleted;
  - `"missing": [names]` for fonts referenced but not in the library.
- `GET /kiosk/labels/fonts/{font_id}/content?initiative_id=` streams the TTF bytes, but only when that font is in the move's set. Otherwise it returns 404.
- `POST /kiosk/labels/test-render` takes `{initiative_id, template_id, dpi_key}` and returns `{"zpl": str, "template_name": str}`:
  - the template must be in the move's set and active, with `dpi_key` matching the template's own (422 `dpi_mismatch` otherwise);
  - values are a fixed `MOCK_VALUES` dict covering every catalog placeholder: asset_id "100000", asset_name "SAMPLE-SERVER-01", serial_number "SN0000001", make "Dell", model "PowerEdge R740", source/destination site "Sample Site A"/"Sample Site B", raw positions "A1.R01.U12" style, RUs "U12", move_name "Sample Move", and dates;
  - `generation_rules` are applied through `placeholder_values`'s rule helpers;
  - rendering uses `generate/engine.render_label`.
- **Access** for every route copies `/kiosk/sync/label-templates`: `kiosk:view`, `_require_move`, and a 422 for non-move initiatives. Station-key twins are not needed for phase 1, because setup always has a person signed in.

- [ ] **Step 1: Write the failing tests.**
  - `fonts_used` parses the `^A@` and `^CW` variants and ignores built-in fonts.
  - The font list returns library fonts plus missing names.
  - Content streams a move font, and gives 404 for a font outside the move.
  - A move-password session for another move gets 403 `move_locked`.
  - test-render returns ZPL equal to `render_label(template, MOCK_VALUES…)`.
  - A DPI mismatch gets 422.
  - An inactive template, or one outside the set, gets 404.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file and `test_kiosk_label_templates_sync.py`. They pass.**
- [ ] **Step 5: Commit** `feat: kiosk font download and test-label render for Label Station setup`.

### Task 2: Edge — network printer transport and Label Station settings

**Files:**
- Create: `kiosk_laptop/edge/src/edge/printers.py` and `kiosk_laptop/edge/src/edge/routes/printers.py`. Mount the routes under `/edge/printers`, session-gated like `/edge/rfid`.
- Modify: `kiosk_laptop/edge/src/edge/laptop_setup.py`. Add `label_station` to the stored setup: `label_kind`, `printer`, `dpi`, `offset_x`, `offset_y`.
  - It's saved by a new `PUT /edge/label-station` (session) and cleared by Clear Setup and by changing station type.
  - Add `GET /edge/label-station`.
- Modify: `kiosk_laptop/edge/src/edge/config_sync.py`. The edge owns a `label_station` config section mirroring the stored settings, the way it owns `alarm`, and marks the config dirty when they change.
- Test: `kiosk_laptop/edge/tests/test_printers.py` and `test_label_station.py`.

**Interfaces:**
- **Scan:** `POST /edge/printers/scan` → `{scan_id}`, then `GET /edge/printers/scan` → `{state, probed, total, printers: [{ip}]}`. It probes the laptop's subnet (host network info, as `rfid/discovery.py` does) for TCP 9100 with bounded concurrency and timeout, copying discovery's limits.
- **Query:** `POST /edge/printers/query` with `{ip, command}` → `{response}`. It sends the command and reads up to 64 KB, ending at 2 s idle or a 5 s total limit. It is used for `~HI`, `~HS` and `^HWE:*.*`.
- **Send:**
  - `POST /edge/printers/send` with `{ip, zpl}` → `{ok}`.
  - `POST /edge/printers/send-font` with `{ip, font_id, name, initiative_id}` → `{ok}`. The edge fetches the font bytes from the cloud kiosk font route (Task 1) and sends `~DYE:{name},B,T,{len},,` plus the bytes.
- **IP guard:** every route accepts only a private IPv4 address (10/8, 172.16/12, 192.168/16) that isn't the laptop's own address or a network/broadcast address; anything else gets 422 `bad_printer_ip`. Port 9100 is fixed.

- [ ] **Step 1: Write the failing tests.**
  - Use a fake TCP printer server on localhost. Allow the test fixture to override the guard: inject the allowed check rather than special-casing loopback.
  - Scan finds the fake printer.
  - Query returns its `~HI` reply.
  - Send delivers the bytes.
  - send-font streams `~DY` with the exact byte length.
  - Bad IPs (public, loopback, link-local, the laptop's own) get 422.
  - A read exceeding the limits is cut off.
  - Without a session, routes return 401.
  - Label-station settings round-trip, and are cleared by Clear Setup.
  - The config `label_station` section mirrors them and marks the config dirty.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full edge suite. It passes.**
- [ ] **Step 5: Commit** `feat(edge): network Zebra printers on port 9100 and Label Station settings`.

### Task 3: Kiosk — setup steps 4 and 5

**Files:**
- Create:
  - `kiosk/src/lib/stationPrinter.ts`: one interface, `StationPrinter { kind: 'usb'|'network'; identify(); status(); query(cmd); send(zpl); sendFont(font) }`, with a USB implementation over `useZebraPrinter` and a network implementation over the Task 2 edge routes.
  - `kiosk/src/components/setup/LabelKindStep.tsx`
  - `kiosk/src/components/setup/PrinterStep.tsx` (choice, scan or typed IP, the checks list, font install, Finish / Finish anyway)
  - `kiosk/src/components/setup/TestLabelModal.tsx` (alignment or mock label, offsets and Reprint)
  - tests for each
- Modify:
  - `kiosk/src/pages/KioskSetup.tsx`: the Label Station path is Type → Move → Site → **What it prints** → **Printer**.
    - The setup is submitted to the portal after Site as today. The Labeled scan type is unchanged.
    - Steps 4 and 5 follow. Setup completes only after step 5 finishes.
    - The wizard progress reads "of 5".
  - `kiosk/src/lib/api.ts`: add the edge and API calls.

**Interfaces:**
- Consumes Tasks 1 and 2.
- Consumes `getLabelTemplates()` (from `kiosk/src/lib/labelTemplates.ts`) for the DPI check and to pick the mock-label template.
- Consumes `applyPrintSettings` for offsets on every test print.

- [ ] **Step 1: Write the failing tests.**
  - Step 4 shows Top first and selected by default, and stores `label_kind`.
  - Step 5:
    - the USB path runs the checks against a mocked printer;
    - the network path scans and lists printers, and a typed IP works;
    - DPI passes or fails against the templates of the chosen kind;
    - status problems show Recheck;
    - a missing font that's in the library installs, and then the check goes green;
    - a font not in the library stays red with the upload hint;
    - Finish is disabled until everything is green;
    - "Finish anyway" shows for a user session and never for a move-password session.
  - Test modal:
    - the alignment label prints at the chosen size and DPI with offsets applied;
    - the mock label prints the ZPL returned by test-render with offsets applied;
    - a mock template at the wrong DPI is skipped with a note;
    - Reprint uses the new offsets.
  - Settings are saved via `PUT /edge/label-station`.
  - The full path counts out of 5.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full kiosk suite and build. Both pass.**
- [ ] **Step 5: Commit** `feat(kiosk): Label Station setup steps for label type and printer`.

### Task 4: Portal — show the Label Station on the kiosk details page

**Files:**
- Modify the portal kiosk details page (`portal/src/pages/hardware/KioskDetail.tsx` and its Settings / Devices components): a read-only **Label Station** card on the Devices tab, shown when the config has `label_station`. It shows label kind, printer (type, model, IP), DPI and offsets.
- Modify `portal/src/lib/kioskConfig.ts` so the `label_station` section is known and passes through on edits.
- Test: the portal page tests.

- [ ] **Step 1: Write the failing tests.**
  - The card renders from `config.label_station`.
  - It's hidden when the section is absent.
  - An edit to another section keeps `label_station` byte-for-byte.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the portal tests touched and the portal build. Both pass.**
- [ ] **Step 5: Commit** `feat(portal): kiosk details shows the Label Station's printer settings`.
