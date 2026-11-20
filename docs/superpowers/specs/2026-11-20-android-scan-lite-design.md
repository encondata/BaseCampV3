# Android kiosk: Scan Lite edition for the TC20 (design)

Date: 2026-11-20 · Status: draft for Jimmy's approval

## Intent

Some crew members drop, soak or otherwise wreck handhelds. Jimmy wants them on a
couple of older Zebra **TC20s running Android 8.1 (API 27)** instead of the
newer hardware. The current Android kiosk needs Android 11 (minSdk 30) and
carries a lot these people never use, and the TC20 is short on memory, storage
and CPU. So this is a **special, lean build** of the kiosk that does only:

1. **Scanning**
2. **Asset Lookup**
3. **RFID Enroll** (from a barcode scan or typed value, see below)

Input is **1D/2D barcodes only**, through the TC20's built-in imager.

Success: the APK installs and runs well on a TC20 with Android 8.1, fits its
480×800 screen with nothing clipped, and the three screens behave exactly like
they do in the full Android kiosk (same matching, same offline outbox, same
server calls).

## Goals

- A second **edition** of the existing app (`Android_Kiosk_App/`), built as its
  own APK with **minSdk 27**.
- Home shows exactly, in this order (Jimmy, 2026-11-20):
  Kiosk Setup · Scanning · Asset Lookup · RFID Enroll · Settings.
  The same for workers and admins: no Rolodex, no Notifications, no Time Clock,
  no Troubleshooting, no Labels, no Containers/Trucks placeholders.
- Always uses the **compact layout** (no Automatic/Compact/Standard choice in
  Kiosk Setup).
- Scanning, Asset Lookup and RFID Enroll share code with the full app, so a
  fix in one lands in both.
- The APK is far smaller than today's (release direct APK is 59 MB, unshrunk).
  R8 code shrinking and resource shrinking are on for this edition.
- Distributed through the **Devices** site (devices.<env>) with the existing
  in-app update check.

## Non-goals

- Anything RFID: no RFD40 / RFD2000 sled, no Zebra RFID library
  (`RFIDAPI3Library`, which needs API 29 anyway), no RFID settings panel, no
  trigger reads in Scanning or Lookup.
- Camera barcode scanning (CameraX + ML Kit) and photo capture.
- Push notifications (Firebase), biometric sign-in, label printing (Bluetooth
  and WebUSB printers, label generator and its JavaScript engine), Rolodex,
  Time Clock and Time Clock station mode, Troubleshooting guides.
- The Play Store. This edition is not uploaded to Play.
- Changes to the full edition's behavior. The full app must look and work
  exactly as it does today.
- Other old hardware (Android 4.x devices, Windows CE). TC20 on 8.1 only.

## Anti-goals (would make this a failure even if it works)

- The full Android kiosk gets slower, loses a feature, or changes behavior.
- The two editions drift: scan matching, outbox or API code copied rather than
  shared.
- The lite APK still bundles RFID, ML Kit or Firebase code "just turned off".
  Leaving them out of the APK is the point.
- A TC20 accidentally offered the full APK by the update check (it would fail
  to install on Android 8.1).

## Constraints and facts found

- Current build: `compileSdk 36`, `minSdk 30`, `targetSdk 36`, one flavor
  dimension `distribution` (`play`, `direct`), `isMinifyEnabled = false`.
- Core libraries (Compose, Room, OkHttp 4, DataStore, kotlinx) all support API
  21+, and EncryptedSharedPreferences supports API 23+. So API 27 is fine for
  everything the edition keeps.
- `RFIDAPI3Library` (`API3_LIB-release.aar`) declares `minSdkVersion 29`. It
  must not be a dependency of the lite edition.
- Code written against minSdk 30 may call APIs added in 28–30 without a version
  check, because lint never flagged them. Building at minSdk 27 with lint's
  `NewApi` check as an error will list them. Every one gets a version check or
  a compatible replacement, in shared code, without changing behavior on the
  full edition.
