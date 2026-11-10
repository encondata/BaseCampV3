# Android Asset Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the web kiosk's Asset Lookup to the Android kiosk app: a Home tile, a scan/type screen, online lookup through the existing API with an offline fallback over synced move assets, and an admin-only full card with scan history.

**Architecture:** Pure matching and models in `core/lookup` (Android-free); a `data/lookup/AssetLookupRepository` that asks the API and falls back to Room (`assets.payload_json`, the label-context meta row, containers) on network errors; an `AssetLookupViewModel` fed by `ScanBus` and the RFD40 `bursts`; a Compose `AssetLookupScreen` wired into `FEATURES`, `Routes` and `KioskApp`.

**Tech Stack:** Kotlin, Jetpack Compose, kotlinx.serialization, OkHttp, Room, Robolectric/JUnit.

**Spec:** `docs/superpowers/specs/2026-11-10-android-asset-lookup-design.md` (a port of `docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md`; the web screen on main, `kiosk/src/pages/AssetLookup.tsx` and `kiosk/src/lib/assetLookup.ts`, is the reference for behavior and copy).

## Global Constraints

- All paths below are under `Android_Kiosk_App/app/src/` — `M/` = `main/java/com/serversherpa/kiosk/`, `T/` = `test/java/com/serversherpa/kiosk/`.
- Build/test (foreground, Bash timeout 600000, never backgrounded): `cd Android_Kiosk_App && export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk && ./gradlew testDebugUnitTest assembleDebug`. Targeted: `./gradlew testDebugUnitTest --tests '<pattern>'`.
- No API change. Routes used: `GET /kiosk/assets/lookup?serial=&q=`, `GET /kiosk/assets/{id}?serial=`, `GET /kiosk/assets/{id}/scans?serial=&limit=50`.
- The lookup never records anything: no class in this feature takes `Outbox`, and no test may see an outbox row.
- Nothing under `M/core/` imports `android*`/`androidx*` (`CorePurityTest`). No inline regex flags `(?u` `(?U` `(?d` (`AndroidRegexTest`).
- Never edit or reflow any line marked `// INTERNET-TEST`.
- American English. Times are 24-hour.
- Copy (exact): header eyebrow "Kiosk · Asset Lookup", title "Asset Lookup", hint `setup.headerLine()` or "Finish Kiosk Setup first."; placeholder "Scan or type an asset tag, serial, RFID, or name"; buttons "Search", "Clear"; "Offline — showing this move's devices only."; "No asset matches <value>."; "Couldn't look that up. Try again."; "Couldn't load that asset."; "Unnamed asset"; "Refine your search"; match labels "Asset tag", "Serial", "RFID", "Name"; list header "Matched on"; card labels "Asset tag", "Serial", "RFID", "Current location", "Source", "Destination", "Site", "Rack", "RU", "Position", "Moves"; "Scan history", "Loading…", "Could not load scan history.", "No scans recorded for this asset.", "Latest 50 scans shown.", "Scan history needs a connection.", "Off move"; history labels "Device", "Operator", "Site", "Location"; sled: "<N> tags read. Point the reader at one tag and try again."; blank values "—".
- Tile: `FeatureId.LOOKUP`, route `"lookup"`, title "Asset Lookup", blurb "Scan an asset to see what it is and where it goes.", placed after Trucks; gated on setup; not on a Time Clock station.
- Admin = `AuthState.Authed.isAdmin` (rank ≥ 60). Scan history also needs `container.auth.can("scans","view")`.
- Must fit 320 dp wide (MC2200).

## Review Focus

1. A scanner burst arriving while a previous lookup is in flight — the newer answer wins and an older answer never replaces it (Task 4 test `newerLookupWins`).
2. Network failure mid-way: lookup succeeds online, details call then fails with a network error — details come from the synced row and the offline notice shows (Task 3 test `detailFallsBackWhenNetworkDropsAfterLookup`).
3. A 404/403 from the API (out of reach) must NOT fall back to local data — it reads as "No asset matches" for lookup / "Couldn't load that asset." for details, never shows a synced copy (Task 3 test `forbiddenDoesNotFallBack`).
4. A sled sweep containing the same EPC several times counts as one tag; padded and unpadded forms of one tag are one tag (Task 4 test `sweepDedupesByPaddedTag`).
5. Leaving the screen disarms the sled, so Scanning's trigger behavior is untouched afterward (Task 5 test `leavingDisarmsTheSled`).

