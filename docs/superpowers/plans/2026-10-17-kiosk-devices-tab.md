# Kiosk Devices Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Devices shows the RFID reader, the Zebra label printer and a barcode scanner test, each with a status pill, its details, and a bottom-pinned button row.

**Architecture:**
- One new edge route adds the reader details the edge already has.
- The kiosk gets a `DevicesPanel`, rendered by Settings for the `devices` tab, with three card components that share one card shell. The shell pins the buttons to the bottom.

**Tech Stack:** FastAPI + sqlite3 (edge), React + Vitest (kiosk).

**Spec:** `docs/superpowers/specs/2026-10-17-kiosk-devices-tab-design.md`

## Global Constraints

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/devices-tab`, branch `devices-tab`.

**Setup:** `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'` and `npm --prefix kiosk ci && npm --prefix portal ci`. Each is needed only if it's missing.

**Git:** stage by explicit path only, and never stage `.superpowers/`, `.venv` or `node_modules`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites:** run every suite in the FOREGROUND with a 600000 ms timeout.
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`
- Kiosk: `npm --prefix kiosk test -- --run`, then `npm --prefix kiosk run build`

**Copy:** American English.

**Layout:** reuse kiosk idioms: `local-kv`, `chip` with `c-green`/`c-red`/`c-amber`/`c-slate`, `mini-btn`, and `healthChips` from `components/printers/PrinterHealth.tsx`. No raw unstyled controls.

**Fixed values (spec):**
- **Reader pills:** Reading (green), Standby (slate), Offline (red), Not paired (slate), Checking… (slate, shown while busy).
- **Printer pills:** Ready (green); Paper out / Ribbon out / Head open / Paused / Too hot / Too cold (amber, the first problem wins); Not connected (slate).
- **Scanner pills:** Scan to test (slate), then Working (green).
- **Polling:** reader status every 5 s; `/edge/rfid/device` every 30 s; printer `~HS` every 10 s.
- **Scanner burst:** keys under 50 ms apart, ending in Enter.
- **Web-mode reader copy:** "RFID readers connect to a laptop RFID Station."
- **No-WebUSB copy:** "Use Chrome or Edge to connect a Zebra printer."
- **Button rows:** pinned to the card bottom (`margin-top: auto` in a flex column), so the rows line up across cards.

## Review Focus

1. **Busy is not Offline.** `/edge/rfid/status` with `busy: true` shows "Checking…", never Offline. (Task 2.)
2. **The printer is always released.** The USB device is released when the tab unmounts, so Printer tools can claim it afterward. A failing `~HS` never throws out of the poll. (Task 3.)
3. **Scanner test catches only real scans.** Typing at human speed in another settings field is not captured. A captured scan isn't typed into a focused input and doesn't trigger any kiosk scan handler. (Task 2.)
4. **Missing data hides the row.** A value the edge or printer doesn't report hides that row, never showing "undefined" or "null". (Tasks 2, 3.)
5. **Web mode.** There are no edge calls at all: the reader card shows its note and the printer card still works over WebUSB. (Tasks 2, 3.)

---

### Task 1: Edge — `GET /edge/rfid/device`

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py`
- Test: `kiosk_laptop/edge/tests/test_rfid_device.py` (new)

**Interfaces:**
- Produces `GET /edge/rfid/device`, on the existing session-gated `/edge/rfid` router.
  - Returns `{"reader": null}` when not paired.
  - Otherwise returns `{"reader": {"serial","model","ip","paired_at"}, "snapshot": <state.reader_snapshot or null>, "last_read_at": <newest raw_tag_reads.received_at for that reader serial, or null>}`.
  - The snapshot's keys are whatever `reader_report.build_snapshot` produces (`firmware`, `mac`, `uptime_seconds`, `antennas_connected`, `antennas_total`, `tags_24h`, `reachable`, `reading`, `taken_at`, …). Pass it through, using `current_snapshot(state)` so a stale snapshot reads as null.
  - It never contacts the reader.

- [ ] **Step 1: Write the failing tests.**
  - `test_device_unpaired_returns_null_reader`
  - `test_device_returns_pairing_snapshot_and_last_read`: seed a pairing, `state.reader_snapshot` and two raw reads, one for another serial. The response carries the paired reader's newest `received_at` only.
  - `test_device_stale_snapshot_is_null`
  - `test_device_needs_a_session`
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full edge suite. It passes.**
- [ ] **Step 5: Commit** `feat(edge): GET /edge/rfid/device for the kiosk Devices tab`.

