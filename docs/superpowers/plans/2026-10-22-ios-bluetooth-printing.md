# iPad Bluetooth Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iOS kiosk prints to a Zebra over Bluetooth Low Energy exactly as it prints over the network, with the deep tools on a new Settings › Troubleshooting tab.

**Architecture:** A small `ZebraTransport` seam (query / write with progress) carries every printer call; network (existing TCP) and Bluetooth (new CoreBluetooth link) both implement it, and identify, status, peeler, serial, fonts, sends and font installs are written once on top of it. One app-wide `ZebraBluetooth` manager owns the CoreBluetooth central and keeps the saved printer's link open while the app is in use. A `PrinterGuard` shared with `PrinterLock` adds the `~JX` clear after a failed send and blocks sends after a cut font install.

**Tech Stack:** Swift 5, SwiftUI, Swift concurrency, CoreBluetooth, Network.framework, Swift Testing; iOS 18.

**Spec:** `docs/superpowers/specs/2026-10-22-ios-bluetooth-printing-design.md` (read it first; decisions are cited as D1–D16).

**References:** the iOS code map `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/83c85735-b7ea-4313-9fa5-a69362b2a6ef/scratchpad/ios-printing-recon.md`; the BLE research `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/83c85735-b7ea-4313-9fa5-a69362b2a6ef/scratchpad/ble-research.md`; the working spike on git branch `ble-spike` (`git show ble-spike:"IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Data/Printer/BleSpikeCentral.swift"`, `.../UI/Screens/Labels/BleSpikeScreen.swift`, `.../Core/Printer/BleSpikePayloads.swift`) — it printed and queried the real ZD421; reuse its CoreBluetooth sequencing and the speed-test label builder (with END marker), never merge the branch.

## Global Constraints

- Paths: IK = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`, IKT = `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa KioskTests/`.
- iOS 18 minimum, Swift 5, no third-party packages, Swift Testing (`import Testing`, `@Test`, `@Suite`).
- `IK/Core/` imports Foundation only (`CorePurityTests`); CoreBluetooth code lives in `IK/Data/Printer/`.
- File basenames are unique across the target (Xcode synchronized folders add new files automatically).
- No Zebra SDK, no Bluetooth Classic, no MFi, no `bluetooth-central` background mode.
- No status check, poll or wait is added to the print path; the only extra command is the `~JX` clear after a failed send (D16).
- The app never changes a printer setting: no `setvar`, `^JUS`, `~SD`, `^MM` (except the existing peel/tear `withPrintMode`), `discoverable` change.
- Network printing keeps its one-connection-per-command TCP path and its timeouts (`ZebraNetwork`) unchanged.
- Zebra parser service `38EB4A80-C570-11E3-9507-0002A5D5C51B`; From Printer Data `38EB4A81-C570-11E3-9507-0002A5D5C51B` (indicate); To Printer Data `38EB4A82-C570-11E3-9507-0002A5D5C51B` (write). Device Information `180A`: `2A29` manufacturer, `2A24` model, `2A25` serial, `2A26` firmware, `2A28` Link-OS.
- Bluetooth limits (D5–D7, D9, D10): chunk = `maximumWriteValueLength(for: .withoutResponse)`, each written `.withResponse`, next only after the ack; connect-and-ready 10 s; a query ends 2 s after its last byte or 5 s in all (network's idle/total); drain before a query: 0.3 s of quiet, at most 1 s; send budget = 15 s + 1 s per 2,048 bytes; reconnect after a drop before Ready: at most 3 tries, 3 s apart; scan 30 s.
- Copy (verbatim):
  - Info.plist `NSBluetoothAlwaysUsageDescription`: `Finds and prints to Zebra label printers over Bluetooth.`
  - Unreachable: `Can't reach the printer at 10.0.0.5.` (network, today's text) / `Can't reach the printer D8J224508535 over Bluetooth.`
  - Summary: `ZD421 at 10.0.0.5 · 203 dpi` (today) / `ZD421 · Bluetooth D8J224508535 · 300 dpi`
  - Recovery: `The printer forgot this iPad. Open Settings › Bluetooth, tap ⓘ next to D8J224508535, choose Forget This Device, then come back and tap Connect.`
  - Font cut: `The font install was cut off. Turn the printer off and on, then tap Check again.`
  - Bluetooth off: `Turn on Bluetooth to reach the printer.` / not allowed: `Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer.`
  - Scan hint: `Don't see the printer? Hold FEED on the printer for 5 seconds (the middle light blinks), then scan again. A Zebra's Bluetooth name is its serial number, like D8J224508535.`
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `.derived*`, `.superpowers`, `.env`, `.venv`, `node_modules`.
- Test gate (from `IOS_Kiosk_App/ServerSherpa Kiosk`, `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`): `xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived -only-testing:"ServerSherpa KioskTests"` must pass (779 tests today), plus the phone build `xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' -derivedDataPath ../.derived`. A task may run only its own suites while iterating; the full gate runs before its commit.

