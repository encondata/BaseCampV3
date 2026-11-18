# ServerSherpa Kiosk (Android)

The native Android port of the web kiosk (`../kiosk/`) for phones and Zebra handhelds. Spec: `../docs/superpowers/specs/2026-09-15-android-kiosk-design.md`.

## Build and test

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testPlayDebugUnitTest assembleDebug
```

Two flavors share one applicationId and version: `play` (Google Play, no self-update code; the default) and `direct` (installed from devices.<env>, which checks that site for a newer APK). `testPlayDebugUnitTest` and `testDirectDebugUnitTest` run the shared tests under each; flavor-only tests live in `app/src/testPlay` and `app/src/testDirect`. `assembleDebug` builds both: `app/build/outputs/apk/play/debug/app-play-debug.apk` and `app/build/outputs/apk/direct/debug/app-direct-debug.apk`.

`local.properties` (ignored) must point `sdk.dir` at the Android SDK. Or open this folder in Android Studio.

## Release build (Google Play)

```bash
./gradlew bundlePlayRelease   # app/build/outputs/bundle/playRelease/app-play-release.aab
```

The release is signed with the Play upload key, which lives outside the repo: `~/.gradle/gradle.properties` sets `serversherpaUploadStoreFile` (the `.jks` path), `serversherpaUploadStorePassword`, `serversherpaUploadKeyAlias` and `serversherpaUploadKeyPassword`. Without them the bundle builds unsigned and Play refuses it. Google holds the app signing key (Play App Signing), so a lost upload key is reset through Play Console, not lost for good. Bump `versionCode` in `app/build.gradle.kts` before every upload. The store listing text and graphics are in `play-store/`.

### Direct build (Devices)

```bash
./gradlew assembleDirectRelease   # app/build/outputs/apk/direct/release/app-direct-release.apk
```

Signed with the same upload key, then uploaded on devices.<env>. Play uploads stay `./gradlew bundlePlayRelease`. A phone that has the Play copy uninstalls it once before the direct build, because the two are signed by different keys.

## Install

```bash
adb devices
adb -s <serial> install -r app/build/outputs/apk/play/debug/app-play-debug.apk
```

Launch it with `adb -s <serial> shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.serversherpa.kiosk/.MainActivity`. It sends the launcher's own intent, so a later tap on the app icon reuses the same screen instead of stacking a second copy. Never use `adb shell monkey` to open the app: when monkey finishes it turns the device's auto-rotate on, which the app itself never does.

Debug builds default to `https://api.dev.serversherpa.com`; change it under Settings › This Kiosk (reachable signed out via the gear on the login screen). Release builds default to `https://api.serversherpa.com`.

## Scanning inputs

A scan reaches a screen by one of four routes. The two that use the scan bus (DataWedge intents and sled barcodes) reach Scanning, RFID Enroll, Print Labels, Asset Lookup, Time Clock and sign-in's Move password view, whichever is open.

- **The scan box (keyboard):** Bluetooth and USB HID scanners, and an RFD40 sled that types as a Bluetooth keyboard, type into the focused box; Enter submits. Nothing swallows or consumes a key.
- **Zebra (DataWedge):** on first launch the app creates the DataWedge profile `ServerSherpaKiosk` (barcode in, intent out to `com.serversherpa.kiosk.SCAN`, keystrokes off). The hardware trigger and the on-screen Scan button both fire it. Scans arrive on the scan bus as intents. On a Zebra host (DataWedge present, or a Zebra manufacturer) the app also sends DataWedge one `ENABLE_PLUGIN` for its scanner input, once per process, which repairs a scanner an earlier build may have left off. DataWedge detection is unchanged, and the manifest has no `<queries>` entry.
- **Camera:** the Camera button on Scanning, RFID Enroll, and Timeclock; Single closes on the first read, Multi reads each distinct code once until Done.
- **Sled barcodes (scanner session):** when the sled's triggers use its barcode scanner (Barcode or Both, below) on a phone that is not a Zebra host, the app opens the sled's scanner session. Each barcode goes on the scan bus as `ScanSource.SLED`, the way a DataWedge intent does. A sled barcode with no scan screen open, or with the app in the background, is dropped.

**Each scan is delivered once.** A sled can type a barcode and send it through its scanner session too. `SledScanGuard` (`core/scan/SledScanGuard.kt`) refuses a copy only when the other route accepted the same value (compared trimmed) within 2 s. A session copy waits 120 ms, then while the sled is still typing, at most 1.5 s. The same route twice always counts twice, so scanning the same code twice on purpose still gives two scans. The guard is on the scan box, Time Clock Welcome's keys and Enter Your Name, and sign-in's Move password field (Enter only). Each refusal is logged under `SledScanGuard` with the route, the gap and the length, never the value.

