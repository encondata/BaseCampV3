# Kiosk Troubleshooting card

Date: 2026-11-19. Requested by Jimmy; he chose "built into the apps" and said "go with your picks" for the rest.

## Intent

Someone standing at a kiosk with a misbehaving Zebra scanner should be able to fix it right there, with no wiki
sign-in and no network. Every kiosk version gets a **Troubleshooting** tile on Home. It opens a list of topics. The
first and only topic for now is **Zebra Scanner Troubleshooting**: a copy of the Operations wiki guide "Zebra DS22
barcode scanners: basic operation" (page 0b7bdf6d-00af-4262-acb8-425d0b0abbd6), programming barcodes included.

## Goals

- The tile is on the web kiosk (browser and laptop), the Android app and the iOS app.
- The guide reads the same as the wiki page: headings, steps, bullets, tables, the warning callout and the five
  barcode images (A1–A4).
- The barcodes can be scanned straight off the kiosk screen: drawn on white, with a quiet zone, never scaled up
  past their source width and never blurred.
- Works offline and signed out of the wiki: the content ships inside each app.
- Adding a second topic later means adding content files and one index entry, not new screen code.

## Non-goals

- Live sync with the wiki. A wiki edit reaches kiosks with the next app release (re-export, then rebuild).
- Search, links between topics, or any editing on the kiosk.
- Other troubleshooting topics (only the scanner guide now).

## Anti-goals

- Three hand-maintained copies of the text that drift apart.
- Barcodes that look fine but won't scan (enlarged, shrunk with nearest-neighbor so bars come out uneven, dark-mode inverted, or cropped quiet zone).
- Troubleshooting locked behind Kiosk Setup: a broken scanner is often why setup can't be finished.

## Approaches

1. **Built into the apps from one shared content file (chosen).** The wiki page's content (ProseMirror JSON, the
   wiki's own format) is exported once into the repo with its images. Each platform bundles identical copies and
   renders the small set of node types the guide uses. Offline, no wiki access needed; updates need a release.
2. **Loaded live from the wiki.** Always current, but needs a network and a kiosk-readable wiki endpoint that
   doesn't exist (wiki pages need a wiki sign-in). Rejected by Jimmy.
3. **Hand-written native screens per platform.** Simplest per screen, but three copies of the text to keep in step.
   Rejected (anti-goal).

## Decisions (my calls, approved by "go with your picks")

- **Availability:** the tile is `alwaysAvailable` (works before Kiosk Setup is complete, like Kiosk Setup and
  Settings), shown to everyone, on full Homes and on every station Home (web STATION_TILES rfid/label/timeclock/dock,
  and the Android/iOS Time Clock station list). Placed immediately before Settings.
- **Signed-out access:** routed like Settings on each platform (no setup gate; the web route sits outside
  KioskGuard like `/settings`).
- **Banner copy:** "Only Kiosk Setup and Settings are available." becomes "Only Kiosk Setup, Troubleshooting and
  Settings are available." wherever it appears (web Home, Android Home). iOS Home's setup-incomplete filter keeps the
  tile visible.
- **Tile copy:** title "Troubleshooting", blurb "Fix common problems with kiosk hardware." Topic title "Zebra Scanner
  Troubleshooting", blurb "Set up, pair, and reset Zebra DS22 scanners, with programming barcodes."
- **Icon:** a wrench, drawn in each platform's existing 40×40 stroke style.

## Content and files

Canonical copy: `kiosk/src/troubleshooting/`
- `topics.json`: `[{ "id": "zebra-ds22", "title": …, "blurb": …, "doc": "zebra-ds22.json" }]`
- `zebra-ds22.json`: the wiki page's published ProseMirror document with each `wikiImage.assetId` replaced by its
  bundled filename. The wiki title becomes the page heading (not part of the doc).
- the five barcode PNGs (400 dpi crops of Zebra's own PRG vector art), file names lowercase with hyphens.

Copies, byte-identical: Android `app/src/main/assets/troubleshooting/`, iOS `ServerSherpa Kiosk/Resources/Troubleshooting/`
(the Xcode project uses synchronized folders, so new files are bundled automatically; names are unique so the
flattened bundle is fine).

`scripts/troubleshooting/export_wiki_page.py` (run with the API venv) re-exports a published wiki page into the
canonical folder; `scripts/troubleshooting/sync.sh` copies the canonical folder to the Android and iOS locations. A
web test fails if any copy differs from the canonical one, or if a doc uses a node type the renderers don't support.

Supported nodes: `doc`, `paragraph`, `heading` (levels 2–3), `bulletList`, `orderedList`, `listItem`, `table`,
`tableRow`, `tableHeader`, `tableCell`, `callout` (variants info/tip/warning/danger), `wikiImage` (alt, caption,
width in px), `text` with the `bold` mark. Unknown nodes are skipped (the test keeps them out of shipped docs).

## Screens

- **Troubleshooting** (list): page header "Troubleshooting", then one row/card per topic (title + blurb). Uses each
  platform's existing card/list components.
- **Topic** (guide): page header with the topic title, the rendered document in the kiosk's normal text styles,
  scrollable, following light/dark theme. Tables use the existing kiosk table look. Barcode images sit on a white
  panel with padding in both themes, shown at the doc's `width` (CSS px / dp / pt), shrunk only to fit the screen,
  with smooth downscaling (web default rendering, Android `FilterQuality.High`, iOS `.interpolation(.high)`), because nearest-neighbor downscaling drops or doubles pixel columns and makes bars uneven (ruling 2026-11-19). Caption under each image.
- Back returns to the list, then Home, using each platform's existing shell/back control.

## Left to the builder

Component reuse on each platform, exact spacing and type styles (match neighbor screens), test structure.
