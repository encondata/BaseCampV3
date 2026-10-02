# ServerSherpa Kiosk (Android)

The native Android port of the web kiosk (`../kiosk/`) for phones and Zebra handhelds. Spec: `../docs/superpowers/specs/2026-09-15-android-kiosk-design.md`.

## Build and test

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

`local.properties` (ignored) must point `sdk.dir` at the Android SDK. Or open this folder in Android Studio.

## Install

```bash
adb devices
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug builds default to `https://api.dev.serversherpa.com`; change it under Settings › This Kiosk (reachable signed out via the gear on the login screen). Release builds default to `https://api.serversherpa.com`.

## Scanning inputs

- **Zebra (DataWedge):** on first launch the app creates the DataWedge profile `ServerSherpaKiosk` (barcode in, intent out to `com.serversherpa.kiosk.SCAN`, keystrokes off). The hardware trigger and the on-screen Scan button both fire it.
- **Zebra RFD40 (UHF RFID):** pair the sled in Android's Bluetooth settings, then turn the reader on under Settings › RFID. Pulling the trigger sweeps; the Scanning screen shows unique and total counts while it reads, and every unique tag queues to the outbox when the trigger comes up. The trigger mode, the repeat-sweep policy, the sled's beeper and the radio settings are all on that tab. RFID reading works on the Scanning screen only. The reader's regulatory region is a compliance setting, not a preference, so it is set on the Admin tab rather than here: the list of regions to offer always comes from the sled itself (never a list this app keeps), so a worldwide unit offers every region it carries and a region-locked unit simply states the one region it has.
- **Zebra RFID library:** `RFIDAPI3Library/API3_LIB-release.aar` is a hand-placed Zebra artifact, not a Gradle dependency. The committed copy is 2.0.5.292 from Zebra's public `ALT-RFID-SAMPLES` repo (`NewGen2XPlay/app/libs/rfidapi3lib-2.0.5.292.aar`). Replace it with the current release from Zebra's RFID SDK for Android download page, keeping the same file name, before trusting the sled on a floor — and re-run `javap` against every `com.zebra.*` name `ZebraRfidReader.kt`/`ZebraBarcodeEngine.kt` reference (see those files) rather than assuming the API surface hasn't moved. This version dropped the two build workarounds the 2.0.2.82 `.aar` used to force: it no longer references `android.support.v4.content.LocalBroadcastManager` (so `app/build.gradle.kts` no longer needs the `com.android.support:localbroadcastmanager:28.0.0` dependency that used to supply it), and it no longer bundles the JAXP `META-INF/services` registration files that used to require excluding them via `packaging.resources.excludes` plus `merges -= "/META-INF/services/**"`, and a matching `systemProperty` override in `testOptions` for the unit-test JVM. A maintainer replacing the `.aar` again should check whether either regresses (a `LinkageError` from `Readers` construction, or a `NoClassDefFoundError` under Robolectric, are what each workaround used to guard against) before assuming they're still unnecessary.
- **Bluetooth / USB HID scanners:** type into the focused box; Enter submits.
- **Camera:** the Camera button on Scanning, RFID Enroll, and Timeclock; Single closes on the first read, Multi reads each distinct code once until Done.

## Layout

`core/` is Android-free Kotlin (matching, RFID, people search, outbox machine, settings) — the layer the iOS app will transliterate. `data/` is HTTP, session, Room, DataStore, sync, outbox. `input/` is the scan sources. `ui/` is Compose.

## Icons and fonts

`python3 tools/make_icons.py` regenerates the launcher icons from `../portal/public/images/serversherpa-logo.png`. Fonts are bundled (see `FONTS-LICENSE.md`).
