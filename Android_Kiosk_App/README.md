# ServerSherpa Kiosk (Android)

The native Android port of the web kiosk (`../kiosk/`) for phones and Zebra handhelds. Spec: `../docs/superpowers/specs/2026-09-15-android-kiosk-design.md`.

## Build and test

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

`local.properties` (ignored) must point `sdk.dir` at the Android SDK. Or open this folder in Android Studio.

## Release build (Google Play)

```bash
./gradlew bundleRelease   # app/build/outputs/bundle/release/app-release.aab
```

The release is signed with the Play upload key, which lives outside the repo: `~/.gradle/gradle.properties` sets `serversherpaUploadStoreFile` (the `.jks` path), `serversherpaUploadStorePassword`, `serversherpaUploadKeyAlias` and `serversherpaUploadKeyPassword`. Without them the bundle builds unsigned and Play refuses it. Google holds the app signing key (Play App Signing), so a lost upload key is reset through Play Console, not lost for good. Bump `versionCode` in `app/build.gradle.kts` before every upload. The store listing text and graphics are in `play-store/`.

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

## Label printing

Labels are made on the device by the shared TypeScript generator in `../kiosk/src/labelgen/`, run in an isolated V8 sandbox (`androidx.javascriptengine`; the Labels screen says so when a device's WebView can't). They print as raw ZPL to a Zebra over the network or over Bluetooth. Both go through one transport seam (`ZebraTransport`), so a printer gets the same bytes either way. Design and rulings: `../docs/superpowers/specs/2026-10-21-android-label-printing-design.md` (Implementation notes) for the printing itself, and `../docs/superpowers/specs/2026-10-22-android-bluetooth-printing-design.md` (Implementation notes) for Bluetooth.

- **The bundle is committed.** `app/src/main/assets/labelgen.js` is generated, but it is checked in so Gradle needs no Node. After changing anything in `kiosk/src/labelgen/`, rebuild it and commit the result: `npm --prefix kiosk run build:labelgen`. `bundle.test.ts` fails with that exact command when the file is stale.
- **Reference labels** (`kiosk/src/labelgen/fixtures/reference.json`) are what the laptop's own code prints for fixed cases. The tests fail with "Regenerate ..." when the Python label code changes. From the repo root, with the api venv:

  ```bash
  api/.venv/bin/python kiosk/src/labelgen/fixtures/make_reference.py
  ```

  Regenerating should leave no diff unless the Python changed. If it did, fix the TypeScript until the reference tests pass again.

**Network.** Raw ZPL goes to port 9100, one connection per command. Printer Setup scans the device's Wi-Fi or Ethernet network (a private /24, never cellular or a VPN) or takes a typed IP. Traffic leaves on that network even when another one is the device's default.

**Bluetooth.** Printers are reached over Bluetooth Low Energy with Android's own `BluetoothLeScanner` and `BluetoothGatt`. There is no Zebra SDK (the one in this app is the RFD40's RFID library, which printing doesn't touch). The service and characteristic UUIDs live in `core/printer/ZebraBluetoothSpec.kt`.
- Permissions are asked the first time someone picks Bluetooth in Printer Setup, not at launch. API 31+ asks for Nearby devices (`BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`) plus precise Location. API 30 (the MC2200) asks for precise Location. The manifest's `BLUETOOTH_SCAN` has no `neverForLocation` because the RFD40 shares it, so on every level Location must also be on to scan. Approximate-only Location counts as not allowed. Each refusal shows its message with the button that fixes it: Turn on Bluetooth, Open Settings or Location settings. Location off stops scans only; a saved printer still connects by its address.
- Printer Setup › Bluetooth lists nearby Zebras, strongest signal first, with other named devices below. A Zebra's Bluetooth name is its serial number (12 capital letters and digits). If the printer doesn't show up, hold FEED on it for 5 seconds and scan again. Picking one connects, checks that Device Information says Zebra Technologies and gives a serial, identifies it with `~HI`, saves it, and runs the checks.
- The saved printer reconnects by its saved Bluetooth address first, then by scanning for its serial, and confirms the serial from Device Information before using it. An address found by scanning is never saved, so a look-alike device can't take the printer's place. Troubleshooting shows "Found at B (saved A)", and choosing the printer again in Printer Setup saves the new address.
- Opening Print Labels or Printer Setup connects in the background. The link stays up while the app is in use, and if the printer drops an idle link the next job reconnects first (about a second). It closes when the app goes to the background (a label already going out finishes first), on sign-out, and when the saved printer changes. Coming back to the app connects it again. Printer Setup never runs checks by itself: they run after a choice or when someone taps Check again.
- Writes go in chunks of the link's MTU minus 3 (244 bytes when the printer grants 247), each acknowledged before the next. Expect about 4 KB a second. A Bluetooth font install shows a time estimate, guessed at 3.9 KB/s until it has measured a rate (a network install shows none until then).
- A send that fails part-way marks the printer. The next thing sent to it (a label, a test label, a font install or a Printer Setup check) starts with `~JX`, which drops only the half label the printer may be holding, then sends its own bytes. Normal labels never carry it, and `~JA` is never used. Network printers get the same step. The mark lives in memory.
- A font install that is cut off (the link drops, the printer is turned off, a timeout) leaves the printer waiting for the rest of the font and treating everything after it as font data. The app stops sending to that printer and says "The font install was cut off. Turn the printer off and on, then tap Check again." The stop is saved on the device, so it holds across a relaunch, and the first check that gets an answer from the printer (`~HI`) lifts it. Cancel during an install finishes the font being sent and stops before the next one.
- If the printer forgot this device, the app shows the steps: in Android Settings › Connected devices, forget the printer's serial, then come back and tap Connect. That card offers Bluetooth settings plus Connect.

