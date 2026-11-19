# iOS Devices Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iOS kiosk app asks the devices service for a newer build and offers a one-tap over-the-air update (Home banner + Settings row), only on Ad Hoc installs.

**Architecture:** Pure Core pieces (profile reader, devices URL, answer → offer mapping) feed a Data-layer client (`URLSessionDevicesApi`) and an `@Observable` `UpdateChecker` owned by `AppContainer`, which checks after sign-in, on foreground after 6 hours, and on demand. SwiftUI views on Home and Settings › This Kiosk read the checker.

**Tech Stack:** Swift 6 / SwiftUI, iOS 18.0+, Swift Testing, URLSession, no third-party dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-ios-update-check-design.md` (short design) and the "In-app update check" section of `docs/superpowers/specs/2026-11-17-devices-app-design.md`. Contract: `devices/api/src/serversherpa_devices/api/routes/updates.py`.

## Global Constraints

- Work only in `IOS_Kiosk_App/` (plus this plan/spec). Never touch Android, the portal, the web kiosk or `devices/`.
- `Core/` is Foundation-only (`CorePurityTests` enforces it).
- Synchronized folders: new files need no project edits, but file **basenames must be unique** in a target.
- No third-party dependencies.
- Shared coders `KioskJSON.encoder/decoder` have no key strategy: spell wire names in `CodingKeys`.
- Build/test (always set `DEVELOPER_DIR`), from `IOS_Kiosk_App/ServerSherpa Kiosk`:
  - `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
  - Unit tests: `xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived -only-testing:"ServerSherpa KioskTests/<Suite>"` (whole target: `-only-testing:"ServerSherpa KioskTests"`)
  - Phone build: `xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' -derivedDataPath ../.derived`
- One simulator at a time: shut down any simulator you booted (`xcrun simctl shutdown all`) before finishing; never leave a second one running. Never `adb`/device settings.
- Tests never touch the live API or Keychain (`RuntimeEnvironment.isUnitTestHost`); use `StubServer`/`StubURLProtocol`, `MemorySecretStore`, fakes.
- House UI: colors from `@Environment(\.kioskPalette)` only (light and dark follow the theme); buttons are `PrimaryButton`/`SecondaryButton`/`LinkButton` from `UI/Components/Buttons.swift`; times are 24-hour `HH:mm`; American English; no buttons below a scroll in a sheet.
- Copy (exact): Home title `Update available — <version_name>` (em dash); buttons `Update`, `Later`, `Check for updates`; register-first fallback `Add this iPhone on <devices host> first.`; signed out `Sign in to check for updates.`; last check `Last checked HH:mm`.
- Commit after each task; messages `feat(ios): …` / `test(ios): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A devices 401/403 (devices service can't verify the token) must **not** sign the kiosk out — Task 3 test `unauthorizedNeverEndsTheSession`.
2. An `available` answer whose `install_url` is not `itms-services://` (or is missing) must never be opened — Task 2 test `availableWithoutItmsUrlIsNotOffered`.
3. A profile file that isn't a profile (truncated, garbage, no plist) reads as `none`, never `adhoc` — Task 1 test `garbageReadsAsNone`.
4. API URLs that aren't `api.<…>` (localhost, IP, `http://api.dev…:8000`) — no request is sent, Settings explains — Task 2 `devicesBaseUrl` cases + Task 4 `noDevicesUrlFailsWithoutARequest`.
5. Foreground flapping (Control Center, app switcher) must not re-check inside 6 hours, and two overlapping checks share one request — Task 4 `foregroundInsideSixHoursDoesNotCheck`, `overlappingChecksSendOneRequest`.

---

### Task 1: Provisioning profile reader (Core) with fixture profiles

**Files:**
- Create: `ServerSherpa Kiosk/Core/Updates/ProvisioningProfile.swift`
- Create: `ServerSherpa KioskTests/Core/Fixtures/Profiles/{adhoc,development,enterprise,appstore}.mobileprovision`, `make_fixtures.sh` (how they were made)
- Test: `ServerSherpa KioskTests/Core/ProvisioningProfileTests.swift`

