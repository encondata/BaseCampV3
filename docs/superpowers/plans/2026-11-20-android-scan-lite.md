# Android Scan Lite Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second edition of the Android kiosk (`com.serversherpa.kiosk.lite`, minSdk 27) for Zebra TC20s on Android 8.1: Scanning, Asset Lookup and RFID Enroll from 1D/2D barcodes, compact layout always, with no RFID, camera, Firebase, biometric or label-engine libraries in the APK.

**Architecture:** A new Gradle flavor dimension `edition` (`full`, `lite`) beside the existing `distribution` (`play`, `direct`). The few files that import a dropped library move to `src/full`, and `src/lite` gets a **flavor twin** for each: a file with the same package, class names and public signatures that reports "not supported" and does nothing. This is the pattern `AppUpdatesFactory` already uses for `play`/`direct`. Shared code stays shared and asks a core `Edition` value for the few lite-only behaviors (Home list, layout, setup, sync, Settings tabs).

**Tech Stack:** Kotlin 2.0.21, AGP 8.13.2, Compose BOM 2024.09, Room 2.6.1, OkHttp 4.12, Robolectric 4.14.1, R8.

**Spec:** `docs/superpowers/specs/2026-11-20-android-scan-lite-design.md`

## Global Constraints

- Work in a worktree on branch `android-lite` off `main`. Gradle runs from `Android_Kiosk_App/` with `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`. The full unit suite takes over 600 s, so run it in the background and wait for it to finish.
- Lite: `minSdk 27`, `applicationIdSuffix ".lite"` (→ `com.serversherpa.kiosk.lite`), app name `ServerSherpa Scan`. Only the variants `liteDirectDebug` and `liteDirectRelease` exist (filter out `litePlay*`).
- Full: unchanged in behavior, `minSdk 30`, `com.serversherpa.kiosk`, `ServerSherpa Kiosk`, release unminified.
- Lite's Home, in this exact order for every role and station type: Kiosk Setup, Scanning, Asset Lookup, RFID Enroll, Settings.
- Lite's runtime classpath has none of: `:RFIDAPI3Library`, `androidx.camera:*`, `com.google.mlkit:*`, `com.google.firebase:*` (and no google-services plugin effect), `androidx.biometric:*`, `androidx.javascriptengine:*`.
- Lite's scan inputs: DataWedge intents, Bluetooth/USB HID keyboard scanners, typed entry.
- Shared code never imports a class that exists only in `src/full`.
- American English in all copy, comments and docs.
- On any real device: never `adb shell monkey`. Launch with `adb shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.serversherpa.kiosk.lite/com.serversherpa.kiosk.MainActivity`. Never change rotation or other device settings.
- After Task 2, the unit test tasks are `testFullPlayDebugUnitTest`, `testFullDirectDebugUnitTest` and `testLiteDirectDebugUnitTest`.

## Review Focus

1. **A shared call to an API added in 28–30 crashes only on the TC20.** Lint `NewApi` as an error on `lintLiteDirectDebug` catches it (Task 3).
2. **R8 strips serializers, Room or Compose pieces, so release crashes while debug works.** Run `liteDirectRelease` on the API 27 emulator through sign-in, sync, scan, lookup and enroll (Task 9).
3. **A lite kiosk with a stored screen layout of `STANDARD`** (set by a debug build, or restored prefs) must still render compact. Test in Task 4.
4. **Sign out, environment switch and Clear Setup on lite run the push and biometric twins.** They must finish without throwing, and nothing from Firebase may be touched. Test in Task 6.
5. **DataWedge on a `.lite` package.** The `SET_CONFIG` profile must associate `context.packageName` (`com.serversherpa.kiosk.lite`), not a hard-coded `com.serversherpa.kiosk`. Test in Task 4.

---

### Task 1: Bring the compact layout onto the branch