## Review Focus

1. **A saved printer from before this update** (today's `ss.kiosk.labels` JSON `{"printer":{"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203},...}`) must load as the same network printer, untouched → Task 1 test `oldSavedPrinterLoadsAsNetwork`.
2. **The app goes to the background mid-label over Bluetooth** → the send fails (not hangs), the printer is marked for a clear, and the next label is preceded by `~JX` → Task 3 test `backgroundCloseFailsPendingSend` + Task 2 test `failedSendClearsBeforeNextLabel`.
3. **The saved Bluetooth printer is off or out of range** when a label is scanned → the job fails within the 10 s connect budget with the unreachable copy, and Retry works once it's back → Task 3 test `connectTimesOutWithinBudget`.
4. **A different printer answers to the saved iPad identifier** (another ZD421 after a repair) → its Device Information serial doesn't match, so it isn't used → Task 3 test `serialMismatchIsRefused`.
5. **Troubleshooting's speed test while Print Labels still has jobs going** → both go through `PrinterLock`, one at a time, no interleaved bytes → Task 5 test `troubleshootingSendsGoThroughPrinterLock`.

---

### Task 1: Core — the printer's connection, Bluetooth limits, directory sizes

**Files:**
- Modify: `IK/Core/Labels/LabelSettings.swift` (SavedPrinter)
- Create: `IK/Core/Printer/ZebraBluetoothSpec.swift` (UUIDs, limits, serial-name check, send budget, copy)
- Modify: `IK/Core/Printer/ZebraReplies.swift` (directory entries with sizes, `~JX` command)
- Modify: `IK/Core/Printer/PrinterChecks.swift` (damaged fonts)
- Modify: `IK/UI/Screens/Labels/LabelsHomeScreen.swift` (`printerSummary`), `IK/Core/Labels/PrintQueue.swift` (`printerUnreachableText`), `IK/UI/Screens/Labels/PrinterSetupViewModel.swift` (`noZebraAnswerText`) — signatures take the printer
- Test: `IKT/Core/SavedPrinterTests.swift` (new), `IKT/Core/ZebraBluetoothSpecTests.swift` (new), `IKT/Core/ZebraRepliesTests.swift`, existing tests touched by the signature changes

**Interfaces:**
- Produces:
  - `enum PrinterConnection: Equatable, Sendable { case network(host: String); case bluetooth(serial: String, peripheralId: UUID?) }`
  - `struct SavedPrinter: Codable, Equatable, Sendable { var connection: PrinterConnection; var model: String; var serial: String; var dpi: Int }` with `var host: String?` (network host, else nil), `var isBluetooth: Bool`, `init(host:model:serial:dpi:)` (network, keeps existing call sites compiling) and `init(connection:model:serial:dpi:)`. Encoding writes `connection` as `{"type":"network","host":…}` / `{"type":"bluetooth","serial":…,"peripheralId":…}` and also `host` (the network host, or `""`) so an older build still decodes; decoding with no `connection` key reads `host` as a network printer.
  - `func printerSummary(_ p: SavedPrinter) -> String`, `func printerUnreachableText(_ p: SavedPrinter) -> String`, `func noZebraAnswerText(_ connection: PrinterConnection) -> String` (`No Zebra printer answered at 10.0.0.5.` / `No Zebra printer answered over Bluetooth as D8J224508535.`; it takes the connection because choosing a printer fails before a `SavedPrinter` exists)
  - `enum ZebraBluetoothSpec` with `serviceUUID`, `fromPrinterUUID`, `toPrinterUUID`, `deviceInfoUUID`, the five DIS UUID strings, `connectReady = 10.0`, `queryIdle = 2.0`, `queryTotal = 5.0`, `drainQuiet = 0.3`, `drainMax = 1.0`, `reconnectTries = 3`, `reconnectSpacing = 3.0`, `scanDuration = 30.0`, `static func sendBudget(bytes: Int) -> TimeInterval` (15 + bytes / 2048), `static func looksLikeZebraSerial(_ name: String) -> Bool` (`^[A-Z0-9]{12}$`), and the copy constants `BLUETOOTH_OFF_TEXT`, `BLUETOOTH_DENIED_TEXT`, `BLUETOOTH_SCAN_HINT_TEXT`, `FONT_INSTALL_CUT_TEXT`, `func pairingLostText(serial: String) -> String` (Global Constraints copy).
  - `ZebraCommands.cancelPartialFormat = "~JX"`
  - `struct DirectoryEntry: Equatable, Sendable { var name: String; var size: Int }`, `func parseDirectoryEntries(_ text: String) -> [DirectoryEntry]` (same rules as `parseDirectory`, which now maps its names).
  - `func damagedFonts(needed: [String], library: [KioskLabelFont], onPrinter: [DirectoryEntry]) -> [String]`: needed, present by name, not resident (name or library flag), library row `size > 0`, and size different → upper-case names in `needed` order.

- [ ] **Step 1: Write the failing tests**
  - `oldSavedPrinterLoadsAsNetwork`: decode `{"printer":{"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203},"offsetX":3}` as `LabelOptions` → `printer?.connection == .network(host: "10.0.0.5")`, `offsetX == 3`.
  - `bluetoothPrinterRoundTrips` / `networkPrinterRoundTrips`: encode → decode equal; the bluetooth JSON contains `"type":"bluetooth"` and `"host":""`.
  - `summaryNamesTheConnection`: `printerSummary` gives `ZD421 at 10.0.0.5 · 203 dpi` and `ZD421 · Bluetooth D8J224508535 · 300 dpi`; a blank model reads `Zebra`.
  - `unreachableTextNamesTheConnection`: the two Global Constraints strings; `noZebraAnswerText(.network(host: "10.0.0.5"))` and `noZebraAnswerText(.bluetooth(serial: "D8J224508535", peripheralId: nil))` give the two strings above.
  - `zebraSerialNames`: `D8J224508535` true; `d8j224508535`, `D8J22450853`, `James’s Mac mini`, `N017E` false.
  - `sendBudgetGrowsWithSize`: `sendBudget(bytes: 0) == 15`, `sendBudget(bytes: 2048) == 16`, `sendBudget(bytes: 170_000)` ≈ 98.0 (±0.1).
  - `directoryEntriesFromTheZD421Listing`: the real listing `"\u{02}\r\n- DIR E:*.* \r\n* E:85620388.TTF   1036584          \r\n* E:IN001.DMP      1032          \r\n* E:TT0003M_.TTF    169188       K  \r\n\r\n-  63311872 bytes free E: ONBOARD FLASH \r\n\u{03}"` → `[("85620388.TTF",1036584), ("IN001.DMP",1032), ("TT0003M_.TTF",169188)]`; `parseDirectory` of it unchanged.
  - `damagedFontIsTheOneWithTheWrongSize`: needed `["ROBOTO.TTF","TT0003M_.TTF"]`, library ROBOTO size 124336 and TT0003M_ resident, on printer ROBOTO 60000 and TT0003M_ 169188 → `["ROBOTO.TTF"]`; ROBOTO at 124336 → `[]`; a library size of 0 → `[]`.
- [ ] **Step 2: Run them and see them fail** (`-only-testing:"ServerSherpa KioskTests/SavedPrinterTests"` etc.): compile errors on the new names.
- [ ] **Step 3: Implement the interfaces above**; update every caller of the three copy functions and of `SavedPrinter(host:…)` so behavior for network printers is unchanged (search `printerUnreachableText(`, `noZebraAnswerText(`, `printerSummary(`, `.host`).
- [ ] **Step 4: Run the full test gate**; all green.
- [ ] **Step 5: Commit** `feat(ios): saved printers know their connection; Bluetooth limits and copy; font sizes from the listing`.

---

### Task 2: The transport seam, the clear step and the font size check

**Files:**
- Create: `IK/Data/Printer/ZebraTransport.swift` (protocol + the shared commands as an extension)
- Create: `IK/Data/Printer/PrinterGuard.swift`
- Modify: `IK/Data/Printer/NetworkZebra.swift` (conform to `ZebraTransport`; its identify/status/peeler/serial/fonts/send/installFont move to the extension byte-for-byte)
- Modify: `IK/Data/Printer/PrinterLock.swift` (`SetupZebra` additions; `LockedZebra` and `lockedSender` use the guard)
- Modify: `IK/Data/Labels/LabelPrintJobs.swift`, `IK/Core/Labels/PrintQueue.swift` (send takes the printer)
- Modify: `IK/UI/Screens/Labels/PrinterSetupViewModel.swift` (`printerAt` takes the printer; damaged fonts; font-cut message; install progress), `IK/App/AppContainer.swift`, `IK/UI/Screens/Labels/PrinterSetupScreen.swift` (wiring only)
- Test: `IKT/Data/PrinterGuardTests.swift` (new), `IKT/Data/NetworkZebraTests.swift`, `IKT/Core/PrintQueueTests.swift`, `IKT/UI/PrinterSetupViewModelTests.swift`

**Interfaces:**
- Consumes: Task 1's `SavedPrinter`, `DirectoryEntry`, `parseDirectoryEntries`, `damagedFonts`, `ZebraCommands.cancelPartialFormat`, `FONT_INSTALL_CUT_TEXT`.
- Produces:
  - `protocol ZebraTransport: Sendable { var address: String { get }; func query(_ command: String, complete: @escaping @Sendable (Data) -> Bool) async throws -> String; func write(_ parts: [Data], progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws }` — `query` throws `PrinterNoReply` on an empty reply; `address` is what error types carry as `host`.
  - `extension ZebraTransport`: `identify()`, `status()`, `peelerPresent()`, `serial()`, `fonts()`, `fontEntries() -> [DirectoryEntry]`, `send(_ zpl: String)`, `installFont(name:bytes:progress:)` — the exact bytes and parsing `NetworkZebra` has today.
  - `SetupZebra` gains `fontEntries()` and `installFont(name:bytes:progress:)` (the old `installFont(name:bytes:)` stays as a convenience with `progress: nil`).
  - `actor PrinterGuard { enum State { case clean, needsClear, fontCut }; var state; func markSendFailed(); func markFontCut(); func reset() }` plus the rules: inside the lock, before a `send` / `installFont` when `needsClear` → write `~JX` first, then the bytes, then `clean`; a failed `send` → `needsClear`; a failed `installFont` → `fontCut`; while `fontCut`, `send`/`installFont` throw `PrinterNeedsRestart` (a `LocalizedError` whose text is `FONT_INSTALL_CUT_TEXT`), queries still run, and a successful `identify()` resets to `clean`. The container owns one guard; `LabelSettingsStore.setPrinter` with a different connection resets it.
  - `typealias LabelSender = @Sendable (_ printer: SavedPrinter, _ zpl: String) async throws -> Void`; `PrintQueueDeps.send(printer, zpl)`; `func lockedSender(_ lock: PrinterLock, _ guard: PrinterGuard, _ send: @escaping LabelSender) -> LabelSender`; `LockedZebra(inner:lock:guard:)`.
  - `PrinterSetupViewModel(…, zebraFor: @escaping @MainActor (SavedPrinter) -> SetupZebra, printerLock:, printerGuard:, …)` replacing `zebraAt`; `runChoose` for a network printer builds `SavedPrinter(host:…)` as today. Print Labels maps `PrinterNeedsRestart` to `FONT_INSTALL_CUT_TEXT`.
  - `PrinterSetupUi` gains `installProgress: Double?` (0…1 while a font is going out) and `installEta: String?` ("about 40 s left").
- Fonts: the font row shows missing and damaged fonts; damaged library fonts are installable (`Damaged: ROBOTO.TTF (reinstall).`). **Cancel finishes the font in progress** (D8): `cancelInstall()` sets a flag checked between fonts only.

- [ ] **Step 1: Failing tests**
  - `failedSendClearsBeforeNextLabel` (PrinterGuardTests, with a recording fake `SetupZebra`/sender): send A fails → send B writes `~JX` then B; send C writes only C.
  - `clearUsesJX` : the written bytes are exactly `~JX`.
  - `fontCutBlocksSendsUntilAPrinterAnswers`: installFont fails → `send` throws `PrinterNeedsRestart` with `FONT_INSTALL_CUT_TEXT`; `identify()` succeeds → next `send` goes out (no `~JX`).
  - `guardResetsWhenThePrinterChanges`.
  - `networkBytesUnchanged` (NetworkZebraTests): `~HI`, `~HS`, getvars, `^XA^HWE:*.*^XZ`, `~DYE:ROBOTO.TTF,B,T,<n>,,`+bytes are byte-identical through the extension (extend the existing byte-recording tests).
  - `damagedFontOffersReinstall` (PrinterSetupViewModelTests): FakeZebra lists `ROBOTO.TTF` at the wrong size → fonts row fail with `Damaged: ROBOTO.TTF (reinstall).`, `fontFix.installable` has ROBOTO.
  - `cancelInstallFinishesTheCurrentFont`: two fonts, cancel during the first → the first's bytes all written, the second never starts.
  - `installReportsProgress`: progress callbacks drive `installProgress` from 0 to 1.
  - `printQueueShowsFontCutText`: send throws `PrinterNeedsRestart` → entry message `FONT_INSTALL_CUT_TEXT`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement**; network behavior and timeouts unchanged; `NetworkZebra.write` reports progress per part written.
- [ ] **Step 4: Full test gate green.**
- [ ] **Step 5: Commit** `feat(ios): one transport seam for printers; ~JX after a failed send; damaged-font check`.

---

### Task 3: The Bluetooth link and transport

**Files:**
- Create: `IK/Data/Printer/BluetoothCentralClient.swift` (thin protocols over `CBCentralManager`/`CBPeripheral` + the real adapters)
- Create: `IK/Data/Printer/ZebraBluetooth.swift` (the app-wide manager: availability, scan, the one link, reconnect, lifecycle)
- Create: `IK/Data/Printer/BluetoothZebra.swift` (`ZebraTransport` over the link; Bluetooth error types)
- Test: `IKT/Data/ZebraBluetoothTests.swift`, `IKT/Support/FakeBluetoothCentral.swift` (new)

**Interfaces:**
- Consumes: Task 1 `ZebraBluetoothSpec`, `SavedPrinter`/`PrinterConnection`; Task 2 `ZebraTransport`, `PrinterError`, `PrinterTimeout`, `PrinterNoReply`, `PrinterUnreachable`.
- Produces:
  - `enum BluetoothAvailability: Equatable, Sendable { case unknown, ready, poweredOff, unauthorized, unsupported }`
  - `struct FoundBluetoothPrinter: Equatable, Sendable, Identifiable { var id: UUID /* the iPad's peripheral identifier */; var name: String; var rssi: Int; var advertisesZebra: Bool }`
  - `struct BluetoothPrinterInfo: Equatable, Sendable { var peripheralId: UUID; var manufacturer: String?; var model: String?; var serial: String?; var firmware: String?; var linkOs: String? }`
  - `struct BluetoothLinkInfo: Equatable, Sendable { var connected: Bool; var info: BluetoothPrinterInfo?; var chunkBytes: Int?; var connectedAt: Date?; var lastActivity: Date?; var lastDrop: BluetoothDrop? }` with `struct BluetoothDrop: Equatable, Sendable { var at: Date; var reason: String }`
  - `@MainActor @Observable final class ZebraBluetooth`: `init(client: BluetoothCentralClient)`; `var availability`; `var link: BluetoothLinkInfo`; `func start()` (creates the central lazily — first use only, so the permission prompt appears when Bluetooth is first picked, D11); `func scan() -> AsyncStream<[FoundBluetoothPrinter]>` (all named devices, Zebra-flagged = `advertisesZebra || looksLikeZebraSerial(name)`, strongest first, ends after `scanDuration` or `stopScan()`); `func stopScan()`; `func connect(peripheralId: UUID?, serial: String?) async throws -> BluetoothPrinterInfo` (by identifier via `retrievePeripherals`, else scan for the name == serial; ready = DIS read + indications on, within `connectReady`; refuses a manufacturer other than "Zebra Technologies" with `BluetoothNotZebra`, and a serial that differs from the expected one with `BluetoothSerialMismatch`); `func transport(for printer: SavedPrinter) -> BluetoothZebra`; `func close()` (background, sign-out, printer change).
  - `struct BluetoothZebra: ZebraTransport` (`address` = the serial): `write` chunks at `maximumWriteValueLength(for: .withoutResponse)`, each `.withResponse`, awaits each ack, reports progress, honors `sendBudget`; `query` drains (D6), writes, reads indications until `complete`, `queryIdle` after the last byte, or `queryTotal`. Both reconnect first when the link is down (one connect within `connectReady`); they never reconnect on their own when idle (D4).
  - Errors (all `PrinterError`, `host` = serial): `BluetoothUnavailable(availability)`, `BluetoothPrinterNotFound`, `BluetoothNotZebra`, `BluetoothSerialMismatch`, `BluetoothPairingLost` (CBError 14 `peerRemovedPairingInformation` or 15 `encryptionTimedOut`; stops retries), plus `PrinterTimeout` / `PrinterNoReply` / `PrinterUnreachable` reused with `host` = serial.
  - Drop handling: a drop during a write or query fails it at once; a drop before Ready retries at most `reconnectTries`, `reconnectSpacing` apart; a drop after Ready records `lastDrop` and waits for the next use.

- [ ] **Step 1: Failing tests** (fake central/peripheral that records writes, acks on demand, emits indications, drops, and reports states)
  - `writesInAckedChunks`: 1,000 bytes at chunk 244 → 5 writes of ≤244 in order, each after the previous ack; progress reaches 1,000.
  - `queryWaitsForCompleteReply`: `~HS` with indications split across three packets → whole 82-byte reply returned.
  - `queryDrainsLateBytes`: stray bytes arriving before the write are not part of the reply.
  - `queryEndsOnIdleAndTotal`: no ETX → returns after `queryIdle`; endless trickle → `queryTotal`.
  - `connectByIdentifierThenBySerial`: unknown identifier → scans, connects to the device named the serial.
  - `serialMismatchIsRefused` and `nonZebraIsRefused`.
  - `connectTimesOutWithinBudget`: no didConnect → `PrinterUnreachable` after `connectReady`.
  - `pairingLostStopsRetries`: didDisconnect with CBError 14 (and 15) → `BluetoothPairingLost`, no reconnect.
  - `dropBeforeReadyRetriesThreeTimes`: then fails.
  - `idleDropDoesNotReconnectUntilUsed`: drop after Ready → no connect call until the next `send`, which reconnects first.
  - `backgroundCloseFailsPendingSend`: `close()` mid-write → the write throws.
  - `availabilityMapsStates`: poweredOff / unauthorized / unsupported → `BluetoothUnavailable` before any connect.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** (central on the main queue, delegate methods `nonisolated` hopping to the main actor as the spike does; continuations resume once; the link is retained strongly).
- [ ] **Step 4: Full test gate green.**
- [ ] **Step 5: Commit** `feat(ios): Bluetooth LE link and transport for Zebra printers`.

---

### Task 4: Bluetooth in Printer Setup and Print Labels

**Files:**
- Modify: `IK/Info.plist` (Bluetooth usage text)
- Modify: `IK/App/AppContainer.swift` (owns one `ZebraBluetooth`; the sender and `zebraFor` pick the transport by `printer.connection`; `close()` on background, sign-out, session end, saved-printer connection change)
- Modify: `IK/UI/Screens/Labels/PrinterSetupViewModel.swift`, `IK/UI/Screens/Labels/PrinterSetupScreen.swift` (Bluetooth card → scan list → choose → checks), `IK/UI/Screens/Labels/PrintLabelsScreen.swift` / its view model only if copy needs it
- Test: `IKT/UI/PrinterSetupViewModelTests.swift`, `IKT/UI/PrintLabelsViewModelTests.swift`

**Interfaces:**
- Consumes: Task 3's `ZebraBluetooth` API and errors; Task 2's `zebraFor`, `PrinterGuard`; Task 1's copy.
- Produces: `PrinterFindMode` gains `.bluetooth`; `PrinterSetupUi` gains `bluetoothFound: [FoundBluetoothPrinter]?`, `bluetoothScanning: Bool`, `bluetoothMessage: String?`, `pairingLost: String?` (the recovery text, with an Open Settings button), `bluetoothUnavailable: BluetoothAvailability?`; `PrinterSetupViewModel.scanBluetooth()`, `.chooseBluetooth(_ p: FoundBluetoothPrinter)`, `.stopBluetoothScan()`; the view model takes `bluetooth: BluetoothPrinting` (a small `@MainActor` protocol `ZebraBluetooth` conforms to: `availability`, `link`, `scan()`, `stopScan()`, `connect(peripheralId:serial:)`) so tests use a fake; Task 5 uses the same protocol.
- Choose flow (D9): connect → `~HI` (model, DPI) → save `SavedPrinter(connection: .bluetooth(serial: info.serial ?? name, peripheralId: id), model: …, serial: …, dpi: id.dpi)` → `startChecks`. Font installs over Bluetooth show `installProgress` / `installEta` (estimate from the measured bytes per second of the install so far, else 3.9 KB/s).
- The Bluetooth card replaces "Bluetooth — coming soon": title `Bluetooth`, description `Find a Zebra printer nearby over Bluetooth.` The list shows Zebra-flagged rows first with signal strength, the scan hint text, and a Stop button; non-Zebra named devices sit under a collapsed "Other devices" row.

- [ ] **Step 1: Failing tests**
  - `bluetoothChooseSavesAndChecks`: fake bluetooth finds `D8J224508535`, connect returns info, FakeZebra `~HI` says ZD421 300 dpi → saved printer `.bluetooth(serial: "D8J224508535", …)`, dpi 300, checks run.
  - `bluetoothOffSaysSo` / `bluetoothDeniedSaysSo`: availability → `BLUETOOTH_OFF_TEXT` / `BLUETOOTH_DENIED_TEXT`, Open Settings shown for denied.
  - `pairingLostShowsRecovery`: connect throws `BluetoothPairingLost` → `pairingLost == pairingLostText(serial: "D8J224508535")`.
  - `printLabelsBluetoothUnreachableCopy`: the queue's message for a Bluetooth printer is `Can't reach the printer D8J224508535 over Bluetooth.`
  - `containerPicksTransportByConnection`: a network printer goes to `NetworkZebra`, a Bluetooth printer to the Bluetooth transport (test the factory function the container uses, not the container).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full test gate + phone build green.**
- [ ] **Step 5: Commit** `feat(ios): Bluetooth printers in Printer Setup and Print Labels`.
- [ ] **Step 6: Device check (controller, with Jimmy):** install on the iPad Pro 13 (`xcodebuild build -destination 'generic/platform=iOS' -allowProvisioningUpdates -allowProvisioningDeviceRegistration`, `xcrun devicectl device install app --device 76EB683A-5E94-5506-8D38-0D3E85761C7D <app>`), choose the ZD421 over Bluetooth, run checks, print test labels and a few scanned asset labels.

---

### Task 5: Settings › Troubleshooting

**Files:**
- Modify: `IK/Core/Settings/SettingsTabs.swift` (`case troubleshooting`, label `Troubleshooting`, blurb `Printer connection, tests and a report to share.`, visible signed in, between Devices and This Kiosk)
- Create: `IK/UI/Screens/Settings/TroubleshootingPanel.swift`, `IK/UI/Screens/Settings/TroubleshootingModel.swift`
- Create: `IK/Core/Printer/PrinterTestLabels.swift` (the speed-test label with START/END markers and the sample, from the spike's `BleSpikePayloads`, Foundation only)
- Modify: `IK/UI/Screens/Settings/SettingsScreen.swift` (panel case)
- Test: `IKT/UI/TroubleshootingModelTests.swift`, `IKT/Core/PrinterTestLabelsTests.swift`

**Interfaces:**
- Consumes: Task 2 `SetupZebra`/`LockedZebra`/`PrinterGuard`/`zebraFor`, Task 3 `ZebraBluetooth` (`link`, `scan()`), Task 1 copy.
- Produces: `TroubleshootingModel(settings:, bluetooth:, zebraFor:, printerLock:, printerGuard:, isAdmin:, isDeveloper:)` with sections (D13): connection details (type, address or serial, connected/idle, chunk bytes, last drop and reason); printer details (`~HI` + DIS for Bluetooth); ask buttons (status, `~HQES`, DPI getvar `head.resolution.in_dpi`, peeler, serial, font listing) each with reply, bytes and milliseconds; speed test (10 / 25 / 50 KB, 1 / 3 / 5 runs, seconds and KB/s, label size and DPI from the saved printer and the template pick); Bluetooth scan (all named devices with signal, Zebras flagged); report (`Copy` and `Share` a text file with device/app info, all of the above and a log capped at 5,000 lines); free-text command box only when `isAdmin || isDeveloper`; developer-only **Cut-send test** (D16): writes the first half of a sample label, records a failure on the guard, then sends a full sample label through the normal path (so `~JX` goes first). Every printer call goes through `LockedZebra` / the guard.
- `func speedTestLabel(targetBytes: Int, widthDots: Int, heightDots: Int, run: Int) -> String` and `func sampleTestLabel(widthDots: Int, heightDots: Int, dpi: Int) -> String` in `PrinterTestLabels.swift`.

- [ ] **Step 1: Failing tests**
  - `troubleshootingTabVisibleSignedIn` (visibleTabs includes it for signed-in non-admins, not signed out).
  - `speedLabelHitsTargetAndEndsWithEND`: 10/25/50 KB within 2% of target; `^GFA` byte counts consistent; contains `END` after the graphic, inside the label length.
  - `troubleshootingSendsGoThroughPrinterLock`: a speed run and a concurrent label send never overlap (FakeLine pattern from PrinterSetupViewModelTests).
  - `freeTextOnlyForAdminsAndDevelopers`.
  - `cutSendTestSendsJXBeforeTheFullLabel`: the recorded bytes are half-label, `~JX`, full label.
  - `reportCarriesEverything`: the share text contains the connection, printer details, every ask result, speed rows and the log.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** using the app's `SettingsRow`, `SectionTitle`, `Segmented`, `SecondaryButton`, `KioskType` and palette.
- [ ] **Step 4: Full test gate + phone build green.**
- [ ] **Step 5: Commit** `feat(ios): Settings › Troubleshooting for printers`.

---

### Task 6: Docs and the device pass

**Files:**
- Modify: `IOS_Kiosk_App/README.md` (Label printing: Bluetooth, the permission, Troubleshooting)
- Modify: `docs/superpowers/specs/2026-10-22-ios-bluetooth-printing-design.md` (an "Implementation notes" section: rulings made during the build, the device results)

- [ ] **Step 1:** Update the README's Label printing section (Bluetooth LE through CoreBluetooth, `NSBluetoothAlwaysUsageDescription`, finding by serial, Settings › Troubleshooting, the `~JX` clear).
- [ ] **Step 2: Device pass (controller, with Jimmy):** on the iPad Pro 13 with the office ZD421 — choose over Bluetooth, checks green, test labels, 10 scanned asset labels, font listing, a speed test, the Cut-send test (only the full label prints), leave idle and print again (reconnect), power-cycle the printer and print again, background the app and come back. Record results in the spec's implementation notes.
- [ ] **Step 3: Commit** `docs(ios): Bluetooth printing notes and README`.