---

### Task 1: Lookup models and API client

**Files:**
- Create: `M/core/model/Lookup.kt`
- Modify: `M/data/api/KioskApi.kt`, `M/data/api/OkHttpKioskApi.kt`, every other `KioskApi` implementer, `T/data/FakeKioskApi.kt`
- Test: `T/core/model/ModelsJsonTest.kt`, `T/data/api/OkHttpKioskApiEndpointsTest.kt`

**Interfaces:**
- Produces (all `@Serializable`, snake_case fields matching `api/src/serversherpa/api/schemas.py` `KioskAssetLookupMatch`/`KioskAssetLookupOut`/`KioskAssetEndOut`/`KioskAssetRouteOut`/`KioskAssetMoveOut`/`KioskAssetFullOut`/`KioskAssetDetailOut`/`AssetScanItem`):
  - `data class KioskLookupMatch(val id: String, val name: String? = null, val asset_tag: String = "", val serial_number: String? = null, val matched: List<String> = emptyList())`
  - `data class KioskLookupResult(val matches: List<KioskLookupMatch> = emptyList(), val truncated: Boolean = false)`
  - `data class KioskAssetEnd(val site_name: String? = null, val pod: String? = null, val rack: String? = null, val ru: String? = null, val position: String? = null)`
  - `data class KioskAssetRoute(val initiative_id: String, val initiative_name: String, val source: KioskAssetEnd, val destination: KioskAssetEnd)`
  - `data class KioskAssetMove(val initiative_id: String, val initiative_name: String, val status: String = "", val status_label: String = "", val status_color: String = "")`
  - `data class KioskAssetFull(val status: String = "", val status_label: String = "", val status_color: String = "", val moves: List<KioskAssetMove> = emptyList(), val container_name: String? = null, val truck_name: String? = null, val location_detail: String = "")`
  - `data class KioskAssetDetail(val id: String, val name: String? = null, val make: String? = null, val model: String? = null, val make_model: String = "", val asset_tag: String = "", val serial_number: String? = null, val rfid: String? = null, val routes: List<KioskAssetRoute> = emptyList(), val full: KioskAssetFull? = null)`
  - `data class AssetScanRow(val id: String, val scanned_value: String = "", val scan_type: String = "", val scan_type_label: String = "", val scan_type_color: String = "", val status: String? = null, val status_label: String? = null, val status_color: String? = null, val scanned_at: String, val device_id: String = "", val operator_name: String? = null, val site_name: String? = null, val location_detail: String = "", val off_move: Boolean = false)`
  - `KioskApi`: `suspend fun lookupAssets(serial: String, value: String): KioskLookupResult`, `suspend fun assetDetail(serial: String, assetId: String): KioskAssetDetail`, `suspend fun assetScans(serial: String, assetId: String, limit: Int): List<AssetScanRow>`
  - `FakeKioskApi`: `var lookupAssetsResult: suspend (String, String) -> KioskLookupResult`, `var assetDetailResult: suspend (String, String) -> KioskAssetDetail`, `var assetScansResult: suspend (String, String, Int) -> List<AssetScanRow>`; each call appends to `calls` as `"lookupAssets:<value>"`, `"assetDetail:<id>"`, `"assetScans:<id>"`. Defaults throw `ApiError(404, "not_found", null)`.