**Interfaces:**
- Produces: `enum ProfileKind: String, Sendable, Equatable { case adhoc, development, none }` (raw values are the wire values) and `func profileKind(fromMobileprovision data: Data?) -> ProfileKind`.

- [ ] **Step 1: Make the fixtures.** `make_fixtures.sh` writes four XML plists and signs each into real CMS/DER with a throwaway self-signed cert: `openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=Fixture" -keyout k.pem -out c.pem -days 1` then `openssl cms -sign -binary -nodetach -outform DER -in X.plist -signer c.pem -inkey k.pem -out X.mobileprovision`; key/cert deleted after. Plists (use only made-up values, e.g. UDID `00008110-0000000000000001`, team `Y2QYBG96U4`, `Name`, `UUID`):
  - adhoc: `ProvisionedDevices` [2 UDIDs], `Entitlements.get-task-allow` false
  - development: `ProvisionedDevices` [1], `get-task-allow` true
  - enterprise: `ProvisionsAllDevices` true, `get-task-allow` false, no devices
  - appstore: no devices, `get-task-allow` false
- [ ] **Step 2: Write failing tests** (Swift Testing, load with `Bundle(for: ProfileFixtureBundle.self)`, a private `final class` token as other suites do):
  - `adhocReadsAsAdhoc` → `.adhoc`; `developmentReadsAsDevelopment` → `.development`; `enterpriseReadsAsNone`, `appStoreReadsAsNone` → `.none`
  - `missingFileReadsAsNone`: `profileKind(fromMobileprovision: nil) == .none`
  - `garbageReadsAsNone`: random bytes; the adhoc fixture truncated to half its length; `Data("<?xml version".utf8)` with no `</plist>` → all `.none`
  - `emptyDeviceListIsNotAdhoc`: a plain XML plist (unsigned bytes are fine: the reader only scans) with `ProvisionedDevices` `[]` and get-task-allow false → `.none`
- [ ] **Step 3: Run** `-only-testing:"ServerSherpa KioskTests/ProvisioningProfileTests"` → fails to compile (no `profileKind`).
- [ ] **Step 4: Implement.** Find the first `<?xml` and the following `</plist>` byte ranges in `data` (`Data.range(of:)`), parse that slice with `PropertyListSerialization`; any failure → `.none`. `get-task-allow` true → `.development`; non-empty `[String]` `ProvisionedDevices` → `.adhoc`; else `.none`.
- [ ] **Step 5: Run** the suite → PASS; also `CorePurityTests` → PASS.
- [ ] **Step 6: Commit** `feat(ios): read the app's own provisioning profile kind`.

### Task 2: Devices URL, update answer and offer (Core)

**Files:**
- Create: `ServerSherpa Kiosk/Core/Updates/UpdateOffer.swift`
- Test: `ServerSherpa KioskTests/Core/UpdateOfferTests.swift`

**Interfaces:**
- Consumes: `ProfileKind` (Task 1).
- Produces:
  - `func devicesBaseUrl(apiUrl: String) -> String?` — first host label `api` → `devices`, scheme and port kept, no path, no trailing slash; any other host → nil.
  - `struct UpdateAnswer: Decodable, Equatable, Sendable { status: String; versionName, build, notes, installUrl, message: String?; size: Int? }` with CodingKeys `version_name`, `install_url`.
  - `enum UpdateOffer: Equatable, Sendable { case upToDate; case available(version: String, build: String?, notes: String?, size: Int?, installUrl: URL); case registerFirst(message: String); case waiting(message: String) }` with `var showsOnHome: Bool` (true for `.available`, `.registerFirst`).
  - `func updateOffer(_ answer: UpdateAnswer, profile: ProfileKind, devicesUrl: String) -> UpdateOffer`
  - `struct UpdateQuery: Equatable, Sendable { bundleId: String; build: String; profile: ProfileKind }` with `var queryItems: [URLQueryItem]` in the order `platform=ios, bundle_id, build, profile_kind`.