**Files:** everything in `git diff --stat $(git merge-base main android-compact) android-compact` (40 files: `core/layout/ScreenLayout.kt`, `ui/layout/LocalCompact.kt`, `ui/shell/CompactHeader.kt`, `KioskShell.kt`, `HomeScreen.kt`, `KioskSetupScreen.kt`, `KioskPrefs.kt`, `Features.kt`, tests incl. `CompactFit.kt` / `CompactFitTest.kt`, plus the compact spec and plan docs).

**Interfaces:**
- Produces: `ScreenLayout` (AUTOMATIC / COMPACT / STANDARD) in `core/layout`, `LocalCompact` composition local, `CompactFit.assertNothingClippedHorizontally`, Kiosk Setup's Screen layout choice. Later tasks use these names as they are on the branch.

- [ ] **Step 1:** `git merge --no-ff android-compact` into `android-lite`. The branch is about 1,107 commits behind main and 12 ahead. Resolve every conflict so that both main's newer work (Asset Lookup, environment picker, update banner, Troubleshooting tile, push, sled changes) and compact's behavior survive. Where main added a new screen or Home tile since 2026-10-25, it must also follow the compact rules: one-line header, no page title, list rows on Home, nothing clipped at 320 dp.
- [ ] **Step 2:** Add `CompactFitTest` cases for every screen main added since the branch point that isn't covered yet (at least Asset Lookup, Troubleshooting, Notifications, Rolodex).
- [ ] **Step 3:** Run `./gradlew testPlayDebugUnitTest testDirectDebugUnitTest assemblePlayDebug` in the background. Expected: all green.
- [ ] **Step 4:** Commit the merge with the message `Merge branch 'android-compact' into android-lite: compact layout for small handhelds`.

### Task 2: The `edition` flavor dimension and `Edition` value

