# Android Bluetooth printing to Zebra printers — design

Date: 2026-10-22. Status: approved scope — Jimmy: "port it the way iOS does it" (no further questions until the device test).
Scope: the native Android kiosk app (`Android_Kiosk_App/`). Branch `android-ble-printing`, cut from `main` 3d82169f.

**The reference is the iOS design**, `docs/superpowers/specs/2026-10-22-ios-bluetooth-printing-design.md` on branch `ios-ble-printing` (read it: `git show ios-ble-printing:docs/superpowers/specs/2026-10-22-ios-bluetooth-printing-design.md`), with its plan `docs/superpowers/plans/2026-10-22-ios-bluetooth-printing.md` on the same branch, and the working throwaway spike on branch `ble-spike` (`IOS_Kiosk_App/.../Data/Printer/BleSpikeCentral.swift`, which printed to and queried the office ZD421). Decisions below keep iOS's numbers (D1–D16) so the two can be read side by side. Where Android differs, the Android rule is stated.

## 1. Why (same as iOS)

Crews work in data centers where the handheld and the Zebra often aren't on the same network. The ZD421's Bluetooth Low Energy "Parser Service" accepts ZPL and returns replies, so the handheld can print straight to the printer next to it. iOS proved it on the office ZD421 (Link-OS 7.3): found by its name (its serial, e.g. `D8J224508535`) with no service UUIDs advertised; no pairing (security mode 1); 1.15 s tap-to-ready; ATT MTU 247 (244-byte writes); no write-without-response; replies 3–33 ms after a write; 3.9 KB/s.

## 2. Goals, non-goals, anti-goals (as iOS, for Android)

**Goals**
- **Bluetooth is a real printer choice in Android Printer Setup**, beside Scan network and Enter IP: it lists nearby Zebras, connects to the one picked, saves it, and runs the same checks.
- **Everything a network printer gets works over Bluetooth:** checks (answers, ready, DPI, fonts, peeler), installing missing fonts (with progress), test labels (alignment and sample), offsets, peel/tear.
- **Print Labels prints over Bluetooth** through the same queue: scan an asset, its stored label prints, one Labeled scan is recorded.
- **Settings gets a Troubleshooting tab** (iOS D13).
- **A printer that forgot the handheld** is explained with recovery steps.

**Non-goals:** the Zebra SDK, Bluetooth Classic, printing in the background, more than one saved printer, sending the connection type to the portal, new label content, iOS changes, conditioning Bluetooth with Internet Test (it conditions TCP only).

