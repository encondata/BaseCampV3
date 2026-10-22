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
- Digit checks use `\p{Nd}` regex property escapes (Python's `int()` and
  `isdigit()` read any decimal digit). That is ES2018 syntax, not `Intl`, but
  V8 answers it from ICU data; a V8 without it can't parse the bundle, so the
  failure is loud (the version check), never a wrong label. The header of
  `plan.ts` says so.

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
  the ES built-ins and host globals (`setTimeout`, `setInterval`,
  `structuredClone`, `atob`, `btoa`, `queueMicrotask`, `console`), and runs
  every reference case through it in a bare `vm` context with every host
  global deleted, by the JSON surface alone (plan, fingerprints and labels).
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
  - The move meta, label context, payloads and templates are read in one
    Room transaction, so a sync can't land between the reads.
  - `buildPlan` goes in chunks of 500 assets (`PLAN_CHUNK`), never the whole
    move in one call: an 8,000-asset move with From-To columns can be 10 to
    20 MB of text, enough to run a low-memory handheld's isolate out of
    memory on every try. The template pick, notes, fonts, DPIs and
    `hasAssetData` depend only on the templates and the label context, so
    `combinePlans` requires every chunk to agree on them (an error if not)
    and concatenates the jobs in order. An empty move still plans once.
  - Bounded transfers: without `EVALUATE_WITHOUT_TRANSACTION_LIMIT`, arguments
    and results move in 64K-character pieces measured after escaping, never
    splitting a surrogate pair, and batches shrink to 50.
  - Timeouts: 120 s plan (per chunk), 60 s render, 5 s print helpers, 30 s
    connect. A timeout closes the isolate and sandbox (closing is what stops
    the script); a dead sandbox is replaced and the call retried once.
  - One sandbox per process: javascriptengine binds one sandbox at a time
    and fails every other connect ("Binding to already bound service")
    until it is closed. A connect given up on (cancelled, or past the 30 s
    connect timeout) is left to finish rather than cancelled (cancelling the
    future unbinds without freeing the library's flag), its sandbox is closed
    as it arrives, and the next connect waits for that first
    (`FutureConnector`). An "already bound" failure counts as a dead sandbox:
    retried once, and every later call tries again.
  - The isolate gets a 512 MB heap cap where the sandbox supports one
    (`JS_FEATURE_ISOLATE_MAX_HEAP_SIZE`), so a runaway ends as a terminated
    isolate rather than a crashed sandbox process. `maxBatch()` connects
    first, so it never answers an unbounded batch before the first call.
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
- Every print scan is refused while a label build runs (laptop parity),
  "Labels are being prepared." during the plan step and "Labels are still
  being made (n of m)." after. Cost: short waits after a sync.
- Every print scan is also refused while a sync runs ("This kiosk is
  syncing. Labels will be ready shortly."): the build that follows hasn't
  started, so a stored label may be for the data the sync replaces. Cost:
  no printing for the length of a sync.
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
  context and the templates, since batches and plan chunks rely on it. The
  sandbox recovery and the heap cap are unit-tested over fakes only; the
  real library's behavior needs the emulator check above.
- **A sync never stays RUNNING:** Print Labels refuses while the sync phase is
  RUNNING, so `Sync.runNow` now guards everything after the write transaction
  (the counts, the part updates and the fonts step). An unexpected throw ends
  the sync in ERROR (`storage`); the font step's own failure cleanup is best
  effort, so a cleanup that throws too still ends DONE with `labelsError`.
  The counts guard has no test of its own (no seam makes a DAO count throw).
- **Kiosk Setup shows the label parts:** the summary's "Local data" line adds
  label templates and fonts when those parts finished, a running sync lists
  all six parts with their state, and a failed templates or fonts download
  shows a warning line (`SyncSummary.kt`).
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
  - Printer Setup has no Cancel for a running scan (leaving cancels it).
  - Memory: large asset bodies are held about 3 to 4 times over during sync;
    each engine call is now one plan chunk or one render batch, but the
    payloads are still all in memory on the Kotlin side during a build.
  - `zebraSession` maps only `IOException`; runtime exceptions from a block
    escape raw on chosen-printer calls.
  - A plain coroutine cancellation does not stop a running script; it ends
    within its own timeout while the next call queues behind it.
  - APK grows 2 to 3 MB from Guava (release builds are not minified).
  - Integers past 2^53 lose precision in labelgen (no real label gets near).
  - Labelgen internals: `model.ts` is 704 lines and an `own`/`has` helper is
    duplicated; `sampleLabel`'s `reason` mixes notes and codes; the plan's
    font lookup swallows errors.

## iOS implementation notes

These notes were written after the iOS build (branch `ios-labels`, based on `android-labels`, with plan
`docs/superpowers/plans/2026-10-21-ios-label-printing.md`). iOS follows the Android behavior above. The
items below are where it differs, and why.

### Store

- SwiftData gets its first versioned schema, V1 → V2, through one lightweight migration. Golden
  entity-hash tests freeze V1 and V2. V2 must stay frozen before any V3 is added.
- A store that won't open is classified before anything is moved:
  - protected data unavailable, a store that is compatible but won't open, or an unknown version:
    the app runs in memory with no move, and nothing is moved;
  - a corrupt SQLite store (code 11/26): the whole store folder is moved aside to
    `serversherpa-kiosk.store.failed-<ts>/` and its unsent outbox is saved first.
  - The old fallback never actually deleted anything, so a transient failure used to heal itself. Moving
    the store aside unconditionally would have stranded unsent scans.
- `KioskStore` is a hand-written `ModelActor` with a custom `SerialModelExecutor` on its own queue.
  SwiftData's default executor runs each job on the caller's thread, which was the main thread for the
  view models, sync and the outbox, and a large label build would have frozen the screen. The
  `ModelContext` is created lazily on that queue, never on the caller's thread: a context made on the main
  thread is a UI context with main-thread autosave until SwiftData converts it. Guard tests pin both
  behaviors. Core Data's concurrency debugging does not catch `ModelContext` misuse on iOS 18.

### Generator (JavaScriptCore)

- The same bundle is copied to `IK/Resources/labelgen.js`. `build:labelgen` writes both copies, and
  `bundle.test.ts` asserts that both match a fresh build.
- Each context gets its own `JSVirtualMachine` and a dedicated thread. Calls are serialized by a Swift
  async gate, so a waiting call never queues on an abandoned thread.
- JavaScriptCore can't be interrupted. A call that times out, or whose caller is cancelled, abandons its
  context and thread, and the next call starts a fresh one. The cost is a leaked thread until the runaway
  finishes, plus one bundle reload.
- The 30 s start limit mirrors Android's `CONNECT_TIMEOUT_MS` and gives `.timeout`. Any other start
  failure is `.unsupported`. The unsupported copy on iOS is "This device can't make labels. Restart the
  app; if it keeps happening, the app needs an update." (Android's WebView wording doesn't apply.)

### Printer (Network.framework)

- The scan sends plain `~HI`, as Android does. STX framing belongs to the reply.
- Probes and connections to a host inside the device's `en*` RFC 1918 subnets prohibit cellular. That
  matches Android binding the socket to the Wi-Fi/Ethernet network. USB Ethernet is still allowed.
- Local Network permission uses `NSLocalNetworkUsageDescription`. A connection still `.waiting` past the
  connect budget counts as unreachable. When every probe is denied by policy, the scan says "Allow Local
  Network access for ServerSherpa Kiosk in Settings to find printers." On the first run the system prompt
  may still be up during the first scan, so Printer Setup scans again once, when the app returns to the
  foreground or after 2 s. The message only shows if that second scan is also denied.
- One app-wide `PrinterLock` serializes every connection to the saved printer: Printer Setup's identify,
  checks, font installs and test labels, plus Print Labels' send. It adds no check, poll or wait of its own.

### Print Labels

- Diverges from Android on purpose: labels already scanned keep printing and recording after the screen
  closes. Android drops the jobs still waiting.
  - One app-lifetime queue lives in `AppContainer`, so a re-entered screen can never interleave labels.
  - Each job captures its move and site at scan time.
- Signing out, a session that ends, and a change to the setup's move or site reset the queue:
  - jobs still waiting are dropped;
  - the list clears;
  - a label already going out finishes on the printer but records nothing.
- A Labeled scan records only if, in the same main-actor turn, the kiosk is still signed in on the job's
  move and site. Retry and Reprint refuse another move's entry with "This label is from another move."
  (new copy, with no Android equivalent).
- When `ios-clear-setup` merges, server Clear Setup must reset the print jobs too, by calling
  `printJobs.reset()` or writing `setupSelection = nil`.

### Still owed (device)

- On a real iPad with the ZD421:
  - the Local Network prompt and the denied path;
  - the scan finding the printer;
  - a real print, peel mode and font install;
  - one label compared byte for byte with the laptop's output.
- Large-move build time and memory on iPad hardware.
- A sync and scan smoke test on the new store executor.
- The live layout in landscape on iPad and iPhone.
- `storeIsTemporary` (a store running in memory) has no UI yet.