- [ ] **Step 1: Failing tests.** `ModelsJsonTest.lookupModelsDecodeTheApiShape` decodes a sample lookup body (two matches, `matched: ["asset_tag","rfid"]`, `truncated: true`), a detail body with `full` present and one with `full: null`, and a scans array including `off_move: true` and an unknown extra key; asserts the fields. `OkHttpKioskApiEndpointsTest.assetLookupPaths` (existing MockWebServer pattern in that file) asserts the three request paths: `/kiosk/assets/lookup?serial=K%201&q=a%2Fb%20c` for `lookupAssets("K 1", "a/b c")`, `/kiosk/assets/<id>?serial=K%201`, `/kiosk/assets/<id>/scans?serial=K%201&limit=50`, each a GET with the bearer token.
- [ ] **Step 2:** Run `./gradlew testDebugUnitTest --tests '*ModelsJsonTest*' --tests '*OkHttpKioskApiEndpointsTest*'` — FAIL (unresolved).
- [ ] **Step 3:** Implement the models and the three `OkHttpKioskApi` methods with the existing `parse(authed { url(apiUrl(...)).get() }, …)` pattern and `q(...)` encoding (scans: `ListSerializer(AssetScanRow.serializer())`); add the overrides to `FakeKioskApi` and any other implementer.
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5:** Commit `feat(android): asset lookup models and API client`.

### Task 2: Pure matching, offline details and formatting

**Files:**
- Create: `M/core/lookup/AssetLookup.kt`, `M/core/text/NaturalSort.kt`
- Test: `T/core/lookup/AssetLookupTest.kt`, `T/core/text/NaturalSortTest.kt`

**Interfaces:**
- Consumes: Task 1 models; `padRfid`/`displayRfid` from `M/core/scan/Rfid.kt`.
- Produces:
  - `fun naturalCompare(a: String?, b: String?): Int` — null as ""; case-insensitive; runs of digits compare by numeric value (leading zeros ignored, then shorter run first on a tie); otherwise char order.
  - `@Serializable data class LocalAsset(val id: String, val asset_id: String = "", val name: String? = null, val rfid: String? = null, val serial_number: String? = null, val make: String? = null, val model: String? = null, val make_model: String = "", val container_id: String? = null, val source_rack: String? = null, val source_ru: String? = null, val source_position: String? = null, val source_pod: String? = null, val destination_rack: String? = null, val destination_ru: String? = null, val destination_position: String? = null, val destination_pod: String? = null, val asset_status: String? = null, val asset_status_label: String? = null, val location_detail: String? = null)` (decoded from `payload_json`)
  - `data class LocalLookupData(val assets: List<LocalAsset>, val containerNames: Map<String, String>, val moveId: String, val moveName: String, val sourceSite: String?, val destinationSite: String?)`
  - `const val LOOKUP_CAP = 25`; `const val SCAN_LIMIT = 50`
  - `fun matchLocal(assets: List<LocalAsset>, raw: String): KioskLookupResult`
  - `fun localDetail(asset: LocalAsset, data: LocalLookupData, admin: Boolean): KioskAssetDetail`
  - `fun matchLabel(kind: String): String` ("asset_tag"→"Asset tag", "serial"→"Serial", "rfid"→"RFID", "name"→"Name")
  - `fun placementText(full: KioskAssetFull): String` — `"<container> · on <truck>"`, container alone, else `location_detail`, else "" (port of `portal/src/lib/placement.ts`)
  - `fun scanWhenText(iso: String, zone: java.time.ZoneId): String` — `yyyy-MM-dd HH:mm` in `zone`, the raw value if it doesn't parse.
  - `fun distinctTags(epcs: List<String>): List<String>` — padded tags (`padRfid(it).tag`), invalid ones dropped, de-duplicated, first-seen order.