**Anti-goals:**
- **No status checks, polls or waits on the print path** (Jimmy's standing rule). The one extra command is the `~JX` clear after a failed send (D16).
- **Never change a printer setting** (no `setvar`, `^JUS`, `~SD`, `discoverable`), apart from the existing peel/tear print mode.
- **Network printing must not get slower or change behavior** (apart from the `~JX` clear after a failed send): one TCP connection per command, its timeouts, and its Internet Test hook (`zebraSession`'s marked `.let(InternetTestRoutes::local)` line) stay exactly as they are.

## 3. Decisions

### Jimmy's (through the iOS design and "port it the way iOS does it")
- Bluetooth Low Energy through the platform's own Bluetooth API (Android `BluetoothLeScanner` / `BluetoothGatt`); no Zebra SDK.
- The `~JX` clear after a failed send (D16).
- One handheld per printer; the link stays open while the app is in use (D4).
- Bluetooth sits beside the network options in Printer Setup and does everything network printing does.
- The deep tools live in Settings › Troubleshooting.

### Mirrored from iOS (D1–D16), with the Android rule where it differs
1. **One transport seam.** A `ZebraTransport` interface (`address`, `query(command, complete)`, `write(parts, progress)`); identify, status, peeler, serial, fonts, font entries, send and font install are written once on top of it, so network and Bluetooth send identical bytes. `NetworkZebra` implements it (its bytes and timeouts unchanged).
2. **The saved printer records its connection.** `SavedPrinter` gains `connection`: network (host) or Bluetooth (serial + **the printer's Bluetooth address** — Android exposes the MAC, where iOS stores a per-iPad identifier). Encoding writes `connection` and also `host` (`""` for Bluetooth) so an older build still decodes; a saved printer from before this change reads back as network.
3. **Found again by serial.** Reconnect by the saved address first (`BluetoothAdapter.getRemoteDevice(address)` + `connectGatt(..., TRANSPORT_LE)`); if that fails to reach Ready, scan for the name equal to the saved serial. After connecting, confirm the serial from Device Information; a mismatch is refused.
4. **The link stays open while the app is in use.** Connect on first need (opening Print Labels or Printer Setup, or the first job); keep it up; a dropped idle link reconnects on the next use (~1.2 s); close it when the app goes to the background (the existing ProcessLifecycle `onStop`), on sign-out, and when the saved printer changes. Never reconnect by itself after the printer lets go.
5. **Writes.** **Android:** request MTU 247 right after connecting (`requestMtu(247)`); chunk = negotiated MTU − 3 (244 at 247; 20 if the request fails). Each chunk is written with response (`WRITE_TYPE_DEFAULT`) and the next only after `onCharacteristicWrite` succeeds. A scan is stopped before any send.
6. **Replies.** Indications on "From Printer Data" are enabled before anything is sent (**Android:** `setCharacteristicNotification(true)` + write `ENABLE_INDICATION_VALUE` to descriptor `0x2902`). Before each query, stray bytes are drained (0.3 s quiet, at most 1 s). A reply is complete by the network rules (ETX frames, quoted value), ending 2 s after its last byte or 5 s in all.
7. **Timeouts:** connect and ready 10 s; a query 5 s total (2 s idle); a send 15 s + 1 s per 2,048 bytes. Network timeouts unchanged.
8. **Fonts over Bluetooth** with progress and a time estimate; Cancel finishes the font in progress and stops before the next; a cut font install blocks sends with `The font install was cut off. Turn the printer off and on, then tap Check again.` until a check succeeds; **the font check compares sizes** (the `^HW` listing's sizes vs the library's) and offers a damaged font for reinstall — for network printers too.
9. **Finding printers:** an **unfiltered** LE scan (the printer advertises no service UUIDs, so a service-UUID scan filter finds nothing), listing named devices; Zebra-flagged = advertises the Zebra parser service or Zebra's `FE79`, **or** the name matches `^[A-Z0-9]{12}$`; strongest signal first, refreshing as it scans; 30 s, stoppable; the FEED hint. **Android:** read the name from the scan record (`ScanRecord.deviceName`), not `BluetoothDevice.getName()`. Picking one: connect → Device Information must say "Zebra Technologies" → `~HI` (model, DPI) → save → checks.
10. **Recovery.** **Android** has no CBError 14/15; a printer that forgot the handheld shows up as GATT status 5 / 8 / 15 / 137 (insufficient authentication/encryption) or a dropped bond. Then stop retrying and show: `The printer forgot this device. Open Android Settings › Connected devices, forget D8J224508535, then come back and tap Connect.` A drop before Ready retries at most 3 times, 3 s apart. **Android:** always `close()` a `BluetoothGatt` after a failed connect (status 133 leaks client slots otherwise).
11. **Bluetooth off or not allowed.** Copy: `Turn on Bluetooth to reach the printer.` (with a button that fires `BluetoothAdapter.ACTION_REQUEST_ENABLE`) / `Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer.` (with an app-settings button). **Android permissions:** API 31+ asks `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`; API 30 (the MC2200) asks `ACCESS_FINE_LOCATION` and needs Location turned on for scans — `Turn on Location to find Bluetooth printers on this device.` (with a Location-settings button). The prompt appears the first time someone picks Bluetooth, never at launch (like `RfidPermissions`). The manifest already declares the permissions (for the RFD40); add `<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />`.
12. **Wording names the printer, not an IP:** `Can't reach the printer at 10.0.0.5.` / `Can't reach the printer D8J224508535 over Bluetooth.`; summary `ZD421 at 10.0.0.5 · 203 dpi` / `ZD421 · Bluetooth D8J224508535 · 300 dpi`; `No Zebra printer answered at 10.0.0.5.` / `No Zebra printer answered over Bluetooth as D8J224508535.`
13. **Settings › Troubleshooting** (visible to everyone signed in): connection details (type, address or serial, connected/idle, write size, last drop and why), printer details (`~HI`, plus Device Information over Bluetooth), ask buttons (status, `~HQES`, DPI getvar `head.resolution.in_dpi`, peeler, serial, font listing — each with the reply, bytes and milliseconds), a speed test (10 / 25 / 50 KB labels ending in END; seconds and KB/s), a Bluetooth scan with signal strength (Zebras flagged), a Copy/Share report, a free-text command box only for admins and developers, and a developer-only Cut-send test (half a label, mark the failure, then a full label: only the full label may print).
14. *(iOS-only: the test card comes out of Printer Setup.)* Android's "Bluetooth — coming soon" card becomes the real Bluetooth card: `Bluetooth` / `Find a Zebra printer nearby over Bluetooth.`
15. *(iOS-only: Info.plist text.)*
16. **The `~JX` clear after a failed send,** for network and Bluetooth alike: after any failed send the printer is marked "needs a clear"; the next thing sent to it (job, Retry, test label, checks) first sends `~JX`, then the real bytes, under the printer lock; the mark clears once `~JX` is delivered. `~JA` is never used.

### Android-only calls (mine)
- **One app-wide printer lock** in `AppContainer`, shared by Print Labels and Printer Setup (and Troubleshooting). Today Android's Printer Setup has a ViewModel-local `Mutex` and Print Labels its own queue; a single GATT link makes serializing them mandatory.
- **One app-wide `PrinterGuard`** in `AppContainer` (the `~JX` and font-cut marks), reset when the saved printer's connection changes.
- **A GATT operation queue:** Android allows one outstanding GATT operation; every connect step (discover services, five Device Information reads, the descriptor write, the MTU request, each chunk write) goes through one queue driven by the `BluetoothGattCallback`, with callbacks marshalled from binder threads onto coroutines. Handle both the pre-API-33 and API-33+ characteristic APIs (minSdk 30).
- `requestConnectionPriority(CONNECTION_PRIORITY_HIGH)` after connecting (Android can, iOS can't); measure its effect in the device pass, keep it only if it doesn't hurt.
- The Bluetooth layer sits behind thin interfaces (scanner, GATT client) with fakes, so every rule above is unit-tested on the JVM (Robolectric only where Android types force it).

## 4. What stays the same
- Labels are generated on the device ahead of time (the shared labelgen bundle); Bluetooth changes only how bytes reach the printer.
- One job at a time in scan order; Retry resends the same bytes; Reprint never records a scan.
- No checks or polls before or after a label.
- The RFD40 RFID sled (Bluetooth Classic through Zebra's library) is untouched; BLE printing shares the radio and must coexist (no forced disconnects, no shared state).

## 5. Constraints
- Kotlin 2.0.21, Compose, coroutines, JUnit4, Robolectric 4.14.1; minSdk 30, targetSdk 36. No new third-party dependencies.
- `core/` stays Android-free (`CorePurityTest`): UUIDs, limits, copy, parsers and size checks go in `core/printer/`; Android Bluetooth code in `data/printer/`.
- Saved printers from before this change load unchanged (test with today's JSON).
- `NetworkZebra.kt` keeps `zebraSession()` and its two `// INTERNET-TEST` lines exactly (Internet Test's `RemovalGuardTest` pins NetworkZebra.kt at 2 marked lines).
- American English; build with `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`, `ANDROID_HOME=~/Library/Android/sdk`, `./gradlew testDebugUnitTest assembleDebug`.

## 6. Left to the builder
Type and file names beyond the plan's, the exact Compose layout of the Bluetooth list and Troubleshooting (using the app's `SettingsRow`, `SetupCard`, `Segmented`, `MiniButton`, chips and tokens), retry spacing and scan timing within the bounds above.

## 7. Hardware checks owed (after the build; Pixel 10 Pro XL and the office ZD421, then an MC2200)
The MTU the printer grants Android; whether the printer's Bluetooth address is stable across power cycles (reconnect by address); idle-drop timing; a second device near a connected printer; security modes 2/3 and the Android forget-device recovery; range in an aisle; whether a disconnect resets the printer's parser mid-label; RFD40 + printer at the same time; the MC2200 (API 30) permission and Location path.

## 8. Implementation notes (2026-10-23)

Built on branch `android-ble-printing` by subagent-driven development: six planned tasks, per-task reviews with fix rounds, a five-lens final review (13 confirmed findings, one fix wave), a cleanup pass, and a device pass.

**Rulings that changed or sharpened the design**
- **Address order.** The saved address is tried first, then the address verified earlier in this run, then a name scan for the serial. Device Information's manufacturer and serial are checked before any write. An address found by scanning is never saved; Troubleshooting shows "Found at B (saved A)", computed from the saved connection, until the operator chooses the printer again.
- **`close()`.** A write already going out finishes within its budget, then the link closes. A job that arrives after the app went to the background reconnects and finishes.
- **Location.** Required for scans at every API level (the manifest's `BLUETOOTH_SCAN` has no `neverForLocation`, shared with the RFD40). COARSE is requested with FINE. Approximate-only counts as not allowed.
- **Warm-ups.** Opening Print Labels or Printer Setup warms the link, and so does coming back to Print Labels from the background. A warm-up never blocks or speaks for itself. A label queued during one joins its connect.
- **No unrequested checks.** Printer Setup never runs its checks by itself. When Bluetooth comes back, a check refusal clears and the link warms; the checks run on a tap.
- **Font-cut stops.** They persist across a relaunch, keyed by printer identity, and are lifted by that printer's `~HI` (iOS 5c3eec9c). Saving another printer no longer resets the guard.
- **Install ETA.** Follows iOS: Bluetooth guesses 3.9 KB/s until it has measured a rate; network shows nothing until measured.
- **Worst case.** A held PrinterLock can wait about 59 s for a printer that keeps dropping just before Ready: 10 s locate + 10 s connect + 3 × (3 + 10 s).
- **Troubleshooting.** A typed `^XA` format goes as a send unless it holds a `^H`/`~H` host query; this differs from iOS on purpose. The share report keeps secrets out by construction. A linear, fail-closed redaction scanner backs that up; it was fuzzed differentially against the old regex over 50M+ inputs.
- **Connected label.** Printer Setup shows "Connected" on the saved printer's row and in the header while its link is up (Jimmy, at the device pass).

**Device pass:** Jimmy, 2026-10-23, Pixel 10 Pro XL with the office ZD421 over Bluetooth: connect, print and the tested flows work ("bluetooth is fine and working").
- Not recorded: the MTU granted and whether the address stays stable across power cycles.
- Still owed: the MC2200 (API 30) permission and Location path and its 320 dp layout, including the Time Clock's two-line header on Enter Your Name, plus security modes 2/3.

**Also on this branch**
- The Rolodex `(?U)` crash fix, with an `AndroidRegexTest` guard.
- Rolodex: the photo viewer, Previous jobs (latest 50 + `jobs_total`, migration 0106), Employee ID hidden on Android.
- The RfidPermissions COARSE request.
- The Time Clock wordmark at 320 dp.
- Robolectric-safe Compose waits (`waitUntilIdlingMain`).
