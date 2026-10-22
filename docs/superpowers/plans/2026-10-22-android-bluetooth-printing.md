# Android Bluetooth Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Android kiosk prints to a Zebra over Bluetooth Low Energy exactly as it prints over the network, mirroring the iOS design, with the deep tools on a new Settings › Troubleshooting tab.

**Architecture:**
- **One transport seam.** A `ZebraTransport` interface (`query` and `write` with progress) carries every printer call. Network (the existing TCP `NetworkZebra`) and Bluetooth (new) both implement it. Identify, status, peeler, serial, fonts, sends and font installs are written once on top of it.
- **The Bluetooth manager.** One app-wide `ZebraBluetooth` owns the scanner and a single GATT link to the saved printer. A GATT operation queue drives it, and the link stays open while the app is in use.
- **App-wide lock and guard.** A `PrinterLock` and `PrinterGuard` serialize Print Labels, Printer Setup and Troubleshooting. They add the `~JX` clear after a failed send, and block sends after a cut font install.

**Tech Stack:** Kotlin 2.0.21, Jetpack Compose, coroutines 1.9, Android Bluetooth LE (`BluetoothLeScanner`, `BluetoothGatt`), JUnit4, kotlinx-coroutines-test, Robolectric 4.14.1. minSdk 30, targetSdk 36.

**Spec:** `docs/superpowers/specs/2026-10-22-android-bluetooth-printing-design.md`. Read it first; decisions are cited as D1–D16.

**References:** the iOS design and plan, on branch `ios-ble-printing`:
- `git show ios-ble-printing:docs/superpowers/specs/2026-10-22-ios-bluetooth-printing-design.md`
- `git show ios-ble-printing:docs/superpowers/plans/2026-10-22-ios-bluetooth-printing.md`

The iOS implementation of Tasks 1–2, on the same branch:
- `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Core/Printer/ZebraBluetoothSpec.swift`
- `.../Core/Labels/LabelSettings.swift`
- `.../Data/Printer/ZebraTransport.swift`
- `.../Data/Printer/PrinterGuard.swift`
- `.../Data/Printer/PrinterLock.swift`
- `.../UI/Screens/Labels/PrinterSetupViewModel.swift`

The working spike: `git show ble-spike:"IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Data/Printer/BleSpikeCentral.swift"`. It has the proven connect sequence and write/indication handling. Its `.../Core/Printer/BleSpikePayloads.swift` holds the speed-test label with an END marker.

## Global Constraints

- **Paths:** A = `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/` and AT = `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/`.
- **`core/` stays Android-free** (`CorePurityTest`). UUIDs, limits, copy, parsers and size checks go in `A/core/printer/`. Android Bluetooth code goes in `A/data/printer/`.
- **Banned:** the Zebra SDK, Bluetooth Classic, background printing, and new third-party dependencies.
- **No status check, poll or wait** is added to the print path. The only extra command is the `~JX` clear after a failed send (D16).
- **The app never changes a printer setting.** No `setvar`, `^JUS`, `~SD` or `discoverable` change. The existing peel/tear print mode is the only exception.
- **Network printing is unchanged.** It keeps its one-connection-per-command TCP path, its `ZebraNetwork` timeouts, and `zebraSession()` with its two `// INTERNET-TEST` lines. Internet Test's `RemovalGuardTest` pins NetworkZebra.kt at exactly 2 marked lines. Don't move or remark them.
- **Zebra parser service and Device Information:**
  - Parser service `38EB4A80-C570-11E3-9507-0002A5D5C51B`.
  - From Printer Data `38EB4A81-C570-11E3-9507-0002A5D5C51B`, which uses indications.
  - To Printer Data `38EB4A82-C570-11E3-9507-0002A5D5C51B`, which is written.
  - Zebra member UUID `FE79`.
  - Device Information `180A`: `2A29` manufacturer, `2A24` model, `2A25` serial, `2A26` firmware, `2A28` Link-OS.
  - CCCD `00002902-0000-1000-8000-00805f9b34fb`.
- **Bluetooth limits:**
  - Request MTU 247. The chunk is the negotiated MTU − 3, or 20 if the MTU request fails.
  - Each chunk is written with `WRITE_TYPE_DEFAULT`; the next waits for the ack.
  - Connect-and-ready 10 s.
  - A query ends 2 s after its last byte, or 5 s in all.
  - Drain before a query: 0.3 s of quiet, at most 1 s.
  - Send budget: 15 s plus 1 s per 2,048 bytes.
  - Reconnect after a drop before Ready: at most 3 tries, 3 s apart.
  - Scan 30 s.
