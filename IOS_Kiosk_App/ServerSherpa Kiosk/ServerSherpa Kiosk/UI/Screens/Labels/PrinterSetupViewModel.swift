import Foundation
import Observation
import os

/// The Peeler check's detail: what the printer said, and how labels print (PrinterStep's words).
func peelerDetail(present: Bool?, peel: Bool) -> String {
    let mode = peel ? "printing in peel-off mode" : "printing in tear-off mode"
    switch present {
    case true?: return "Peeler detected · \(mode)"
    case false?: return "No peeler · \(mode)"
    case nil: return "Printer doesn't report a peeler · \(mode)"
    }
}

/// "ZD421 · Serial XYZ · 203 DPI", or what to say when the printer wouldn't.
func foundDetails(_ p: FoundPrinter) -> String {
    let text = [p.model, p.serial.map { "Serial \($0)" }, p.dpi.map { "\($0) DPI" }].compactMap { $0 }.joined(separator: " · ")
    return text.isEmpty ? "Didn't say what it is" : text
}

/// "8 dots ≈ 1 mm at 203 DPI." (the offset fields' hint; Kotlin's `Math.round`).
func offsetHint(dpi: Int) -> String {
    "\(Int((Double(dpi) / 25.4 + 0.5).rounded(.down))) dots ≈ 1 mm at \(dpi) DPI."
}

/// The checks, in the order they run (the web kiosk's PrinterStep rows).
enum CheckKey: Int, CaseIterable, Sendable {
    case answers, dpi, status, peeler, fonts

    var label: String {
        switch self {
        case .answers: "Printer answers"
        case .dpi: "DPI matches the templates"
        case .status: "Ready to print"
        case .peeler: "Peeler"
        case .fonts: "Fonts installed"
        }
    }
}

/// WARN informs (amber); FAIL is something to fix (red). Neither blocks anything.
enum CheckState: Sendable { case running, ok, warn, fail }

struct CheckRow: Equatable, Sendable {
    var key: CheckKey
    var state: CheckState
    var detail: String? = nil
    var notes: [String] = []
}

enum TestLabel: Sendable { case alignment, sample }

/// The alignment label's size: `widthIn` x `heightIn` inches at `dpi`.
struct AlignmentSize: Equatable, Sendable {
    var widthIn: Double
    var heightIn: Double
    var dpi: Int

    var widthDots: Int { Int((widthIn * Double(dpi)).rounded()) }
    var heightDots: Int { Int((heightIn * Double(dpi)).rounded()) }
    /// "4x2", "2.25x1.5".
    var label: String { "\(Self.inches(widthIn))x\(Self.inches(heightIn))" }

    private static func inches(_ v: Double) -> String { v == v.rounded(.down) ? String(Int64(v)) : String(v) }
}

/// The picked template's size, else 4x2 for Top and 2x1 for Front (the web kiosk's test labels).
func alignmentSizeFor(kind: LabelKind, dpi: Int, pick: LabelPick?) -> AlignmentSize {
    if let pick, pick.kind == kind, pick.dpi == dpi, let w = pick.widthIn, let h = pick.heightIn {
        return AlignmentSize(widthIn: w, heightIn: h, dpi: dpi)
    }
    return kind == .front ? AlignmentSize(widthIn: 2, heightIn: 1, dpi: dpi) : AlignmentSize(widthIn: 4, heightIn: 2, dpi: dpi)
}

/// How the operator is finding a printer: a network scan, a typed IP, or a Bluetooth scan (nil
/// until one is picked).
enum PrinterFindMode: Sendable { case scan, ip, bluetooth }

struct PrinterSetupUi: Equatable {
    var findMode: PrinterFindMode? = nil
    var scanning = false
    /// Nil until a scan finishes.
    var found: [FoundPrinter]? = nil
    var scanMessage: String? = nil
    var ipText = ""
    /// The host being identified and saved, or the Bluetooth printer's identifier (`uuidString`).
    var choosing: String? = nil
    var chooseError: String? = nil
    /// Every named device the Bluetooth scan heard, strongest first: nil until a scan starts.
    var bluetoothFound: [FoundBluetoothPrinter]? = nil
    var bluetoothScanning = false
    /// Under the Bluetooth list: Bluetooth off or not allowed, or no Zebra heard.
    var bluetoothMessage: String? = nil
    /// Bluetooth couldn't be used (off, not allowed, missing), as the last scan, choice or check
    /// found; nil when it could.
    var bluetoothUnavailable: BluetoothAvailability? = nil
    /// The printer forgot this iPad: the steps to fix it (the screen adds Open Settings and Connect).
    var pairingLost: String? = nil
    var checks: [CheckRow] = []
    var checking = false
    /// How many check runs have finished.
    var checkRuns = 0
    var fontFix: FontFix? = nil
    /// The fonts on the printer at the wrong size (upper-case): Install sends them again.
    var damagedFonts: [String] = []
    var installing = false
    /// Cancel was tapped: the font going out finishes, then the install stops.
    var installStopping = false
    /// The font going out: its name, and which of how many it is.
    var installFont: InstallingFont? = nil
    /// While a font is going out: how much of it has (0…1), and about how long it has left.
    var installProgress: Double? = nil
    var installEta: String? = nil
    var fontMessage: String? = nil
    var fontError = false
    /// What the peeler check found: true, false, or nil (unknown or not checked).
    var peeler: Bool? = nil
    var offsetXText = "0"
    var offsetYText = "0"
    var testing = false
    var testMessage: String? = nil
    var testError = false
    /// The test label's message is Bluetooth not allowed, or a printer that forgot this iPad: the
    /// sheet offers Settings.
    var testBluetoothSettings = false
    /// The test label's message is a printer that forgot this iPad: the sheet offers Connect too.
    var testPairingLost = false

    /// Peel-off can be chosen unless the printer said it has no peeler.
    var peelAllowed: Bool { peeler != false }
    var busy: Bool { choosing != nil || installing || testing }
    /// The scan message reads as an error (red).
    var scanError: Bool { scanMessage == SCAN_FAILED_TEXT || scanMessage == LOCAL_NETWORK_DENIED_TEXT }
    /// A message the main screen shows says iOS kept the kiosk off the local network (the scan,
    /// twice, see `scan()`; choosing a printer; its Answers check): the screen offers Settings.
    var localNetworkDenied: Bool {
        scanMessage == LOCAL_NETWORK_DENIED_TEXT || chooseError == LOCAL_NETWORK_PRINTER_DENIED_TEXT
            || checks.contains { $0.detail == LOCAL_NETWORK_PRINTER_DENIED_TEXT }
    }
    /// The test label sheet's own message says so: the sheet offers Settings.
    var testLocalNetworkDenied: Bool { testMessage == LOCAL_NETWORK_PRINTER_DENIED_TEXT }
    /// "Installing ROBOTO.TTF (1 of 3)…" (no count for a single font), "Stopping after ROBOTO.TTF…".
    var installStatus: String {
        guard let font = installFont else { return installStopping ? "Stopping…" : "Installing fonts…" }
        if installStopping { return "Stopping after \(font.name)…" }
        return font.count > 1 ? "Installing \(font.name) (\(font.number) of \(font.count))…" : "Installing \(font.name)…"
    }
    /// The Bluetooth list's Zebras (named like a Zebra serial, or advertising Zebra), strongest first.
    var bluetoothZebras: [FoundBluetoothPrinter] { (bluetoothFound ?? []).filter(\.isZebra) }
    /// Every other named device the scan heard, strongest first.
    var bluetoothOthers: [FoundBluetoothPrinter] { (bluetoothFound ?? []).filter { !$0.isZebra } }
    /// The Bluetooth message reads as an error (red).
    var bluetoothError: Bool { bluetoothMessage != nil && bluetoothMessage != NO_BLUETOOTH_PRINTERS_TEXT }
    /// Bluetooth isn't allowed for the kiosk (the scan, choosing a printer, its Answers check), or a
    /// printer forgot this iPad: the main screen offers Settings.
    var offersBluetoothSettings: Bool {
        bluetoothMessage == BLUETOOTH_DENIED_TEXT || checks.contains { $0.detail == BLUETOOTH_DENIED_TEXT } || pairingLost != nil
    }
}

