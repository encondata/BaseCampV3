# iOS Label Printing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iOS/iPadOS kiosk prints asset labels offline by scan to a network Zebra, with labels built on the device by the same shared TypeScript generator Android uses — behavior identical to the Android build already verified on a Pixel.

**Architecture:** Port the Android implementation (branch `android-labels`) to the iOS app: the committed `labelgen.js` bundle runs in JavaScriptCore; SwiftData gets a versioned V1→V2 migration (and loses its destructive store fallback); sync keeps raw JSON text with a number-preserving splitter; a `LabelBuilder` actor builds and stores labels; Network.framework talks to Zebras on TCP 9100; SwiftUI screens mirror Android's Print Labels and Printer Setup.

**Tech Stack:** Swift 5 mode on Xcode 26.1.1, SwiftUI, SwiftData, JavaScriptCore, Network.framework, Swift Testing. No third-party packages.

**Spec:** `docs/superpowers/specs/2026-10-21-android-label-printing-design.md` (iOS is its "Later" phase; its Implementation notes record every Android ruling, which iOS inherits).

**Behavioral reference:** the Android code on this branch, under `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/` (abbreviated **AK/**) and its tests under `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/` (**AKT/**). "Port X" means: same behavior, same copy, same constants, same edge cases; port its tests to Swift Testing alongside.

## Global Constraints

- iOS app root: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/` (**IK/**); unit tests: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa KioskTests/` (**IKT/**).
- Build/test from `IOS_Kiosk_App/ServerSherpa Kiosk`: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived -only-testing:"ServerSherpa KioskTests"` (foreground, 600000 ms timeout). Also build for `platform=iOS Simulator,name=iPhone 16,OS=18.5` at the end of UI tasks.
- **Synchronized folders: every new file's basename must be unique across the target** (two `Sync.swift` break the build). Never hand-edit file references in `project.pbxproj`; new files are picked up automatically. Build-setting edits there only if unavoidable (prefer `Info.plist`).
- `IK/Core/` imports Foundation only (`CorePurityTests`). UI state is `@MainActor` explicitly (`SWIFT_DEFAULT_ACTOR_ISOLATION = nonisolated`).
- Tests use Swift Testing, in-memory or temp-dir stores, and never touch the live API or the Keychain (`RuntimeEnvironment.isUnitTestHost`).
- No third-party dependencies.
- Same product rules as Android: asset labels only; Top/Front set once in setup; stored ZPL byte-identical to the laptop; offsets/peel applied at send time via the bundle's `applyPrintSettings`/`withPrintMode`; one Labeled scan (`scan_type "barcode"`, `scan_status "labeled"`) per scan through the outbox; Reprint never records; refuse printing while a sync or a label build runs; no checks/polls on the print path; Bluetooth placeholder only.
- Constants (from Android): port 9100; scan concurrency 64; scan probe connect 500 ms; chosen printer connect 3 s; identify 1.5 s; query idle 2 s / total 5 s; send 30 s; scan budget 10 s; plan chunk 500 assets; render batch 200; font install recheck after 500 ms; offsets clamp −9999…9999; peeler query `! U1 getvar "sensor.peeler_present"\r\n`; serial getvar `device.unique_id`; resident font `TT0003M_.TTF`.
- The JS bundle is the SAME bytes as `Android_Kiosk_App/app/src/main/assets/labelgen.js`, copied to `IK/Resources/labelgen.js`; `kiosk/src/labelgen/bundle.test.ts` must assert both copies equal a fresh build.
- American English. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Upgrading an installed app with unsent scans** keeps every outbox row and the synced move through the V1→V2 store migration, and a store that won't open is never deleted. → Task 1 tests.
2. **A From-To number literal (`12.0`, `1e-05`, `7`) and non-ASCII text** survive iOS sync byte-for-byte into the generator input. → Task 2 tests.
3. **A generator call that never returns** (JavaScriptCore has no time limit) doesn't freeze printing forever: the call times out, the context is abandoned and recreated, and later calls work. → Task 4 tests.
4. **Local Network permission denied or pending**: the scan and printer calls end with a clear message instead of hanging (`NWConnection` sits in `.waiting`). → Task 6 tests.
5. **Scanning during a sync or build, or an asset with no label**, records nothing and says why; a send that times out says the printer may have printed. → Task 8 tests.

---

### Task 1: Store safety and the SwiftData V1→V2 migration

**Files:** Modify `IK/App/AppContainer.swift` (`openStore`), `IK/Data/Db/Records.swift`, `IK/Data/Db/KioskStore.swift`; Create `IK/Data/Db/KioskSchemaVersions.swift`; Test `IKT/Data/StoreMigrationTests.swift`.

**Interfaces — Produces:**
- `KioskSchemaV1: VersionedSchema` (today's models, frozen), `KioskSchemaV2: VersionedSchema`, `KioskMigrationPlan: SchemaMigrationPlan` (lightweight V1→V2); `KioskSchema.container(inMemory:)` uses the plan.
- V2 adds: `AssetRecord.payloadJson: String = "{}"` and `AssetRecord.position: Int = 0` (server order); `LabelTemplateRecord(id: String @unique, position: Int, json: String)`; `LabelFontRecord(id: String @unique, name: String, size: Int, resident: Bool, fileName: String?)`; `GeneratedLabelRecord(assetId: String @unique, zpl: String?, outcome: String, fingerprint: String, templateId: String?)`; meta key `label_context` (raw JSON text) in `MetaRecord`.
- `openStore()` never deletes: on failure it **moves** the store files aside to `serversherpa-kiosk.store.failed-<yyyyMMdd-HHmmss>` (+ `-shm`/`-wal`), logs, and opens a fresh store; failing that, in-memory.
- [ ] Step 1: Failing tests: build an on-disk store at V1 in a temp dir with 2 outbox rows, 3 assets, a meta row; reopen with the V2 container → all rows present, `payloadJson == "{}"`, new tables empty; a corrupt store file → moved aside (file exists with the `.failed-` name), app gets a working store.
- [ ] Step 2: Run; expect FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run the full unit suite; expect PASS.
- [ ] Step 5: Commit `feat(ios): versioned SwiftData store with a V2 for labels; a failed store is moved aside, never deleted`.

### Task 2: Raw-JSON sync of templates, fonts and full asset payloads with per-part progress

**Files:** Create `IK/Core/Json/RawJson.swift` (pure, number-preserving element splitter); Modify `IK/Data/Api/KioskApi.swift`, `IK/Data/Api/URLSessionKioskApi.swift` (+ the test fake), `IK/Core/Model/Sync.swift`, `IK/Data/Sync/SyncCoordinator.swift`, `IK/Data/Db/KioskStore.swift`; Create `IK/Core/Labels/ResidentFonts.swift`; Tests `IKT/Core/RawJsonTests.swift`, `IKT/Data/SyncLabelsTests.swift`.

**Interfaces — Produces:**
- `RawJson.arrayElements(of text: String, key: String) throws -> [String]` (each element's exact raw text from a top-level object's array member) and `RawJson.member(of text: String, key: String) throws -> String?` (exact raw text of a top-level member, nil for absent/`null`). Pure string scanner honoring JSON strings/escapes; never re-serializes.
- API: `assetsSyncRaw(initiativeId:) -> String`, `labelTemplatesRaw(initiativeId:) -> String`, `labelFonts(initiativeId:) -> KioskLabelFonts`, `labelFontContent(id:initiativeId:) -> Data` (errors keep their `code`; 403 `font_not_servable` recognized).
- `SyncStatus.parts: [SyncPart]` (`assets, people, containers, trucks, templates, fonts` × `waiting/running/done/failed` + count) and `labelsError: String?`; port AK/data/sync/Sync.kt rules exactly: raw payload per asset (+ `position`), raw `label_context`, raw templates in server order, templates/fonts soft (keep same-move rows on failure; a move change with a failed step clears that move's templates/fonts), resident by flag OR name (`RESIDENT_FONTS`) OR a 403 `font_not_servable` (skip, store as resident), font bytes under `Application Support/label-fonts/<id>.ttf` written atomically, safe ids only (`[A-Za-z0-9-]{1,64}`), unreferenced files deleted after a successful swap, post-write steps can never leave the phase `running`; `hydrate()` shows templates/fonts `waiting` when no `label_context` row.
- [ ] Step 1: Failing tests: `RawJson` keeps `12.0`, `1e-05`, `7`, `true`, `null`, `"é😀\"\\"`, nested objects byte-for-byte; ports of AKT `SyncLabelsTest` cases (progress per part, soft failures, same-move keep vs move-change clear, resident by name and by 403, font failure leaves sync DONE with `labelsError`, nothing ever left `running`).
- [ ] Step 2–4: Run FAIL → implement → full suite PASS.
- [ ] Step 5: Commit `feat(ios): sync raw asset payloads, label templates and fonts with per-part progress`.

### Task 3: Core label model (pure Swift ports)

**Files:** Create in `IK/Core/Labels/`: `LabelSettings.swift` (port AK/core/labels/LabelSettings.kt), `LabelBuildStatus.swift` (port LabelBuildStatus.kt incl. `LabelPick` with `failed`), `LabelGenArgs.swift` (port core/labels/LabelGenSurface.kt incl. `combinePlans`, `parseZpl`, `printSettings`, `printMode`), `PrintQueue.swift` (port core/labels/PrintQueue.kt incl. all refusal copy: syncing, preparing when total 0, still being made, outcome reasons, `LabelSendTimeout` copy); Tests `IKT/Core/LabelGenArgsTests.swift`, `LabelBuildStatusTests.swift`, `PrintQueueTests.swift` (ports of the AKT tests).

**Interfaces — Produces:** Swift equivalents with the same names (types `LabelKind`, `SavedPrinter`, `LabelOptions`, `LabelSettings`, `LabelBuildStatus`, `LabelPick`, `LabelGenArgs`, `PrintQueue`) — `PrintQueue` is an `actor` taking an injected deps struct (`settings`, `label`, `prepare`, `send`, `record`, `log`) with send+record+final state guaranteed to finish once started (Swift: run them in an unstructured `Task` the queue awaits, so caller cancellation can't interrupt them).
- [ ] Steps: ported failing tests → FAIL → implement → PASS → commit `feat(ios): label settings, build status, generator arguments and the print queue`.

### Task 4: JavaScriptCore label engine

**Files:** Create `IK/Resources/labelgen.js` (byte copy of the Android asset); Modify `kiosk/src/labelgen/bundle.test.ts` (assert the iOS copy equals a fresh build too) and `kiosk/package.json` `build:labelgen` (write both copies); Create `IK/Data/Labels/LabelEngine.swift` (protocol) and `IK/Data/Labels/JavaScriptLabelEngine.swift`; Test `IKT/Data/JavaScriptLabelEngineTests.swift`.

**Interfaces — Produces:**
- `protocol LabelEngine: Sendable { func call(_ fn: String, _ argsJson: String) async throws -> String; func isSupported() async -> Bool }`.
- `JavaScriptLabelEngine`: one `JSContext` owned by a dedicated serial thread (not a cooperative-pool thread); loads the bundle from the app bundle, checks the surface version like Android; allowlisted function names; arguments passed as a JS string value (no source interpolation); per-call timeouts (buildPlan 120 s, renderLabels 60 s, helpers 5 s). JavaScriptCore can't be interrupted: on timeout the context is **abandoned** (its thread is left to finish and its result dropped) and a fresh context is created for the next call; a JS exception → `LabelEngineError.evaluationFailed(message)`; context creation failure → `.unsupported`.
- [ ] Step 1: Failing tests (run the REAL bundle in the test host): `buildPlan` + `renderLabels` on two cases copied from `kiosk/src/labelgen/fixtures/reference.json` produce the expected ZPL byte-for-byte; a disallowed fn throws; a script that never returns (inject via a test-only engine hook evaluating `while(true){}`) times out within the budget and the next call succeeds on a fresh context; an args string containing quotes/backslashes/emoji round-trips.
- [ ] Step 2–4: FAIL → implement → `npm --prefix kiosk test -- src/labelgen` + iOS suite PASS.
- [ ] Step 5: Commit `feat(ios): run the shared label generator in JavaScriptCore`.

### Task 5: LabelBuilder

**Files:** Create `IK/Data/Labels/LabelBuilder.swift` (actor; port AK/data/labels/LabelBuilder.kt), `IK/Data/Labels/LabelSettingsStore.swift` (port LabelSettingsStore.kt over `KioskPrefs`, key `ss.kiosk.labels`; kind lives in the setup selection); Modify `IK/Data/Prefs/KioskPrefs.swift`, `IK/Core/Model/Kiosk.swift` (`KioskSetupSelection.labelKind`, default `"top"` for old JSON), `IK/App/AppContainer.swift` (wiring; the builder starts after a sync completes); Test `IKT/Data/LabelBuilderTests.swift`, `LabelSettingsStoreTests.swift` (ports of AKT).

**Interfaces — Produces:** `LabelBuilder.status: AsyncStream`/`@Observable` snapshot of `LabelBuildStatus`, `pick` publication, `rebuild(reason:)`, `stop()`; settings watcher on `(kind, printer.dpi)` changes; plan in chunks of 500 (combined via `combinePlans`), render batches of 200 with only that batch's payloads, only changed fingerprints re-rendered, prune only when `hasAssetData`, every write re-checks the move in the same store transaction, needs SYNC / PRINTER flags, ERROR keeps stored labels, a failed plan publishes `LabelPick(failed: true)`.
- [ ] Steps: ported failing tests (fake engine) → FAIL → implement → PASS → commit `feat(ios): on-device label builds with progress`.

### Task 6: Zebra network printer core (Network.framework)

**Files:** Create `IK/Core/Printer/ZebraReplies.swift`, `IK/Core/Printer/PrinterChecks.swift` (ports of AK/core/printer/*; fixtures: copy `AKT/../resources/printer/zt220_hh.txt` and the sample replies into `IKT/Fixtures/`), `IK/Data/Printer/NetworkZebra.swift` (NWConnection: query read rules, send, installFont with name guard, serial getvar, `PrinterUnreachable`/`PrinterNoReply`/`PrinterBadReply`/`PrinterTimeout`), `IK/Data/Printer/ZebraScanner.swift` (getifaddrs: `en*` only, skip `utun*`/`ipsec*`/`pdp_ip*`, RFC 1918 only, scan the device's /24, 64 concurrent, 500 ms probe, 10 s budget, STX-framed `~HI`, serial getvar only after identify, per-host failures never fail the scan); Modify `IK/Info.plist` (`NSLocalNetworkUsageDescription`: "Finds and prints to Zebra label printers on this network."); Tests `IKT/Core/ZebraRepliesTests.swift`, `IKT/Data/NetworkZebraTests.swift` (local fake printer via `NWListener` on 127.0.0.1).
- **Local Network permission:** an `NWConnection` stuck in `.waiting` (e.g. `.posix(.ENETDOWN)` / local-network-prohibited) for longer than the connect budget is `PrinterUnreachable`; the scan surfaces `"Allow Local Network access for ServerSherpa Kiosk in Settings to find printers."` when every probe ends `.waiting` with a policy-denied error.
- [ ] Steps: failing tests (parsers on real replies; send exact bytes; `~DY` header; unreachable; timeout vs unreachable; a waiting connection ends within budget) → FAIL → implement → PASS → commit `feat(ios): Zebra network printer core`.

### Task 7: Setup step 4 and the sync summary

**Files:** Modify `IK/UI/Screens/Setup/KioskSetupViewModel.swift`, `IK/UI/Screens/Setup/KioskSetupScreen.swift`; Create `IK/UI/Screens/Setup/SyncSummaryView.swift` (port AK/ui/screens/setup/SyncSummary.kt: local-data line with templates/fonts + singular forms, per-part lines while running, labels warning); Tests `IKT/UI/KioskSetupViewModelTests.swift` additions, `IKT/UI/SyncSummaryTests.swift`.
- Behavior: steps `move → site → scanType → labels` ("Step N of 4", step 4 title "What do labels print on?", cards Top "Labels for the top of the device." / Front "Labels for the front of the device.", Top preselected fresh, saved kind on re-run); scan type tap only advances; the submit path moves to the step-4 tap.
- [ ] Steps: failing tests → FAIL → implement → PASS (+ iPhone 16 build) → commit `feat(ios): Top/Front setup step and sync progress`.

### Task 8: Label Printing tile and Print Labels

**Files:** Modify `IK/Core/Features.swift` (labels not a placeholder; blurb "Print asset labels."), `IK/UI/Routes.swift` (`labels`, `labelsPrint`, `labelsPrinter`), `IK/UI/RootView.swift`; Create `IK/UI/Screens/Labels/LabelsHomeScreen.swift`, `PrintLabelsScreen.swift`, `PrintLabelsViewModel.swift` (port the Android screen + VM: `ScanBus` collection at screen level, `matchAssetOrSerial`, header ready/problems summary, build progress, sync-needed prompt with Sync now, unsupported-device copy, Retry/Reprint), placeholder `PrinterSetupScreen.swift`; Tests `IKT/UI/PrintLabelsViewModelTests.swift` (port AKT), feature tests updated.
- [ ] Steps: failing tests → FAIL → implement → PASS (+ iPhone 16 build) → commit `feat(ios): Print Labels — scan to print with Labeled scans`.

### Task 9: Printer Setup and test labels

**Files:** Replace `IK/UI/Screens/Labels/PrinterSetupScreen.swift`; Create `PrinterSetupViewModel.swift`, `TestLabelSheet.swift` (port AK/ui/screens/labels/PrinterSetup* and TestLabelSheet.kt: scan/IP/Bluetooth-coming-soon, identify before save, null serial → "", null model → "Zebra", checks on save and Check again only, immediate sync-needed / build-failed answers, one printer connection at a time (actor lock), peel copy and auto tear-off when Not Present, fonts install then recheck after 500 ms, alignment + sample labels via the engine with helper retry once on timeout, offsets clamp + debounce + `numbersAndPunctuation` keyboard for the minus sign, IPv4 validation rejecting leading-zero octets); Tests `IKT/UI/PrinterSetupViewModelTests.swift` (port AKT).
- [ ] Steps: failing tests → FAIL → implement → PASS (+ iPhone 16 build) → commit `feat(ios): Printer Setup — find printers, checks, fonts, test labels, offsets, peel`.

### Task 10: Docs

**Files:** Modify `docs/superpowers/specs/2026-10-21-android-label-printing-design.md` (append `## iOS implementation notes`), `IOS_Kiosk_App/README.md` (Label printing section: bundle copy, tests, Local Network permission).
- [ ] Record iOS-specific rulings (store moved aside, JavaScriptCore abandon-on-timeout, Local Network handling, raw JSON splitter) and owed hardware checks; commit `docs(ios): label printing implementation notes`.

---

## After the tasks (controller)

1. Whole-branch review; one fix wave; scoped re-review.
2. Gates: iOS unit suite + iPhone 16 build; kiosk labelgen tests; Android unit suite still green (shared bundle unchanged).
3. Live test on the iPad Air simulator against the dev API (simulator reaches the Mac's localhost) with the fake Zebra on `127.0.0.1:9100`: setup Top, sync parts, labels built, Printer Setup (Enter IP 127.0.0.1 — the simulator's scan sees the Mac's interfaces), test labels, print by typed scan, byte-compare one captured label with the laptop's Python output, Labeled scan in the DB.
4. Report to Jimmy.
