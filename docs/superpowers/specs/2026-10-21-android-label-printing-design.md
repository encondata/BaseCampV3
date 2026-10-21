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
