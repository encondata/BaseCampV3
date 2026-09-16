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
- **Bluetooth / USB HID scanners:** type into the focused box; Enter submits.
- **Camera:** the Camera button on Scanning, RFID Enroll, and Timeclock; Single closes on the first read, Multi reads each distinct code once until Done.

## Layout

`core/` is Android-free Kotlin (matching, RFID, people search, outbox machine, settings) — the layer the iOS app will transliterate. `data/` is HTTP, session, Room, DataStore, sync, outbox. `input/` is the scan sources. `ui/` is Compose.

## Icons and fonts

`python3 tools/make_icons.py` regenerates the launcher icons from `../portal/public/images/serversherpa-logo.png`. Fonts are bundled (see `FONTS-LICENSE.md`).
