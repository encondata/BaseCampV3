# Kiosk Troubleshooting Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Troubleshooting tile on every kiosk Home (web/laptop, Android, iOS) that opens a topic list whose first topic, "Zebra Scanner Troubleshooting", shows a bundled copy of the DS22 wiki guide with its programming barcodes.

**Architecture:** One canonical content folder (`kiosk/src/troubleshooting/`: `topics.json`, the wiki page's ProseMirror JSON, five barcode PNGs) is copied byte-for-byte into Android assets and iOS resources. Each platform adds the tile, two routes (list, topic) and a small renderer for the node types the doc uses.

**Tech Stack:** React + Vite + Vitest (kiosk/), Kotlin + Compose + kotlinx.serialization + Robolectric (Android_Kiosk_App/), SwiftUI + Swift Testing (IOS_Kiosk_App/), Python (API venv) for the exporter.

**Spec:** `docs/superpowers/specs/2026-11-19-kiosk-troubleshooting-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/kiosk-troubleshooting` (branch `kiosk-troubleshooting`). Never edit the main checkout or other worktrees. Never touch the dev database or running dev services except the read-only wiki export in Task 1.
- Copy is exact: tile title `Troubleshooting`, tile blurb `Fix common problems with kiosk hardware.`; topic id `zebra-ds22`, topic title `Zebra Scanner Troubleshooting`, topic blurb `Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.`
- Setup banner (web and Android only): `Kiosk setup is incomplete. Only Kiosk Setup, Troubleshooting and Settings are available.` iOS banner copy is unchanged.
- The tile is `alwaysAvailable`, sits immediately before Settings in every Home list (full Home, web STATION_TILES rfid/label/timeclock/dock, Android/iOS Time Clock station list, admin lists after Rolodex/Notifications).
- Routes: web `/troubleshooting` and `/troubleshooting/:topicId`; Android `troubleshooting` and `troubleshooting/{topicId}`; iOS `Route.troubleshooting` and `Route.troubleshootingTopic(String)`. Routed like Settings (no setup gate; web outside KioskGuard).
- Wrench icon path for every platform, 40×40 viewport, 2.5 stroke, round caps/joins: `M25.5 6.5a8 8 0 0 0-8.9 10.6L6.5 27.2a3.3 3.3 0 0 0 4.7 4.7l10.1-10.1a8 8 0 0 0 10.6-8.9l-4.6 4.6-4.4-1.2-1.2-4.4z`
- Supported doc nodes: `doc`, `paragraph`, `heading` (attrs.level 2 or 3), `bulletList`, `orderedList`, `listItem`, `table`, `tableRow`, `tableHeader`, `tableCell`, `callout` (attrs.variant info/tip/warning/danger), `wikiImage` (attrs.assetId = bundled filename, alt, caption, width px), `text` (marks: only `bold`). Unknown nodes render nothing.
- Barcode images: white panel with at least 16 px/dp/pt padding in both themes; drawn at `width` px/dp/pt, shrunk only to fit, never enlarged; no smoothing (web `image-rendering: pixelated`, Compose `FilterQuality.None`, SwiftUI `.interpolation(.none)`). Caption below in the muted text color.
- Everything else follows the current light/dark theme. American English. 24-hour times if any appear.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands:
  - web: `cd kiosk && npx vitest run <path>`; full: `cd kiosk && npx vitest run && npx tsc --noEmit -p .`
  - Android: `cd Android_Kiosk_App && ./gradlew testPlayDebugUnitTest --tests '<Class>'`; full: `./gradlew testPlayDebugUnitTest testDirectDebugUnitTest`
  - iOS (always `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, derived data inside the worktree): `cd "IOS_Kiosk_App/ServerSherpa Kiosk" && xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived -only-testing:"ServerSherpa KioskTests/<Suite>"`; phone build: `xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' -derivedDataPath ../.derived`

## Review Focus

- **Dark mode barcodes:** in dark theme the barcode must still be black on white with its quiet zone. Each platform's renderer test asserts the image sits in a white container.
- **Narrow phones (360 dp/pt, MC2200 480×800):** a 470-wide barcode shrinks to fit without horizontal scroll and the tables wrap text. Android/iOS renderer tests render at 360 width; web uses `max-width: 100%`.
- **Unknown topic id** (`/troubleshooting/nope`): shows "This topic isn't available." with the back control, never a crash or blank page. Each platform tests it.
- **Signed out / setup incomplete:** the tile shows before setup is complete and the route opens without a setup gate. Each platform's Home test covers setup-incomplete.
- **Copies drifting:** someone edits only the Android or iOS copy. The web guard test fails on any byte difference.

---

### Task 1: Shared content, exporter, sync and guard

**Files:**
- Create: `scripts/troubleshooting/export_wiki_page.py`, `scripts/troubleshooting/sync.sh`, `scripts/troubleshooting/README.md`
- Create: `kiosk/src/troubleshooting/topics.json`, `kiosk/src/troubleshooting/zebra-ds22.json`, five PNGs (`factory-defaults.png`, `ds2208-usb-keyboard-hid.png`, `ds2278-hid-bluetooth-classic.png`, `ds2278-unpairing.png`, `add-enter-key.png`)
- Create (by sync.sh): `Android_Kiosk_App/app/src/main/assets/troubleshooting/*`, `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Resources/Troubleshooting/*`
- Test: `kiosk/src/troubleshooting/content.test.ts`

**Interfaces:**
- Produces: the canonical folder and its two copies (same 7 files each). `topics.json` is `[{"id":"zebra-ds22","title":"Zebra Scanner Troubleshooting","blurb":"Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.","doc":"zebra-ds22.json"}]`.

- [ ] **Step 1: Write the exporter** `export_wiki_page.py --node <uuid> --out <dir> --doc <name.json>`: run from `api/` with `PYTHONPATH=src` and the root `.env` loaded (same pattern as `.superpowers/wiki/ds22-guide/ds22_guide.py`). Read the page's latest **published** version (`WikiPageVersion` with the highest `version_no` for the node; check the model in `api/src/serversherpa/db/models`), map each `wikiImage.assetId` to its `WikiPageAsset.filename`, download each image with `storage.get_object(storage_key)` into `--out`, write the doc with assetIds replaced by filenames (pretty-printed, 2-space indent, trailing newline), and exit non-zero if the doc contains a node type outside the Global Constraints list. Read-only on the DB.
- [ ] **Step 2: Run it** for node `0b7bdf6d-00af-4262-acb8-425d0b0abbd6` into `kiosk/src/troubleshooting/` with `--doc zebra-ds22.json`. Expected: 5 PNGs written, doc written, exit 0. (If dev MinIO is down, `docker start serversherpa-dev-minio-1`.) Then write `topics.json` by hand with the exact entry above.
- [ ] **Step 3: Write `sync.sh`**: copies every file in `kiosk/src/troubleshooting/` except `*.test.ts` into both copy folders (creating them, deleting files there that no longer exist in the canonical folder). Run it.
- [ ] **Step 4: Write the guard test** `content.test.ts` (node `fs`, paths relative to the repo root):
  - `it('ships identical copies to Android and iOS')`: for each canonical file (excluding tests), both copies exist and `Buffer.equals` is true; neither copy folder has extra files.
  - `it('uses only supported nodes')`: walk `zebra-ds22.json`; every `type` is in the supported list; every mark is `bold`; heading levels are 2 or 3.
  - `it('bundles every image the doc names')`: every `wikiImage.attrs.assetId` is a file in the folder, and every PNG is referenced.
  - `it('lists the scanner topic')`: `topics.json` equals the exact entry in Interfaces and each `doc` file exists.
- [ ] **Step 5: Run** `cd kiosk && npx vitest run src/troubleshooting/content.test.ts`. Expected: 4 passing. Then edit one byte of the Android copy, confirm the first test fails, re-run sync.sh, confirm it passes.
- [ ] **Step 6: README.md**: three lines: what the folder is, how to re-export (command), then run sync.sh and rebuild the apps.
- [ ] **Step 7: Commit** `feat(kiosk): bundled troubleshooting content (Zebra DS22 guide) shared by web, Android and iOS`

### Task 2: Web kiosk tile, pages and renderer

**Files:**
- Modify: `kiosk/src/lib/features.ts` (id union, FEATURES, STATION_TILES), `kiosk/src/pages/Home.tsx` (ICONS, banner copy), `kiosk/src/App.tsx` (two routes, outside KioskGuard, inside KioskShell, beside `/settings`)
- Create: `kiosk/src/troubleshooting/topics.ts`, `kiosk/src/troubleshooting/WikiDoc.tsx`, `kiosk/src/pages/Troubleshooting.tsx`, `kiosk/src/pages/TroubleshootingTopic.tsx`, styles in `kiosk/src/styles/kiosk.css`
- Test: `kiosk/src/lib/features.test.ts`, `kiosk/src/pages/Home.test.tsx`, `kiosk/src/troubleshooting/WikiDoc.test.tsx`, `kiosk/src/pages/Troubleshooting.test.tsx`

**Interfaces:**
- Consumes: Task 1 files.
- Produces: `TROUBLESHOOTING` feature `{ id: 'troubleshooting', path: '/troubleshooting', title: 'Troubleshooting', blurb: 'Fix common problems with kiosk hardware.', alwaysAvailable: true }` in FEATURES before settings; `topics.ts` exports `TOPICS: Topic[]`, `findTopic(id: string): Topic | undefined`, `topicImageUrl(file: string): string` (Vite `import.meta.glob('./*.png', { eager: true, query: '?url', import: 'default' })`); `<WikiDoc doc={…} />`.

- [ ] **Step 1: Failing tests**
  - features.test.ts: `homeFeatures(false, undefined)` ends `[…'troubleshooting','settings']`; for each station type rfid/label/timeclock/dock the list ends `['troubleshooting','settings']`; `featureAvailable(TROUBLESHOOTING, 'incomplete', false)` is true.
  - Home.test.tsx: with setup incomplete, tiles are exactly Kiosk Setup, Troubleshooting, Settings and the banner text is the Global Constraints copy.
  - WikiDoc.test.tsx: renders the shipped doc; finds heading "Appendix: programming barcodes"; finds 5 `img` elements whose `alt`s are the doc's alts, each inside an element with class `wiki-barcode` and with `style.width` equal to its `width`px; bold text renders in `<strong>`; a doc containing `{type:'mystery'}` renders without throwing and without its text.
  - Troubleshooting.test.tsx: list shows "Zebra Scanner Troubleshooting" and its blurb, links to `/troubleshooting/zebra-ds22`; topic route shows the topic title as page title and the doc; `/troubleshooting/nope` shows "This topic isn't available." and a link back to `/troubleshooting`.
- [ ] **Step 2: Run** those four files; expected failures (missing modules / ids).
- [ ] **Step 3: Implement.** Add the wrench icon to `ICONS` (path from Global Constraints) and the banner copy. Pages use the existing `portal-page` / `eyebrow` / `page-title` structure (eyebrow "Kiosk"); list rows reuse `kiosk-tile` cards. `WikiDoc` maps nodes to `h2/h3/p/ul/ol/li/table/thead?/tr/th/td`, callouts to the portal's existing `portal-banner` variants (warning → the warning look), images to `<figure class="wiki-barcode"><img …><figcaption>…</figcaption></figure>`. CSS: `.wiki-barcode img { background:#fff; padding:16px; max-width:100%; height:auto; image-rendering:pixelated; box-sizing:border-box }`, tables use existing kiosk table tokens and wrap.
- [ ] **Step 4: Run** the four files, then the full web suite + `tsc`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(kiosk): Troubleshooting tile and Zebra scanner guide on the web kiosk`

### Task 3: Android tile, screens and renderer

**Files:**
- Modify: `core/features/Features.kt` (FeatureId.TROUBLESHOOTING, FEATURES before SETTINGS, Time Clock station list), `ui/screens/home/FeatureIcons.kt`, `ui/screens/home/HomeScreen.kt` (banner copy), `ui/Routes.kt`, `ui/KioskApp.kt` (routes beside SETTINGS, same `StationIdleReturn` + `KioskShell` wrapping)
- Create: `core/troubleshooting/Troubleshooting.kt` (assets loading + kotlinx.serialization model), `ui/screens/troubleshooting/TroubleshootingScreen.kt`, `ui/screens/troubleshooting/TroubleshootingTopicScreen.kt`, `ui/screens/troubleshooting/WikiDoc.kt`
- Test: `core/features/FeaturesTest.kt`, `core/troubleshooting/TroubleshootingTest.kt`, `ui/screens/troubleshooting/TroubleshootingScreenTest.kt` (Robolectric + compose rule, like other screen tests)
(paths under `Android_Kiosk_App/app/src/{main,test}/java/com/serversherpa/kiosk/`)

**Interfaces:**
- Consumes: Task 1 assets at `assets/troubleshooting/`.
- Produces: `Routes.TROUBLESHOOTING = "troubleshooting"`, `Routes.TROUBLESHOOTING_TOPIC = "troubleshooting/{topicId}"`, `fun Routes.troubleshootingTopic(id: String): String`; `object TroubleshootingContent { fun topics(ctx: Context): List<Topic>; fun doc(ctx: Context, topic: Topic): DocNode; fun image(ctx: Context, file: String): ImageBitmap }`; `DocNode(type: String, attrs: JsonObject?, content: List<DocNode>, text: String?, marks: List<Mark>)` (ignore unknown keys).

- [ ] **Step 1: Failing tests**
  - FeaturesTest: `homeFeatures(null)` ends `[TROUBLESHOOTING, SETTINGS]`; admin list ends `[ROLODEX, NOTIFICATIONS, TROUBLESHOOTING, SETTINGS]`; timeclock station list is `[TIMECLOCK_STATION, SETUP, TROUBLESHOOTING, SETTINGS]`; `featureAvailable(feature(TROUBLESHOOTING), INCOMPLETE)` is true.
  - TroubleshootingTest: `topics()` is the single exact entry; `doc()` parses and its top-level node count matches the JSON; `image()` decodes each of the 5 files.
  - TroubleshootingScreenTest: list shows the topic title and blurb; topic screen at 360 dp width shows "Appendix: programming barcodes" and 5 images tagged `barcode-<file>` each inside a node tagged `barcode-panel` whose background is white, image width ≤ its `width` dp and ≤ 360 − padding; dark theme still white; unknown topic shows "This topic isn't available."; Home with setup incomplete shows tile `tile-TROUBLESHOOTING` enabled and the new banner copy.
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*Features*' --tests '*Troubleshooting*'`; expected failures.
- [ ] **Step 3: Implement.** Icon via `icon("troubleshooting", strokes = listOf(<wrench path>))`. Screens use `PageHeader(title, subtitle)` and `SetupCard` rows for the list, a scrolling `Column` for the topic. Images: `Image(bitmap, filterQuality = FilterQuality.None, contentScale = ContentScale.Fit)` with `Modifier.widthIn(max = width.dp)` inside a white `Box` with 16 dp padding.
- [ ] **Step 4: Run** the targeted tests, then the full Android suite (both flavors). Expected: all pass (known flakes per `android-robolectric-flakes` memory may need a re-run; report any that fail twice).
- [ ] **Step 5: Commit** `feat(android): Troubleshooting tile and Zebra scanner guide`

### Task 4: iOS tile, screens and renderer

**Files:**
- Modify: `Core/Features.swift` (`.troubleshooting`, FEATURES before settings, Time Clock station list), `UI/Screens/Home/FeatureIcons.swift`, `UI/Routes.swift` (`.troubleshooting`, `.troubleshootingTopic(String)`, feature mapping), `UI/RootView.swift` (destinations, like `.settings`)
- Create: `Core/Troubleshooting.swift` (bundle loading + Codable `DocNode`), `UI/Screens/Troubleshooting/TroubleshootingView.swift`, `UI/Screens/Troubleshooting/TroubleshootingTopicView.swift`, `UI/Screens/Troubleshooting/WikiDocView.swift`
- Test: `ServerSherpa KioskTests/Core/FeaturesTests.swift`, `ServerSherpa KioskTests/Core/TroubleshootingTests.swift`, `ServerSherpa KioskTests/UI/TroubleshootingViewTests.swift`
(app paths under `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`)

**Interfaces:**
- Consumes: Task 1 resources (flattened into the main bundle by the synchronized folder).
- Produces: `enum TroubleshootingContent { static func topics(bundle: Bundle = .main) -> [Topic]; static func doc(for: Topic, bundle: Bundle = .main) -> DocNode?; static func image(named: String, bundle: Bundle = .main) -> UIImage? }`; `func topicImageSize(width: Double, available: Double) -> Double` (= min(width, available − 32)).

- [ ] **Step 1: Failing tests**
  - FeaturesTests: full Home ends `[.troubleshooting, .settings]`; admin full Home ends `[.rolodex, .troubleshooting, .settings]`; timeclock station `[timeclock-station, .setup, .troubleshooting, .settings]`; `homeTiles(setupState: .incomplete, devMode: false)` contains Troubleshooting.
  - TroubleshootingTests: topics is the exact entry; doc decodes; all 5 images load; `topicImageSize(width: 470, available: 360) == 328`, `topicImageSize(width: 190, available: 1000) == 190`.
  - TroubleshootingViewTests: a pure `wikiDocBlocks(doc)` flattening (headings, paragraphs, list items, tables, callouts, images) yields "Appendix: programming barcodes" and 5 image blocks with their captions; an unknown node yields no block; unknown topic id gives the "This topic isn't available." state.
- [ ] **Step 2: Run** the three suites; expected failures.
- [ ] **Step 3: Implement.** Wrench icon in the existing shape style. Views follow neighbor screens (page header, palette from `\.kioskPalette`). Images: `Image(uiImage:).interpolation(.none).resizable().scaledToFit().frame(width: topicImageSize(...))` on `Color.white` with 16 pt padding, both themes.
- [ ] **Step 4: Run** the full unit target and the phone build. Expected: all pass, build succeeds.
- [ ] **Step 5: Commit** `feat(ios): Troubleshooting tile and Zebra scanner guide`
