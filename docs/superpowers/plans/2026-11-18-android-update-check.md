# Android in-app update check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `direct` build of the Android kiosk app that checks the Devices service for a newer APK, shows it on Home and in Settings, downloads it and hands it to the system installer; a `play` build that has none of it.

**Architecture:** Product flavors `play` (default) and `direct` in one `distribution` dimension. Shared code (`src/main`) holds the `AppUpdates` interface, its state type and the UI; `src/play` wires a no-op, `src/direct` wires the real client, downloader, `PackageInstaller` hand-off and the `REQUEST_INSTALL_PACKAGES` permission. Pure decisions (devices URL, answer mapping, re-check rule) live in `core/update`.

**Tech Stack:** Kotlin, Jetpack Compose, OkHttp 4.12, kotlinx.serialization, coroutines; tests JUnit4 + Robolectric 4.14.1 + MockWebServer + Compose UI test.

**Spec:** `docs/superpowers/specs/2026-11-18-android-update-check-design.md` (Android-specific design), parent `docs/superpowers/specs/2026-11-17-devices-app-design.md` ("Android", "In-app update check"). Server contract: `devices/api/src/serversherpa_devices/api/routes/updates.py`.

## Global Constraints

- All commands run from `Android_Kiosk_App/` with `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`; run Gradle in the foreground with a long timeout (10 min). Don't start a full suite while another session's suite runs (`pgrep -f GradleWorkerMain`); single test classes are fine.
- Once Task 1 lands, task names are `testPlayDebugUnitTest` / `testDirectDebugUnitTest` (`testDebugUnitTest` no longer exists). Shared tests (`src/test`) run under both; direct-only tests go in `src/testDirect`, play-only in `src/testPlay`.
- Both flavors keep `applicationId = "com.serversherpa.kiosk"` and the same `versionCode`/`versionName` (no suffixes).
- `src/main` and `src/play` must contain no `PackageInstaller`, `REQUEST_INSTALL_PACKAGES`, `ACTION_MANAGE_UNKNOWN_APP_SOURCES` or `canRequestPackageInstalls`.
- `core/` may not import `android*`/`androidx*` (`CorePurityTest`).
- New files never route through Internet Test (`// INTERNET-TEST`, `InternetTestRoutes`); RemovalGuardTest counts must stay unchanged.
- American English copy. Times are 24-hour `HH:mm`. Colors only from `LocalKioskColors` / `ChipTone`; the app follows light/dark. Buttons ≥ 48 dp from `ui/components/Buttons.kt` (`SolidButton` primary, `MiniButton` secondary).
- Exact copy: Home banner title `Update available — <versionName>` (em dash), buttons `Update` and `Later`; Settings button `Check for updates`.
- Devices host: the API URL's host must start with `api.`; the devices origin is the same scheme and port with `api.` replaced by `devices.`.
- Query: `GET <devices>/api/updates?platform=android&package=<pkg>&version_code=<n>&signing_digest=<64 lower-case hex>` with `Authorization: Bearer <kiosk access token>`.
- A 401 from the devices service never ends the kiosk session (no `SessionStore.notifySessionEnded()`).
- The APK download sends no `Authorization` header and no cookies; the link's token is the credential.
- Re-check interval on return to the front: 1 hour (`RECHECK_INTERVAL_MS = 3_600_000`).
- Compose tests: wait with `waitUntil { onAllNodesWithTag(..).fetchSemanticsNodes().isNotEmpty() }` before asserting; use `createComposeRule(StandardTestDispatcher())` when state changes off the main thread (memory: android-robolectric-flakes).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run `adb shell monkey`; launch with `adb -s <serial> shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.serversherpa.kiosk/.MainActivity`. Never change device settings.

## Review Focus