let NO_PRINTERS_FOUND_TEXT = "No Zebra printers found on this network."
let NO_BLUETOOTH_PRINTERS_TEXT = "No Zebra printers found nearby."
let NO_BLUETOOTH_SERIAL_TEXT = "This printer didn't report a serial number, so it can't be saved over Bluetooth."
let SCAN_FAILED_TEXT = "Couldn't scan the network."
let INVALID_IP_TEXT = "That isn't a valid IP address."
let NO_PEELER_TEXT = "This printer has no peeler."
let FONTS_INSTALLED_TEXT = "Fonts installed."
/// "No Zebra printer answered at 10.0.0.5." / "No Zebra printer answered over Bluetooth as D8J224508535."
func noZebraAnswerText(_ connection: PrinterConnection) -> String {
    switch connection {
    case .network(let host): "No Zebra printer answered at \(host)."
    case .bluetooth(let serial, _): "No Zebra printer answered over Bluetooth as \(serial)."
    }
}
func fontInstallFailedText(_ name: String) -> String { "Couldn't install \(name)." }

/// "about 40 s left", "about 4 min left": the time `remainingBytes` take at `bytesPerSecond`;
/// nil when nothing is left (or no rate is known).
func installEtaText(remainingBytes: Int, bytesPerSecond: Double) -> String? {
    guard remainingBytes > 0, bytesPerSecond > 0 else { return nil }
    let seconds = (Double(remainingBytes) / bytesPerSecond).rounded(.up)
    if seconds < 60 { return "about \(Int(seconds)) s left" }
    return "about \(Int((seconds / 60).rounded())) min left"
}

/// "Strong signal (-52 dBm)": a Bluetooth device's signal in words (strong from -65 dBm, fair from
/// -80), or "Signal unknown" when iOS gave no reading.
func bluetoothSignalText(rssi: Int) -> String {
    guard rssi < 0, rssi > -127 else { return "Signal unknown" }
    let words = rssi >= -65 ? "Strong" : (rssi >= -80 ? "Fair" : "Weak")
    return "\(words) signal (\(rssi) dBm)"
}

/// The font button: "Install 2 missing fonts", "Reinstall 1 damaged font", or both ("Install 1
/// missing font, reinstall 1 damaged font"). `damaged` names (upper-case) the fonts on the printer
/// at the wrong size; the rest of `installable` are missing.
func fontInstallButtonText(installable: [KioskLabelFont], damaged: [String]) -> String {
    func fonts(_ n: Int, _ kind: String) -> String { "\(n) \(kind) font\(n == 1 ? "" : "s")" }
    let reinstall = installable.filter { damaged.contains($0.name.uppercased()) }.count
    let install = installable.count - reinstall
    if reinstall == 0 { return "Install \(fonts(install, "missing"))" }
    if install == 0 { return "Reinstall \(fonts(reinstall, "damaged"))" }
    return "Install \(fonts(install, "missing")), reinstall \(fonts(reinstall, "damaged"))"
}

/// A font install's font going out: its name and which of how many it is.
struct InstallingFont: Equatable, Sendable {
    var name: String
    var number: Int
    var count: Int
}

/// No synced file for a font the library lists.
private struct FontFileMissing: Error {}

/// A Bluetooth printer whose Device Information gave no serial: it couldn't be found again by it.
private struct NoBluetoothSerial: Error {}

/**
 Printer Setup (Android's PrinterSetupViewModel, the laptop's PrinterStep in
 kiosk/src/components/setup/PrinterStep.tsx): pick a Zebra (a network scan, a typed IP, or a
 Bluetooth scan), check it, install missing or damaged fonts, print test labels, and set the
 offsets and peel/tear. Choosing a printer saves it; the label builder rebuilds by itself when its
 DPI changes, and offsets and peel never rebuild (they apply at send time).

 Bluetooth (D9–D11): the first Bluetooth scan asks iOS for permission. Picking a printer from the
 list connects to it by the iPad's identifier for it, asks `~HI` for its model and DPI, saves it by
 its serial (Device Information's, else its Bluetooth name) and checks it. Bluetooth off or not
 allowed says so; a printer that forgot this iPad gets the Forget This Device steps, and Connect
 tries again once that's done.

 The checks inform and never block, and run only when the operator saves a printer or taps
 Check printer / Check again: nothing is checked on appear, polled, or checked on the print path.
 The DPI and font checks read the builder's own template pick for the saved printer, waiting for
 the build a DPI change starts (an unsynced kiosk, a failed build and an unsupported device answer
 at once).

 Every call to a printer goes through the container's `PrinterLock` and `PrinterGuard`, shared
 with Print Labels' queue: one connection to the printer at a time, app-wide, a `~JX` before the
 next send after a failed one, and no sends after a cut font install until a check gets an answer.

 iOS only: the first scan can run while the system's "Allow Local Network" prompt is on screen and
 come back denied, so a denied scan runs once more when the app is back in front (scene phase
 `.active`, told through `scenePhaseChanged`): when it comes back, or 2 s after the denial if it
 is in front then. A timer that ends while the prompt is still up (the scene isn't active) waits
 for `.active` instead. Only a second denial says so; and with that message showing, coming back
 to the app (from Settings, Local Network turned on) scans once more.
 */
@MainActor @Observable
final class PrinterSetupViewModel {
    nonisolated static let DEFAULT_MODEL = "Zebra"
    /// How long a printer gets to file a downloaded font before the re-check (PrinterStep's).
    nonisolated static let FONT_SETTLE: Duration = .milliseconds(500)
    nonisolated static let OFFSET_SAVE_DELAY: Duration = .milliseconds(500)
    /// How long the DPI check waits for the build a DPI change starts to pick a template.
    nonisolated static let PICK_WAIT: Duration = .seconds(30)
    /// A denied scan runs again after this long if the app hasn't come back to the front first.
    nonisolated static let RESCAN_FALLBACK: Duration = .seconds(2)
    nonisolated static let OFFSET_LIMIT = 9_999
    /// What a Bluetooth font install's time left is reckoned at until its bytes have been moving for
    /// `ETA_MEASURE_AFTER`: the Bluetooth speed measured on a ZD421 (3.9 KB/s). A network install
    /// shows no time left until then (a font usually goes out within a second).
    nonisolated static let INSTALL_BYTES_PER_SECOND: Double = 3_900
    nonisolated static let ETA_MEASURE_AFTER: Duration = .seconds(1)