`matchLocal` is the web `matchLocal` exactly: trim; empty → no matches. Asset tag only when the value is `^[1-9][0-9]*$` and ≤ 18 chars and equals `asset_id`; serial when `serial_number.trim()` equals the value ignoring case; RFID when both pad to the same 24-char tag. Any exact hits → those (each with every kind it hit, in order asset_tag, serial, rfid), sorted by `naturalCompare(name)` then `naturalCompare(asset_tag)`, capped at 25 with `truncated`. No exact hit → names containing the value (ignoring case), sorted by name, `matched = ["name"]`, capped the same. `localDetail` is the web `localDetail`: one route (the move, `sourceSite`/`destinationSite` and the asset's rack/RU/position/pod); `full` only when `admin` — status and label from the asset, color "", moves = the move with empty status when `moveId` is set, `container_name` from `containerNames`, `truck_name` null, `location_detail` or "".

- [ ] **Step 1: Failing tests** (`AssetLookupTest`): `assetTagMatchesOnlyPlainDigits` ("0102466" and "12a" don't hit an asset whose tag is "102466"; "102466" does); `serialIgnoresCaseAndSpaces`; `rfidMatchesPaddedOrNot` ("100418" and "000000000000000000100418" both hit rfid "000000000000000000100418"); `oneValueOnTwoDevicesListsBothWithKinds` (value "102466" = A's tag and B's padded RFID → two matches, kinds `["asset_tag"]` and `["rfid"]`); `nameFallbackOnlyWithoutExactHit`; `capAt25Truncates` (30 name hits → 25, truncated); `sortsNaturally` ("Rack 2" before "Rack 10"); `emptyValueFindsNothing`; `localDetailHidesFullBelowAdmin`; `localDetailAdminHasContainerNameNoTruckNoColor`; `placementTextForms`; `scanWhenTextIs24Hour` ("2026-11-08T21:05:00Z" in UTC → "2026-11-08 21:05"); `distinctTagsDedupesPadded` (["100418","000000000000000000100418","ZZ!"] → one tag). `NaturalSortTest`: numbers by value, case ignored, nulls first.
- [ ] **Step 2:** Run `--tests '*AssetLookupTest*' --tests '*NaturalSortTest*'` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, plus `--tests '*CorePurityTest*' --tests '*AndroidRegexTest*'` — PASS.
- [ ] **Step 5:** Commit `feat(android): asset lookup matching and offline details`.

### Task 3: Repository — online first, offline fallback

**Files:**
- Create: `M/data/lookup/AssetLookupRepository.kt`
- Test: `T/data/lookup/AssetLookupRepositoryTest.kt`

**Interfaces:**
- Consumes: Task 1 API methods; Task 2 `LocalAsset`, `LocalLookupData`, `matchLocal`, `localDetail`; `KioskDatabase` (`assets().all()` → `payloadJson`, `containers().all()`, `meta().get(LABEL_CONTEXT_META_KEY)` holding the raw `label_context` JSON with `source_site`/`destination_site` text, `Sync.readMeta(db)` for `initiativeId`/`initiativeName`); `KioskJson`.
- Produces:
  - `data class Found(val offline: Boolean, val result: KioskLookupResult)`
  - `data class Opened(val offline: Boolean, val detail: KioskAssetDetail?)`
  - `class AssetLookupRepository(private val api: KioskApi, private val db: KioskDatabase)` with `suspend fun find(serial: String, value: String): Found`, `suspend fun open(serial: String, id: String, offline: Boolean, admin: Boolean): Opened`, `suspend fun scans(serial: String, id: String): List<AssetScanRow>` (limit `SCAN_LIMIT`), `suspend fun loadLocal(): LocalLookupData` (rows whose payload doesn't decode are skipped).

Fallback only on `ApiError.isNetwork` (and code `"edge_offline"`); every other `ApiError` is rethrown. `open` with `offline = true` skips the API.

- [ ] **Step 1: Failing tests** with `KioskDatabase.inMemory`, seeded `AssetEntity` rows whose `payloadJson` is a real `/kiosk/sync/assets` element (include `source_rack`, `destination_ru`, `asset_status_label`, `container_id`), a container row, a label-context meta row and the sync meta row: `onlineUsesTheApi` (no Room read changes the answer: API result returned, `offline=false`); `networkErrorFallsBackToSyncedAssets` (`ApiError(0,"network",null)` → local match, `offline=true`); `detailFallsBackWhenNetworkDropsAfterLookup`; `forbiddenDoesNotFallBack` (404 and 403 rethrown from `find` and `open`); `offlineDetailCarriesSitesFromLabelContext`; `unknownIdOfflineIsNull`; `nothingIsWrittenToTheOutbox` (`db.outbox().count()` stays 0 across all calls).
- [ ] **Step 2:** Run `--tests '*AssetLookupRepositoryTest*'` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5:** Commit `feat(android): asset lookup repository with offline fallback`.

### Task 4: View model

**Files:**
- Create: `M/ui/screens/lookup/AssetLookupViewModel.kt`
- Test: `T/ui/screens/lookup/AssetLookupViewModelTest.kt`

**Interfaces:**
- Consumes: Task 3 repository; `container.identity.get().serial`; Task 2 `distinctTags`, `SCAN_LIMIT`.
- Produces:
  - `sealed interface ScanHistory { object Hidden; object Loading; object Failed; data class Rows(val rows: List<AssetScanRow>) }`
  - `data class LookupUi(val value: String = "", val offline: Boolean = false, val list: KioskLookupResult? = null, val detail: KioskAssetDetail? = null, val miss: String? = null, val error: String? = null, val scans: ScanHistory = ScanHistory.Hidden, val notice: String? = null)`
  - `class AssetLookupViewModel(repo: AssetLookupRepository, identity: Identity /* M/data/identity/Identity.kt; serial = identity.get().serial */, isAdmin: () -> Boolean, canScans: () -> Boolean, scopeOverride: CoroutineScope? = null) : ViewModel()` with `val ui: StateFlow<LookupUi>`, `fun onValueChange(v: String)`, `fun lookup()`, `fun onScan(value: String)` (sets the value and looks up), `fun onSweep(epcs: List<String>)`, `fun pick(id: String)`, `fun clear()`.

Behavior is the web screen's: `lookup` ignores blank; empties the box at once and clears list/detail/miss/error/notice; a request counter drops any answer to an older lookup/pick/clear; no match → `miss = value` and the value is put back; error → `error = "Couldn't look that up. Try again."` and the value put back; one match → `open`; several → `list`. Details missing → `error = "Couldn't load that asset."`. After a detail opens: scans load only when `detail.full != null`, `full.moves` not empty, not offline and `canScans()`; offline with an admin card → history shows the needs-connection line (screen decides from `offline`). `onSweep`: `distinctTags` empty → nothing; one → `onScan(tag)`; more → `notice = "<N> tags read. Point the reader at one tag and try again."`, no lookup.

- [ ] **Step 1: Failing tests** with `FakeKioskApi` + in-memory DB, `scopeOverride = backgroundScope`, `settle()` as in `EnrollViewModelTest`: `oneMatchOpensDetail`; `severalMatchesShowList`; `noMatchKeepsValueAndSaysSo`; `errorKeepsValue`; `newerLookupWins` (first `lookupAssetsResult` suspends on a `CompletableDeferred`, second answers; then complete the first — UI shows the second); `clearDropsInFlightAnswer`; `scansOnlyForAdminWithScansViewOnMovedDevice` (four cases: worker, admin without scans:view, admin on no move, admin+scans:view+move → `assetScans` called once); `scanFailureShowsFailed`; `sweepOfOneTagLooksUp`; `sweepDedupesByPaddedTag`; `sweepOfSeveralSaysSo` (notice text exact, no API call); `blankLookupIsNoOp`.
- [ ] **Step 2:** Run `--tests '*AssetLookupViewModelTest*'` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5:** Commit `feat(android): asset lookup view model`.

### Task 5: Screen, tile and route

**Files:**
- Create: `M/ui/screens/lookup/AssetLookupScreen.kt`, `M/ui/components/ColorChip.kt` (moved from `RolodexList.kt`; Rolodex imports it)
- Modify: `M/core/features/Features.kt`, `M/ui/Routes.kt`, `M/ui/KioskApp.kt`, `M/ui/screens/home/FeatureIcons.kt`, `M/ui/screens/rolodex/RolodexList.kt`
- Test: `T/ui/screens/lookup/AssetLookupScreenTest.kt`, `T/core/features/FeaturesTest.kt`, `T/ui/screens/home/HomeScreenTest.kt`, `T/ui/StationModeTest.kt` (only as needed)

**Interfaces:**
- Consumes: Task 4 view model and `LookupUi`; Task 2 `matchLabel`, `placementText`, `scanWhenText`, `SCAN_LIMIT`; `PageHeader`, `ScanInput`, `CameraFieldButton`, `CameraScanSheet`, `SolidButton`, `MiniButton`, `KioskToast`, `SetupCard`; `container.scanBus`, `container.rfid` (`arm()`, `disarm()`, `bursts`).
- Produces: `@Composable fun AssetLookupScreen(nav: NavController)`; `Routes.LOOKUP = "lookup"`; `FeatureId.LOOKUP`; `KioskApp` line `gated(nav, Routes.LOOKUP, FeatureId.LOOKUP) { AssetLookupScreen(nav) }`; `public fun hexColor(...)` and `@Composable fun ColorChip(...)` in `ui/components`.

Layout per the spec's "The screen (Android)": header; `ScanInput(keepFocus = !camera, trailingIcon = camera button when container.hasCamera)` with Search (`SolidButton`) and Clear (`MiniButton`) beneath it in a row; offline line; miss/error/notice via `KioskToast(error = true)` (notice not as error); the match list as stacked rows (tap the name to `pick`), "Matched on" line per row only when any match is not by name; the card: name + make/model with the admin `ColorChip` (plain chip when no color) at top right, then Asset tag / Serial / RFID (display form) and admin Current location, then for each route (move name above it when 2+) Source and Destination columns of Site / Rack / RU-or-Position (Position when RU blank and position set), then admin Moves (name + chip each), then Scan history (rows: status chip or "—", amber `KioskChip("Off move", ChipTone.AMBER)` when off-move, `scanWhenText`, method chip, Device / Operator / Site / Location, "—" for blanks; "Latest 50 scans shown." when 50 rows). Collect `scanBus.events` → `vm.onScan`, `rfid.bursts` → `vm.onSweep`; `DisposableEffect { rfid.arm(); onDispose { rfid.disarm() } }`. `KioskShell(scroll = true)` default.

- [ ] **Step 1: Failing tests.** `FeaturesTest.orderMatchesTheWebKiosk` → `listOf("setup","scan","enroll","containers","trucks","lookup","labels","timeclock","settings")`; `lookupIsNotOnATimeClockStation`. `AssetLookupScreenTest` (Robolectric, `testContainer(api = fake)`, completed setup): `tileOpensTheScreen`; `greyedUntilSetup` (tile disabled, "Finish Kiosk Setup first." count in `HomeScreenTest` updated to 7); `workerSeesSourceAndDestinationOnly` (no "Moves", no "Current location", no "Scan history"); `adminSeesFullCardAndHistory`; `positionShownWhenNoRu`; `moveNamesShownForTwoRoutes`; `offlineShowsNotice`; `dataWedgeScanLooksUp` (`scanBus.publish(ScanEvent("102466", ScanSource.DATAWEDGE))` → `calls` has `lookupAssets:102466`); `leavingDisarmsTheSled` (`FakeRfidReader`/controller shows armed on enter, disarmed after navigating Home); `fitsAt320dp` (`@Config(qualifiers = "w320dp-h640dp")`, admin card with long values: the Search and Clear buttons and every label are displayed, nothing clipped — assert `assertIsDisplayed` on "Search", "Clear", "Current location" and "Destination"); `outboxStaysEmpty` (after several lookups `db.outbox().count() == 0`). Rolodex tests still pass after the `ColorChip` move.
- [ ] **Step 2:** Run `--tests '*AssetLookupScreenTest*' --tests '*FeaturesTest*' --tests '*HomeScreenTest*'` — FAIL.
- [ ] **Step 3:** Implement; add a `lookup` icon to `FEATURE_ICONS` (a magnifier over a tag, same `icon(name, strokes, fills)` style).
- [ ] **Step 4:** Run the whole suite and the debug build: `./gradlew testDebugUnitTest assembleDebug` — PASS.
- [ ] **Step 5:** Commit `feat(android): Asset Lookup screen and Home tile`.

### Task 6: Docs

**Files:**
- Modify: `Android_Kiosk_App/README.md` (a short "Asset Lookup" section after "Sign-in": what it does, who sees what, offline, the sled rule, link to both specs); `docs/superpowers/specs/2026-11-10-android-asset-lookup-design.md` (an "Implementation notes" section: files, any rulings made during the build).

- [ ] **Step 1:** Write both. **Step 2:** Commit `docs(android): Asset Lookup notes`.