### Task 2: Kiosk — Devices panel, card shell, RFID reader card, barcode scanner card

**Files:**
- Create `kiosk/src/components/devices/DevicesPanel.tsx`, `DeviceCard.tsx` (the shell: title, pill, children, a bottom-pinned `actions` slot), `ReaderCard.tsx` and `ScannerCard.tsx`, plus tests next to them.
- Modify:
  - `kiosk/src/pages/Settings.tsx`: render `<DevicesPanel />` for `devices`, and drop it from the placeholder fallthrough.
  - `kiosk/src/lib/api.ts`: add `getReaderDevice()` and its type.
  - `kiosk/src/styles/kiosk.css`: the grid and card shell.
- Reuse `readerState` and `antennasLabel` from `pages/RfidStatus.tsx`. Export them if they aren't already exported. Use the portal's `ageText` and `fullDateTime` from `@portal/lib/format` if importable; otherwise use the kiosk's existing age helper.

**Interfaces:**
- `DeviceCard({ title, pill: {label, tone} | null, children, actions?: ReactNode })`.
- `DevicesPanel` lays out `ReaderCard`, `PrinterCard` (Task 3) and `ScannerCard`. Until Task 3 lands, leave a clearly marked slot where the printer card goes.

- [ ] **Step 1: Write the failing tests.**
  - `reader_card_shows_details_and_reading_pill`
  - `busy_status_shows_checking_not_offline`
  - `unreachable_shows_offline`
  - `not_paired_shows_not_paired_and_no_check_button`
  - `missing_values_hide_their_rows`
  - `check_reader_runs_the_check_and_shows_the_result`
  - `web_mode_shows_note_and_makes_no_edge_calls`
  - `scanner_catches_a_fast_burst_ending_in_enter_and_shows_it`
  - `slow_typing_in_a_field_is_not_captured`
  - `captured_scan_is_not_typed_into_the_focused_input`
  - `clear_resets_scanner_to_scan_to_test`
  - `polls_status_every_5s_and_device_every_30s_and_stops_on_unmount`
  - `button_rows_use_the_bottom_pinned_actions_slot`: the actions render inside the shell's actions element.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Use the spec's details list; ages show the full time on hover. The scanner capture listens on `window` in the capture phase only while the panel is mounted. When a burst completes, call `preventDefault` on the Enter and remove the burst's characters from any input they reached, or block keys once a burst is detected.
- [ ] **Step 4: Run the full kiosk suite and the build. Both pass.**
- [ ] **Step 5: Commit** `feat(kiosk): Settings › Devices with the RFID reader and a barcode scanner test`.

### Task 3: Kiosk — Label printer card

**Files:**
- Create `kiosk/src/components/devices/PrinterCard.tsx` and its test.
- Modify `DevicesPanel.tsx` to put it in the slot.

**Interfaces:**
- Consumes the `useZebraPrinter()` hook from `lib/useZebraPrinter.ts`: `supported`, `connected`, `productName`, `connect`, `connectTo`, `disconnect`, `identify`, `status`, `send`, `knownDevices`.
- Consumes `healthChips` from `PrinterHealth.tsx`.

- [ ] **Step 1: Write the failing tests.** Mock the hook.
  - `no_webusb_shows_chrome_or_edge_note`
  - `not_connected_shows_connect_button`
  - `auto_connects_to_an_already_allowed_printer`
  - `connected_shows_model_firmware_dpi_usb_and_ready_pill`
  - `paper_out_status_shows_amber_paper_out_pill_and_chips`
  - `status_refreshes_every_10s_and_a_failure_never_throws`
  - `print_test_label_sends_zpl_with_kiosk_name_and_dpi_sizing`
  - `other_allowed_printers_are_listed_and_switchable`
  - `disconnect_and_unmount_release_the_printer`
  - `printer_tools_link_only_where_label_printing_is_reachable`
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - The test label is ZPL from a small pure function, `testLabelZpl(kioskName, when, dpi)`, with a border and three text lines.
  - It fits a 2×1 in label at 203 dpi and scales by dpi/203.
- [ ] **Step 4: Run the full kiosk suite and the build. Both pass.**
- [ ] **Step 5: Commit** `feat(kiosk): Devices label printer card with status, test label and switching`.