- [ ] **Step 1: Write failing tests:**
  - `devicesUrlFromApi`: `https://api.dev.serversherpa.com` → `https://devices.dev.serversherpa.com`; `https://api.serversherpa.com/` → `https://devices.serversherpa.com`; `http://api.dev.serversherpa.com:8000` → `http://devices.dev.serversherpa.com:8000`; `http://localhost:8000`, `http://192.168.1.5:8000`, `https://portal.dev.serversherpa.com`, `https://apis.example.com`, `not a url` → nil.
  - `decodesTheContract`: `{"status":"available","version_name":"1.2.0","build":"7","notes":"Fixes","size":1234,"install_url":"itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fota%2Ft%2Fmanifest.plist"}` decodes every field; `{"status":"up_to_date"}` decodes with nils.
  - `availableOnAdhocIsOffered` → `.available(version: "1.2.0", build: "7", notes: "Fixes", size: 1234, installUrl: …)`.
  - `availableWithoutAdhocAsksToRegister`: same answer with `.development` and with `.none` → `.registerFirst(message: "Add this iPhone on devices.dev.serversherpa.com first.")` (devicesUrl `https://devices.dev.serversherpa.com`).
  - `availableWithoutItmsUrlIsNotOffered`: install_url `https://evil.example/x.ipa`, and nil → `.waiting(message: "This update's install link isn't valid. Check again later.")`.
  - `registerFirstUsesTheServersMessage`: `{"status":"register_first","message":"Add this iPhone on https://devices.dev.serversherpa.com first."}` → `.registerFirst` with that message; without message → the fallback above.
  - `preparingAndNotSetUpWait`: `preparing` / `not_set_up` with messages → `.waiting(message:)` with that message; unknown status `"later_thing"` without message → `.waiting(message: "The Devices site sent an answer this app doesn't know.")`.
  - `upToDate` → `.upToDate`; `showsOnHome` true only for available/registerFirst.
  - `queryItems`: `UpdateQuery(bundleId: "Server-Sherpas.ServerSherpa-Kiosk", build: "1", profile: .adhoc).queryItems` == `[platform=ios, bundle_id=Server-Sherpas.ServerSherpa-Kiosk, build=1, profile_kind=adhoc]`.
- [ ] **Step 2: Run** `-only-testing:"ServerSherpa KioskTests/UpdateOfferTests"` → compile failure.
- [ ] **Step 3: Implement** in `UpdateOffer.swift` (use `URLComponents` for the host swap; `version` falls back to `build` then `"a new version"` when `version_name` is missing).
- [ ] **Step 4: Run** → PASS. Commit `feat(ios): devices URL and update offer mapping`.

### Task 3: Devices API client (Data)

**Files:**
- Create: `ServerSherpa Kiosk/Data/Updates/DevicesApi.swift`
- Test: `ServerSherpa KioskTests/Data/DevicesApiTests.swift`

**Interfaces:**
- Consumes: `UpdateQuery`, `UpdateAnswer` (Task 2); `SessionStore` (`tokenIsStale()`, `refresh()`, `accessToken()`), `URLSessionKioskApi.execute(_:on:)`, `.parse(_:)`, `.url(_:)`, `.request(_:)`.
- Produces:
  - `protocol DevicesApi: Sendable { func checkUpdates(_ query: UpdateQuery) async throws -> UpdateAnswer }`
  - `final class URLSessionDevicesApi: DevicesApi` with `init(devicesUrl: @escaping @Sendable () async -> String?, session: URLSession, sessionStore: SessionStore)`.
  - `enum DevicesApiError: Error, Equatable { case noDevicesUrl }` (other failures are `ApiError`, as elsewhere).