1. Devices host not there yet (DNS fails, connection refused, 502 from the proxy) → Settings shows "Couldn't reach <host>…", no crash, no sign-out, Home shows nothing. Test in Task 3 (network error → ApiError) and Task 5 (Failed state, banner hidden).
2. A custom API URL (`http://10.0.2.2:8010`, an IP) → Settings says this API address has no Devices site; no banner, no request. Test in Task 2 (`devicesUrlFor` → null) and Task 5 (`Unavailable`, no checker call).
3. The app goes to the background between download and installer confirm → the confirm screen opens when the app returns. Test in Task 4 (pending confirm stored when not foreground) and Task 5 (launched on foreground).
4. The person cancels the system install screen → back to Available with "Install canceled." Test in Task 4 (`STATUS_FAILURE_ABORTED` → event) and Task 5.
5. A link to another host, a truncated file, or an APK that isn't ours at the offered build → refused, file deleted, notice shown. Tests in Task 4.

---

### Task 1: Flavors, the `AppUpdates` seam and container wiring

**Files:**
- Modify: `app/build.gradle.kts` (add `flavorDimensions += "distribution"`; `productFlavors { create("play") { dimension = "distribution"; isDefault = true }; create("direct") { dimension = "distribution" } }`)
- Create: `app/src/main/java/com/serversherpa/kiosk/data/update/AppUpdates.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/update/UpdateOffer.kt` (`data class UpdateOffer(val versionName: String, val build: Long, val notes: String?, val size: Long?, val installUrl: String)`)
- Create: `app/src/play/java/com/serversherpa/kiosk/data/update/AppUpdatesFactory.kt`
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/AppUpdatesFactory.kt` (returns `NoAppUpdates` for now; Task 5 replaces it)
- Create: `app/src/direct/AndroidManifest.xml` (`<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>`)
- Modify: `app/src/main/java/com/serversherpa/kiosk/AppContainer.kt` (constructor param `updatesOverride: AppUpdates? = null`; `val updates: AppUpdates by lazy { updatesOverride ?: createAppUpdates(UpdateDeps(...)) }`; `start()` calls `updates.start()` after `SessionCoordinator(...).start()`)
- Modify: `app/src/test/java/com/serversherpa/kiosk/TestContainer.kt` (param `updates: AppUpdates = NoAppUpdates` passed as `updatesOverride`)
- Modify: `README.md` (Build and test, Release, Install: new task names and APK paths; a "Direct build (Devices)" paragraph: `./gradlew assembleDirectRelease` → `app/build/outputs/apk/direct/release/app-direct-release.apk`, signed with the same upload key, uploaded on devices.<env>; Play uploads stay `./gradlew bundlePlayRelease`; a phone with the Play copy uninstalls it once)
- Modify: `app/src/main/java/com/serversherpa/kiosk/nettest/REMOVAL.md` (only the `./gradlew testDebugUnitTest assembleDebug` lines → `./gradlew testPlayDebugUnitTest assembleDebug`; nothing else)
- Test: `app/src/testDirect/java/com/serversherpa/kiosk/FlavorManifestTest.kt`, `app/src/testPlay/java/com/serversherpa/kiosk/FlavorManifestTest.kt`, `app/src/test/java/com/serversherpa/kiosk/PlayHasNoInstallerTest.kt`

**Interfaces:**
- Produces (in `data/update/AppUpdates.kt`):
  ```kotlin
  sealed interface UpdateState {
      data object Idle : UpdateState
      data object Checking : UpdateState
      data class UpToDate(val checkedAtMillis: Long) : UpdateState
      data class Available(val offer: UpdateOffer, val checkedAtMillis: Long, val notice: String? = null) : UpdateState
      data class Downloading(val offer: UpdateOffer, val fraction: Float?) : UpdateState
      data class Installing(val offer: UpdateOffer) : UpdateState
      /** The server answered with a message instead of an offer (reinstall_required, …). Shown on Home and Settings. */
      data class Blocked(val message: String, val checkedAtMillis: Long) : UpdateState
      /** This kiosk can't check (no devices host for its API URL). Settings only. */
      data class Unavailable(val message: String) : UpdateState
      data class Failed(val message: String, val checkedAtMillis: Long) : UpdateState
  }
  interface AppUpdates {
      val supported: Boolean
      val state: StateFlow<UpdateState>
      val homeBannerVisible: StateFlow<Boolean>
      fun start(); fun check(); fun update(); fun later()
  }
  object NoAppUpdates : AppUpdates  // supported = false, Idle, banner false, no-ops
  class UpdateDeps(val app: Application, val client: OkHttpClient, val session: SessionStore,
      val apiUrl: suspend () -> String, val authState: StateFlow<AuthState>,
      val foreground: StateFlow<Boolean>, val scope: CoroutineScope)
  ```
- Produces (both flavor source sets, same package): `fun createAppUpdates(deps: UpdateDeps): AppUpdates`
- Produces: `AppContainer.updates: AppUpdates`; `testContainer(updates = …)`.

- [ ] **Step 1: Write the failing tests.** `FlavorManifestTest` (Robolectric, `@Config(sdk = [34])`) reads `packageManager.getPackageInfo(packageName, GET_PERMISSIONS).requestedPermissions`: direct asserts `REQUEST_INSTALL_PACKAGES` is in it (`theDirectBuildMayRequestInstalls`); play asserts it is not (`thePlayBuildNeverRequestsInstalls`). `PlayHasNoInstallerTest` (plain JUnit, runs in both flavors) walks `src/main` and `src/play` (resolve from `File("src")`, the module dir is the working dir) and asserts no file contains any of the four strings from Global Constraints (`mainAndPlayCarryNoSelfUpdateCode`).
- [ ] **Step 2: Run** `./gradlew testDirectDebugUnitTest --tests '*FlavorManifestTest'` → fails (no flavor task / permission missing).
- [ ] **Step 3: Implement** the flavors, manifest, `AppUpdates.kt`, `core/update/UpdateOffer.kt`, both factories, container and testContainer wiring, docs.
- [ ] **Step 4: Run** `./gradlew testPlayDebugUnitTest --tests '*FlavorManifestTest' --tests '*PlayHasNoInstallerTest' --tests '*BuildConfigTest' testDirectDebugUnitTest --tests '*FlavorManifestTest' --tests '*PlayHasNoInstallerTest' assembleDebug` → PASS, and both `app/build/outputs/apk/play/debug/app-play-debug.apk` and `app/build/outputs/apk/direct/debug/app-direct-debug.apk` exist.
- [ ] **Step 5: Commit** `feat(android): play and direct flavors with an AppUpdates seam`.

### Task 2: `core/update` — devices URL, answer mapping, re-check rule

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/core/update/UpdateCheck.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/core/update/UpdateCheckTest.kt`

