# Android label printing (with a shared TypeScript label generator): design

Date: 2026-10-21. Builds on `2026-10-19-label-station-printing-design.md` (whose
"phase 4: Android" this replaces), `2026-10-19-label-station-printing-station-design.md`
(the laptop's edge generation and Printing Station), `2026-10-19-kiosk-label-templates-sync-design.md`
(which templates a kiosk syncs), `2026-10-19-label-builder-design.md` (schema 2
designs, the Python compiler) and `2026-09-15-android-kiosk-design.md`.

## 1. Why

Crews put asset labels on equipment with the Android kiosk at the site. Each
label is printed by scanning the asset's barcode, which sends raw ZPL to a
Zebra printer on the network, and the scan is recorded as **Labeled**. Today
Android has only a placeholder Label Printing tile. The laptop Label Station
already does this, and works perfectly.

The Android device must keep printing with **no internet**, from what it
synced (Jimmy).

## 2. Goals, non-goals, anti-goals

**Goals**
- Android prints asset labels by scan, offline, from synced data, with labels
  byte-identical to the laptop's and the portal's for the same asset,
  template and DPI.
- A **TypeScript label generator** that runs on the device. Android uses it
  now; iOS and a web kiosk (USB printing in Chrome or Edge) can adopt it later
  unchanged.
- Printer setup on Android: find a network Zebra (scan or manual IP), a
  Bluetooth placeholder, printer checks, font check and install, test labels,
  offsets and peel mode.

**Non-goals (this project)**
- **No change to the laptop kiosk** or its edge generator (Jimmy: "working
  perfectly").
- **No server-side ZPL generation** for kiosks (Jimmy). The API keeps sending
  data and templates only.
- iOS and the web kiosk (later phases, Jimmy).
- Bluetooth printing (placeholder only).
- A dedicated Android "Label Station" mode. Android uses its normal menu and
  the Label Printing tile (Jimmy).
- Labels with pictures (schema 3, badges). Asset labels don't use them.
- Bulk Print.
- **Container labels** (Jimmy: the containers flow comes later). The Label
  Printing tile's description changes to say asset labels only for now.

**Anti-goals**
- A phone label that differs by even one byte from the laptop's for the same
  inputs. That is the failure the generator must be built to prevent.
- Printing that stalls or fails because the connection to the portal dropped.
- Re-downloading or regenerating everything when nothing relevant changed.
- Status checks or polling added to the print path (house rule: the print
  path sends ZPL straight to the printer).

## 3. Decisions (Jimmy)

- **Generate on the device**, not on the server. The reasons are bandwidth and
  flaky connections: once the move is synced, a printer swap, a DPI change or
  top/front change rebuilds locally.
- **One shared generator in TypeScript**, so Android, iOS and the web can use
  the same code. Android runs it in a JavaScript engine; iOS will use the
  built-in JavaScriptCore; a web kiosk would run it directly.
- **Phases:** Android now; iOS and the web kiosk later.
- **Setup** asks once whether this device prints **top** or **front** labels;
  changing it means running Kiosk Setup again.
- **Printer:** find network Zebras by scanning, or type an IP. Show Bluetooth
  as "coming soon".
- **Peel mode** works like the laptop: the printer must report a peeler, and
  in peel mode the printer holds the next label until this one is taken
  (`^MMP`), with no extra polling.
- **Test labels** for alignment and offsets, like the laptop.
- **Font check and missing-font install**, like the laptop.
- The scan type recorded for a printed label is **Labeled**.

## 4. The shared TypeScript label generator

**What it is.** A faithful port of the Python label code the laptop uses
(`api/src/serversherpa/labels/`), limited to what asset labels need:

| Python module | Role |
|---|---|
| `pick.py` | template choice: Top = destination → source → global (not Generic) → Generic Rack and RU; Front = destination → global; a step with no version at the printer's DPI falls through; ties go to version, then `updated_at` |
| `label_values.py`, `tokens.py` | the placeholder catalog and `{token}` fill for code templates and schema 1 designs |
| `fields.py`, `field_rules.py` | schema 2 field values from the asset, its `label_context` and its From-To columns, with Split and the field rules |
| `model.py` (schemas 1–2), `zpl.py`, `qr.py`, `barcode.py`, `compile.py` (ZPL path only), `render.py` | design parse and the ZPL compiler |
| `template_fonts.py`, `fonts.py` | which printer fonts a template needs; font objects |
| `tags.py`, the constants and `Bitmap` type from `dither.py` | small helpers the modules above import |
| `kiosk_laptop/edge/src/edge/labels/generate.py` (`build_plan`, `render_job`, fingerprints) | per-asset plan, the `no_template_at_dpi` / `template_failed` / `template_unsupported` outcomes, change detection |

It is **pure**: inputs are the synced assets (with `label_context` and
From-To columns), the synced template set, label kind and DPI (label size
comes from each template's `width_in`/`height_in`; the move day comes from
`label_context`); output is finished ZPL per asset plus its outcome and
fingerprint. No I/O, no clock, no platform APIs. From the edge's
`generate.py` only the logic is ported (`build_plan` there reads the edge's
store).

**Porting traps the builder must honor:** Python's `round()` is
round-half-to-even (used for dots, font sizes and magnification in
`zpl.py`), and `Decimal.normalize()` formatting must be reproduced exactly;
the reference suite must include cases that exercise both. The port is about
2,500 lines of Python in all (model 620, fields 526, zpl 383, label_values
198, the rest small).

**Keeping it identical.** A **reference-label suite**: a Python script in
the repo generates fixtures (inputs and the exact ZPL Python produces) over
a broad set of templates, assets, DPIs, both kinds, field rules, QR and
Code 128 edge cases and non-ASCII text. The TypeScript tests must reproduce
every fixture byte for byte. Regenerating fixtures is one command, and a
test fails when the fixtures are older than the Python label code they came
from, so a portal compiler change cannot drift silently.

Unsupported input (schema 3 or newer, an ESC/P or P-touch language) yields
`template_unsupported`, never a wrong label.

**Packaging.** One bundled JavaScript file with a tiny call surface
(e.g. `buildPlan(input) -> plan`, `renderLabels(plan, changedOnly) -> results`),
built from the TypeScript source and copied into the Android app's assets at
build time. *(Builder's call: location in the repo and the build tooling.)*

**Running on Android.** Jetpack JavaScriptEngine (`androidx.javascriptengine`),
which runs the bundle in an isolated V8 sandbox from the system WebView
(the app's minSdk 30 is fine; support is decided at runtime by
`JavaScriptSandbox.isSupported()`). Results cross a Binder boundary (about
1 MB), so generation runs **in batches** of assets, or uses
`EVALUATE_WITHOUT_TRANSACTION_LIMIT` where available. The app checks support
at startup; a device without it says label generation
isn't supported on this device instead of failing silently. *(Builder: confirm
the Zebra devices in use support it; if not, report before choosing another
engine.)*

## 5. Android: setup and sync

- **Kiosk Setup** gains a step after scan type: **What do labels print on?**
  with Top and Front cards (same card idiom as the other steps).
- **Sync** additionally downloads, with the existing assets/people/containers/
  trucks sync:
  - the move's label templates (`GET /kiosk/sync/label-templates`), as the
    web kiosk already does;
  - each asset's full payload as the API sends it (including `label_context`
    and the From-To columns the templates place), which Android currently
    drops; *(my call: store each asset's raw JSON so the generator sees
    exactly what the edge sees)*;
  - the fonts those templates use (`GET /kiosk/labels/fonts` and each
    `/kiosk/labels/fonts/{id}/content`), so a missing font installs offline.
  The local database gets its **first migration** (Room is at version 1 with
  no migration history): set up schema export and a real migration so devices
  upgrade without crashing or losing their outbox.
- **Progress:** sync shows each part as it goes (assets, people, containers,
  trucks, templates, fonts), then **label generation** shows its own
  progress (n of N), using the generator's per-asset results.
- **When labels rebuild:** after a sync, a Kiosk Setup save (top/front), or a
  printer change that changes the DPI, regenerate only assets whose
  fingerprint changed, as the laptop does. Offsets and peel/tear are applied
  when a label is sent (as the laptop's print queue does), so they never
  trigger a rebuild, and the **stored** ZPL is what matches the laptop byte
  for byte. Results (ZPL, outcome, fingerprint) are stored
  in the local database.
- The templates sync stays soft, as on the web kiosk: a refusal keeps the
  previous set and records the error.

## 6. Android: Label Printing tile

The existing placeholder becomes a real screen with two sections:

**Print Labels**
- Scan input from everything the app already supports (DataWedge, Bluetooth
  scanner, camera). Matching by Asset ID or serial against the local assets,
  as the laptop's Printing Station does.
- A match sends the stored ZPL, with the saved offsets and the peel/tear
  mode applied, straight to the printer over TCP port 9100.
- Each print of a scan records one **Labeled** scan (`scan_type: barcode`,
  status `labeled`) through the existing outbox, so it uploads whenever the
  device is online. A **Reprint** never records again.
- Clear messages: no printer set up; asset not found; no label for this asset
  (with the reason: no template at this DPI, template failed, template too
  new for this app); labels still generating; printer unreachable.
- Shows how many labels are ready, and how many couldn't be made and why.

**Printer Setup**
- **Choose printer:** Scan the network (find Zebras on the device's subnet,
  showing model, serial and DPI), Enter an IP, or **Bluetooth — coming soon**
  (shown, disabled).
- **Checks**, as the laptop's setup step 5: the printer answers (`~HI`), its
  DPI, its status (`~HS`), whether a peeler is present
  (`sensor.peeler_present`), and fonts (`^HWE:*.*` against the fonts the
  picked template needs), with **Install missing fonts** from the synced
  copies (`~DY`).
- **Test labels:** the alignment label and a sample label built by the
  device's own generator from made-up data (no server render).
- **Offsets** (top and left, in dots) and **Peel or tear** mode, saved on the
  device and applied at send time (`applyPrintSettings`, `withPrintMode`).
- *(My call)* Printer, offsets, peel/tear and top/front are stored on the
  device for now. When Android joins the portal's per-kiosk config document
  (that feature's pending Android phase), they move into it.

The network transport (socket, scan, `~HI`/`~HS`/`^HW` parsing) is native
Kotlin. The ZPL builders for alignment, offsets and print mode come from the
shared TypeScript where they already exist in the portal
(`portal/src/lib/printLabels.ts`, `portal/src/labels/zebraCommands.ts`).
*(Builder's call: reuse through the bundle or port the few small builders.)*

## 7. API

No new endpoints. The phone uses what the web kiosk and edge already use:
`/kiosk/sync/assets`, `/kiosk/sync/label-templates`, `/kiosk/labels/fonts`,
`/kiosk/labels/fonts/{id}/content`, `/kiosk/scans`. Kiosk Setup on Android
does not send a station type (Android has no station mode), so the API's
Labeled-forcing for Label Stations doesn't apply: the Label Printing screen
sends `labeled` on each print scan itself. *(Builder: confirm `/kiosk/scans`
accepts a per-scan `scan_status` override for a person session.)*

## 8. Calls I made

- **The portal's existing TypeScript label code is not refactored** onto the
  new generator in this project (risk to the label builder). The reference
  suite protects the new generator; consolidating the portal's copies is a
  later cleanup.
- **Top/front in Kiosk Setup** has Top preselected, so a kiosk that never
  prints passes the step with one tap.
- Asset raw JSON stored locally; settings on the device (above).

## 9. Left to the builder

- Where the TypeScript generator lives and how it's bundled.
- Database migration shape, screen layout within the app's existing idioms.
- How the subnet scan finds Zebras (e.g. probing port 9100 and asking `~HI`),
  within a bounded time.
- Test structure on each side.

## 10. Later (named, not built)

- iOS: the same bundle via JavaScriptCore, native socket and screens.
- Web kiosk: the same bundle in the browser, USB Zebra via WebUSB in Chrome
  or Edge (network printers are out of reach from a browser).
- Bluetooth printing.
- Schema 3 (pictures) in the shared generator.

## Implementation notes

Written after the build (branch `android-labels`, plan
`docs/superpowers/plans/2026-10-21-android-label-printing.md`). It records
what shipped, the rulings made on the way and what is still open.

### The generator

- It lives in `kiosk/src/labelgen/` (the kiosk package already has vitest and
  vite, and is the future web adopter). Every file is pure ECMAScript: no
  DOM, `Intl`, `TextEncoder`, Node or `console`, because the Android sandbox
  has none of them. Each file's header names the Python it ports.
- The surface is a few functions on `globalThis.labelgen`, all taking and
  returning JSON strings (`buildPlan`, `renderLabels`, `applyPrintSettings`,
  `withPrintMode`, `alignmentTestZpl`, `sampleLabel`). A failure comes back as
  `{error}`, never a throw across the boundary.
- Asset payloads are read with a number-preserving JSON reader (`pyjson.ts`)
  so `12.0`, `7` and `1e-05` print as Python prints them. Python's `round()`,
  floor division, code-point string handling, `Decimal` and `str()` rules are
  ported on purpose (see the porting traps in section 4).
- Fingerprints are cyrb53 over canonical JSON, not Python's sha256. They are
  device-local, so they only need to be stable here.

### Reference labels

- `kiosk/src/labelgen/fixtures/reference.json` holds what the laptop's own
  code path prints: 55 cases, 243 labels (built-in designs at 203/300/600,
  schema 1 and 2, code templates, pick order, generation and field rules,
  QR and Code 128 values, odd names, raw From-To values, RU forms, no-data and
  bad-design cases).
- `make_reference.py` seeds a temporary edge store the way the edge tests do
  and calls the edge's real `build_plan` and `render_job`. It imports the
  built-in designs rather than copying them. Regenerate from the repo root
  with the api venv (it needs sqlalchemy):
  `api/.venv/bin/python kiosk/src/labelgen/fixtures/make_reference.py`.
  The script puts `api/src` and `kiosk_laptop/edge/src` on `sys.path` itself,
  so no `PYTHONPATH` is needed.
- `reference.json` records a `source_hash` over `api/src/serversherpa/labels/*.py`
  and the edge's `labels/generate.py`. `reference.test.ts` recomputes it and
  fails with "Regenerate ..." when the Python changes, so the TypeScript
  cannot silently fall behind the laptop. The test then holds every ZPL
  byte-identical, or the same outcome code, and checks the plan (template id,
  notes, DPIs, fonts).

### The bundle

- `npm --prefix kiosk run build:labelgen` writes
  `Android_Kiosk_App/app/src/main/assets/labelgen.js` (an unminified IIFE,
  `es2020`, about 86 KB, byte-stable across rebuilds). It is committed so the
  Gradle build needs no Node.
- `bundle.test.ts` fails when the committed file differs from a fresh build
  ("run npm --prefix kiosk run build:labelgen"), greps it for anything outside
  the ES built-ins, and runs it in a bare `vm` context with every host global
  deleted, comparing one reference case.
- The IIFE is named `labelgenModule`, not `labelgen`, so it cannot overwrite
  `globalThis.labelgen`.

### Android

- **Database.** Room goes to version 2 with `MIGRATION_1_2`: `assets.payload_json`
  (default `'{}'`) plus `label_templates`, `label_fonts` and `generated_labels`.
  Schemas are exported to `app/schemas/` (v1 was exported before any change)
  and `MigrationTest` upgrades a real v1 file, keeping the outbox. The schemas
  also ride in debug APKs only, because Robolectric reads merged assets.
  There is no destructive fallback: the outbox must survive.
- **Sync.** The assets and templates bodies are fetched raw and each asset's
  element text is stored verbatim, so number literals survive. Sync now shows
  six parts (assets, people, containers, trucks, templates, fonts) with
  Waiting/Running/Done/Failed. Templates and fonts are soft: a failure keeps
  the previous set on the same move. Resident fonts (by name or a 403
  `font_not_servable`) are never downloaded; other fonts go to
  `filesDir/label-fonts/<id>.ttf` (temp file, then rename).
- **LabelBuilder** runs `androidx.javascriptengine` (1.1.1) in a V8 isolate.
  Build order: unsupported device, no sync data (`needs = SYNC`, nothing
  pruned), no printer (`needs = PRINTER`), `buildPlan`, then changed jobs
  (fingerprint differs) in batches of 200, then prune assets no longer on the
  move. A batch carries only its own payloads (verified equal on all 243
  reference labels), which keeps render time linear: about 2.9 s for 8,000
  assets on a Mac, versus 20 s with the full body per batch.
  - Bounded transfers: without `EVALUATE_WITHOUT_TRANSACTION_LIMIT`, arguments
    and results move in 64K-character pieces measured after escaping, never
    splitting a surrogate pair, and batches shrink to 50.
  - Timeouts: 120 s plan, 60 s render, 5 s print helpers, 30 s connect. A
    timeout closes the isolate and sandbox (closing is what stops the
    script); a dead sandbox is replaced and the call retried once.
  - Cancel safety: a new `rebuild()` cancels the running one at once; every
    write re-reads the move meta in the same transaction and aborts if the
    move changed or was cleared. A kind or DPI change rebuilds on its own; a
    build error keeps whatever is stored.
- **Printer core.** `NetworkZebra` (port 9100; one connection per command;
  `~HI`, `~HS`, `^HWE:*.*`, peeler and serial getvar, `send`, `installFont`)
  and `ZebraScanner` (64-way probe, `~HI`, 10 s budget, scans each connected
  Wi-Fi/Ethernet network through its own socket factory, RFC 1918 only).
  Reply parsers are pure Kotlin in `core/printer/` and tested against the
  edge's real ZD421 and ZT220 replies. `installFont` refuses names that could
  inject ZPL into the `~DY` header.
- **Kiosk Setup** has a fourth step, Top or Front (Top preselected; `labelKind`
  in the saved selection, defaulting to Top for older saves). Printer, offsets
  and peel are stored on the device (`ss.kiosk.labels`), per section 6.
- **Print Labels.** A port of the web kiosk's print queue: one job at a time,
  Queued, Sending, Printed or Failed, Retry resends the exact bytes built the
  first time, Reprint never records. Offsets and peel are applied at send
  through `applyPrintSettings` then `withPrintMode`. The send and the Labeled
  scan (`barcode`, `labeled`, per-scan `scan_status`, which `/kiosk/scans`
  accepts) are one non-cancellable step, so a label that went out is always
  recorded. A send that times out says the label may have printed and records
  nothing.
- **Printer Setup.** Choose by scan or typed IP (Bluetooth shown, disabled);
  checks for the printer, DPI against the picked template, status, peeler and
  fonts; Install missing fonts from the synced copies; alignment and sample
  test labels; offset fields and a peel switch. All printer calls take one
  VM-wide lock, so a test label waits for a running check.

### Rulings

- Non-ZPL templates (ESC/P, P-touch) are `template_unsupported` on Android,
  where the laptop would compile them. Cost: none for Zebra printing.
- The generator lives in `kiosk/src/labelgen` and its bundle is committed with
  a freshness test instead of running Node inside Gradle. Cost: one extra
  build command when labelgen changes.
- Font bytes are files under `filesDir`, not Room BLOBs (CursorWindow 2 MB
  limit). Cost: none.
- The live test sends to a fake ZPL listener on a Mac; the ZD421 at
  10.10.48.67 gets only read-only queries, and the ZT220 at 10.10.48.90 is
  sent nothing.
- Decimal values with an exponent beyond 1e6 throw in labelgen where Python
  would print them. Cost: one unlabelable absurd asset (`template_failed`).
- The reference generator runs with the api venv and imports the built-in
  designs, so a design change marks the fixtures stale. Cost: none.
- On a move change, a failed templates or fonts download clears the old move's
  rows (the plan said keep them), since old templates would pick wrong-move
  labels. Cost: no labels until the next good sync on the new move.
- The chosen printer's connect timeout is 3 s and the scan probe's is 500 ms
  (the constraints' 500 ms read as the probe, matching the edge). Cost: a dead
  chosen printer takes 3 s to report.
- The printer serial comes from the read-only `getvar "device.unique_id"`,
  sent only after `~HI` named a Zebra, because `~HI` has no serial. Cost: one
  extra query per printer; the reply format is unconfirmed on the ZD421.
- Every print scan is refused while a label build runs (laptop parity).
  Cost: short waits after a sync.
- The Labeled scan's time is the enqueue time (`EnqueueInput` has no scan
  time; a Retry records the retry time). Cost: `scanned_at` is off by the
  print or retry delay.
- Rapid double scans print and record twice (laptop parity). Cost: a duplicate
  label if a scanner double-fires.
- A Not Present peeler check flips a saved peel setting to tear-off (the web
  kiosk takes peel from the same check); the row says so. Cost: none.
- Check again that finds a different DPI or model at the same address updates
  the saved printer, which rebuilds. Cost: a rebuild.
- Printer checks run on save and Check again, not when the screen opens.
  Cost: one tap; easy to change if Jimmy wants an automatic check.
- ZPL injection through code-template placeholder values (`render.ts`) is kept
  as is: it mirrors the Python `tokens.py` byte for byte. Escaping belongs in
  the shared Python, fixed for the portal and the edge together; the source
  hash then forces the TypeScript to follow. Cost: the same exposure as the
  laptop until then. Surface this to Jimmy.

### Open follow-ups

- **ZPL injection** (above), shared with the laptop. One fix in Python plus a
  regenerated reference file closes it everywhere.
- **Live checks owed:** emulator against the dev API on a cloned database
  (sign in, setup with Top, sync progress with templates and fonts, build
  progress, support detection and the transaction-limit feature, real
  timings); Printer Setup and a print against a fake ZPL listener, comparing
  one captured label byte for byte with the laptop's for the same
  asset, template and DPI; read-only `~HI`, `~HS` and `^HW` on the ZD421, plus
  the serial getvar reply; the offset keypad on a TC-series handheld
  (it uses the phone keypad because Compose's number pad has no minus sign);
  the VPN exclusion in `LocalNetworks`.
- **Test gaps:** no Compose tests for the Print Labels, Labels home, Printer
  Setup or test-label screens (the view models and queue are tested). A
  kiosk test should pin that a label depends only on its own asset, the
  context and the templates, since batches rely on it. The committed bundle
  should be run over every reference case in the bare `vm`, and the
  host-global ban list extended (`setTimeout`, `structuredClone`, `atob`,
  `btoa`, `queueMicrotask`).
- **Deferred minors worth naming:**
  - A build ERROR leaves changed-but-unrendered rows printing their old ZPL
    (the laptop does too; the header shows the error).
  - Fonts: stray files after a partial failure; the fonts clear on failure
    runs outside the transaction; the resident list is duplicated in
    Kotlin, TypeScript and the server.
  - `installFont` allows hyphenated or long names the `^HW` parser never
    lists (an edge and portal parity gap).
  - A Room read failure before `buildPlan` still leaves the DPI check
    waiting its full 30 s; a stale failed pick can show briefly after a resync.
  - A refusal during the plan step reads "(0 of 0)"; "Labels are being
    prepared" would be clearer.
  - Printer Setup has no Cancel for a running scan (leaving cancels it).
  - Memory: large asset bodies are held about 3 to 4 times over during sync
    and double-escaped in the engine call; watch it on low-memory handhelds.
  - `zebraSession` maps only `IOException`; runtime exceptions from a block
    escape raw on chosen-printer calls.
  - A plain coroutine cancellation does not stop a running script; it ends
    within its own timeout while the next call queues behind it.
  - APK grows 2 to 3 MB from Guava (release builds are not minified).
  - Integers past 2^53 lose precision in labelgen (no real label gets near).
  - Labelgen internals: `model.ts` is 704 lines and an `own`/`has` helper is
    duplicated; `sampleLabel`'s `reason` mixes notes and codes; the plan's
    font lookup swallows errors.
