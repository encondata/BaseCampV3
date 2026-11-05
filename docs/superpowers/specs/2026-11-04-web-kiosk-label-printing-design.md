# Web kiosk label printing: design

Date: 2026-11-04. Builds on `2026-10-21-android-label-printing-design.md`
(the shared TypeScript generator, whose "Later" section names this phase),
`2026-10-19-label-station-printing-station-design.md` (the laptop's Printing
Station and print queue) and `2026-10-19-kiosk-label-templates-sync-design.md`.

## 1. Why

The web kiosk's Label Printing tile has three sections. Printer Setup /
Troubleshooting works (WebUSB Zebra tools), but **Printing Station** and
**Bulk Print** are "Coming soon" placeholders. The laptop Label Station,
Android and iOS all print asset labels by scan already. Jimmy: bring the
printing we already have to the web kiosk.

Jimmy asked for no further questions, so every choice below not quoted from
an earlier ruling is **my call**, marked as such.

## 2. Goals, non-goals, anti-goals

**Goals**
- The web kiosk's Printing Station prints asset labels by scan, the way the
  laptop's does: scan box always focused, match by asset ID or serial against
  the synced move, label sent straight to the printer, one **Labeled** scan
  recorded per scan (never on Reprint), Reprint / Retry, flash + sound.
- Labels are generated **in the browser** by the shared generator
  (`kiosk/src/labelgen`), byte-identical to the laptop, Android and iOS for
  the same asset, template and DPI.
- Printer setup on the web kiosk with the same checks as the laptop's step 5:
  printer answers, DPI matches the templates, ready to print, peeler, fonts
  (with install), test labels, offsets, peel or tear.
- Printing keeps working with **no internet** once the move is synced.

**Non-goals**
- **No change to the laptop kiosk's behavior** (Jimmy: "working perfectly").
  Shared components may be refactored only where the laptop path stays
  identical, which its existing tests must prove.
- No server-side ZPL generation (Jimmy, Android ruling).
- Network printers: a browser can't open a TCP socket, so the web kiosk
  prints over **USB only** (WebUSB, Chrome or Edge on HTTPS or localhost).
- Bluetooth (Web Bluetooth) printing.
- Bulk Print (stays a placeholder; no kiosk has it).
- Container labels (Android ruling: the containers flow comes later).
- Putting the web label settings into the portal's per-kiosk config document.

**Anti-goals**
- A web label that differs by one byte from the laptop's for the same inputs.
- Any status check, poll or wait added to the per-label print path (house
  rule, `feedback-no-unrequested-printer-checks`): labels go straight to the
  printer, and in peel mode the printer itself holds the next one.
- The page freezing while labels generate.
- Regenerating everything when nothing relevant changed.

## 3. Decisions carried over (Jimmy, earlier phases)

- Generate on the device, with the one shared TypeScript generator.
- The device asks once whether it prints **Top** or **Front** labels.
- Peel mode like the laptop: only when the printer reports a peeler; `^MMP`
  per label, `^MMT` otherwise (`withPrintMode`), no polling.
- Test labels for alignment and offsets; font check and missing-font install.
- The scan type recorded for a printed label is **Labeled**.
- Print Labels with no printer saved opens Printer Setup first (iOS/Android).
- Every print scan is refused while a sync or a label build runs
  (Android ruling), with a clear message.

## 4. Shape

### 4.1 Setup: Top or Front

*My call:* the web kiosk follows Android and iOS (a general kiosk with no
station type), not the laptop's Label Station mode. Web Kiosk Setup becomes
Move → Site → Scan type → **What it prints** (the existing `LabelKindStep`
cards, Top preselected, so a kiosk that never prints passes with one tap).
The choice is kept on this kiosk with the label settings (4.3); changing it
means running Kiosk Setup again, and a change rebuilds the labels.

### 4.2 Sync keeps the raw bodies

The generator reads the raw `/kiosk/sync/assets` and
`/kiosk/sync/label-templates` bodies with its number-preserving reader, never
`JSON.parse` output. Sync therefore stores both response texts as they came
(a new IndexedDB store, written in the same transaction as the parsed rows
they belong to, tagged with the owning move), alongside today's parsed
stores, which stay as they are. Clear local data and Clear Setup clear them.
The templates sync stays soft: a failure keeps the previous set; on a **move
change** a failed templates download clears the old move's set (Android
ruling: old templates would pick wrong-move labels).

### 4.3 Label settings on the web kiosk

The web kiosk keeps the same `LabelStationSettings` shape the laptop's edge
stores (`label_kind`, `printer {type: 'usb', serial, model}`, `dpi`,
`offset_x`, `offset_y`, `peel`) in localStorage (*my call*, as Android keeps
them on the device). Clear Setup and Clear local data leave them alone, like
the other per-kiosk settings; Kiosk Setup writes `label_kind`.