    nonisolated static let TEMPLATES_UNKNOWN_TEXT = "Couldn't read the move's label templates. Check again in a moment."
    nonisolated static let SYNC_TO_CHECK_TEXT = "Sync this kiosk to check its label templates."
    nonisolated static let FONTS_UNCHECKED_TEXT = "Fonts can't be checked until the move's label templates are known."
    nonisolated static let TEST_TIMEOUT_TEXT = "The printer didn't take the test label in time."
    nonisolated static let TEST_FAILED_TEXT = "Couldn't make the test label. Try again."

    nonisolated static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "labels")

    private(set) var ui = PrinterSetupUi()
    /// The saved label settings (Observation follows them through the prefs).
    var settings: LabelSettings { settingsStore.current() }
    /// The builder's template pick (its name and size for the test labels).
    var currentPick: LabelPick? { build.pick }

    @ObservationIgnored private let settingsStore: LabelSettingsStore
    @ObservationIgnored private let build: LabelBuildMonitor
    @ObservationIgnored private let engine: LabelEngine
    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let fontsDir: URL?
    @ObservationIgnored private let scanner: @Sendable () async throws -> ZebraScanResult
    @ObservationIgnored private let bluetooth: BluetoothPrinting
    @ObservationIgnored private let printerAt: @MainActor (SavedPrinter) -> SetupZebra
    /// A printer being chosen, before it is saved: under the lock and the guard (a pending clear
    /// still goes first), but its answer never lifts a cut font's stop (the check after saving does).
    @ObservationIgnored private let unsavedPrinterAt: @MainActor (SavedPrinter) -> SetupZebra
    @ObservationIgnored private let printerGuard: PrinterGuard
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> ContinuousClock.Instant
    @ObservationIgnored private let pickWait: Duration
    @ObservationIgnored private var scanTask: Task<Void, Never>?
    @ObservationIgnored private var bluetoothScanTask: Task<Void, Never>?
    /// Bumped by each Bluetooth scan: only the latest one writes when it ends.
    @ObservationIgnored private var bluetoothScanRun = 0
    /// When the Bluetooth scan started, and whether Stop ended it: only a scan that ran its full
    /// length or was stopped says it found no Zebra.
    @ObservationIgnored private var bluetoothScanStarted = ContinuousClock.now
    @ObservationIgnored private var bluetoothStopTapped = false
    /// What Connect (beside the pairing-lost steps) tries again.
    @ObservationIgnored private var pairingRetry: PairingRetry?
    @ObservationIgnored private var chooseTask: Task<Void, Never>?
    @ObservationIgnored private var checksTask: Task<Void, Never>?
    /// Bumped by each check run: only the latest one writes the rows.
    @ObservationIgnored private var checkRun = 0
    @ObservationIgnored private var offsetsTask: Task<Void, Never>?
    /// Cancel was tapped during a font install: checked between fonts only.
    @ObservationIgnored private var installCancelled = false
    /// The font going out: only its progress is shown.
    @ObservationIgnored private var fontGoingOut: FontGoingOut?
    /// The bytes per second this install measured so far: the next font's guess until it measures its own.
    @ObservationIgnored private var installRate: Double?
    @ObservationIgnored private var fontsStarted = 0
    @ObservationIgnored private var rescanWait: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var rescanTimer: Task<Void, Never>?
    /// The scene phase is `.active` (the screen reports every phase, the first included).
    @ObservationIgnored private var sceneActive = true
    @ObservationIgnored private var closed = false

    /// `bluetooth` finds and connects Bluetooth printers (the container's `ZebraBluetooth`).
    /// `zebraFor` is a printer the way its connection reaches it (`AppContainer.zebra(for:)` on
    /// the device); every call to it is made under `printerLock` and `printerGuard`. `fontsDir`
    /// holds the synced font files (`Sync.defaultFontsDir`). `now` times font installs.
    init(settings: LabelSettingsStore, build: LabelBuildMonitor, engine: LabelEngine, store: KioskStore, fontsDir: URL?,
         scanner: @escaping @Sendable () async throws -> ZebraScanResult,
         bluetooth: BluetoothPrinting,
         zebraFor: @escaping @MainActor (SavedPrinter) -> SetupZebra,
         printerLock: PrinterLock,
         printerGuard: PrinterGuard,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
         pickWait: Duration = PrinterSetupViewModel.PICK_WAIT) {
        self.settingsStore = settings
        self.build = build
        self.engine = engine
        self.store = store
        self.fontsDir = fontsDir
        self.scanner = scanner
        self.bluetooth = bluetooth
        self.printerAt = { printer in
            LockedZebra(inner: zebraFor(printer), connection: printer.connection, lock: printerLock, guard: printerGuard)
        }
        self.unsavedPrinterAt = { printer in
            LockedZebra(inner: zebraFor(printer), connection: printer.connection, lock: printerLock, guard: printerGuard, liftsStop: false)
        }
        self.printerGuard = printerGuard
        self.sleep = sleep
        self.now = now
        self.pickWait = pickWait
        // The saved offsets fill the fields.
        let s = settings.current()
        ui.offsetXText = String(s.offsetX)
        ui.offsetYText = String(s.offsetY)
    }

    /// The screen went away: scans, identifying and checks stop (their queries are cancelled). A
    /// test label or font install already going out finishes, and an offsets edit still waiting
    /// for its save is kept.
    func close() {
        closed = true
        scanTask?.cancel()
        endBluetoothScan()
        chooseTask?.cancel()
        checksTask?.cancel()
        wakeRescan()
    }

    /// The screen is showing (again): the operator's actions work.
    func open() { closed = false }

    // MARK: Choosing a printer

    /// The Scan network card (and Scan again): scan mode, and a scan. A Bluetooth scan stops, and
    /// its message goes (it isn't shown in scan mode).
    func scan() {
        leaveBluetooth()
        ui.findMode = .scan
        startScan(retryDenied: true)
    }

    /// The Enter IP card: IP mode. A scan still running stops, and its message goes with it
    /// (it isn't shown in IP mode).
    func enterIp() {
        guard ui.findMode != .ip else { return }
        ui.findMode = .ip
        endNetworkScan()
        leaveBluetooth()
    }

    /// A network scan still running stops (a denied one's rescan too), and its message goes.
    private func endNetworkScan() {
        scanTask?.cancel()
        wakeRescan()
        ui.scanMessage = nil
    }

    /// `retryDenied`: a denial is scanned once more after the prompt (see the type's notes).
    private func startScan(retryDenied: Bool) {
        guard !ui.scanning, !closed else { return }
        ui.scanning = true
        ui.scanMessage = nil
        scanTask = Task { await self.runScan(retryDenied: retryDenied) }
    }

    private func runScan(retryDenied: Bool) async {
        var result: ZebraScanResult?
        do {
            result = try await scanner()
            if retryDenied && result?.localNetworkDenied == true {
                // Maybe answered under the system's Local Network prompt: once more, after it.
                await waitToRescan()
                try Task.checkCancellation()
                result = try await scanner()
            }
        } catch is CancellationError {
            ui.scanning = false
            return
        } catch {
            Self.log.warning("printer scan failed: \(String(describing: error), privacy: .private)")
            result = nil
        }
        // Stopped (Enter IP, or the screen closed) after the scanner answered: say nothing.
        if Task.isCancelled {
            ui.scanning = false
            return
        }
        let denied = result?.localNetworkDenied == true
        ui.scanning = false
        ui.found = result?.printers ?? []
        ui.scanMessage = if let result {
            denied ? result.message : (result.printers.isEmpty ? NO_PRINTERS_FOUND_TEXT : nil)
        } else {
            SCAN_FAILED_TEXT
        }
    }

    /// Until the app comes back to the front, or `RESCAN_FALLBACK` passes with it in front.
    private func waitToRescan() async {
        let sleep = self.sleep
        await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                rescanWait = c
                rescanTimer = Task { [weak self] in
                    do { try await sleep(Self.RESCAN_FALLBACK) } catch { return }
                    self?.fallbackEnded()
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.wakeRescan() }
        }
    }

    /// The 2 s passed: rescan now if the app is in front; under the prompt, the wait goes on
    /// until `.active` (`scenePhaseChanged`).
    private func fallbackEnded() {
        rescanTimer = nil
        if sceneActive { wakeRescan() }
    }

    private func wakeRescan() {
        rescanTimer?.cancel()
        rescanTimer = nil
        rescanWait?.resume()
        rescanWait = nil
    }

    /// Every scene phase, the first included (`active` is `.active`). Coming back to the front
    /// runs a denied scan's waiting rescan, or, with the denied message showing, scans once more
    /// (back from Settings). The same for Bluetooth: with Bluetooth off or not allowed showing,
    /// coming back (from Settings or Control Center) scans for Bluetooth printers once more.
    /// Nothing else starts here.
    func scenePhaseChanged(active: Bool) {
        let cameBack = active && !sceneActive
        sceneActive = active
        guard cameBack else { return }
        if rescanWait != nil {
            wakeRescan()
        } else if ui.findMode == .scan && ui.scanMessage == LOCAL_NETWORK_DENIED_TEXT && !ui.scanning {
            startScan(retryDenied: false)
        } else if ui.findMode == .bluetooth && ui.bluetoothUnavailable != nil && !ui.bluetoothScanning {
            startBluetoothScan()
        }
    }

    // MARK: Bluetooth

    /// The Bluetooth card (and Scan again): Bluetooth mode, and a scan of the printers nearby (the
    /// first asks iOS for Bluetooth permission). A network scan still running stops, and its
    /// message goes (it isn't shown in Bluetooth mode).
    func scanBluetooth() {
        guard !closed else { return }
        if ui.findMode != .bluetooth {
            ui.findMode = .bluetooth
            endNetworkScan()
        }
        startBluetoothScan()
    }

    /// Stop: the scan ends, and what it heard stays listed.
    func stopBluetoothScan() {
        if ui.bluetoothScanning { bluetoothStopTapped = true }
        bluetooth.stopScan()
    }

    private func startBluetoothScan() {
        guard !ui.bluetoothScanning, !closed else { return }
        bluetoothScanRun += 1
        let run = bluetoothScanRun
        ui.bluetoothScanning = true
        ui.bluetoothFound = []
        ui.bluetoothMessage = nil
        ui.bluetoothUnavailable = nil
        clearPairingLost()
        bluetoothScanStarted = now()
        bluetoothStopTapped = false
        let heard = bluetooth.scan()
        bluetoothScanTask = Task { await self.runBluetoothScan(heard, run: run) }
    }

    /// Lists what the scan hears until it ends (30 s, Stop, Bluetooth refused, or another Bluetooth
    /// call taking the radio), then says why nothing is listed: no Zebra heard only after its full
    /// 30 s or Stop. One stopped by the screen (another mode, a choice, closing) says nothing.
    private func runBluetoothScan(_ heard: AsyncStream<[FoundBluetoothPrinter]>, run: Int) async {
        for await list in heard where run == bluetoothScanRun { ui.bluetoothFound = list }
        guard run == bluetoothScanRun else { return }
        bluetoothScanTask = nil
        ui.bluetoothScanning = false
        let availability = bluetooth.availability
        if let text = bluetoothUnavailableText(availability) {
            ui.bluetoothUnavailable = availability
            ui.bluetoothMessage = text
        } else if ui.bluetoothZebras.isEmpty
                    && (bluetoothStopTapped || now() - bluetoothScanStarted >= .seconds(ZebraBluetoothSpec.scanDuration)) {
            ui.bluetoothMessage = NO_BLUETOOTH_PRINTERS_TEXT
        }
    }

    /// Another way to find a printer was picked: the Bluetooth scan stops, and its message goes.
    private func leaveBluetooth() {
        endBluetoothScan()
        ui.bluetoothMessage = nil
        ui.bluetoothUnavailable = nil
    }

    /// The scan stops quietly, keeping its list (the screen moved on).
    private func endBluetoothScan() {
        guard let task = bluetoothScanTask else { return }
        bluetoothScanTask = nil
        bluetoothScanRun += 1
        task.cancel()
        ui.bluetoothScanning = false
    }

    /// Saves the Bluetooth printer picked from the list (D9), then checks it.
    func chooseBluetooth(_ printer: FoundBluetoothPrinter) {
        guard !ui.busy, !closed else { return }
        endBluetoothScan()
        beginChoosing(printer.id.uuidString)
        chooseTask = Task { await self.runChooseBluetooth(printer) }
    }

    /// Connect, beside the pairing-lost steps (once the printer is forgotten in Settings; on the
    /// screen or in the test label sheet): the same printer again, or the saved printer's checks.
    /// Checks that reach the printer clear the sheet's steps.
    func connectAgain() {
        switch pairingRetry {
        case .choose(let printer)?: chooseBluetooth(printer)
        case .check?: checkAgain()
        case nil: break
        }
    }

    /// Connects by the iPad's identifier (any serial: Device Information's is the one saved; a
    /// printer that gives none is refused, as it couldn't be found again), asks `~HI` under the
    /// lock and the guard as a network choice does, and saves the printer with that model and DPI.
    /// A choice that fails or is left after the link came up lets that printer go unless it is the
    /// saved one, so an unsaved printer isn't held from other devices.
    private func runChooseBluetooth(_ found: FoundBluetoothPrinter) async {
        let saved: SavedPrinter
        var linked = false
        var chosen: PrinterIdentity?
        do {
            let info = try await bluetooth.connect(peripheralId: found.id, serial: nil)
            linked = true
            guard let serial = info.serial, !Self.blank(serial) else { throw NoBluetoothSerial() }
            let connection = PrinterConnection.bluetooth(serial: serial, peripheralId: info.peripheralId)
            chosen = connection.identity
            let id = try await unsavedPrinterAt(SavedPrinter(connection: connection, model: Self.DEFAULT_MODEL, serial: serial, dpi: 0)).identify()
            try Task.checkCancellation()
            saved = SavedPrinter(connection: connection, model: Self.blank(id.model) ? Self.DEFAULT_MODEL : id.model, serial: serial, dpi: id.dpi)
        } catch {
            ui.choosing = nil
            if linked && (chosen == nil || settingsStore.current().printer?.connection.identity != chosen) { bluetooth.close() }
            if error is CancellationError { return }
            if error is NoBluetoothSerial {
                ui.chooseError = NO_BLUETOOTH_SERIAL_TEXT
            } else if let text = noteBluetoothRefusal(error, retry: .choose(found)) {
                if !(bluetoothRefusal(error) is BluetoothPairingLost) { ui.bluetoothMessage = text }
            } else {
                Self.log.warning("bluetooth printer not chosen: \(String(describing: error), privacy: .private)")
                ui.chooseError = (error as? BluetoothNotZebra)?.errorDescription
                    ?? noZebraAnswerText(.bluetooth(serial: found.name, peripheralId: found.id))
            }
            return
        }
        settingsStore.setPrinter(saved)
        ui.choosing = nil
        startChecks(saved)
    }

    /// A Bluetooth failure the crew fixes on the iPad (`bluetoothRefusal`): notes Bluetooth off or
    /// not allowed (`bluetoothUnavailable`), or a printer that forgot this iPad (`pairingLost`,
    /// which Connect tries again with `retry`), and returns what to tell them; nil for any other.
    private func noteBluetoothRefusal(_ error: Error, retry: PairingRetry) -> String? {
        guard let refusal = bluetoothRefusal(error), let text = refusal.errorDescription else { return nil }
        if let off = refusal as? BluetoothUnavailable { ui.bluetoothUnavailable = off.availability }
        if refusal is BluetoothPairingLost {
            ui.pairingLost = text
            pairingRetry = retry
        }
        return text
    }

    private func clearPairingLost() {
        ui.pairingLost = nil
        pairingRetry = nil
    }

    func setIpText(_ text: String) {
        ui.ipText = text
        ui.chooseError = nil
    }

    func useIp() {
        let ip = kotlinTrimmed(ui.ipText)
        guard isIpv4(ip) else {
            ui.chooseError = INVALID_IP_TEXT
            return
        }
        choosePrinter(host: ip, found: nil)
    }

    func choose(_ printer: FoundPrinter) { choosePrinter(host: printer.host, found: printer) }

    /// Saves the printer at `host` (asked `~HI` first when `found` doesn't know its DPI), then checks it.
    private func choosePrinter(host: String, found: FoundPrinter?) {
        guard !ui.busy, !closed else { return }
        beginChoosing(host)
        chooseTask = Task { await self.runChoose(host: host, found: found) }
    }

    /// A printer is being chosen (`key` names it in `ui.choosing`): what was shown for the last one goes.
    private func beginChoosing(_ key: String) {
        cancelChecks()
        ui.choosing = key
        ui.chooseError = nil
        ui.checks = []
        ui.checking = false
        ui.fontFix = nil
        ui.damagedFonts = []
        ui.fontMessage = nil
        ui.peeler = nil
        ui.testMessage = nil
        ui.bluetoothMessage = nil
        ui.bluetoothUnavailable = nil
        clearPairingLost()
    }

    private func runChoose(host: String, found: FoundPrinter?) async {
        let saved: SavedPrinter
        do {
            if let found, let dpi = found.dpi {
                saved = SavedPrinter(host: host, model: found.model ?? Self.DEFAULT_MODEL, serial: found.serial ?? "", dpi: dpi)
            } else {
                // Addresses the printer for its `~HI`; what is saved is built from the answers.
                let zebra = unsavedPrinterAt(SavedPrinter(host: host, model: Self.DEFAULT_MODEL, serial: "", dpi: 0))
                let id = try await zebra.identify()
                let serial: String?
                if let known = found?.serial { serial = known } else { serial = try await quietly { try await zebra.serial() } ?? nil }
                saved = SavedPrinter(host: host, model: Self.blank(id.model) ? Self.DEFAULT_MODEL : id.model, serial: serial ?? "", dpi: id.dpi)
            }
            try Task.checkCancellation()
        } catch is CancellationError {
            ui.choosing = nil
            return
        } catch {
            ui.choosing = nil
            ui.chooseError = wasLocalNetworkDenied(error) ? LOCAL_NETWORK_PRINTER_DENIED_TEXT : noZebraAnswerText(.network(host: host))
            return
        }
        settingsStore.setPrinter(saved)
        ui.choosing = nil
        startChecks(saved)
    }

    // MARK: The checks

    func checkAgain() {
        guard !ui.busy, let printer = settingsStore.current().printer else { return }
        startChecks(printer)
    }

    private func cancelChecks() {
        checksTask?.cancel()
        checkRun += 1
    }

    private func startChecks(_ printer: SavedPrinter, keepFontMessage: Bool = false) {
        guard !closed else { return }
        cancelChecks()
        let run = checkRun
        ui.checks = []
        ui.checking = true
        ui.fontFix = nil
        ui.damagedFonts = []
        ui.peeler = nil
        ui.bluetoothUnavailable = nil
        clearPairingLost()
        if !keepFontMessage {
            ui.fontMessage = nil
            ui.fontError = false
        }
        checksTask = Task { await self.runChecks(printer, run: run) }
    }

    private func runChecks(_ saved: SavedPrinter, run: Int) async {
        defer {
            if run == checkRun {
                ui.checking = false
                ui.checkRuns += 1
                // The printer no longer says it forgot this iPad: the test label sheet's steps go.
                if ui.testPairingLost && ui.pairingLost == nil { clearTestMessage() }
            }
        }
        // Ends early (cancelled, or replaced by a newer run) without touching the rows.
        try? await checks(saved, run: run)
    }

    /// Throws when this run was cancelled or replaced: it then writes nothing and asks nothing more.
    private func live(_ run: Int) throws {
        try Task.checkCancellation()
        if run != checkRun { throw CancellationError() }
    }

    private func put(_ row: CheckRow, _ run: Int) throws {
        try live(run)
        ui.checks = (ui.checks.filter { $0.key != row.key } + [row]).sorted { $0.key.rawValue < $1.key.rawValue }
    }

    private func checks(_ saved: SavedPrinter, run: Int) async throws {
        let zebra = printerAt(saved)
        try put(CheckRow(key: .answers, state: .running), run)
        let id: HostId
        switch try await attempt({ try await zebra.identify() }) {
        case .success(let answer): id = answer
        case .failure(let error):
            var detail = noZebraAnswerText(saved.connection)
            if wasLocalNetworkDenied(error) {
                detail = LOCAL_NETWORK_PRINTER_DENIED_TEXT
            } else if let text = noteBluetoothRefusal(error, retry: .check) {
                // Off or not allowed: say so here; a printer that forgot this iPad gets the steps above.
                if bluetoothRefusal(error) is BluetoothUnavailable { detail = text }
            } else if await printerGuard.state(for: saved.connection) == .fontCut {
                // Still waiting for the rest of a font: it needs the restart.
                detail = FONT_INSTALL_CUT_TEXT
            }
            try put(CheckRow(key: .answers, state: .fail, detail: detail), run)
            return
        }
        try put(CheckRow(key: .answers, state: .ok, detail: "\(id.model) · \(id.dpi) DPI"), run)
        var printer = saved
        let model = Self.blank(id.model) ? Self.DEFAULT_MODEL : id.model
        if id.dpi != saved.dpi || model != saved.model {
            // Another printer took this address: its DPI picks the template (the builder rebuilds).
            let serial = try await quietly { try await zebra.serial() } ?? nil
            try live(run)
            printer = SavedPrinter(connection: saved.connection, model: model, serial: serial ?? "", dpi: id.dpi)
            settingsStore.setPrinter(printer)
        }

        try put(CheckRow(key: .dpi, state: .running), run)
        let kind = settingsStore.current().kind
        // Unsynced, no build will pick a template: don't wait for one.
        let picked: PickWait = await synced() ? await awaitPick(kind: kind, dpi: printer.dpi) : .unsynced
        try put(dpiRow(picked, kind: kind, dpi: printer.dpi), run)

        try put(CheckRow(key: .status, state: .running), run)
        let problems = try await quietly { try await zebra.status() }.map(statusProblems)
        try put(problems.map { $0.isEmpty ? CheckRow(key: .status, state: .ok) : CheckRow(key: .status, state: .fail, detail: $0.joined(separator: " ")) }
            ?? CheckRow(key: .status, state: .fail, detail: "Couldn't read the printer's status."), run)

        try put(CheckRow(key: .peeler, state: .running), run)
        let peeler = try await quietly { try await zebra.peelerPresent() } ?? nil
        try live(run)
        ui.peeler = peeler
        // Peel-off on a printer without a peeler would hold every label: print tear-off.
        if peeler == false && settingsStore.current().peel { settingsStore.setPeel(false) }
        try put(CheckRow(key: .peeler, state: .ok, detail: peelerDetail(present: peeler, peel: settingsStore.current().peel)), run)

        try put(CheckRow(key: .fonts, state: .running), run)
        let pick: LabelPick? = if case .got(let p) = picked { p } else { nil }
        try put(try await fontsRow(zebra, pick, run), run)
    }

    private enum PickWait: Equatable {
        case got(LabelPick)
        case unsupported
        case unknown
        case unsynced
    }

    private struct PickState: Equatable, Sendable {
        var pick: LabelPick?
        var unsupported: Bool
    }

    /// The kiosk has the move's label data (the label build's own precondition).
    private func synced() async -> Bool {
        let meta = try? await store.meta()
        let context = try? await store.labelContext()
        return meta != nil && context != nil
    }

    /// The builder's pick for `kind` at `dpi`: a DPI just saved waits for the build it starts.
    private func awaitPick(kind: LabelKind, dpi: Int) async -> PickWait {
        let build = self.build
        let states = observationStream { PickState(pick: build.pick, unsupported: build.status.phase == .unsupportedDevice) }
        let wait = pickWait
        return await withTaskGroup(of: PickWait?.self) { group in
            group.addTask {
                for await s in states {
                    if s.unsupported { return .unsupported }
                    if let p = s.pick, p.kind == kind, p.dpi == dpi { return .got(p) }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: wait)
                return .unknown
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? .unknown
        }
    }

    private func dpiRow(_ picked: PickWait, kind: LabelKind, dpi: Int) -> CheckRow {
        switch picked {
        case .unsupported: return CheckRow(key: .dpi, state: .warn, detail: DEVICE_UNSUPPORTED_TEXT)
        case .unknown: return CheckRow(key: .dpi, state: .warn, detail: Self.TEMPLATES_UNKNOWN_TEXT)
        case .unsynced: return CheckRow(key: .dpi, state: .warn, detail: Self.SYNC_TO_CHECK_TEXT)
        case .got(let p):
            if !p.synced { return CheckRow(key: .dpi, state: .warn, detail: Self.SYNC_TO_CHECK_TEXT) }
            if p.failed { return CheckRow(key: .dpi, state: .warn, detail: BUILD_FAILED_TEXT) }
            if p.templateId != nil { return CheckRow(key: .dpi, state: .ok, detail: p.templateName ?? "\(dpi) DPI", notes: p.notes) }
            return CheckRow(key: .dpi, state: .warn, detail: noTemplateText(kind: kind, printerDpi: dpi, available: p.availableDpis), notes: p.notes)
        }
    }

    private func fontsRow(_ zebra: SetupZebra, _ pick: LabelPick?, _ run: Int) async throws -> CheckRow {
        guard let pick, pick.synced, !pick.failed else { return CheckRow(key: .fonts, state: .warn, detail: Self.FONTS_UNCHECKED_TEXT) }
        var needed: [String] = []
        for name in pick.fonts.map({ $0.uppercased() }) where !needed.contains(name) { needed.append(name) }
        if needed.isEmpty { return CheckRow(key: .fonts, state: .ok, detail: "No printer fonts needed.") }
        guard let onPrinter = try await quietly({ try await zebra.fontEntries() }) else {
            return CheckRow(key: .fonts, state: .fail, detail: "Couldn't read the fonts on the printer.")
        }
        let library = ((try? await store.labelFonts()) ?? []).map { KioskLabelFont(id: $0.id, name: $0.name, size: $0.size, resident: $0.resident) }
        try live(run)
        let missing = missingFonts(needed: needed, onPrinter: onPrinter.map(\.name))
        // A download cut short leaves a smaller file under the right name: sending it again
        // overwrites it.
        let damaged = damagedFonts(needed: needed, library: library, onPrinter: onPrinter)
        if missing.isEmpty && damaged.isEmpty { return CheckRow(key: .fonts, state: .ok) }
        let fix = fontFixFor(missing: missing + damaged, library: library)
        ui.fontFix = fix
        ui.damagedFonts = damaged
        let others = missing.filter { !fix.builtIn.contains($0) }
        let detail = [others.isEmpty ? nil : "Missing: \(others.joined(separator: ", ")).",
                      damaged.isEmpty ? nil : "Damaged: \(damaged.joined(separator: ", ")) (reinstall).",
                      fix.builtIn.isEmpty ? nil : builtInFontText(fix.builtIn)].compactMap { $0 }.joined(separator: " ")
        return CheckRow(key: .fonts, state: .fail, detail: detail)
    }

    /// Sends each missing or damaged font the library has (its synced file), then checks again
    /// after the printer has had `FONT_SETTLE` to file them. The first failure stops the installs;
    /// one that cut a font off (a cancellation after its bytes started included) says to restart
    /// the printer and checks nothing (the printer is waiting for the rest of the font).
    func installFonts() {
        guard let fix = ui.fontFix, !ui.busy, !fix.installable.isEmpty else { return }
        ui.installing = true
        ui.installStopping = false
        ui.installEta = nil
        ui.fontMessage = nil
        ui.fontError = false
        installCancelled = false
        installRate = nil
        Task { await self.runInstall(fix) }
    }

    /// Stops a font install after the font going out: a download announces its size, so cutting
    /// one would leave the printer taking whatever comes next as font data (D8).
    func cancelInstall() {
        guard ui.installing else { return }
        installCancelled = true
        ui.installStopping = true
    }

    private func endInstall() {
        ui.installing = false
        ui.installStopping = false
    }

    private func runInstall(_ fix: FontFix) async {
        guard let printer = settingsStore.current().printer else {
            endInstall()
            return
        }
        let zebra = printerAt(printer)
        var failed: String?
        var cut = false
        var stopped = false
        var files: [String: LabelFontRow] = [:]
        for row in (try? await store.labelFonts()) ?? [] { files[row.name.uppercased()] = row }
        // Each font's size (the library's), for the time left across the fonts still to send.
        let sizes = fix.installable.map { max(files[$0.name.uppercased()]?.size ?? 0, 0) }
        for (index, font) in fix.installable.enumerated() {
            if installCancelled {
                stopped = true
                break
            }
            let name = font.name.uppercased()
            ui.installFont = InstallingFont(name: name, number: index + 1, count: fix.installable.count)
            do {
                guard let fontsDir, let fileName = files[name]?.fileName else { throw FontFileMissing() }
                let bytes = try await Self.readFont(fontsDir.appendingPathComponent(fileName))
                let progress = fontStarted(overBluetooth: printer.isBluetooth, bytesAfter: sizes[(index + 1)...].reduce(0, +))
                try await zebra.installFont(name: name, bytes: bytes, progress: progress)
                fontFinished()
            } catch {
                let canceled = error is CancellationError
                if !canceled {
                    Self.log.warning("font install failed: \(name, privacy: .public): \(String(describing: error), privacy: .private)")
                    failed = name
                }
                cut = await printerGuard.state(for: printer.connection) == .fontCut
                // Canceled before its bytes went out: nothing to say.
                if canceled && !cut {
                    fontsDone()
                    endInstall()
                    return
                }
                break
            }
        }
        fontsDone()
        if cut {
            endInstall()
            ui.fontMessage = FONT_INSTALL_CUT_TEXT
            ui.fontError = true
            return
        }
        try? await sleep(Self.FONT_SETTLE)
        endInstall()
        if let failed {
            ui.fontMessage = fontInstallFailedText(failed)
        } else {
            // Stopped before the rest: the check shows what is still missing.
            ui.fontMessage = stopped ? nil : FONTS_INSTALLED_TEXT
        }
        ui.fontError = failed != nil
        // Fonts sent before a failure still turn green; the message stays.
        startChecks(printer, keepFontMessage: true)
    }

    /// A font starts going out: its progress from 0, and the callback its install reports through
    /// (from any thread; each report notes when it came, then hops here, and one that arrives after
    /// the font is done or behind a newer one is dropped).
    private func fontStarted(overBluetooth: Bool, bytesAfter: Int) -> @Sendable (_ sent: Int, _ total: Int) -> Void {
        fontsStarted += 1
        let id = fontsStarted
        fontGoingOut = FontGoingOut(id: id, overBluetooth: overBluetooth, bytesAfter: bytesAfter)
        ui.installProgress = 0
        let now = self.now
        // Held only while the font goes out (the install's own task holds the view model as long).
        return { sent, total in
            let at = now()
            Task { @MainActor in self.fontProgressed(id, sent: sent, total: total, at: at) }
        }
    }

    /// The time left covers this font's bytes still to go and every font after it. It is reckoned
    /// from the font's first report, when its bytes start moving (the wait for the printer lock and
    /// a `~JX` before it aren't install time), at the speed measured since then once that is
    /// `ETA_MEASURE_AFTER` old; until then at the speed an earlier font of this install measured,
    /// else a Bluetooth install guesses `INSTALL_BYTES_PER_SECOND` and a network install shows none.
    private func fontProgressed(_ id: Int, sent: Int, total: Int, at: ContinuousClock.Instant) {
        guard var going = fontGoingOut, going.id == id, total > 0 else { return }
        let fraction = min(max(Double(sent) / Double(total), 0), 1)
        guard fraction >= ui.installProgress ?? 0 else { return }
        let first = going.firstReport ?? (at, sent)
        going.firstReport = first
        fontGoingOut = going
        ui.installProgress = fraction
        let elapsed = at - first.at
        let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        if elapsed >= Self.ETA_MEASURE_AFTER && sent > first.sent { installRate = Double(sent - first.sent) / seconds }
        ui.installEta = guessedRate(going).flatMap { installEtaText(remainingBytes: total - sent + going.bytesAfter, bytesPerSecond: $0) }
    }

    /// The speed measured so far in this install, else Bluetooth's measured 3.9 KB/s (a network
    /// install has no guess).
    private func guessedRate(_ going: FontGoingOut) -> Double? {
        installRate ?? (going.overBluetooth ? Self.INSTALL_BYTES_PER_SECOND : nil)
    }

    /// The font's install returned: all of it went out (the time left is the fonts after it).
    private func fontFinished() {
        ui.installProgress = 1
        ui.installEta = fontGoingOut.flatMap { going in
            guessedRate(going).flatMap { installEtaText(remainingBytes: going.bytesAfter, bytesPerSecond: $0) }
        }
    }

    private func fontsDone() {
        fontGoingOut = nil
        ui.installProgress = nil
        ui.installEta = nil
        ui.installFont = nil
    }

    @concurrent nonisolated private static func readFont(_ url: URL) async throws -> Data {
        try Data(contentsOf: url)
    }

    // MARK: Offsets and peel

    func setOffsetX(_ text: String) { editOffsets { $0.offsetXText = text } }

    func setOffsetY(_ text: String) { editOffsets { $0.offsetYText = text } }

    /// The fields as saved numbers: clamped to the allowed range; text that isn't a number keeps
    /// the saved value.
    private func offsets() -> (x: Int, y: Int) {
        let saved = settingsStore.current()
        return (Self.parseOffset(ui.offsetXText) ?? saved.offsetX, Self.parseOffset(ui.offsetYText) ?? saved.offsetY)
    }

    /// Saved `OFFSET_SAVE_DELAY` after the last edit. The save doesn't need this view model, so
    /// one still waiting when the screen closes is kept.
    private func editOffsets(_ change: (inout PrinterSetupUi) -> Void) {
        change(&ui)
        let next = offsets()
        offsetsTask?.cancel()
        let sleep = self.sleep
        let store = settingsStore
        offsetsTask = Task {
            do { try await sleep(Self.OFFSET_SAVE_DELAY) } catch { return }
            if Task.isCancelled { return }
            store.setOffsets(x: next.x, y: next.y)
        }
    }

    /// Shows the fields as the numbers that are saved (a clamped or unreadable entry).
    func tidyOffsets() {
        let (x, y) = offsets()
        ui.offsetXText = String(x)
        ui.offsetYText = String(y)
    }

    func setPeel(_ peel: Bool) {
        if peel && !ui.peelAllowed { return }
        settingsStore.setPeel(peel)
        // The Peeler row says how labels print.
        let found = ui.peeler
        ui.checks = ui.checks.map { row in
            guard row.key == .peeler, row.state == .ok else { return row }
            var r = row
            r.detail = peelerDetail(present: found, peel: peel)
            return r
        }
    }

    // MARK: Test labels

    func alignmentSize() -> AlignmentSize? {
        let s = settings
        return s.printer.map { alignmentSizeFor(kind: s.kind, dpi: $0.dpi, pick: build.pick) }
    }

    /// Sends `which` to the saved printer with the offsets in the fields and the saved print mode.
    func printTest(_ which: TestLabel) {
        guard !ui.busy else { return }
        let offsets = offsets()
        ui.testing = true
        clearTestMessage()
        offsetsTask?.cancel()
        settingsStore.setOffsets(x: offsets.x, y: offsets.y)
        Task { await self.runTest(which, offsets: offsets) }
    }

    private func runTest(_ which: TestLabel, offsets: (x: Int, y: Int)) async {
        let s = settingsStore.current()
        guard let printer = s.printer else {
            ui.testing = false
            return
        }
        let message: String
        let isError: Bool
        var settingsOffered = false
        var forgotten = false
        do {
            let zpl: String?
            let text: String
            switch which {
            case .alignment:
                let size = alignmentSizeFor(kind: s.kind, dpi: printer.dpi, pick: build.pick)
                zpl = try parseZpl(try await helper("alignmentTestZpl", LabelGenArgs.alignment(
                    widthDots: size.widthDots, heightDots: size.heightDots, sizeLabel: size.label, dpi: printer.dpi)))
                text = "Alignment label (\(size.label)) sent to the printer."
            case .sample:
                let templates = LabelGenArgs.templatesBody(try await store.labelTemplates().map(\.json))
                let sample = try parseSample(try await helper("sampleLabel", LabelGenArgs.sample(templatesJson: templates, kind: s.kind, dpi: printer.dpi)))
                let name = build.pick.flatMap { $0.kind == s.kind && $0.dpi == printer.dpi ? $0.templateName : nil }
                zpl = sample.zpl
                text = sample.zpl == nil ? Self.sampleRefusedText(sample.reason)
                    : name.map { "Sample label (\($0)) sent to the printer." } ?? "Sample label sent to the printer."
            }
            if let zpl {
                let shifted = try parseZpl(try await helper("applyPrintSettings", LabelGenArgs.printSettings(zpl: zpl, offsetX: offsets.x, offsetY: offsets.y)))
                try await printerAt(printer).send(try parseZpl(try await helper("withPrintMode", LabelGenArgs.printMode(zpl: shifted, peel: s.peel))))
                (message, isError) = (text, false)
            } else {
                (message, isError) = (text, true)
            }
        } catch is CancellationError {
            ui.testing = false
            return
        } catch where LabelEngineError.isUnsupported(error) {
            (message, isError) = (DEVICE_UNSUPPORTED_TEXT, true)
        } catch is PrinterNeedsRestart {
            (message, isError) = (FONT_INSTALL_CUT_TEXT, true)
        } catch where wasLocalNetworkDenied(error) {
            (message, isError) = (LOCAL_NETWORK_PRINTER_DENIED_TEXT, true)
        } catch let error where bluetoothRefusal(error) != nil {
            // Bluetooth off or not allowed, or a printer that forgot this iPad: what to do (the
            // main screen keeps the forgotten printer's steps, with Connect, once the sheet closes).
            let refusal = bluetoothRefusal(error)
            (message, isError) = (noteBluetoothRefusal(error, retry: .check) ?? printerUnreachableText(printer), true)
            settingsOffered = refusal is BluetoothPairingLost || (refusal as? BluetoothUnavailable)?.availability == .unauthorized
            forgotten = refusal is BluetoothPairingLost
        } catch is PrinterTimeout {
            (message, isError) = (Self.TEST_TIMEOUT_TEXT, true)
        } catch is PrinterError {
            (message, isError) = (printerUnreachableText(printer), true)
        } catch {
            Self.log.warning("test label failed: \(String(describing: error), privacy: .private)")
            (message, isError) = (Self.TEST_FAILED_TEXT, true)
        }
        ui.testing = false
        ui.testMessage = message
        ui.testError = isError
        ui.testBluetoothSettings = settingsOffered
        ui.testPairingLost = forgotten
    }

    private func clearTestMessage() {
        ui.testMessage = nil
        ui.testError = false
        ui.testBluetoothSettings = false
        ui.testPairingLost = false
    }

    /// The helpers share the generator with the label build: one can time out right after a
    /// cancelled build while the engine restarts, so it is asked once more.
    private func helper(_ fn: String, _ args: String) async throws -> String {
        let engine = self.engine
        return try await askingAgainOnTimeout(isTimeout: LabelEngineError.isTimeout) { try await engine.call(fn, args) }
    }

    // MARK: Helpers

    /// `op`'s answer, or nil when it fails any way but a cancellation (which is rethrown).
    private func quietly<T>(_ op: () async throws -> T) async throws -> T? {
        if case .success(let answer) = try await attempt(op) { return answer }
        return nil
    }

    /// `op`'s answer or its error; a cancellation is rethrown.
    private func attempt<T>(_ op: () async throws -> T) async throws -> Result<T, Error> {
        do {
            return .success(try await op())
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return .failure(error)
        }
    }

    /// Kotlin's `isBlank()`.
    private static func blank(_ text: String) -> Bool { kotlinTrimmed(text).isEmpty }

    /// A whole number of dots, clamped to ±`OFFSET_LIMIT`; nil when `text` isn't one. Kotlin's
    /// `trim().toBigIntegerOrNull()`: an optional leading minus, then decimal digits only (any
    /// script's, as Java's `Character.digit` reads them); no plus sign.
    nonisolated static func parseOffset(_ text: String) -> Int? {
        var scalars = Substring(kotlinTrimmed(text)).unicodeScalars
        if scalars.isEmpty { return nil }
        var negative = false
        if scalars.first == "-" {
            negative = true
            scalars = scalars.dropFirst()
            if scalars.isEmpty { return nil }
        }
        var magnitude = 0
        for scalar in scalars {
            guard scalar.properties.numericType == .decimal, let value = scalar.properties.numericValue else { return nil }
            // Past the limit it only clamps, so stop growing there.
            magnitude = min(magnitude * 10 + Int(value), OFFSET_LIMIT + 1)
        }
        return negative ? -min(magnitude, OFFSET_LIMIT) : min(magnitude, OFFSET_LIMIT)
    }

    /// Why there's no sample label: the generator's pick notes, or an outcome code.
    nonisolated static func sampleRefusedText(_ reason: String?) -> String {
        switch reason {
        case NO_TEMPLATE_AT_DPI?: return "This move has no template at this printer's DPI."
        case TEMPLATE_FAILED?: return "The label template couldn't be built."
        case TEMPLATE_UNSUPPORTED?: return NEEDS_UPDATE_TEXT
        case nil, ""?: return "No sample label for this printer."
        case let other?: return other
        }
    }
}

/// What Connect, beside the pairing-lost steps, tries again: choosing that Bluetooth printer, or
/// the saved printer's checks.
private enum PairingRetry {
    case choose(FoundBluetoothPrinter)
    case check
}

/// A font going out: its number, its transport, the bytes of the fonts still to send after it,
/// and its first progress report (when its bytes started moving, and how many had gone by then).
private struct FontGoingOut {
    var id: Int
    var overBluetooth: Bool
    var bytesAfter: Int
    var firstReport: (at: ContinuousClock.Instant, sent: Int)?
}
