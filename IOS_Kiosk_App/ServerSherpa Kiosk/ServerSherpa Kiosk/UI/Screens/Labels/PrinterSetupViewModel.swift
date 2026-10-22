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

struct PrinterSetupUi: Equatable {
    var scanning = false
    /// Nil until a scan finishes.
    var found: [FoundPrinter]? = nil
    var scanMessage: String? = nil
    var ipText = ""
    /// The host being identified and saved.
    var choosing: String? = nil
    var chooseError: String? = nil
    var checks: [CheckRow] = []
    var checking = false
    /// How many check runs have finished.
    var checkRuns = 0
    var fontFix: FontFix? = nil
    var installing = false
    var fontMessage: String? = nil
    var fontError = false
    /// What the peeler check found: true, false, or nil (unknown or not checked).
    var peeler: Bool? = nil
    var offsetXText = "0"
    var offsetYText = "0"
    var testing = false
    var testMessage: String? = nil
    var testError = false

    /// Peel-off can be chosen unless the printer said it has no peeler.
    var peelAllowed: Bool { peeler != false }
    var busy: Bool { choosing != nil || installing || testing }
    /// The scan message reads as an error (red).
    var scanError: Bool { scanMessage == SCAN_FAILED_TEXT || scanMessage == LOCAL_NETWORK_DENIED_TEXT }
    /// iOS kept the kiosk off the local network: the scan (twice, see `scan()`), choosing a
    /// printer, its Answers check or a test label says so, and the screen offers Settings.
    var localNetworkDenied: Bool {
        scanMessage == LOCAL_NETWORK_DENIED_TEXT || chooseError == LOCAL_NETWORK_DENIED_TEXT
            || testMessage == LOCAL_NETWORK_DENIED_TEXT || checks.contains { $0.detail == LOCAL_NETWORK_DENIED_TEXT }
    }
}

let NO_PRINTERS_FOUND_TEXT = "No Zebra printers found on this network."
let SCAN_FAILED_TEXT = "Couldn't scan the network."
let INVALID_IP_TEXT = "That isn't a valid IP address."
let NO_PEELER_TEXT = "This printer has no peeler."
let FONTS_INSTALLED_TEXT = "Fonts installed."
func noZebraAnswerText(_ host: String) -> String { "No Zebra printer answered at \(host)." }
func fontInstallFailedText(_ name: String) -> String { "Couldn't install \(name)." }

/// The connection waited with iOS's Local Network denial (`NetworkZebra` marks it).
func wasLocalNetworkDenied(_ error: Error) -> Bool { (error as? PrinterUnreachable)?.localNetworkDenied == true }

/// No synced file for a font the library lists.
private struct FontFileMissing: Error {}