**Interfaces:**
- Consumes: `UpdateOffer` (Task 1).
- Produces:
  ```kotlin
  @Serializable data class UpdateAnswerWire(val status: String, val version_name: String? = null, val build: String? = null,
      val notes: String? = null, val size: Long? = null, val install_url: String? = null, val message: String? = null)
  sealed interface UpdateAnswer { data object UpToDate; data class Available(val offer: UpdateOffer); data class Blocked(val message: String) }
  fun UpdateAnswerWire.toAnswer(): UpdateAnswer
  fun devicesUrlFor(apiUrl: String): String?
  const val RECHECK_INTERVAL_MS = 3_600_000L
  fun shouldRecheck(lastCheckMillis: Long?, nowMillis: Long, intervalMillis: Long = RECHECK_INTERVAL_MS): Boolean
  const val NO_DEVICES_HOST = "This kiosk's API address has no Devices site next to it, so it can't check for updates."
  const val BAD_ANSWER = "The Devices site sent an update this app can't read."
  /** The Settings line for a failed check (ApiError is core's). */
  fun checkFailureMessage(e: ApiError, devicesHost: String): String
  // network (status 0) → "Couldn't reach <devicesHost>. Try again later."
  // otherwise          → "The Devices site answered <status>. Try again later."
  ```