- [ ] **Step 1: Write failing tests** (`@Suite(.serialized, .timeLimit(.minutes(1)))`, `ApiHarness` for a signed-in `SessionStore`; a second `StubServer` as the devices host passed via `devicesUrl: { devices.baseURL }`; the same `makeSession(protocolClasses: [StubURLProtocol.self])` session):
  - `sendsTheQueryWithTheBearer`: after `signIn` (token `tok1`), a 200 answer → request `GET /api/updates?platform=ios&bundle_id=Server-Sherpas.ServerSherpa-Kiosk&build=1&profile_kind=adhoc`, header `Authorization: Bearer tok1`; answer decoded.
  - `unauthorizedNeverEndsTheSession`: devices answers 401 `{"detail":{"code":"unauthenticated","message":"Sign in to continue."}}` → throws `ApiError(status: 401, code: "unauthenticated", …)`; the API stub saw **no** refresh request, `session.accessToken() == "tok1"`, and `sessionEnded` yielded nothing (check with a short-timeout read, as existing auth tests do).
  - `refreshesAStaleTokenFirst`: advance `TestClock` past expiry; API stub answers the refresh with `sessionResponse(token: "tok2")`; devices request carries `Bearer tok2`.
  - `noDevicesUrlThrows`: `devicesUrl: { nil }` → throws `DevicesApiError.noDevicesUrl`, no request on either stub.
  - `networkFailureIsApiNetwork`: devices `.fail()` → `ApiError.network()`.
- [ ] **Step 2: Run** `-only-testing:"ServerSherpa KioskTests/DevicesApiTests"` → compile failure.
- [ ] **Step 3: Implement**: refresh when stale; build `<devicesUrl>/api/updates` with `URLComponents.queryItems = query.queryItems`; bearer when a token exists; one `execute`; `parse` (non-2xx → `ApiError.from`). No retry, no `notifySessionEnded`.
- [ ] **Step 4: Run** → PASS. Commit `feat(ios): devices update-check client`.

### Task 4: Update checker and app wiring (Data + App)