**Troubleshooting.** Settings › Troubleshooting works on the saved printer, network or Bluetooth.
- Everyone signed in sees it, so a crew can troubleshoot on site. It isn't shown signed out.
- It has the connection (type, address or serial, link state, chunk size and MTU, last drop and why) with the Bluetooth link's own event log, the printer's details from `~HI` (and Device Information over Bluetooth), buttons that ask the printer for status, the error report, DPI, peeler, serial and the font listing (each shows the reply and how long it took), a speed test (10, 25 or 50 KB labels that print END at the bottom, with seconds and KB/s), a Bluetooth scan with signal strength, and a Copy or Share report.
- The report is built from what the tab itself hears, which never includes the session, cookies or keys, so secrets stay out by construction. Pattern redaction is only a backstop. Copy and Share are capped at 100,000 characters, dropping the oldest log lines first.
- Admins and developers also get a box to send a command, because a raw command can change printer settings. A `^XA` format typed there goes as a send, like a label does, unless it contains a host query (`^H` or `~H`), which goes as a query so its reply shows.
- Developers also get the Cut-send test: it sends half a sample label, marks the failure, then sends a full label. Only the full label should print.

**Tests.** TypeScript: `npm --prefix kiosk test -- src/labelgen` (node environment, no jsdom). Android: the Gradle command under Build and test. `LabelBuilderTest`, `MigrationTest`, `SyncLabelsTest`, `PrintQueueTest` and `PrinterSetupViewModelTest` cover labels; `PrinterGuardTest`, `ZebraBluetoothTest` and `TroubleshootingModelTest` cover the `~JX` and font-cut rules, the Bluetooth link and Troubleshooting. They use a fake printer (`NetworkZebraTest` runs one on 127.0.0.1) and a fake Bluetooth stack (`FakeBluetoothLe`) only, and never contact a real printer or Bluetooth device. `JavaScriptSandbox` can't run under Robolectric, so the generator is faked there; the real engine, Bluetooth scanning and printing need a device or emulator.

**Room schema.** Version 2 adds the label tables. Schemas are exported to `app/schemas/` and committed; export the new one before changing an entity.

## Time Clock station

Kiosk Setup › **Time Clock** makes this device a dedicated time clock. It signs out to a Welcome screen, and crews clock in and out there by name or with the QR code from the portal's /me page.
- The station key is kept in EncryptedSharedPreferences and bound to the API origin. Changing the API URL drops it, and you run Kiosk Setup again.
- The gear on Welcome opens sign-in.
- Signed in, Home shows Time Clock, Kiosk Setup and Settings.
- Design and rulings: `../docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md` (Implementation notes, phases 2 and 3).

## Icons and fonts

`python3 tools/make_icons.py` regenerates the launcher icons from `../portal/public/images/serversherpa-logo.png`. Fonts are bundled (see `FONTS-LICENSE.md`).