- [ ] **Step 1: Write the failing tests:**
  - `devicesUrlFor`: `"https://api.dev.serversherpa.com"` → `"https://devices.dev.serversherpa.com"`; `"https://api.serversherpa.com/"` → `"https://devices.serversherpa.com"`; `"https://API.dev.serversherpa.com:8443"` → `"https://devices.dev.serversherpa.com:8443"`; `"http://10.0.2.2:8010"`, `"https://portal.dev.serversherpa.com"`, `"https://myapi.example.com"`, `"not a url"` → `null`.
  - `toAnswer`: `up_to_date` → `UpToDate`; `available` with `version_name="0.1.2", build="3", notes="Fixes", size=123, install_url="https://devices.x/dl/t/a.apk"` → `Available(UpdateOffer("0.1.2", 3, "Fixes", 123, "https://devices.x/dl/t/a.apk"))`; `available` without `install_url` or with `build="x"` → `Blocked(BAD_ANSWER)`; `reinstall_required` with message M → `Blocked(M)`; any other status with a message → `Blocked(message)`; any other status without one → `Blocked(BAD_ANSWER)`; `available` without `version_name` uses the build as the name.
  - `checkFailureMessage`: `ApiError(0, "network")`, host `devices.dev.serversherpa.com` → `"Couldn't reach devices.dev.serversherpa.com. Try again later."`; `ApiError(502, "x")` → `"The Devices site answered 502. Try again later."`.
  - `shouldRecheck`: null → true; `now - last == 3_599_999` → false; `== 3_600_000` → true.
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*UpdateCheckTest'` → FAIL (unresolved).
- [ ] **Step 3: Implement** with `java.net.URI` (lower-case the host; strip path and trailing slash; keep the port when present).
- [ ] **Step 4: Run** `./gradlew testPlayDebugUnitTest --tests '*UpdateCheckTest' --tests '*CorePurityTest'` → PASS.
- [ ] **Step 5: Commit** `feat(android): update-check decisions in core/update`.

### Task 3: `DevicesUpdateClient` and the signing digest (direct)

**Files:**
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/DevicesUpdateClient.kt`
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/SigningDigest.kt`
- Test: `app/src/testDirect/java/com/serversherpa/kiosk/data/update/DevicesUpdateClientTest.kt`, `.../SigningDigestTest.kt`

**Interfaces:**
- Consumes: `executeCall`, `apiErrorFrom`, `q` (`data/api/OkHttpKioskApi.kt`, internal); `SessionStore` (`accessToken()`, `tokenIsStale()`, `refresh()`); `ApiError`; Task 2's `UpdateAnswerWire`, `toAnswer()`, `devicesUrlFor`, `NO_DEVICES_HOST`.
- Produces:
  ```kotlin
  class DevicesUpdateClient(client: OkHttpClient, private val session: SessionStore, private val apiUrl: suspend () -> String) {
      /** null when the API URL has no devices host. */
      suspend fun devicesBase(): String?
      /** Throws ApiError (status 0 = network) on transport/HTTP failure. Returns Blocked(NO_DEVICES_HOST) without a request when there is no devices host. */
      suspend fun check(packageName: String, versionCode: Long, signingDigest: String): UpdateAnswer
  }
  object SigningDigest {
      fun hex(certDer: ByteArray): String            // SHA-256, 64 lower-case hex chars
      fun of(context: Context): String               // signingInfo.apkContentsSigners[0]; "" if unreadable
  }
  ```
  The client uses `client.newBuilder().cookieJar(CookieJar.NO_COOKIES).build()`.

- [ ] **Step 1: Write the failing tests** (`ApiHarness` from `src/test/.../data/api/ApiTestSupport.kt`; the client's `apiUrl` lambda returns a URL whose host is `api.<x>` — use MockWebServer's `hostName` via a `Dns` override or a client `apiUrl = { "http://api.test:${server.port}" }` with an OkHttp `dns` mapping `devices.test` and `api.test` to 127.0.0.1):
  - `sendsTheContractQueryWithTheBearer`: after sign-in, request path is `/api/updates?platform=android&package=com.serversherpa.kiosk&version_code=2&signing_digest=<digest>` and `Authorization` = `Bearer tok1`; host header `devices.test`.
  - `mapsAvailable`, `mapsReinstallRequired` (JSON from the contract → `UpdateAnswer`).
  - `refreshesOnceOn401ThenRetries`: 401, then refresh response, then 200 → Available; exactly one refresh.
  - `a401AfterRefreshThrowsButKeepsTheSession`: 401, refresh ok, 401 → `ApiError(401)`; `session.sessionEnded` emitted nothing; `session.accessToken()` still set.
  - `aServerErrorThrows` (502 → `ApiError(status = 502)`), `aRefusedConnectionIsANetworkError` (server shut down → `isNetwork`).
  - `noDevicesHostMakesNoRequest`: `apiUrl = { "http://10.0.2.2:8010" }` → `Blocked(NO_DEVICES_HOST)`, `server.requestCount` unchanged.
  - `SigningDigestTest.hexIsLowerCaseSha256`: `hex("abc".toByteArray())` = `"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"`; `ofReturns64HexOrEmpty` (Robolectric) matches `^([0-9a-f]{64})?$`.