**RFID tags.** Scanning and Asset Lookup arm the sled. A trigger pull sweeps while the sled is connected and the triggers in force give one to tags. Scanning shows unique and total counts while it reads, and every unique tag queues to the outbox when the trigger comes up. Asset Lookup looks up one tag; several tags show a notice to point the reader at one tag. RFID Enroll and Print Labels take sled barcodes but never read tags. RFID Enroll's tag step refuses a value equal to a roster asset's ID or serial, in the web kiosk's words. The reader's regulatory region is a compliance setting, not a preference, so it is set on the Admin tab rather than on the RFID tab: the list of regions to offer always comes from the sled itself (never a list this app keeps), so a worldwide unit offers every region it carries and a region-locked unit simply states the one region it has. A sled with no region set connects, says so, and reads nothing until an admin picks one.

## RFID sled

The Zebra RFD40 (UHF RFID, Bluetooth) on a phone with no DataWedge, and beside the MC2200's own scanner. Design, rulings and what the build changed: `../docs/superpowers/specs/2026-11-10-android-sled-sdk-review-design.md` (Implementation notes).

- **Pairing.** Pair the sled in Android's Bluetooth settings (the app counts a bonded device as a sled when its name starts `RFD40`, `RFD90` or `RFD8500`), then turn the reader on under Settings › RFID. The Connect button needs only Nearby devices; the automatic connect (switching the reader on, coming back to the app) also needs precise Location. Before it touches the vendor SDK the app checks that Bluetooth is on, the permission is granted, every paired device has a name, a sled is paired and no two paired devices share its name; each failure has its own sentence and fix button.
- **The reader chooser.** With one sled paired, the app uses it and saves its address. With two or more, the RFID reader row lists them, one per line, and the one tapped is saved (`readerAddress`) and used from then on; choosing one after "More than one sled is paired" connects to it. A saved sled that is no longer paired counts as none saved. Restore defaults keeps the reader switch, the region and the chosen sled.
- **Sled triggers.** RFID (both triggers read tags), Barcode (both scan), Both (upper reads tags, lower scans). It is a row on the RFID tab and a control in the tool row of Scanning, both steps of RFID Enroll, Print Labels and Asset Lookup while the sled is connected. It applies live: the app writes the sled's key layout, reads it back, and shows what the sled reports when that differs. A layout is never saved on the sled. A change during a sweep ends the sweep first, and its tags queue. On a Zebra host (the MC2200) the sled always gets RFID whatever the setting says: the handheld's own scanner reads barcodes, the RFID tab shows the row dimmed with RFID lit, the scan screens show no sled control, and no scanner session opens. A sled known to have no barcode scanner gets RFID too, dimmed the same way. While the scanner is ready, the tool row also has the sled's Scan button (pull, then release on the first barcode or after 3 s). A kiosk that had "Trigger drives: Barcode" comes up in Barcode.
- **Reconnect.** The app notices a lost link (the disconnect event, or two link-trouble results in a row) and says "The sled disconnected. Reconnecting…". It tries four times, after waits of 2, 4, 15 and 60 s (`OutboxMachine.BACKOFF`), then gives up and says so. A connect that never came up is retried only while a sled screen is open (Scanning, Asset Lookup, RFID Enroll, Print Labels, Settings › RFID); elsewhere it is one attempt. Bluetooth turning on, or the sled's Bluetooth link appearing, cuts a wait short or starts one try. Nothing is tried while a label is printing. Stop (on the RFID tab and the scan-screen line), Disconnect, the reader switch and the app leaving the foreground end it. A failure the operator has to fix (Bluetooth off, a permission, no sled, a password) is never retried on a timer.
- **Sled flashes.** While "Flash when the sled connects or drops" is on (Settings › RFID, on by default, saved on this phone only), a sled that drops by itself shows a full-screen red "Sled disconnected", and each connection shows a green "Ready to scan" once, when it can scan (in Barcode or Both, once the barcode scanner is ready), on the Appearance tab's scan-flash colors, holding 1.5 s before it fades, with a tap dismissing it.
- **The display rule.** While the sled is in use the display stays on: on Scanning and Asset Lookup while it is connected, connecting or reconnecting, and on RFID Enroll and Print Labels while it is connected in Barcode or Both. It is released after 10 minutes with no trigger pull, tag, sled barcode, typed scan or touch, and when reconnecting gives up. `ui/SledDisplayEffect.kt` sets the view's `keepScreenOn` and is the only code that does; the app takes no wake lock and changes no device setting (`SledNeverCallTest` scans `src/main/java` for both).
- **Zebra SDK logging.** A switch on Settings › Developer (shown with Developer mode on) turns on the RFID SDK's wire log (`IRFIDinfo`), tag and barcode values included. It is off at every launch and is not saved. Separately, once the sled's scanner session is used, the scanner SDK logs every barcode frame at info level in any build, Time Clock badge codes included. The app's own lines are under `ZebraRfidReader`, `ZebraBarcodeEngine`, `RfidController`, `SledScanGuard`, `SledNudgeReceiver` and `DataWedge`.
- **Hardware.** Nothing here has been seen on a sled yet. `../docs/android-sled-hardware-script.md` is the ordered script for the first hardware session (logcat and launch commands, five blocks, forks, hand-off notes). Unit tests use `FakeRfidReader` and a fake scanner SDK and never contact a sled; `ZebraVendorPinTest` pins every vendor member the adapter calls, and `SledNeverCallTest` fails on the calls the review found dangerous.