- RFID, camera, push, biometric and printing code is referenced from shared
  files today: `AppContainer`, `KioskApplication`, `MainActivity`,
  `ScanViewModel`/`ScanScreen`, `AssetLookupScreen`, `EnrollScreen`,
  `LoginViewModel`/`LoginScreen`/`EnrollOfferSheet`, the Settings panels
  (`ThisKioskPanel`, `AdminPanel`, `DeveloperPanel`, `RfidPanel`), `KioskPrefs`,
  `KioskAuth`, `EnvironmentSwitcher`, `KioskApi`/`OkHttpKioskApi`,
  `core/model/Session.kt`. Those links become seams (below).
- DataWedge use is `SET_CONFIG`, `SCANNER_INPUT_PLUGIN`, `SOFT_SCAN_TRIGGER`
  (DataWedge 6.3/6.4+). The TC20 on 8.1 ships a newer DataWedge, but check on
  the device (`DataWedge.isPresent`, the profile `ServerSherpaKiosk`, the
  intent action `com.serversherpa.kiosk.SCAN`).
- The compact layout (smallest width under 360 dp, one-line header, list rows
  on Home, no footer, no page titles) lives on branch **`android-compact`**
  (head `353e2b19a`), **unmerged and about 1,100 commits behind `main`**. The
  MC2200 is 480×800, and the TC20 is believed to be 480×800 too (confirm on
  the device).
- The Devices service picks an Android app by `package` (`/api/updates?
  platform=android&package=…`, `apps` unique on `(platform, identifier)`). A
  separate applicationId therefore gets its own listing and its own update
  stream, with no server change.
- CLAUDE.md device rules apply on the TC20: never `adb shell monkey`; launch
  with the launcher intent (`am start -a android.intent.action.MAIN -c
  android.intent.category.LAUNCHER -n <package>/.MainActivity`); never change
  rotation or other device settings.

## Approaches considered

- **A. Second edition of the same app (picked by Jimmy, 2026-11-20).** A new
  flavor dimension in the same Gradle module. The lite edition has its own
  minSdk, applicationId, dependencies and a small source set with no-op or
  absent versions of the dropped features. Shared screens and logic stay
  shared. Cost: untangling the places where shared code calls RFID, camera,
  push, biometric or printing directly.
- **B. Shared library module plus two app modules.** The cleanest separation,
  but it restructures the whole current app before the TC20 gets anything, and
  it puts the full app at the most risk.
- **C. A separate small app that copies what it needs.** The fastest start, but
  it's a fourth kiosk codebase (web, Android, iOS, lite), and scan-matching
  fixes would drift.

## Design (decided parts)

### Part 1: compact layout onto main first

Bring `android-compact` up to date with `main` and merge it before the lite
work. The full edition keeps the compact layout's own rules (automatic under
360 dp, plus the Kiosk Setup › Screen layout choice). Jimmy approved merging
it ahead of his MC2200 trial (2026-11-20). The owed MC2200 device pass stays
owed.

### Part 2: the edition flavor