**Files:**
- Create: `ServerSherpa Kiosk/Data/Updates/UpdateChecker.swift`, `ServerSherpa Kiosk/Data/Updates/InstalledApp.swift`
- Modify: `ServerSherpa Kiosk/App/AppContainer.swift` (own `updates`, wire `authChanged`/`onActive`, inject into `appContainer(_:)`)
- Test: `ServerSherpa KioskTests/Data/UpdateCheckerTests.swift`, `ServerSherpa KioskTests/Support/FakeDevicesApi.swift`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `struct InstalledApp: Equatable, Sendable { bundleId, versionName, build: String; profile: ProfileKind; static func current(bundle: Bundle = .main) -> InstalledApp }` (reads `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, and `embedded.mobileprovision` via `profileKind(fromMobileprovision:)`).
  - `enum UpdateCheckState: Equatable { case idle, checking, done(UpdateOffer), failed(String) }`
  - `@MainActor @Observable final class UpdateChecker` with `init(api: any DevicesApi, installed: InstalledApp, devicesUrl: @escaping @MainActor () -> String?, signedIn: @escaping @MainActor () -> Bool, now: @escaping () -> Date = Date.init)`; read-only `state`, `lastChecked: Date?`, `installed`; `var homeOffer: UpdateOffer?`; `func checkNow() async`; `func checkIfDue() async`; `func later()`; `func reset()`; `static let interval: TimeInterval = 6 * 3600`; `var devicesHost: String?` (host of `devicesUrl()`, for copy).
  - `AppContainer.updates: UpdateChecker`; `.environment(c.updates)` in `appContainer(_:)`.

- [ ] **Step 1: Write failing tests** (fake API records calls, answers from a queue, can hold an answer):
  - `checkNowStoresTheOffer`: answer available (adhoc installed) → `state == .done(.available(…))`, `lastChecked == now`, `homeOffer` is that offer.
  - `signedOutNeverChecks`: `signedIn` false → `checkNow()` and `checkIfDue()` send nothing; state `.idle`.
  - `foregroundInsideSixHoursDoesNotCheck`: check at t0; `checkIfDue()` at t0+5h59m → 1 call; at t0+6h → 2 calls.
  - `overlappingChecksSendOneRequest`: two `checkNow()` concurrently while the fake holds → 1 call, both return after release.
  - `laterHidesHomeUntilAnotherOffer`: `later()` → `homeOffer == nil`, `state` unchanged; next check with the same offer → still nil; a different version → shown.
  - `registerFirstShowsOnHome`, `waitingStaysOffHome` (`homeOffer` nil for `.waiting`/`.upToDate`).
  - `noDevicesUrlFailsWithoutARequest`: `devicesUrl` nil → `.failed("This kiosk's API address doesn't start with api., so the Devices site can't be found.")`, 0 calls.
  - `failuresSayWhy`: `ApiError.network()` → `.failed("Can't reach <host>.")`; `ApiError(status: 503, code: "main_api_unavailable", detail: ["message": "Sign-in is unavailable right now. Try again in a minute."])` → that message; `ApiError(status: 500, code: "x")` → `.failed("The Devices site answered 500.")`.
  - `failureKeepsTheLastOffer`: a successful `available` check, then a failed one → `state == .failed(…)` but `homeOffer` is still the earlier offer (the checker keeps `lastOffer` separately from `state`).
  - `resetForgetsEverything`: after a check, `reset()` → `.idle`, `lastChecked` nil, `homeOffer` nil (sign-out).
- [ ] **Step 2: Run** `-only-testing:"ServerSherpa KioskTests/UpdateCheckerTests"` → compile failure.
- [ ] **Step 3: Implement** the checker (single-flight with a stored `Task`; `checkIfDue` = signed in and (`lastChecked` nil or ≥ `interval` old); query from `installed`; offer via `updateOffer(_:profile:devicesUrl:)`; `later()` stores the current offer as hidden).
- [ ] **Step 4: Wire `AppContainer`**: build `URLSessionDevicesApi(devicesUrl: { await MainActor.run { devicesBaseUrl(apiUrl: config.apiUrl) } }, session: session, sessionStore: sessionStore)` on the shared session; `authChanged()` → authed: `Task { await updates.checkIfDue() }`, anon: `updates.reset()`; `onActive()` → `Task { await updates.checkIfDue() }`. `InstalledApp.current()` in the live container. DEBUG only: launch argument `-uiTestUpdate <available|register_first|preparing|up_to_date>` makes the checker answer from a built-in `SampleDevicesApi` (sample: version `1.2.0`, build `7`, notes `"Faster sync.\nFixes the scan box on iPhone."`, size `48_200_000`, install_url `itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fota%2Fsample%2Fmanifest.plist`) and treats the install as `.adhoc` for `available` (so the Update button shows in the simulator). Keep the sample in `#if DEBUG`.
- [ ] **Step 5: Run** `UpdateCheckerTests` → PASS, then the whole unit target → PASS (no regressions), then the phone build → BUILD SUCCEEDED.
- [ ] **Step 6: Commit** `feat(ios): update checker — after sign-in, every 6 h on foreground`.

### Task 5: Home banner and Settings row, verified in the simulator

**Files:**
- Create: `ServerSherpa Kiosk/UI/Screens/Home/UpdateBanner.swift`, `ServerSherpa Kiosk/UI/Screens/Settings/AppUpdatesRow.swift`
- Modify: `UI/Screens/Home/HomeScreen.swift` (banner under `PageHeader`, above the setup banner), `UI/Screens/Settings/ThisKioskPanel.swift` (row right after `Version`), `IOS_Kiosk_App/README.md` (an "App updates" section: when it checks, profile kinds, `-uiTestUpdate`).
- Test: `ServerSherpa KioskTests/UI/UpdateCopyTests.swift` (pure copy helpers), `ServerSherpa KioskUITests/UpdateBannerUITests.swift`

**Interfaces:**
- Consumes: `UpdateChecker` from the environment, `UpdateOffer`.
- Produces: pure helpers in `AppUpdatesRow.swift`: `func updateStatusLine(_ state: UpdateCheckState, installed: InstalledApp) -> String`, `func lastCheckedLine(_ date: Date?, timeZone: TimeZone = .current) -> String?` (`"Last checked HH:mm"`, 24-hour, `en_US_POSIX`), `func sizeLine(_ bytes: Int?) -> String?` (`ByteCountFormatter`, `.file`).

- [ ] **Step 1: Failing copy tests**: `lastCheckedLine` at 2026-11-18T14:05Z in UTC → `"Last checked 14:05"`, 21:30 → `"Last checked 21:30"` (never AM/PM), nil → nil; `updateStatusLine`: `.idle` → `"Not checked yet."`, `.checking` → `"Checking…"`, `.done(.upToDate)` → `"Up to date — 1.0 (1)."`, `.done(.available(version: "1.2.0", …))` → `"Update available — 1.2.0"`, `.failed("x")` → `"Couldn't check for updates. x"`.
- [ ] **Step 2: Run** `-only-testing:"ServerSherpa KioskTests/UpdateCopyTests"` → fail; implement helpers; → PASS.
- [ ] **Step 3: Build the views.**
  - `UpdateBanner` (Home, only when `updates.homeOffer != nil`): a card in `palette.paper` with `palette.paperLine` stroke, corner radius 10 (as `SetupCard`), accessibility id `update-banner`. `.available`: title `Update available — <version>`, then `PrimaryButton("Update")` (opens `installUrl` with `openURL`) and `SecondaryButton("Later")` (`updates.later()`), side by side (wrap with `ViewThatFits` to a vertical stack on narrow phones). `.registerFirst`: title `Update available`, the message, `SecondaryButton("Later")` only.
  - `AppUpdatesRow` (`SettingsRow(title: "App updates", detail: "Updates come from the Devices site. The kiosk checks after sign-in and every 6 hours.")`): `updateStatusLine`; for `.available`: notes (`Text`, `palette.textMute`), `sizeLine`, `PrimaryButton("Update")`; for `.registerFirst`/`.waiting`: the message; then `SecondaryButton("Check for updates")` (`enabled` false while checking or signed out; signed out shows `Sign in to check for updates.`), and `lastCheckedLine`. Accessibility ids `check-for-updates`, `update-now`.
- [ ] **Step 4: UI test** `UpdateBannerUITests.signedOutSettingsExplains` (Home needs a session, which UI tests never have): launch with `-uiTestUpdate available -uiTestSignedOut`, open Settings from the login gear, assert `check-for-updates` exists and is disabled and `Sign in to check for updates.` is visible. Save a screenshot when `TEST_RUNNER_SCREENSHOT_DIR` is set (follow `SheetButtonsUITests` for the gear and screenshots).
- [ ] **Step 5: Simulator check (the done-gate for the banner):** build for iPhone 16 iOS 18.5, boot only that simulator, `xcrun simctl install` + `xcrun simctl launch … -uiTestUpdate available`. If the simulator has a signed-in session, screenshot Home (banner with Update + Later) and Settings › This Kiosk (row with notes, size, Update, Check for updates, `Last checked HH:mm`) in light and dark (`xcrun simctl ui booted appearance dark`), then `-uiTestUpdate register_first` (no Update button). Tap Later → banner gone. Tap Update → iOS shows the itms-services prompt or a "cannot open" alert in the simulator (expected; the real OTA test waits for the paid Apple account). If no session exists, sign in is the user's to do — record that and verify the signed-out Settings state only. Shut the simulator down afterwards.
- [ ] **Step 6: Whole unit target + phone build → PASS / BUILD SUCCEEDED. Commit** `feat(ios): update banner on Home and App updates in Settings`.