### 4.4 Label build (in a Web Worker)

When the kiosk has label settings with a DPI and both raw bodies for the
set-up move, it builds labels with `labelgen` (`buildPlan` + `renderLabels`
in batches) **in a Web Worker**, so the page never freezes. Results (asset
id, ZPL or error, fingerprint, template name) go to an IndexedDB store, with
a meta row recording move, kind, DPI, the generator's fixture `source_hash`,
counts, notes and the time it finished.

A build runs after a sync finishes, after the label settings change kind or
DPI, and on app start when the stored build doesn't match (move, kind, DPI or
generator hash). Only assets whose fingerprint changed are re-rendered;
removed assets' rows are deleted; a different generator hash re-renders all.
Offsets and peel never trigger a build: they are applied when a label is sent.

While a build runs, the laptop's yellow takeover (`LabelRegenScreen`) shows
with its progress, fed from the local build status instead of the edge
(*my call*: the established kiosk-app pattern; it only appears on kiosks
that have a printer saved).

### 4.5 One label backend, two implementations

The laptop's Printing Station, Printer Setup step, test-label modal and
station printer tools talk to the edge (`/edge/label-station`,
`/edge/labels/plan`, `/edge/labels/asset/:id`, `/edge/labels/printed`,
`/edge/labels/recorded`, `/edge/labels/status`). A small **label backend**
interface puts those behind one seam:

| Call | Laptop (unchanged) | Web |
|---|---|---|
| settings read/save | `GET/PUT /edge/label-station` | localStorage (4.3) |
| plan at a DPI/kind | `GET /edge/labels/plan` | `labelgen.buildPlan` on the stored raw bodies |
| label for an asset | `GET /edge/labels/asset/:id` | the build store (4.4); `labels_regenerating` while a build or sync runs |
| record a printed scan | `POST /edge/labels/printed` | the existing outbox: `scan_type: barcode`, `scan_status: labeled`, the exact scanned value |
| recorded? | `GET /edge/labels/recorded` | the outbox row reached `sent` |
| status / unsupported count | `GET /edge/labels/status` | the build meta |
| printer types | USB + network | USB only |

The page code above it stays shared, so the web kiosk gets the laptop's
screens, copy and behavior. Copy that names "this laptop" says "this kiosk"
on the web.

### 4.6 Screens

- **/labels/station (Printing Station):** the laptop's page on the web
  backend. Header shows how many labels are ready and how many couldn't be
  made (and why: no template at this DPI, template failed, too new for this
  kiosk). With no printer saved, the first visit opens Printer Setup
  (`/labels/printers`) once per visit. Needs a USB printer the browser has
  allowed; otherwise the existing "Connect printer" note.
- **/labels/printers:** on the web, with a printer saved, the laptop's
  station printer tools on the web backend (saved printer card, Test Label
  Alignment saving offsets to the web settings, Full Printer Setup, Factory
  Reset, Change printer / Check printer & fonts via the printer step). With
  none saved, it opens on the printer step (USB only) to save one. The
  existing generic USB tools remain reachable where they are today when the
  browser has no WebUSB (*my call*: the unsupported banner stays).
- **Bulk Print** unchanged (placeholder).
- The Label Printing tile/section copy says asset labels only for now.

## 5. API

No new endpoints. `/kiosk/sync/assets`, `/kiosk/sync/label-templates`,
`/kiosk/labels/fonts`, `/kiosk/labels/fonts/{id}/content`,
`/kiosk/labels/test-render`, `/kiosk/scans` (with the per-scan `scan_status`
override, which a person session already sends).

## 6. Calls I made

- Web follows the Android/iOS model (kind step in Kiosk Setup, printer in the
  Labels tile), not the laptop's Label Station mode.
- USB only; Bluetooth and network named as impossible/later.
- Label settings in localStorage, not the portal config document.
- Labels built ahead of time in a Web Worker and stored, like every other
  kiosk, rather than rendered per scan.
- The yellow regeneration takeover reused for web builds.
- The generator's fixture `source_hash` joins the build key, so a kiosk
  deploy that changes the generator rebuilds.
- Test labels keep the laptop's path (`/kiosk/labels/test-render` for the
  sample label), since setup runs online.

## 7. Left to the builder

- Store names and the IndexedDB version bump (current v6).
- How the worker is wired (Vite module worker) and the in-thread fallback the
  tests use.
- Exactly how the backend is provided to components (hook or prop).

## 8. Later (named, not built)

- Bluetooth printing from the browser (Web Bluetooth).
- Web label settings in the portal's per-kiosk config document.
- Bulk Print on every kiosk.
- Container labels.