- [ ] **Step 2: Run** `./gradlew testDirectDebugUnitTest --tests '*DevicesUpdateClientTest' --tests '*SigningDigestTest'` → FAIL.
- [ ] **Step 3: Implement.** Stale token → `session.refresh()` first; one retry after a 401 if `refresh()` returned non-null; parse with the app's `Json { ignoreUnknownKeys = true }` convention.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(android): devices update client and signer digest (direct)`.

### Task 4: Download, archive check and `PackageInstaller` hand-off (direct)

**Files:**
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/ApkDownloader.kt`
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/ApkInstaller.kt` (interface `ApkInstall` + `AndroidApkInstall`)
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/UpdateInstallReceiver.kt` (+ `InstallEvents`)
- Modify: `app/src/direct/AndroidManifest.xml` (`<receiver android:name=".data.update.UpdateInstallReceiver" android:exported="false"/>`)
- Test: `app/src/testDirect/java/com/serversherpa/kiosk/data/update/ApkDownloaderTest.kt`, `ApkInstallerTest.kt`, `UpdateInstallReceiverTest.kt`

**Interfaces:**
- Consumes: `UpdateOffer`.
- Produces:
  ```kotlin
  class UpdateError(message: String) : Exception(message)
  class ApkDownloader(client: OkHttpClient, private val dir: File) {
      /** Streams offer.installUrl to dir/<build>.apk (via a .part file). Refuses a URL whose scheme/host/port differ from devicesBase. */
      suspend fun download(offer: UpdateOffer, devicesBase: String, onProgress: (Float?) -> Unit): File
      fun clear()   // deletes everything in dir
  }
  interface ApkInstall {
      fun canRequestInstalls(): Boolean
      fun openInstallPermissionSettings()             // ACTION_MANAGE_UNKNOWN_APP_SOURCES, data package:<pkg>, NEW_TASK
      /** null when the file is packageName at build; otherwise the notice to show. */
      fun checkArchive(file: File, packageName: String, build: Long): String?
      fun install(file: File)                          // PackageInstaller session; commit → UpdateInstallReceiver
      fun launchPendingConfirm(): Boolean              // starts InstallEvents.pendingConfirm, clears it
  }
  sealed interface InstallEvent { data class Failed(val message: String) : InstallEvent; data object Canceled : InstallEvent }
  object InstallEvents {
      val events: SharedFlow<InstallEvent>
      @Volatile var foreground: Boolean               // DirectAppUpdates keeps it in sync
      var pendingConfirm: Intent?
      fun onStatus(context: Context, intent: Intent)  // the receiver's whole body
  }
  ```
  Copy: other-host link → `"The download link isn't on <devices host>."`; size mismatch → `"The download was cut short. Try again."`; HTTP error → `"The download failed (HTTP <code>)."`; not our package/build → `"The downloaded file isn't ServerSherpa Kiosk <versionName>."`; unreadable → `"The downloaded file isn't an app this phone can install."`; installer failure → `InstallEvent.Failed("The install didn't finish: <EXTRA_STATUS_MESSAGE or status>")`.

- [ ] **Step 1: Write the failing tests:**
  - Downloader (MockWebServer, `dns` mapping as Task 3): `writesTheFileAndReportsProgress` (body 64 KiB, `Content-Length` set; file bytes equal; last progress 1.0; no `Authorization` and no `Cookie` header on the request); `refusesALinkOnAnotherHost` (offer URL `http://evil.test:<port>/…` with base `http://devices.test:<port>` → `UpdateError`, zero requests); `aShortBodyIsRefusedAndDeleted` (`offer.size` 1000, body 10 bytes → `UpdateError`, `dir` empty); `anHttpErrorIsRefused` (404); `cancelingDeletesThePartFile`; `clearEmptiesTheFolder`.
  - Installer (Robolectric): `installWritesASessionAndCommits` — after `install(file)`, `context.packageManager.packageInstaller.allSessions` has one session for our package and `shadowOf(packageInstaller)` shows it committed (use Robolectric's `ShadowPackageInstaller` API; if it can't observe commit, assert the session's written bytes and that `commit` was reached through a seam); `checkArchiveRejectsAnotherPackage` (Robolectric `ShadowPackageManager` archive info, or a stub `ArchiveReader` seam returning `(pkg, build)`), `checkArchiveAcceptsOurBuild`; `openInstallPermissionSettingsStartsTheSystemPage` (next started activity has action `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES`, data `package:com.serversherpa.kiosk`).
  - Receiver/events (Robolectric): `pendingUserActionInForegroundOpensTheConfirmScreen` (status `STATUS_PENDING_USER_ACTION` + `EXTRA_INTENT` → started activity is that intent with `FLAG_ACTIVITY_NEW_TASK`); `pendingUserActionInBackgroundIsKept` (`foreground = false` → nothing started, `pendingConfirm` set; `launchPendingConfirm()` then starts it and returns true); `abortedIsCanceled` (`STATUS_FAILURE_ABORTED` → `Canceled`); `aFailureCarriesItsMessage` (`STATUS_FAILURE_CONFLICT`, message "x" → `Failed("The install didn't finish: x")`); `successEmitsNothing`.
- [ ] **Step 2: Run** `./gradlew testDirectDebugUnitTest --tests '*ApkDownloaderTest' --tests '*ApkInstallerTest' --tests '*UpdateInstallReceiverTest'` → FAIL.
- [ ] **Step 3: Implement.** Download on `Dispatchers.IO` with `client.newCall().execute()`, canceling the call when the coroutine is canceled; the client is built without cookies. Session: `SessionParams(MODE_FULL_INSTALL)` + `setAppPackageName(pkg)`; `openWrite("base.apk", 0, file.length())`, `fsync`; commit with `PendingIntent.getBroadcast(context, sessionId, Intent(context, UpdateInstallReceiver::class.java).setPackage(pkg), FLAG_UPDATE_CURRENT or FLAG_MUTABLE).intentSender`. Archive check via `packageManager.getPackageArchiveInfo(path, 0)` and `longVersionCode`.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(android): APK download and PackageInstaller hand-off (direct)`.

### Task 5: `DirectAppUpdates` — state machine and triggers (direct)

**Files:**
- Create: `app/src/direct/java/com/serversherpa/kiosk/data/update/DirectAppUpdates.kt`
- Modify: `app/src/direct/java/com/serversherpa/kiosk/data/update/AppUpdatesFactory.kt` (build the real one; `ApkSource` adapts `ApkDownloader` with `client.devicesBase()`: `DevicesUpdateClient(deps.client, deps.session, deps.apiUrl)`, `ApkDownloader(deps.client, File(deps.app.filesDir, "updates"))`, `AndroidApkInstall(deps.app)`, package = `deps.app.packageName`, version = `BuildConfig.VERSION_CODE`, digest = `SigningDigest.of(deps.app)`)
- Test: `app/src/testDirect/java/com/serversherpa/kiosk/data/update/DirectAppUpdatesTest.kt`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```kotlin
  /** Wraps client.check(pkg, code, digest); the factory turns an ApiError into UpdateError(checkFailureMessage(e, host)). */
  fun interface UpdateChecker { suspend fun check(): UpdateAnswer }
  interface ApkSource { suspend fun fetch(offer: UpdateOffer, onProgress: (Float?) -> Unit): File; fun clear() }
  class DirectAppUpdates(
      private val checker: UpdateChecker, private val source: ApkSource, private val installer: ApkInstall,
      private val packageName: String, private val authState: StateFlow<AuthState>,
      private val foreground: StateFlow<Boolean>, private val scope: CoroutineScope,
      private val events: Flow<InstallEvent> = InstallEvents.events,
      private val clock: () -> Long = System::currentTimeMillis,
  ) : AppUpdates   // supported = true
  ```
  Copy: a checker `UpdateError` → `Failed(its message)`; any other exception → `Failed("Couldn't check for updates. Try again later.")`; signed out → `check()` does nothing; installs off after the settings trip → `"Installs from this app are off. Turn on Allow from this source, then tap Update."`; canceled → `"Install canceled."`.

- [ ] **Step 1: Write the failing tests** (fakes for the three seams, `TestScope` + `runCurrent()`, an `AuthState.Authed` built with `fakeSession(...)` from `src/test/.../data/FakeKioskApi.kt`):
  - `checksOnceWhenSignedInAndInFront`: Anon+foreground → 0 checks; becomes Authed → 1 check; state `UpToDate(now)`.
  - `rechecksOnReturnOnlyAfterAnHour`: background/foreground at +59 min → still 1; at +60 min → 2.
  - `checkButtonAlwaysChecksAndCoalesces`: `check()` twice while the first is suspended → 1 call.
  - `availableShowsTheBanner` / `laterHidesItForThatBuildOnly`: `later()` → `homeBannerVisible` false; a later answer with build 4 → true again.
  - `blockedShowsTheBannerWithoutAnOffer` (reinstall message), `unavailableNeverShowsTheBanner` (`Blocked(NO_DEVICES_HOST)` from the checker maps to `Unavailable`), `aFailedCheckHidesTheBanner` (checker throws `UpdateError("m")` → `Failed("m", now)`, banner false, auth state untouched).
  - `updateWithoutPermissionOpensSettingsThenContinues`: `canRequestInstalls` false → `openInstallPermissionSettings` called, no fetch; flip true + foreground false→true → fetch, `checkArchive`, `install` called; state `Installing`.
  - `permissionStillOffShowsTheNotice`: same, still false on return → `Available(notice = installs-off copy)`.
  - `downloadProgressThenInstall`: fetch reports 0.5 → `Downloading(fraction = 0.5f)` → `Installing`.
  - `aBadArchiveIsDeletedAndReported`: `checkArchive` returns "x" → `source.clear()` called, `Available(notice = "x")`, no install.
  - `cancelReturnsToAvailable`: `Installing` + event `Canceled` → `Available(notice = "Install canceled.")`; `Failed("m")` → notice "m".
  - `returningToTheFrontLaunchesAPendingConfirm`: foreground false→true while `Installing` → `installer.launchPendingConfirm()` called.
  - `startClearsOldDownloads`: `start()` → `source.clear()` once.
- [ ] **Step 2: Run** `./gradlew testDirectDebugUnitTest --tests '*DirectAppUpdatesTest'` → FAIL.
- [ ] **Step 3: Implement.** `start()` collects `combine(authState, foreground)` in `scope`, mirrors `foreground` into `InstallEvents.foreground`, and collects `events`.
- [ ] **Step 4: Run** the same command plus `--tests '*FlavorManifestTest'` → PASS.
- [ ] **Step 5: Commit** `feat(android): direct build checks Devices for updates`.

### Task 6: Home banner and Settings › This Kiosk "App updates" row (shared UI)

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/ui/components/UpdateBanner.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/AppUpdatesRow.kt`
- Modify: `app/src/main/java/com/serversherpa/kiosk/ui/screens/home/HomeScreen.kt` (after `PageHeader`: `UpdateBanner(container.updates)`)
- Modify: `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/ThisKioskPanel.kt` (after the Version row: `if (container.updates.supported) AppUpdatesRow(container.updates, signedIn = auth is AuthState.Authed)`)
- Create: `app/src/test/java/com/serversherpa/kiosk/data/update/FakeAppUpdates.kt` (`supported = true`, `MutableStateFlow`s, counters for each call)
- Test: `app/src/test/java/com/serversherpa/kiosk/ui/components/UpdateBannerTest.kt`, `app/src/test/java/com/serversherpa/kiosk/ui/screens/settings/AppUpdatesRowTest.kt`

**Interfaces:**
- Consumes: `AppUpdates`, `UpdateState` (Task 1), `testContainer(updates = …)`.
- Produces: `@Composable fun UpdateBanner(updates: AppUpdates)`, `@Composable fun AppUpdatesRow(updates: AppUpdates, signedIn: Boolean)`. Test tags: `update-banner`, `update-now`, `update-later`, `update-progress`, `app-updates`, `check-updates`, `update-notes`.

UI: the banner is a full-width rounded box tinted `ChipTone.BLUE` (same shape and padding as `KioskToast`): title `Update available — 0.1.2`; Available → `SolidButton("Update")` + `MiniButton("Later")` in one row, with `notice` under the title in the red tone when present; Downloading → `Downloading 0.1.2 — 45%` and a `LinearProgressIndicator` (indeterminate when `fraction == null`); Installing → `Opening the installer…`; Blocked → title `Update available`, the message, `Later` only. Settings row (`SettingsRow("App updates", "New builds come from the Devices site.")`): status line — UpToDate `Up to date · checked 14:05`, Failed message + `checked 14:05`, Unavailable message, Checking `Checking…`, Idle `Not checked yet`; Available → `0.1.2 is available (12.4 MB)`, notes under it, `Update`; Downloading/Installing as on Home; Blocked → the message; then `MiniButton("Check for updates")`, enabled only when `signedIn` and not Checking/Downloading/Installing, with `Sign in to check for updates.` under it when signed out. Times: `DateTimeFormatter.ofPattern("HH:mm")` in the device zone. Size: one decimal MB (`size / 1_000_000.0`).

- [ ] **Step 1: Write the failing tests** (`@Config(sdk = [34], qualifiers = "w360dp-h800dp")`, `createComposeRule(StandardTestDispatcher())`):
  - Banner: `showsVersionAndBothButtons` (Available 0.1.2 → text `Update available — 0.1.2`, `update-now` and `update-later` displayed); `updateAndLaterCallThrough` (clicks → fake counters 1); `hiddenWhenTheBannerIsOff`; `downloadingShowsProgress` (`Downloading 0.1.2 — 45%`, `update-progress` exists, no `update-now`); `blockedShowsTheMessageWithoutUpdate` (reinstall message shown, no `update-now`, `update-later` shown); `noticeIsShown`.
  - Home: `homeShowsTheBannerFromTheContainer` (testContainer(updates = fake Available) → `update-banner` on HomeScreen); `playBuildShowsNoBanner` (default `NoAppUpdates` → no `update-banner`).
  - Settings: `upToDateShows24HourTime` (checkedAt at 14:05 local → `Up to date · checked 14:05`); `availableShowsNotesSizeAndUpdate` (`update-notes` text, `12.4 MB`); `checkButtonCallsCheck`; `checkDisabledSignedOutWithHint`; `checkDisabledWhileDownloading`; `rowHiddenWhenUnsupported` (ThisKioskPanel with `NoAppUpdates` → no `app-updates`).
- [ ] **Step 2: Run** `./gradlew testPlayDebugUnitTest --tests '*UpdateBannerTest' --tests '*AppUpdatesRowTest'` → FAIL.
- [ ] **Step 3: Implement** the two composables and the two insertions.
- [ ] **Step 4: Run** the same command plus `--tests '*HomeScreenTest' --tests '*SettingsScreenTest'` → PASS.
- [ ] **Step 5: Commit** `feat(android): update banner on Home and App updates in Settings`.

### Task 7: Full gate, release builds and docs check

**Files:**
- Modify: `README.md` only if Steps 2–3 contradict it.

- [ ] **Step 1:** With no other suite running, `./gradlew testPlayDebugUnitTest testDirectDebugUnitTest assembleDebug` → BUILD SUCCESSFUL, 0 failures. Report test counts per flavor.
- [ ] **Step 2:** `./gradlew assembleDirectRelease bundlePlayRelease` → `app-direct-release.apk` and `app-play-release.aab` exist; `$ANDROID_HOME/build-tools/<latest>/aapt2 dump permissions app/build/outputs/apk/direct/release/app-direct-release.apk` lists `REQUEST_INSTALL_PACKAGES`; `bundletool`-free check for play: `aapt2 dump permissions app/build/outputs/apk/play/debug/app-play-debug.apk` does not. `apksigner verify --print-certs` on the direct release prints the upload key's SHA-256 (same as `keytool -list -v -keystore ~/.android-keys/serversherpa-kiosk-upload.jks -alias upload` would; don't print passwords).
- [ ] **Step 3:** Commit any README correction: `docs(android): direct build and update check`.