- **Copy (verbatim):**
  - Unreachable:
    - `Can't reach the printer at 10.0.0.5.` (today's text)
    - `Can't reach the printer D8J224508535 over Bluetooth.`
  - Summary:
    - `ZD421 at 10.0.0.5 · 203 dpi` (today's text)
    - `ZD421 · Bluetooth D8J224508535 · 300 dpi`
  - No answer:
    - `No Zebra printer answered at 10.0.0.5.`
    - `No Zebra printer answered over Bluetooth as D8J224508535.`
  - Recovery: `The printer forgot this device. Open Android Settings › Connected devices, forget D8J224508535, then come back and tap Connect.`
  - Font cut: `The font install was cut off. Turn the printer off and on, then tap Check again.`
  - Bluetooth off: `Turn on Bluetooth to reach the printer.`
  - Not allowed: `Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer.`
  - Location off (API 30): `Turn on Location to find Bluetooth printers on this device.`
  - Scan hint: `Don't see the printer? Hold FEED on the printer for 5 seconds (the middle light blinks), then scan again. A Zebra's Bluetooth name is its serial number, like D8J224508535.`
  - Bluetooth card: `Bluetooth` / `Find a Zebra printer nearby over Bluetooth.`
  - Damaged font: `Damaged: ROBOTO.TTF (reinstall).`
- **Writing and commits:** American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.superpowers/`, `.kotlin/`, `local.properties` or build outputs.
- **Test gate.** From `Android_Kiosk_App/`, with `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"; export ANDROID_HOME=~/Library/Android/sdk`:
  - Iterate with `./gradlew testDebugUnitTest --tests '<class>'`.
  - Before each commit, run the full `./gradlew testDebugUnitTest assembleDebug` in the foreground with a 600 s timeout.
  - A Compose `waitUntil` timeout under heavy machine load is a known flake: rerun once when the load drops, and report it.

## Review Focus

1. **A saved printer from before this update** must load as the same network printer, with offsets and peel kept. The test JSON is `{"printer":{"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203},"offsetX":3}`. Owned by Task 1, test `oldSavedPrinterLoadsAsNetwork`.
2. **The app goes to the background mid-label over Bluetooth.** The send must fail, not hang, the printer is marked for a clear, and the next label is preceded by `~JX`. Owned by Task 3 test `closeFailsPendingWrite` and Task 2 test `failedSendClearsBeforeNextLabel`.
3. **The saved Bluetooth printer is off or out of range** when a label is scanned. The job fails within the 10 s connect budget with the unreachable copy, and Retry works once the printer is back. Owned by Task 3 test `connectTimesOutWithinBudget`.
4. **A different printer answers at the saved address,** for example a replacement ZD421. Its Device Information serial doesn't match, so it isn't used. Owned by Task 3 test `serialMismatchIsRefused`.
5. **Two GATT operations issued back to back** (Android drops the second one if it isn't queued) must go out in order, one at a time. The same holds for a Troubleshooting speed test while Print Labels has jobs: everything goes through `PrinterLock` with no interleaved bytes. Owned by Task 3 test `gattOperationsRunOneAtATime` and Task 5 test `troubleshootingSendsGoThroughPrinterLock`.

---

### Task 1: Core — the printer's connection, Bluetooth limits and copy, directory sizes

**Files:**
- Modify: `A/core/labels/LabelSettings.kt` (`SavedPrinter`)
- Create: `A/core/printer/ZebraBluetoothSpec.kt`
- Modify: `A/core/printer/ZebraReplies.kt` (directory entries with sizes, `~JX`)
- Modify: `A/core/printer/PrinterChecks.kt` (damaged fonts)
- Modify (signatures take the printer or connection; network text unchanged): `A/ui/screens/labels/LabelsHomeScreen.kt` (`printerSummary`), `A/core/labels/PrintQueue.kt` (`printerUnreachableText`), `A/ui/screens/labels/PrinterSetupViewModel.kt` (`noZebraAnswerText`), and every caller
- Test: `AT/core/labels/SavedPrinterTest.kt` (new), `AT/core/printer/ZebraBluetoothSpecTest.kt` (new), the existing ZebraReplies and PrinterChecks tests, and any tests touched by the signature changes

**Interfaces (produces):**
- `@Serializable sealed interface PrinterConnection` with:
  - `@Serializable @SerialName("network") data class Network(val host: String)`
  - `@Serializable @SerialName("bluetooth") data class Bluetooth(val serial: String, val address: String?)`
- `@Serializable(with = SavedPrinterSerializer::class) data class SavedPrinter(val connection: PrinterConnection, val model: String, val serial: String, val dpi: Int)`, with:
  - `val host: String?` (the network host, else null) and `val isBluetooth: Boolean`
  - a secondary constructor `SavedPrinter(host: String, model: String, serial: String, dpi: Int)` that builds a network printer, so existing call sites compile
- Encoding writes `"connection":{"type":"network","host":…}` or `{"type":"bluetooth","serial":…,"address":…}`. It also writes `"host"` (the network host, or `""`), so an older build still decodes. Decoding with no `connection` key reads `host` as a network printer.
- `fun printerSummary(p: SavedPrinter): String`, `fun printerUnreachableText(p: SavedPrinter): String`, and `fun noZebraAnswerText(c: PrinterConnection): String`, returning the copy above. A blank model reads `Zebra`.
- `object ZebraBluetoothSpec` holds:
  - The UUID strings from Global Constraints.
  - `REQUESTED_MTU = 247`, `CONNECT_READY_MS = 10_000L`, `QUERY_IDLE_MS = 2_000L`, `QUERY_TOTAL_MS = 5_000L`, `DRAIN_QUIET_MS = 300L`, `DRAIN_MAX_MS = 1_000L`, `RECONNECT_TRIES = 3`, `RECONNECT_SPACING_MS = 3_000L`, `SCAN_MS = 30_000L`.
  - `fun sendBudgetMs(bytes: Int): Long = 15_000 + bytes * 1_000L / 2_048`
  - `fun looksLikeZebraSerial(name: String): Boolean`, matching `^[A-Z0-9]{12}$`.
  - `fun chunkBytes(mtu: Int?): Int`, which is mtu − 3, or 20 when null or below 23.
  - The copy constants `BLUETOOTH_OFF_TEXT`, `BLUETOOTH_DENIED_TEXT`, `LOCATION_OFF_TEXT`, `BLUETOOTH_SCAN_HINT_TEXT` and `FONT_INSTALL_CUT_TEXT`.
  - `fun pairingLostText(serial: String): String`.
- `ZebraCommands.CANCEL_PARTIAL_FORMAT = "~JX"`.
- `data class DirectoryEntry(val name: String, val size: Int)` and `fun parseDirectoryEntries(text: String): List<DirectoryEntry>`. It uses the same rules as `parseDirectory`, which now maps the entry names.
- `fun damagedFonts(needed: List<String>, library: List<KioskLabelFont>, onPrinter: List<DirectoryEntry>): List<String>`. A font is damaged when it is needed, present by name, not resident (by name or by the library flag), its library row has `size > 0`, and the printer's size differs. Returns upper-case names in `needed` order.

- [ ] **Step 1: Write the failing tests.** These are the iOS Task 1 tests, ported:
  - `oldSavedPrinterLoadsAsNetwork`: decode that JSON through `KioskPrefs`' JSON as `LabelOptions`. Expect `printer?.connection == Network("10.0.0.5")` and `offsetX == 3`.
  - `bluetoothPrinterRoundTrips` and `networkPrinterRoundTrips`: the Bluetooth JSON contains `"type":"bluetooth"` and `"host":""`.
  - `aBluetoothPrinterReadByAnOldDecoder`: decode the new Bluetooth JSON with a stand-in for the old class, `data class Old(val host: String, val model: String, val serial: String, val dpi: Int)` with `ignoreUnknownKeys`. It succeeds with `host == ""`.
  - `summaryNamesTheConnection`, `unreachableTextNamesTheConnection` and `noAnswerTextNamesTheConnection`.
  - `zebraSerialNames`: `D8J224508535` is true; `d8j224508535`, `D8J22450853`, `Jimmy's Pixel` and `N017E` are false.
  - `sendBudgetGrowsWithSize`: 0 gives 15,000; 2,048 gives 16,000; 170,000 gives 98,007 (±1).
  - `chunkFromMtu`: 247 gives 244, null gives 20, and 23 gives 20.
  - `directoryEntriesFromTheZD421Listing`: the iOS listing fixture (copy it from the iOS plan's Task 1) gives `[(85620388.TTF,1036584),(IN001.DMP,1032),(TT0003M_.TTF,169188)]`, and `parseDirectory` of it is unchanged.
  - `damagedFontIsTheOneWithTheWrongSize`: the iOS case.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Network behavior and copy stay unchanged for every caller. A decode failure must still not lose `LabelOptions`; the new tests prove old JSON loads.
- [ ] **Step 4: Run the full test gate.**
- [ ] **Step 5: Commit** `feat(android): saved printers know their connection; Bluetooth limits and copy; font sizes from the listing`.

### Task 2: The transport seam, the app-wide lock and guard, font progress and the damaged-font check

**Files:**
- Create: `A/data/printer/ZebraTransport.kt` (the interface, plus the shared commands as extension functions)
- Create: `A/data/printer/PrinterGuard.kt` and `A/data/printer/PrinterLock.kt`
- Modify: `A/data/printer/NetworkZebra.kt`:
  - `NetworkZebra` implements `ZebraTransport`.
  - Its identify, status, peelerPresent, serial, fonts, send and installFont move to the extension byte for byte.
  - `zebraSession()` and its marked lines stay as they are.
- Modify: `A/ui/screens/labels/PrinterSetupViewModel.kt`:
  - `SetupZebra` gains `fontEntries()` and `installFont(name, bytes, progress)`.
  - `zebraAt(host)` becomes `zebraFor(printer: SavedPrinter)`.
  - Uses the app-wide lock and guard; damaged fonts; install progress and ETA; cancel between fonts.
- Modify: `A/ui/screens/labels/PrintLabelsViewModel.kt` and `A/core/labels/PrintQueue.kt` (`LabelSender.send(printer: SavedPrinter, zpl)` and `PrintQueueDeps.send(printer, zpl)`; map `PrinterNeedsRestart` to `FONT_INSTALL_CUT_TEXT`)
- Modify: `A/AppContainer.kt` (it owns one `PrinterLock` and one `PrinterGuard`, and resets the guard when the saved printer's connection changes) and the two screens' wiring
- Test: `AT/data/printer/PrinterGuardTest.kt` (new), `NetworkZebraTest` (byte-identical), `PrintQueueTest`, `PrinterSetupViewModelTest` and `PrintLabelsViewModelTest`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `interface ZebraTransport { val address: String; suspend fun query(command: String, complete: (ByteArray) -> Boolean): String; suspend fun write(parts: List<ByteArray>, progress: ((sent: Long, total: Long) -> Unit)? = null) }`. `query` throws `PrinterNoReply(address)` on an empty reply.
  - Extensions on it: `identify()`, `status()`, `peelerPresent()`, `serial()`, `fonts()`, `fontEntries()`, `send(zpl)` and `installFont(name, bytes, progress)`. They carry today's exact bytes and parsing.
  - `class PrinterLock`, a fair coroutine `Mutex` wrapper with `suspend fun <T> withLock(block: suspend () -> T): T`.
  - `class PrinterGuard` with `enum State { CLEAN, NEEDS_CLEAR, FONT_CUT }`, `val state`, `markSendFailed()`, `markFontCut()` and `reset()`. Its rules:
    - **Inside the lock:** before a send or font install while `NEEDS_CLEAR`, write `~JX` first, then the bytes, then set `CLEAN`.
    - **On failure:** a failed send sets `NEEDS_CLEAR`; a failed font install sets `FONT_CUT`.
    - **While `FONT_CUT`:** send and font install throw `PrinterNeedsRestart` (message `FONT_INSTALL_CUT_TEXT`) and queries still run. A successful `identify()` resets to `CLEAN`.
  - `LockedZebra(inner, lock, guard)` and `fun lockedSender(lock, guard, send: LabelSender): LabelSender`.
  - `PrinterSetupUi` gains `installProgress: Float?` and `installEta: String?` (for example `about 40 s left`).
  - The fonts row lists damaged fonts as installable.
  - **Cancel finishes the font in progress** (D8): `cancelInstall()` sets a flag that is checked only between fonts.
  - `NetworkZebra.write` reports progress per part written.

- [ ] **Step 1: Failing tests.** These are the iOS Task 2 tests, ported:
  - `failedSendClearsBeforeNextLabel`, `clearUsesJX`, `fontCutBlocksSendsUntilAPrinterAnswers` and `guardResetsWhenThePrinterChanges`.
  - `networkBytesUnchanged`: extend `NetworkZebraTest`'s byte recording to cover every command through the extension.
  - `damagedFontOffersReinstall`, `cancelInstallFinishesTheCurrentFont`, `installReportsProgress` and `printQueueShowsFontCutText`.
  - `setupAndPrintLabelsShareOneLock`: a Printer Setup call and a Print Labels send never overlap (FakeLine pattern).
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement.** Network behavior and timeouts stay unchanged.
- [ ] **Step 4: Full test gate green.** `RemovalGuardTest` and `MarkedLinesAreDeletableTest` must still pass.
- [ ] **Step 5: Commit** `feat(android): one transport seam for printers; app-wide printer lock; ~JX after a failed send; damaged-font check`.

### Task 3: The Bluetooth link and transport

**Files:**
- Create: `A/data/printer/BluetoothLeClient.kt`. It holds thin interfaces over `BluetoothLeScanner` and `BluetoothGatt`, the real adapters, and a `GattQueue` that serializes GATT operations through the callbacks. It handles both the pre-33 and 33+ characteristic APIs.
- Create: `A/data/printer/ZebraBluetooth.kt`, the app-wide manager: availability, scan, the one link, reconnect and lifecycle.
- Create: `A/data/printer/BluetoothZebra.kt`, the `ZebraTransport` over the link, plus the Bluetooth error types.
- Test: `AT/data/printer/ZebraBluetoothTest.kt` and `AT/data/printer/FakeBluetoothLe.kt` (new).

**Interfaces:**
- Consumes: Task 1 `ZebraBluetoothSpec` and `SavedPrinter`/`PrinterConnection`; Task 2 `ZebraTransport` and the existing `PrinterException` types.
- Produces:
  - `enum class BluetoothAvailability { UNKNOWN, READY, POWERED_OFF, UNAUTHORIZED, LOCATION_OFF, UNSUPPORTED }`
  - `data class FoundBluetoothPrinter(val address: String, val name: String, val rssi: Int, val advertisesZebra: Boolean)`
  - `data class BluetoothPrinterInfo(val address: String, val manufacturer: String?, val model: String?, val serial: String?, val firmware: String?, val linkOs: String?)`
  - `data class BluetoothLinkInfo(val connected: Boolean, val info: BluetoothPrinterInfo?, val chunkBytes: Int?, val mtu: Int?, val connectedAtMs: Long?, val lastActivityMs: Long?, val lastDrop: BluetoothDrop?)` and `data class BluetoothDrop(val atMs: Long, val reason: String)`
  - `class ZebraBluetooth(client: BluetoothLeClient, scope: CoroutineScope, clock)`. Its members:
    - `val availability: StateFlow<BluetoothAvailability>` and `val link: StateFlow<BluetoothLinkInfo>`.
    - `fun scan(): Flow<List<FoundBluetoothPrinter>>`: named devices only. Zebra-flagged means `advertisesZebra || looksLikeZebraSerial(name)`. Sorted Zebra-flagged first, then serial-like, then signal in 10 dB buckets, then name. Ends after `SCAN_MS` or `stopScan()`.
    - `fun stopScan()`.
    - `suspend fun connect(address: String?, serial: String?): BluetoothPrinterInfo`:
      - It tries the address first, else scans for name == serial.
      - Ready means:
        1. services discovered;
        2. the Device Information characteristics read (each read has a fallback timeout, so one slow read doesn't block);
        3. the MTU requested;
        4. indications enabled through the CCCD;
        5. all within `CONNECT_READY_MS`.
      - It refuses a non-"Zebra Technologies" manufacturer (`BluetoothNotZebra`) and a serial mismatch (`BluetoothSerialMismatch`).
    - `fun transport(printer: SavedPrinter): BluetoothZebra`.
    - `fun close()`, for background, sign-out and printer change.
  - `class BluetoothZebra(...) : ZebraTransport`, with `address` = the serial:
    - `write` chunks at `chunkBytes(mtu)`, uses `WRITE_TYPE_DEFAULT`, waits for each ack, reports progress, honors `sendBudgetMs`, and stops the scan first.
    - `query` drains (D6), writes, then reads indications until `complete`, `QUERY_IDLE_MS` after the last byte, or `QUERY_TOTAL_MS`.
    - Both reconnect first when the link is down, within one `CONNECT_READY_MS`. Neither reconnects on its own while idle (D4).
  - **Errors** (all `PrinterException`, with `host` = serial): `BluetoothUnavailable(availability)`, `BluetoothPrinterNotFound`, `BluetoothNotZebra`, `BluetoothSerialMismatch`, and `BluetoothPairingLost`. Pairing lost covers GATT status 5, 8, 15 or 137, or a bond lost mid-link, and it stops retries. `PrinterTimeout`, `PrinterNoReply` and `PrinterUnreachable` are reused, with `host` = serial.
  - **Drops:** a drop during a write or query fails it at once. A drop before Ready retries at most `RECONNECT_TRIES` times, `RECONNECT_SPACING_MS` apart, and a failed connect always `close()`s its GATT. A drop after Ready records `lastDrop` and waits for the next use.

- [ ] **Step 1: Failing tests.** Use a fake LE client that records operations, acks on demand, emits indications, drops, and reports adapter, permission and location states.
  - `gattOperationsRunOneAtATime`: discovery, the DIS reads, the MTU request, the CCCD write and two chunk writes are issued strictly one after another, each after its callback.
  - `writesInAckedChunks`: 1,000 bytes at MTU 247 give 5 writes of at most 244 bytes, in order, each after the previous ack. Progress reaches 1,000.
  - `smallMtuFallsBackTo20`.
  - `queryWaitsForCompleteReply`: a `~HS` split over three indications.
  - `queryDrainsLateBytes`.
  - `queryEndsOnIdleAndTotal`.
  - `connectByAddressThenBySerial`.
  - `serialMismatchIsRefused` and `nonZebraIsRefused`.
  - `connectTimesOutWithinBudget`.
  - `pairingLostStopsRetries`: statuses 5, 8, 137 and a bond loss.
  - `dropBeforeReadyRetriesThreeTimes`: it then fails, and every failed attempt closed its GATT.
  - `idleDropDoesNotReconnectUntilUsed`.
  - `closeFailsPendingWrite`.
  - `availabilityMapsStates`: powered off, unauthorized, location off and unsupported each give `BluetoothUnavailable` before any connect.
  - `scanSortsZebrasFirstAndUsesTheScanRecordName`.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement.** Callbacks hop from binder threads onto a single dispatcher, and continuations resume exactly once. Port the spike's sequencing. Call `requestConnectionPriority(HIGH)` after Ready (D-Android).
- [ ] **Step 4: Full test gate green.**
- [ ] **Step 5: Commit** `feat(android): Bluetooth LE link and transport for Zebra printers`.

### Task 4: Bluetooth in Printer Setup and Print Labels

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/AndroidManifest.xml` (add `<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />`)
- Create: `A/data/printer/BluetoothPermissions.kt`. On API 31+ it asks `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`. On API 30 it asks `ACCESS_FINE_LOCATION` and checks that Location is turned on. It asks when Bluetooth is first picked, not at launch, modeled on `input/rfid/RfidPermissions.kt`.
- Modify: `A/AppContainer.kt`:
  - It owns one `ZebraBluetooth`.
  - The Print Labels sender and the Printer Setup `zebraFor` pick the transport by `printer.connection`.
  - It calls `close()` on background (ProcessLifecycle `onStop`), on sign-out (in `logout()`, after the existing first line), when the session ends, and when the saved printer's connection changes.
- Modify: `A/ui/screens/labels/PrinterSetupViewModel.kt` and `PrinterSetupScreen.kt`:
  - The Bluetooth card replaces "Bluetooth — coming soon" and opens the scan list.
  - Choose, then run checks.
  - Font installs show progress and ETA.
  - Show the off, denied and location messages with their buttons, and the pairing-lost text.
- Modify: `A/ui/screens/labels/PrintLabelsScreen.kt` (wiring) and `LabelsHomeScreen.kt` (summary)
- Test: `PrinterSetupViewModelTest` and `PrintLabelsViewModelTest`, plus a Compose test for the Bluetooth card and list

**Interfaces:**
- Consumes: Task 3's `ZebraBluetooth` API (through an interface the ViewModel takes, `BluetoothPrinting`: `availability`, `link`, `scan()`, `stopScan()`, `connect(address, serial)`), Task 2's `zebraFor`, `PrinterGuard` and `PrinterLock`, and Task 1's copy.
- Produces:
  - The find mode gains `BLUETOOTH`.
  - `PrinterSetupUi` gains `bluetoothFound: List<FoundBluetoothPrinter>?`, `bluetoothScanning: Boolean`, `bluetoothMessage: String?`, `pairingLost: String?` and `bluetoothUnavailable: BluetoothAvailability?`.
  - `scanBluetooth()`, `chooseBluetooth(p)` and `stopBluetoothScan()`.
  - **The choose flow (D9):**
    1. Connect.
    2. Run `~HI`.
    3. Save `SavedPrinter(PrinterConnection.Bluetooth(info.serial ?: name, address), model, serial, dpi)`.
    4. Run the checks.
  - **The list:** Zebra-flagged rows first, with signal strength. Non-Zebra named devices go under a collapsed "Other devices". It shows the scan hint and a Stop button.

- [ ] **Step 1: Failing tests:**
  - `bluetoothChooseSavesAndChecks`.
  - `bluetoothOffSaysSo`, `bluetoothDeniedSaysSo` and `locationOffSaysSo` (API 30).
  - `pairingLostShowsRecovery`.
  - `printLabelsBluetoothUnreachableCopy`.
  - `containerPicksTransportByConnection`: test the factory function, not the container.
  - `linkClosesOnBackgroundAndSignOut`.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full test gate green.**
- [ ] **Step 5: Commit** `feat(android): Bluetooth printers in Printer Setup and Print Labels`.
- [ ] **Step 6: Device check** (controller with Jimmy, on the Pixel and the office ZD421): install with `adb install -r`, choose the ZD421 over Bluetooth, run the checks, then print test labels and a few scanned asset labels.

### Task 5: Settings › Troubleshooting

**Files:**
- Modify: `A/core/settings/SettingsTabs.kt`:
  - Add `SettingsTabId.TROUBLESHOOTING("troubleshooting")`.
  - Its label is `Troubleshooting` and its blurb is `Printer connection, tests and a report to share.`
  - It is visible to anyone signed in, placed between Devices and RFID.
- Create: `A/ui/screens/settings/TroubleshootingPanel.kt` and `A/ui/screens/settings/TroubleshootingModel.kt`.
- Create: `A/core/printer/PrinterTestLabels.kt`, holding `speedTestLabel(targetBytes, widthDots, heightDots, run)` and `sampleTestLabel(widthDots, heightDots, dpi)`, ported from the spike's `BleSpikePayloads.swift`.
- Modify: `A/ui/screens/settings/SettingsScreen.kt` (the panel case)
- Test: `AT/ui/screens/settings/TroubleshootingModelTest.kt` and `AT/core/printer/PrinterTestLabelsTest.kt`

**Interfaces:** `TroubleshootingModel(settings, bluetooth, zebraFor, printerLock, printerGuard, isAdmin, isDeveloper)`, with the D13 sections. Every printer call goes through `LockedZebra` and the guard. The free-text command box shows only for admins and developers. The Cut-send test shows only for developers.

- [ ] **Step 1: Failing tests:**
  - `troubleshootingTabVisibleSignedIn`.
  - `speedLabelHitsTargetAndEndsWithEND`: within 2% of target.
  - `troubleshootingSendsGoThroughPrinterLock`.
  - `freeTextOnlyForAdminsAndDevelopers`.
  - `cutSendTestSendsJXBeforeTheFullLabel`.
  - `reportCarriesEverything`.
- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement** with the app's `SettingsRow`, `Segmented`, `MiniButton`, chips and tokens.
- [ ] **Step 4: Full test gate green.**
- [ ] **Step 5: Commit** `feat(android): Settings › Troubleshooting for printers`.

### Task 6: Docs and the device pass

**Files:**
- Modify: `Android_Kiosk_App/README.md` (Label printing: Bluetooth, permissions, Troubleshooting)
- Modify: the spec (an "Implementation notes" section with the rulings and device results)

- [ ] **Step 1:** Update the README's label printing section.
- [ ] **Step 2: Device pass** (controller with Jimmy): on the Pixel with the office ZD421, then an MC2200 if one is available.
  1. Choose the printer over Bluetooth.
  2. Checks green.
  3. Test labels.
  4. Ten scanned asset labels.
  5. The font listing.
  6. A speed test.
  7. The Cut-send test (only the full label prints).
  8. Leave it idle, then print again (reconnect).
  9. Power-cycle the printer, then print again.
  10. Background the app, then come back.
  11. Record the MTU granted and whether the address is stable.
- [ ] **Step 3: Commit** `docs(android): Bluetooth printing notes and README`.