- New flavor dimension **`edition`** with **`full`** (default, today's app) and
  **`lite`**. Combined with `distribution`, the lite edition is built only as
  **`liteDirect`**. `litePlay` is filtered out of the variants.
- `lite`: `minSdk 27`, `applicationIdSuffix ".lite"` → **`com.serversherpa.kiosk.lite`**,
  app name **"ServerSherpa Scan"** (my call), its own launcher icon tint or
  badge so the two are told apart on a shelf (my call; builder picks the look
  from the existing icon tool `tools/make_icons.py`).
- `full`: unchanged. `minSdk 30`, `com.serversherpa.kiosk`, same versions.
- Release `liteDirect`: `isMinifyEnabled = true`, `isShrinkResources = true`,
  with keep rules for kotlinx.serialization models, Room, and anything reached
  by reflection. Full release stays unminified in this work (turning R8 on for
  full is a separate decision).
- Version name and code follow the shared ones (0.3.x); lite's versionCode
  matches full's so builds keep increasing together.
- Lite dependencies exclude `RFIDAPI3Library`, CameraX, ML Kit,
  `firebase-messaging` (and the google-services plugin), `biometric`,
  `javascriptengine`. `zxing-core` stays if the login QR (`ui/screens/login/Qr.kt`)
  needs it.

### Part 3: seams in shared code

Each feature that lite drops gets an interface in `src/main` and two
implementations: the real one in `src/full`, a no-op or "not available" one in
`src/lite` (or the feature's entry point is absent and the shared code asks an
`Edition` object). Shared code may not import a class that exists only in
`full`. A test enforces it, the way `PlayHasNoInstallerTest` already does for
the installer code.

Seams needed (from the reference list above): RFID controller and reader
(Scanning, Lookup, Enroll, Settings), camera scan sheet and photo capture,
push registrar and messaging service, biometric sign-in and the enroll offer,
Bluetooth/WebUSB printing and the label generator, Rolodex and Notifications
routes.

On lite:
- Scanning, Asset Lookup and RFID Enroll show no RFID read panel, no Stop
  button, no camera button. Everything else is the same.
- RFID Enroll keeps its name and flow: scan or type the asset, then scan or
  type the tag value (the printed barcode on the tag). It already reads both
  from ScanBus.
- Sign-in has no biometric option and no enroll offer.
- Settings shows only the panels that apply. The builder confirms each against
  the code: This Kiosk (environment, app updates), Appearance, Sound, and
  Developer and Admin for those roles, minus their RFID, push and printer
  rows. Not shown: RFID, Devices (printers), Troubleshooting.
- Scan inputs: DataWedge intents (primary), Bluetooth/USB HID keyboard
  scanners, typed entry.
- The heartbeat's `deviceInfo` adds `"edition" to "lite"` (or `"full"`). It
  shows up in the "other keys" table on the device's detail page in the
  portal (`KioskDevicesTab.tsx`) with no portal or API change (my call). No
  new list column, and the web, laptop and iOS kiosks don't send it.

### Part 3b: setup and sync on lite (my call, builder check 2026-11-20)

Lite prints nothing, so on lite:
- Kiosk Setup skips the "What do labels print on?" (Top/Front) step. Setup
  finishes from the step before it, with the saved label kind left at its
  default.
- Sync does not download label templates or label fonts, and the sync summary
  doesn't list them. Anything Asset Lookup reads offline (assets payload,
  label_context metadata, containers) is still synced.
- These are edition checks in shared `Sync.kt` and the setup wizard. The full
  edition's behavior and tests stay unchanged.

### Part 4: Home and layout

- `homeFeatures()` returns the lite list for the lite edition, whatever the
  station type or role: Kiosk Setup, Scanning, Asset Lookup, RFID Enroll,
  Settings. A Time Clock station type can't be chosen in lite's Kiosk Setup.
- The layout is always compact on lite. Kiosk Setup hides the Screen layout
  step or row on lite only.
- "Nothing clipped at 320 dp" tests (`CompactFit.kt`) cover the lite Home and
  the three screens.

### Part 5: distribution

- `assembleLiteDirectRelease` produces the APK uploaded to Devices as its own
  app (`com.serversherpa.kiosk.lite`). The update check already sends the
  package, so it only ever sees lite builds.
- The full edition's Play and Devices builds are unchanged.
- This work ends at a built, emulator-verified lite APK that's ready to
  install (Jimmy: "let me know when the build is ready to install"). Uploading
  it to devices.dev, or installing it on a TC20 over adb, happens only on
  Jimmy's say-so.

## Verification

- Unit tests run for both editions (`testFullPlayDebugUnitTest`,
  `testFullDirectDebugUnitTest`, `testLiteDirectDebugUnitTest`). Shared tests
  that touch dropped features move to the `full` test source set.
- `lintLiteDirectRelease` passes with `NewApi` as an error.
- APK size of `liteDirectRelease` is reported next to today's 59 MB.
- An Android 8.1 (API 27) emulator at 480×800 hdpi: sign in, Kiosk Setup and
  sync, scan, look up, enroll by typed tag, go offline and back (outbox sends).
- A device pass on a real TC20 when Jimmy has one connected: DataWedge
  profile creation and scans, screen fit, memory use.

## Left to the builder

- Exact flavor wiring (`missingDimensionStrategy`, variant filter) and where
  each seam's interface lives.
- Keep rules for R8.
- Which Settings rows each panel drops on lite, by reading the panels.
- The fix for each API 28–30 call that lint reports.
- Updating wiki pages and trackers after merge (per the usual process).