**The Zebra RFID library.** `RFIDAPI3Library/API3_LIB-release.aar` is a hand-placed Zebra artifact, not a Gradle dependency. The committed copy is 2.0.5.292 from Zebra's public `ALT-RFID-SAMPLES` repo (`NewGen2XPlay/app/libs/rfidapi3lib-2.0.5.292.aar`). Replace it with the current release from Zebra's RFID SDK for Android download page, keeping the same file name, before trusting the sled on a floor — and re-run `javap` against every `com.zebra.*` name `ZebraRfidReader.kt`/`ZebraBarcodeEngine.kt` reference (see those files) rather than assuming the API surface hasn't moved. This version dropped the two build workarounds the 2.0.2.82 `.aar` used to force: it no longer references `android.support.v4.content.LocalBroadcastManager` (so `app/build.gradle.kts` no longer needs the `com.android.support:localbroadcastmanager:28.0.0` dependency that used to supply it), and it no longer bundles the JAXP `META-INF/services` registration files that used to require excluding them via `packaging.resources.excludes` plus `merges -= "/META-INF/services/**"`, and a matching `systemProperty` override in `testOptions` for the unit-test JVM. A maintainer replacing the `.aar` again should check whether either regresses (a `LinkageError` from `Readers` construction, or a `NoClassDefFoundError` under Robolectric, are what each workaround used to guard against) before assuming they're still unnecessary.

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

## Sign-in

Besides email and password, the link with phone and the move password, a person's own phone can sign in with a fingerprint or face. Design and rulings: `../docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md`.
- **Who it's for.** Only the person assigned to the phone in the portal (Scanning Hardware › Kiosks › the device › Personal device). A device with a station key or a station type (label, RFID, time clock) is shared, so it never qualifies.
- **Turning it on.** After a password sign-in on that phone, the app offers "Use fingerprint or face…". Turn on runs the system prompt once.
- **How it works.** The phone holds an EC key in Android Keystore that only a strong biometric can unlock. The server checks Android key attestation when the key is registered, and each sign-in answers a one-time challenge with a signature. The phone stores no password or token for it.
- **30 days.** Biometric sign-in lasts 30 days from the last password sign-in. Biometric sign-ins don't extend it; a password sign-in does.
- **Sign-in screen.** It opens on a "Sign in as …" card and starts the prompt. **Other account** opens the usual choices, and **Use password** opens the password form with the person's email filled in.
- **When it turns off.** A new fingerprint is enrolled or the screen lock is removed (Android invalidates the key, and the app drops it). The password is changed or reset, the account is disabled, or the phone is reassigned to someone else (or made non-personal). After a key is dropped, the next password sign-in offers it again.
- **Forget.** In Settings › This Kiosk, on /me, or on the user page. The device's page in the portal can forget it too.

**Server.** `SS_KIOSK_SIGNING_DIGESTS` lists the allowed app signing-certificate SHA-256 digests (release, Play app signing, and the debug key in dev); enrollment is refused for any other. `serversherpa refresh-attestation-status` seeds Google's revocation list, which the notification worker then refreshes daily. Enrollment is refused until a list exists.

**Tests.** `BiometricSignInTest` and the login tests use a software P-256 key (`FakeBiometricKeys`) and a fake prompt only. The real Keystore, attestation and BiometricPrompt need a device.

## Asset Lookup

Home › Asset Lookup finds one asset and shows what the server knows about it. Design: `../docs/superpowers/specs/2026-11-10-android-asset-lookup-design.md` (Implementation notes), ported from the web kiosk: `../docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md`.
- **Who sees what.** Everyone sees identity (name, make/model, asset tag, serial, RFID) and each route's source and destination. Admins (rank 60+) also see status, moves and current location, and scan history when they have `scans:view` and the asset is on a move. The server decides what is returned; the app only decides what to draw.
- **Inputs.** Typed text, DataWedge scans, the camera, and the RFD40 sled. One tag from the sled looks it up; several tags show a notice to point the reader at one tag.
- **Setup.** Needs Kiosk Setup; the tile and the input stay disabled until it is complete.
- **Offline.** When the API can't be reached, lookup runs on the synced move devices only and shows a notice saying so. Scan history needs a connection.
- **Never records a scan.** A lookup writes nothing to the outbox.

## Icons and fonts

`python3 tools/make_icons.py` regenerates the launcher icons from `../portal/public/images/serversherpa-logo.png`. Fonts are bundled (see `FONTS-LICENSE.md`).