/**
 Printer Setup (Android's PrinterSetupViewModel, the laptop's PrinterStep in
 kiosk/src/components/setup/PrinterStep.tsx): pick a network Zebra (a scan or a typed IP), check
 it, install missing fonts, print test labels, and set the offsets and peel/tear. Choosing a
 printer saves it; the label builder rebuilds by itself when its DPI changes, and offsets and peel
 never rebuild (they apply at send time).

 The checks inform and never block, and run only when the operator saves a printer or taps
 Check printer / Check again: nothing is checked on appear, polled, or checked on the print path.
 The DPI and font checks read the builder's own template pick for the saved printer, waiting for
 the build a DPI change starts (an unsynced kiosk, a failed build and an unsupported device answer
 at once).

 Every call to a printer goes through the container's `PrinterLock`, shared with Print Labels'
 queue: one connection to the printer at a time, app-wide.

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
    @ObservationIgnored private let printerAt: @MainActor (String) -> SetupZebra
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let pickWait: Duration
    @ObservationIgnored private var scanTask: Task<Void, Never>?
    @ObservationIgnored private var chooseTask: Task<Void, Never>?
    @ObservationIgnored private var checksTask: Task<Void, Never>?
    /// Bumped by each check run: only the latest one writes the rows.
    @ObservationIgnored private var checkRun = 0
    @ObservationIgnored private var offsetsTask: Task<Void, Never>?
    @ObservationIgnored private var rescanWait: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var rescanTimer: Task<Void, Never>?
    /// The scene phase is `.active` (the screen reports every phase, the first included).
    @ObservationIgnored private var sceneActive = true
    @ObservationIgnored private var closed = false

    /// `zebraAt` is the printer at a host (`NetworkZebra` on the device); every call to it is made
    /// under `printerLock`. `fontsDir` holds the synced font files (`Sync.defaultFontsDir`).
    init(settings: LabelSettingsStore, build: LabelBuildMonitor, engine: LabelEngine, store: KioskStore, fontsDir: URL?,
         scanner: @escaping @Sendable () async throws -> ZebraScanResult,
         zebraAt: @escaping @MainActor (String) -> SetupZebra,
         printerLock: PrinterLock,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         pickWait: Duration = PrinterSetupViewModel.PICK_WAIT) {
        self.settingsStore = settings
        self.build = build
        self.engine = engine
        self.store = store
        self.fontsDir = fontsDir
        self.scanner = scanner
        self.printerAt = { host in LockedZebra(inner: zebraAt(host), lock: printerLock) }
        self.sleep = sleep
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
        chooseTask?.cancel()
        checksTask?.cancel()
        wakeRescan()
    }

    /// The screen is showing (again): the operator's actions work.
    func open() { closed = false }

    // MARK: Choosing a printer

    func scan() { startScan(retryDenied: true) }

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
    /// (back from Settings). Nothing else starts here.
    func scenePhaseChanged(active: Bool) {
        let cameBack = active && !sceneActive
        sceneActive = active
        guard cameBack else { return }
        if rescanWait != nil {
            wakeRescan()
        } else if ui.scanMessage == LOCAL_NETWORK_DENIED_TEXT && !ui.scanning {
            startScan(retryDenied: false)
        }
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
        cancelChecks()
        ui.choosing = host
        ui.chooseError = nil
        ui.checks = []
        ui.checking = false
        ui.fontFix = nil
        ui.fontMessage = nil
        ui.peeler = nil
        ui.testMessage = nil
        chooseTask = Task { await self.runChoose(host: host, found: found) }
    }

    private func runChoose(host: String, found: FoundPrinter?) async {
        let saved: SavedPrinter
        do {
            if let found, let dpi = found.dpi {
                saved = SavedPrinter(host: host, model: found.model ?? Self.DEFAULT_MODEL, serial: found.serial ?? "", dpi: dpi)
            } else {
                let zebra = printerAt(host)
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
            ui.chooseError = wasLocalNetworkDenied(error) ? LOCAL_NETWORK_DENIED_TEXT : noZebraAnswerText(host)
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
        ui.peeler = nil
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
        let zebra = printerAt(saved.host)
        try put(CheckRow(key: .answers, state: .running), run)
        let id: HostId
        switch try await attempt({ try await zebra.identify() }) {
        case .success(let answer): id = answer
        case .failure(let error):
            let detail = wasLocalNetworkDenied(error) ? LOCAL_NETWORK_DENIED_TEXT : noZebraAnswerText(saved.host)
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
            printer = SavedPrinter(host: saved.host, model: model, serial: serial ?? "", dpi: id.dpi)
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
        guard let onPrinter = try await quietly({ try await zebra.fonts() }) else {
            return CheckRow(key: .fonts, state: .fail, detail: "Couldn't read the fonts on the printer.")
        }
        let missing = missingFonts(needed: needed, onPrinter: onPrinter)
        if missing.isEmpty { return CheckRow(key: .fonts, state: .ok) }
        let library = ((try? await store.labelFonts()) ?? []).map { KioskLabelFont(id: $0.id, name: $0.name, size: $0.size, resident: $0.resident) }
        try live(run)
        let fix = fontFixFor(missing: missing, library: library)
        ui.fontFix = fix
        let others = missing.filter { !fix.builtIn.contains($0) }
        let detail = [others.isEmpty ? nil : "Missing: \(others.joined(separator: ", ")).",
                      fix.builtIn.isEmpty ? nil : builtInFontText(fix.builtIn)].compactMap { $0 }.joined(separator: " ")
        return CheckRow(key: .fonts, state: .fail, detail: detail)
    }

    /// Sends each missing font the library has (its synced file), then checks again after the
    /// printer has had `FONT_SETTLE` to file them. The first failure stops the installs.
    func installFonts() {
        guard let fix = ui.fontFix, !ui.busy, !fix.installable.isEmpty else { return }
        ui.installing = true
        ui.fontMessage = nil
        ui.fontError = false
        Task { await self.runInstall(fix) }
    }

    private func runInstall(_ fix: FontFix) async {
        guard let printer = settingsStore.current().printer else {
            ui.installing = false
            return
        }
        let zebra = printerAt(printer.host)
        var failed: String?
        var files: [String: LabelFontRow] = [:]
        for row in (try? await store.labelFonts()) ?? [] { files[row.name.uppercased()] = row }
        for font in fix.installable {
            let name = font.name.uppercased()
            do {
                guard let fontsDir, let fileName = files[name]?.fileName else { throw FontFileMissing() }
                let bytes = try await Self.readFont(fontsDir.appendingPathComponent(fileName))
                try await zebra.installFont(name: name, bytes: bytes)
            } catch is CancellationError {
                ui.installing = false
                return
            } catch {
                Self.log.warning("font install failed: \(name, privacy: .public): \(String(describing: error), privacy: .private)")
                failed = name
                break
            }
        }
        try? await sleep(Self.FONT_SETTLE)
        ui.installing = false
        ui.fontMessage = failed.map(fontInstallFailedText) ?? FONTS_INSTALLED_TEXT
        ui.fontError = failed != nil
        // Fonts sent before a failure still turn green; the message stays.
        startChecks(printer, keepFontMessage: true)
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
        ui.testMessage = nil
        ui.testError = false
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
                try await printerAt(printer.host).send(try parseZpl(try await helper("withPrintMode", LabelGenArgs.printMode(zpl: shifted, peel: s.peel))))
                (message, isError) = (text, false)
            } else {
                (message, isError) = (text, true)
            }
        } catch is CancellationError {
            ui.testing = false
            return
        } catch where LabelEngineError.isUnsupported(error) {
            (message, isError) = (DEVICE_UNSUPPORTED_TEXT, true)
        } catch where wasLocalNetworkDenied(error) {
            (message, isError) = (LOCAL_NETWORK_DENIED_TEXT, true)
        } catch is PrinterTimeout {
            (message, isError) = (Self.TEST_TIMEOUT_TEXT, true)
        } catch is PrinterError {
            (message, isError) = (printerUnreachableText(printer.host), true)
        } catch {
            Self.log.warning("test label failed: \(String(describing: error), privacy: .private)")
            (message, isError) = (Self.TEST_FAILED_TEXT, true)
        }
        ui.testing = false
        ui.testMessage = message
        ui.testError = isError
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