**Files:**
- Modify: `Android_Kiosk_App/app/build.gradle.kts`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/edition/Edition.kt`
- Create: `app/src/lite/res/values/strings.xml` (`app_name` = `ServerSherpa Scan`)
- Modify: `AppContainer.kt` (expose `val edition: Edition`)
- Move: tests that need a full-only flavor stay put for now (they still compile; lite still has every dependency at this point)
- Test: `app/src/test/java/com/serversherpa/kiosk/core/edition/EditionTest.kt`, `app/src/testLite/java/com/serversherpa/kiosk/LiteBuildTest.kt`, `app/src/testFull/java/com/serversherpa/kiosk/FullBuildTest.kt`

**Interfaces:**
- Produces: `enum class Edition { FULL, LITE; companion object { fun fromWire(s: String): Edition } }` in `core/edition` (Android-free, so `CorePurityTest` holds). `BuildConfig.EDITION: String` is `"full"` or `"lite"`. `AppContainer.edition: Edition = Edition.fromWire(BuildConfig.EDITION)`.

- [ ] **Step 1:** Write the tests. `EditionTest`: `fromWire("full") == FULL`, `fromWire("lite") == LITE`, unknown → `IllegalArgumentException`. `LiteBuildTest`: `BuildConfig.EDITION == "lite"`, `BuildConfig.APPLICATION_ID == "com.serversherpa.kiosk.lite"`. `FullBuildTest`: `"full"` and `"com.serversherpa.kiosk"`.
- [ ] **Step 2:** Run `./gradlew testLiteDirectDebugUnitTest --tests '*LiteBuildTest*'`. Expected: FAIL (no such task or variant).
- [ ] **Step 3:** In `build.gradle.kts`: `flavorDimensions += listOf("edition", "distribution")` (edition first). Flavors: `full` (default, `isDefault = true`, `buildConfigField EDITION "full"`), and `lite` (`minSdk = 27`, `applicationIdSuffix = ".lite"`, `buildConfigField EDITION "lite"`). Use `androidComponents.beforeVariants` to disable `lite`+`play`. Keep `play` as the default distribution. Add `Edition.kt` and `AppContainer.edition`.
- [ ] **Step 4:** Run the three tests above, then `./gradlew assembleFullPlayDebug assembleLiteDirectDebug`. Expected: PASS. The lite assemble may fail only on `RFIDAPI3Library`'s minSdk 29 manifest merge. If it does, add `tools:overrideLibrary="com.zebra.rfid.api3"` to `src/lite/AndroidManifest.xml` temporarily, with a `TEMP until Task 5` comment.
- [ ] **Step 5:** Fix every place that names the old variant tasks: `FlavorManifestTest`, scripts under `Android_Kiosk_App/tools/` and `play-store/`, and README build commands (`grep -rn "PlayDebug\|DirectRelease\|DirectDebug\|PlayRelease" Android_Kiosk_App docs/*android* devices`). Commit: `feat(android): edition flavor dimension (full, lite)`.

### Task 3: Android 8.1 API compatibility in shared code

**Files:** whatever `lintLiteDirectDebug` reports. The builder check already expects `PackageManager.GET_SIGNING_CERTIFICATES` / `signingInfo` and `PackageInfo.longVersionCode` in `src/direct/.../update/SigningDigest.kt` and `DirectAppUpdates.kt`.

- [ ] **Step 1:** In `build.gradle.kts`, set `lint { error += "NewApi"; checkDependencies = false }`. Run `./gradlew lintLiteDirectDebug`. Expected: FAIL, listing each NewApi call.
- [ ] **Step 2:** For each call, add a `Build.VERSION.SDK_INT` branch with the API 27 equivalent (for example `GET_SIGNATURES` + `signatures` below 28, `versionCode.toLong()` below 28). Full keeps the exact current code path on 30+.
- [ ] **Step 3:** Add unit tests with `@Config(sdk = [27])` for every branch that changes a value: `SigningDigestTest` gets a pre-28 case that returns the same digest from `signatures`, and so on.
- [ ] **Step 4:** Run `./gradlew lintLiteDirectDebug testLiteDirectDebugUnitTest testFullDirectDebugUnitTest` (background). Expected: lint clean of NewApi, tests PASS. Commit: `fix(android): run on API 27 (version checks for 28-30 calls)`.

### Task 4: Lite behavior in shared code (Home, layout, setup, sync, Settings, heartbeat)

**Files:**
- Modify: `core/features/Features.kt`, `core/layout/ScreenLayout.kt` (from Task 1), `core/settings/SettingsTabs.kt`, `data/sync/Sync.kt`, `ui/screens/setup/KioskSetupViewModel.kt` + `KioskSetupScreen.kt`, `ui/screens/settings/SettingsScreen.kt`, `ui/KioskApp.kt` (nav), `AppContainer.kt` (heartbeat `deviceInfo`, `Sync(...)` construction)
- Test: `FeaturesTest`, `ScreenLayoutTest`, a new `SettingsTabsTest`, `SyncTest`, `KioskSetupViewModelTest`, `HeartbeatTest` (or the AppContainer device-info test), a `DataWedgeTest` case

**Interfaces:**
- Consumes: `Edition` (Task 2), `ScreenLayout` (Task 1).
- Produces:
  - `fun homeFeatures(stationType: String?, isAdmin: Boolean = false, edition: Edition = Edition.FULL): List<KioskFeature>`
  - `fun effectiveLayout(stored: ScreenLayout, smallestWidthDp: Int, edition: Edition): ScreenLayout`. Lite always returns COMPACT. Full keeps today's rule. If Task 1 left the function under another name, keep that name and add the `edition` parameter.
  - `fun settingsTabs(edition: Edition, isAdmin: Boolean, isDeveloper: Boolean): List<SettingsTabId>`. Lite drops DEVICES, TROUBLESHOOTING and RFID. Full returns exactly today's list.
  - `Sync(..., labels: Boolean = true)`. With `false`: no templates or fonts fetched or stored, and the parts list shown is `SYNC_PARTS` minus templates and fonts.
  - `KioskSetupViewModel(..., edition: Edition)`. On lite, the step before labels calls `finish("top")` directly, and the Screen layout choice is not shown.
  - The heartbeat `deviceInfo` map gains `"edition" to edition.name.lowercase()`.

- [ ] **Step 1: Write the failing tests.**
  - `homeFeatures(null, isAdmin = true, edition = LITE).map { it.id } == listOf(SETUP, SCAN, LOOKUP, ENROLL, SETTINGS)`. Same for `isAdmin = false` and `stationType = "timeclock"`.
  - The full edition's existing `FeaturesTest` cases are unchanged.
  - `effectiveLayout(STANDARD, 600, LITE) == COMPACT`, and `effectiveLayout(AUTOMATIC, 400, LITE) == COMPACT` (Review Focus 3).
  - `settingsTabs(LITE, isAdmin = true, isDeveloper = true)` has none of DEVICES, TROUBLESHOOTING, RFID.
  - With `labels = false`, `Sync` makes no request to the template or font endpoints (MockWebServer or a fake `KioskApi` that records calls), `db.labelTemplates().count() == 0`, and the visible parts are `[assets, people, containers, trucks]`.
  - Lite setup VM: choosing the scan status ends in a saved `KioskSetupSelection` with `labelKind == "top"` and no labels step state.
  - The heartbeat device info contains `edition=lite` on lite.
  - DataWedge `SET_CONFIG`'s `APP_LIST` `PACKAGE_NAME` equals `context.packageName` (Review Focus 5).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the signatures above. In the nav graph, on lite, skip the routes for labels, timeclock, rolodex, notifications and troubleshooting. Home's tile list already excludes them; this just keeps them unreachable. A lite Compose smoke test (`@Config(sdk = [27], qualifiers = "w320dp-h533dp")`) renders Home with exactly those five rows, all `assertNothingClippedHorizontally`.
- [ ] **Step 4:** Run `testLiteDirectDebugUnitTest` and `testFullPlayDebugUnitTest` (background). Expected: PASS. Commit: `feat(android): lite Home, compact-only layout, setup and sync without labels`.

### Task 5: RFID out of lite

**Files:**
- Move to `src/full/java/.../input/rfid/`: `ZebraRfidReader.kt`, `ZebraBarcodeEngine.kt`, `SledNudgeReceiver.kt` (and its manifest entry, if any, into `src/full/AndroidManifest.xml`)
- Move to `src/testFull/...`: `ZebraRfidReaderTest.kt`, `ZebraReadersConstructibleTest.kt`, `ZebraBarcodeEngineTest.kt`
- Create: `src/full/java/.../input/rfid/RfidReaderFactory.kt` and `src/lite/java/.../input/rfid/RfidReaderFactory.kt`
- Create: `src/lite/java/.../input/rfid/NoRfidReader.kt`
- Modify: `AppContainer.kt` (construct the reader through the factory), `build.gradle.kts` (`"fullImplementation"(project(":RFIDAPI3Library"))`), and remove the TEMP `overrideLibrary` from Task 2
- Modify: Scanning, Asset Lookup and Enroll UI and Settings so RFID panels, Stop buttons and sled controls render only when `rfid.supported` is true
- Test: `src/testLite/.../LiteHasNoRfidTest.kt`, `src/testLite/.../input/rfid/NoRfidReaderTest.kt`

**Interfaces:**
- Consumes: the existing `RfidReader` interface and `RfidController` (stay in `src/main`).
- Produces: `fun rfidReaderFor(app: Application, scope: CoroutineScope, isZebraHost: Boolean): RfidReader` in each flavor's `RfidReaderFactory.kt`. Full returns `ZebraRfidReader(...)`, lite returns `NoRfidReader`. Also `val supported: Boolean` on `RfidReader` (default `true`, `NoRfidReader` = `false`), exposed by `RfidController` as `val supported: Boolean`. `NoRfidReader` reports no paired sleds, never connects, and emits no reads.

- [ ] **Step 1:** Write `LiteHasNoRfidTest`: `Class.forName("com.zebra.rfid.api3.RFIDReader")` throws `ClassNotFoundException`. Write `NoRfidReaderTest`: `pairedSleds()` is empty, `connect` makes no reads, `supported == false`.
- [ ] **Step 2:** Run `testLiteDirectDebugUnitTest --tests '*NoRfid*'`. Expected: FAIL.
- [ ] **Step 3:** Do the moves and the factory. Add `fullImplementation` for the RFID library. Gate the RFID UI on `rfid.supported` in `ScanScreen`/`ScanTools`/`SledControls`/`RfidReadPanel`, `AssetLookupScreen`, `EnrollScreen`, `SledFlashOverlay`, `SledDisplayEffect`, `DeveloperPanel`, `AdminPanel` and `DevicesPanel`. `MainActivity`'s sled-scan guard still works (with no sled it simply never holds).
- [ ] **Step 4:** Run `testLiteDirectDebugUnitTest testFullDirectDebugUnitTest` (background) and `assembleLiteDirectDebug`. Expected: PASS. The full app's RFID tests pass unchanged in `testFull`. Commit: `feat(android): lite has no RFID library or reader UI`.

### Task 6: Push and biometrics out of lite

**Files:**
- Move to `src/full/java/.../data/push/`: `FirebaseFcmTokens.kt`, `KioskMessagingService.kt`. Move its `<service>` (and the FCM auto-init `<meta-data>`) to `src/full/AndroidManifest.xml`.
- Move to `src/full/...`: `ui/screens/login/BiometricPrompting.kt`, `data/auth/BiometricKeys.kt`, and their tests to `src/testFull`
- Create lite twins with identical package, names and public signatures: `src/lite/.../data/push/FcmTokensFactory.kt` (a `FcmTokens` whose `token()` throws `UnsupportedOperationException("Push isn't available on this edition")` and whose `delete()` returns), `src/lite/.../data/auth/BiometricKeys.kt` (reports no key, no hardware), `src/lite/.../ui/screens/login/BiometricPrompting.kt` (never prompts, and reports unavailable)
- Modify: `build.gradle.kts` (`fullImplementation` for firebase BoM + messaging and biometric; apply the google-services plugin only to full variants, or confirm it has no effect on lite), `AppContainer.kt`
- Test: `src/testLite/.../LiteHasNoPushOrBiometricTest.kt`, `src/testLite/.../LiteSignOutTest.kt`

**Interfaces:**
- Produces: `fun fcmTokens(): FcmTokens` per flavor. The lite `BiometricSignIn` reports `available == false`, so the login screen shows no biometric button and the enroll offer never appears. `PushRegistrar` on lite never registers (ThisKioskPanel's "This is my phone" row is hidden when push isn't supported).

- [ ] **Step 1:** Write `LiteHasNoPushOrBiometricTest`: `Class.forName` of `com.google.firebase.messaging.FirebaseMessaging` and `androidx.biometric.BiometricPrompt` both throw. The lite merged manifest has no `KioskMessagingService` and no `POST_NOTIFICATIONS`. Write `LiteSignOutTest` (Review Focus 4): with the lite container, `auth.signOut()`, `environmentSwitcher.switch(...)` and Clear Setup finish without throwing.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Do the moves, twins and Gradle changes. In `src/lite/AndroidManifest.xml`, remove `POST_NOTIFICATIONS`, `CAMERA` (camera goes in Task 7), the Bluetooth, BLE and location permissions, and their `uses-feature` entries, all with `tools:node="remove"`. Lite has no sled or printer, and HID scanners need no app permission.
- [ ] **Step 4:** Run `testLiteDirectDebugUnitTest testFullDirectDebugUnitTest testFullPlayDebugUnitTest` (background). Expected: PASS. Commit: `feat(android): lite has no push or biometric sign-in`.

### Task 7: Camera and the label engine out of lite

**Files:**
- Move to `src/full/.../input/camera/`: `CameraScanSheet.kt`, `PhotoCaptureSheet.kt`, `BarcodeAnalyzer.kt`, `CameraSupport.kt`
- Move to `src/full/.../data/labels/LabelGenerator.kt`, and its test to `src/testFull`
- Create lite twins: `src/lite/.../input/camera/CameraScanSheet.kt` and `PhotoCaptureSheet.kt` (same composable signatures, render nothing), `CameraSupport.kt` (`hasCamera(...) = false`, plus whatever else shared code calls), `src/lite/.../data/labels/LabelGenerator.kt` (`isSupported() = false`; generating throws `UnsupportedOperationException`)
- Modify: `build.gradle.kts` (`fullImplementation` for CameraX ×4, ML Kit and javascriptengine)
- Test: `src/testLite/.../LiteHasNoCameraOrLabelEngineTest.kt`

- [ ] **Step 1:** Write the test: `Class.forName` of `androidx.camera.core.CameraX`, `com.google.mlkit.vision.barcode.BarcodeScanning` and `androidx.javascriptengine.JavaScriptSandbox` all throw. `AppContainer.hasCamera == false` on lite. Scanning, Lookup and Enroll show no camera button on lite (a Compose assertion in the lite smoke test).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Do the moves, twins and Gradle changes.
- [ ] **Step 4:** Run all three unit test tasks (background) and `assembleLiteDirectDebug`. Expected: PASS. Commit: `feat(android): lite has no camera scanning or label engine`.

### Task 8: Release shrinking and the lite icon

**Files:**
- Modify: `build.gradle.kts` (`release` for lite: `isMinifyEnabled = true`, `isShrinkResources = true`, through `androidComponents.onVariants` or a lite-only `buildType` override; full release stays unminified), `app/proguard-rules.pro` (or `src/lite/proguard-rules.pro`)
- Modify: `tools/make_icons.py` to produce a lite launcher icon under `src/lite/res/mipmap-*`. Use the same mark with a visible "SCAN" band or a contrasting background, so a TC20 and a full kiosk can be told apart on a shelf.

- [ ] **Step 1:** Add keep rules for kotlinx.serialization (`@Serializable` classes and their `$serializer`s), Room entities and DAOs (usually handled by Room's own consumer rules: verify), and anything reached by reflection (`grep -rn "Class.forName\|::class.java.getDeclared" app/src/main`).
- [ ] **Step 2:** Run `./gradlew assembleLiteDirectRelease` and record the APK size. Expected: builds. Report the size next to the current 59 MB `app-direct-release.apk`. If release signing properties are missing locally, build with the debug signing config for this check, and say so.
- [ ] **Step 3:** Commit: `build(android): shrink the lite release; lite launcher icon`.

### Task 9: Verify on an Android 8.1 emulator

- [ ] **Step 1:** Create an AVD with system image `system-images;android-27;google_apis;x86_64` (or arm64-v8a on Apple silicon) and a 480×800, 240 dpi hardware profile (TC20-like) via `avdmanager`/`sdkmanager`. If the image isn't installed, install it with `sdkmanager`.
- [ ] **Step 2:** Install `liteDirectRelease` (and separately `liteDirectDebug`) with `adb install -r`. Launch with the launcher intent from Global Constraints.
- [ ] **Step 3:** Against api.dev, using a dev login from the dev-workflow notes: sign in, run Kiosk Setup (no labels step, no layout choice), sync (four parts), scan an asset by typed entry, look it up, enroll a typed tag value on it and then put the original value back, go offline (airplane mode in the emulator only) and scan, then come back online and see the outbox send. Screenshot Home and each screen with `adb exec-out screencap -p`, and check that nothing is clipped. `adb logcat` must show no crash or `NoClassDefFoundError`.
- [ ] **Step 4:** Note the results and APK size in the spec's new "Implementation notes" section. Commit: `docs(android): Scan Lite implementation notes`.
