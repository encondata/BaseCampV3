import Foundation
import Observation

/// A label and its value: the connection and printer details, on the tab and in the report.
struct DetailLine: Equatable, Hashable, Sendable {
    var label: String
    var value: String
}

/// One ask-the-printer button (D13): what it sends, when its reply is whole (the transports'
/// rules), and what the reply says.
enum PrinterAsk: CaseIterable, Sendable {
    case status, alerts, dpi, peeler, serial, fonts

    var label: String {
        switch self {
        case .status: "Status"
        case .alerts: "Error report"
        case .dpi: "DPI"
        case .peeler: "Peeler"
        case .serial: "Serial number"
        case .fonts: "Font listing"
        }
    }

    var command: String {
        switch self {
        case .status: ZebraCommands.hostStatus
        case .alerts: "~HQES"
        case .dpi: "! U1 getvar \"head.resolution.in_dpi\"\r\n"
        case .peeler: ZebraCommands.peelerPresent
        case .serial: ZebraCommands.serialNumber
        case .fonts: ZebraCommands.fontDirectory
        }
    }

    /// `~HS` is three frames, `~HQES` and the listing one, a getvar one quoted value.
    var complete: @Sendable (Data) -> Bool {
        switch self {
        case .status: { replyHasFrames($0, 3) }
        case .alerts, .fonts: { replyHasFrames($0, 1) }
        case .dpi, .peeler, .serial: { replyHasQuotedValue($0) }
        }
    }

    /// The reply in words; nil when it doesn't read as this answer (the raw reply still shows).
    func meaning(_ reply: String) -> String? {
        switch self {
        case .status:
            guard let s = parseHostStatus(reply) else { return nil }
            let problems = statusProblems(s)
            return (problems.isEmpty ? "Ready to print." : problems.joined(separator: " "))
                + " Formats queued \(s.formatsQueued) · label waiting \(yesNo(s.labelWaiting))"
                + " · partial format \(yesNo(s.partialFormat)) · buffer full \(yesNo(s.bufferFull)) · print mode \(s.printMode)"
        case .alerts:
            return nil
        case .dpi:
            return parseGetvar(reply).map { "\($0) dpi" }
        case .peeler, .serial:
            return parseGetvar(reply)
        case .fonts:
            guard isDirectoryListing(reply) else { return nil }
            let entries = parseDirectoryEntries(reply)
            return entries.isEmpty ? "Nothing stored on E:." : entries.map { "\($0.name) (\($0.size) bytes)" }.joined(separator: ", ")
        }
    }
}

/// An ask button's or the command box's result: the command, the reply as the printer sent it
/// (Latin-1), how long it took (inside the printer lock), and what it means or why it failed.
struct AskResult: Identifiable, Equatable, Sendable {
    let id: Int
    var label: String
    var command: String
    var at: Date
    var reply = ""
    var milliseconds: Int?
    var meaning: String?
    var error: String?

    /// The reply's length in bytes (Latin-1: one byte a character).
    var bytes: Int { reply.unicodeScalars.count }
}

/// One speed-test label: its size, and how long it took to send (or why it didn't go).
struct SpeedRow: Identifiable, Equatable, Sendable {
    let id: Int
    var run: Int
    var targetKb: Int
    var bytes: Int
    var seconds: Double?
    var error: String?

    var kbPerSecond: Double? {
        guard let seconds, seconds > 0 else { return nil }
        return Double(bytes) / 1024 / seconds
    }
}

struct TroubleLogLine: Equatable, Sendable {
    var at: Date
    var text: String
}

/// What the tab is doing with the printer (one thing at a time).
enum TroubleAction: Sendable { case details, ask, command, speed, cutSend }

/// A Bluetooth refusal the crew fixes on the iPad, as the last call met it: its words and buttons
/// (`printerReachProblem`), shown in the section of the call (`action`) that met it.
struct TroubleReachProblem: Equatable, Sendable {
    var action: TroubleAction
    var problem: PrinterReachProblem
}

/// The Cut-send test's labels went out (D16).
let CUT_SEND_DONE_TEXT = "Sent half a sample label, then a full one with ~JX before it. "
    + "Only the full label should print, with no merged or extra label."
/// Beside the speed test's results.
let SPEED_END_TEXT = "Each label must print END at the bottom — a missing END means data was lost."
let NO_TROUBLESHOOTING_PRINTER_TEXT = "No printer set up yet. Choose one in Label Printing › Printer Setup."
let NOTHING_HEARD_TEXT = "No Bluetooth devices heard nearby."
/// A scan a printer call cut short (a label going out shares the radio).
let SCAN_CUT_SHORT_TEXT = "The scan stopped because the printer was in use. Scan again."
/// A command box command (a setvar, say) that replied nothing, as it does by design.
let COMMAND_SENT_TEXT = "Sent, no reply."

/// "Device: iPad16,6 (ipad), iPadOS 18.5" and "App: version 1.0 (build 7)": the report's first lines.
@MainActor func troubleshootingDeviceText() -> String {
    let info = DeviceInfo.rawInfo()
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    return "Device: \(info["model"] ?? "?") (\(info["idiom"] ?? "?")), \(info["system_name"] ?? "iOS") \(info["system_version"] ?? "?")\n"
        + "App: version \(KioskBuildConfig.kioskVersion) (build \(build))"
}

/// `text` (a command, or a reply read as Latin-1) with its control bytes made visible: STX ␂,
/// ETX ␃, CR ␍, LF ␊ plus a line break, any other control byte as `<XX>`.
func visibleBytes(_ text: String) -> String {
    var out = ""
    for scalar in text.unicodeScalars {
        switch scalar.value {
        case 0x02: out += "␂"
        case 0x03: out += "␃"
        case 0x0D: out += "␍"
        case 0x0A: out += "␊\n"
        case 0x00..<0x20, 0x7F...0x9F: out += String(format: "<%02X>", scalar.value)
        default: out.unicodeScalars.append(scalar)
        }
    }
    return out
}

/**
 Settings › Troubleshooting (D13): the deeper tools for the saved printer, network or Bluetooth,
 grown from the Bluetooth test screen Jimmy used on the ZD421 (branch ble-spike).

 - Connection and printer details: how the iPad reaches the printer (for Bluetooth, the link's state,
   write size and last drop), `~HI`, and for Bluetooth the Device Information read when the link
   came up.
 - Ask the printer: status, error report, DPI, peeler, serial and the font listing, each with its
   raw reply, its bytes and how long it took; and a free-text command box for admins and
   developers only (a raw command can change printer settings; one that replies nothing, as a
   setvar does, reads as sent).
 - A Bluetooth refusal the crew fixes on the iPad (a printer that forgot this iPad, Bluetooth off or
   not allowed) shows with its buttons (`reachProblem`: Connect, or Open Settings), as on Print
   Labels, in the section whose call met it; the next call replaces it.
 - Speed test: speed-test labels (`speedTestLabel`) on the template's label size at the saved
   printer's DPI, with seconds and KB/s for each.
 - Cut-send test (developers, D16): half a sample label, a failure marked on the guard, then a full
   sample label through the normal path, so `~JX` goes first. Only the full label may print.
 - Bluetooth scan: every named device nearby with its signal, Zebras flagged ("why can't I find my
   printer?"). It never saves a printer, and Bluetooth starts only when Scan is tapped (never during
   a speed test, whose KB/s it would lower). A scan a printer call cut short says so.
 - Report: all of the above and the last `LOG_CAP` log lines, merged in time with the Bluetooth
   link's own events (`ZebraBluetooth.events`), as text to copy or share.

 Every call to the printer goes through `LockedZebra` with the app's `PrinterLock` and
 `PrinterGuard`, so nothing here interleaves with Print Labels or Printer Setup, and a printer left
 needing a clear gets its `~JX` first. Times are taken inside the lock (a wait behind a label
 isn't counted). Nothing reaches the printer until a button is tapped.
 */
@MainActor @Observable
final class TroubleshootingModel {
    nonisolated static let LOG_CAP = 5_000
    nonisolated static let SPEED_SIZES_KB = [10, 25, 50]
    nonisolated static let SPEED_RUN_COUNTS = [1, 3, 5]

    let isAdmin: Bool
    let isDeveloper: Bool
    /// A raw command can change printer settings: admins and developers only.
    var showsCommandBox: Bool { isAdmin || isDeveloper }
    var showsCutSendTest: Bool { isDeveloper }

    private(set) var running: TroubleAction?
    private(set) var hostId: HostId?
    private(set) var hostIdMilliseconds: Int?
    private(set) var detailsError: String?
    private(set) var asks: [AskResult] = []
    var commandText = ""
    var speedKb = 10
    var speedRuns = 1
    private(set) var speedRows: [SpeedRow] = []
    /// The speed-test label going out (0 when none).
    private(set) var speedRunNow = 0
    /// Stop was tapped: the label going out finishes, then the test stops.
    private(set) var speedStopping = false
    private(set) var cutSendMessage: String?
    private(set) var cutSendError = false
    /// What the Bluetooth scan heard, strongest first: nil until a scan starts.
    private(set) var found: [FoundBluetoothPrinter]?
    private(set) var scanning = false
    /// Under the scan: Bluetooth off or not allowed, or nothing heard.
    private(set) var scanMessage: String?
    private(set) var logLines: [TroubleLogLine] = []
    /// The last call's Bluetooth refusal the crew fixes on the iPad, with its buttons; nil once a
    /// call gets through or fails any other way.
    private(set) var reachProblem: TroubleReachProblem?

    @ObservationIgnored private let settings: LabelSettingsStore
    @ObservationIgnored private let bluetooth: BluetoothPrinting
    @ObservationIgnored private let zebraFor: @MainActor (SavedPrinter) -> SetupZebra
    @ObservationIgnored private let printerLock: PrinterLock
    @ObservationIgnored private let printerGuard: PrinterGuard
    @ObservationIgnored private let pick: @MainActor () -> LabelPick?
    @ObservationIgnored private let device: @MainActor () -> String
    @ObservationIgnored private let stopwatch = CallStopwatch()
    @ObservationIgnored private var nextId = 0
    @ObservationIgnored private var stopRequested = false
    @ObservationIgnored private var scanTask: Task<Void, Never>?
    /// Bumped by each scan (and by closing): only the latest one writes when it ends.
    @ObservationIgnored private var scanRun = 0
    @ObservationIgnored private var closed = false

    /// `zebraFor` is a printer the way its connection reaches it (`AppContainer.zebra(for:)` on the
    /// device); every call to it is made under `printerLock` and `printerGuard`. `pick` is the label
    /// builder's template pick (the speed test's label size); `device` names this device and app
    /// for the report.
    init(settings: LabelSettingsStore, bluetooth: BluetoothPrinting,
         zebraFor: @escaping @MainActor (SavedPrinter) -> SetupZebra,
         printerLock: PrinterLock, printerGuard: PrinterGuard, isAdmin: Bool, isDeveloper: Bool,
         pick: @escaping @MainActor () -> LabelPick? = { nil },
         device: @escaping @MainActor () -> String = troubleshootingDeviceText) {
        self.settings = settings
        self.bluetooth = bluetooth
        self.zebraFor = zebraFor
        self.printerLock = printerLock
        self.printerGuard = printerGuard
        self.isAdmin = isAdmin
        self.isDeveloper = isDeveloper
        self.pick = pick
        self.device = device
    }

    /// The tab went away: the scan stops, and a speed test stops after the label going out. A query
    /// or label already going out finishes.
    func close() {
        closed = true
        stopRequested = true
        if scanning {
            scanRun += 1
            scanTask?.cancel()
            scanTask = nil
            scanning = false
        }
    }

    /// The tab is showing (again).
    func open() { closed = false }

    // MARK: What the tab shows

    var printer: SavedPrinter? { settings.current().printer }
    var busy: Bool { running != nil }

    /// How the iPad reaches the saved printer: for Bluetooth, the link's state, write size, last
    /// use and last drop when the link (up, or last up) was to this printer.
    var connectionLines: [DetailLine] {
        guard let printer else { return [] }
        switch printer.connection {
        case .network(let host):
            return [DetailLine(label: "Type", value: "Network (port 9100)"),
                    DetailLine(label: "Address", value: host),
                    DetailLine(label: "Link", value: "None kept: each command opens its own connection")]
        case .bluetooth(let serial, let peripheralId):
            let link = linkFor(printer)
            var lines = [DetailLine(label: "Type", value: "Bluetooth LE"),
                         DetailLine(label: "Serial", value: serial),
                         DetailLine(label: "iPad's identifier", value: peripheralId?.uuidString ?? "Not known yet")]
            // What Bluetooth last reported (reading it starts nothing).
            if let state = Self.bluetoothStateText(bluetooth.availability) { lines.append(DetailLine(label: "Bluetooth", value: state)) }
            if let link, link.connected {
                lines.append(DetailLine(label: "Link", value: link.connectedAt.map { "Connected since \(clockText($0))" } ?? "Connected"))
            } else {
                lines.append(DetailLine(label: "Link", value: "Idle: connects when the printer is next used"))
            }
            if let chunk = link?.chunkBytes {
                lines.append(DetailLine(label: "Write size", value: "\(chunk) bytes per chunk (MTU \(chunk + 3))"))
            }
            if let used = link?.lastActivity { lines.append(DetailLine(label: "Last used", value: clockText(used))) }
            if let drop = link?.lastDrop { lines.append(DetailLine(label: "Last drop", value: "\(clockText(drop.at)): \(drop.reason)")) }
            return lines
        }
    }

    /// What `~HI` said (Printer details).
    var hostIdLines: [DetailLine] {
        guard let id = hostId else { return [] }
        return [DetailLine(label: "Model", value: id.model),
                DetailLine(label: "Firmware", value: id.firmware),
                DetailLine(label: "Resolution", value: "\(id.dotsPerMm) dots/mm (\(id.dpi) dpi)"),
                DetailLine(label: "Memory", value: id.memory)]
    }

    /// A Bluetooth printer's Device Information, read when the link to it came up.
    var deviceInfoLines: [DetailLine] {
        guard let printer, let info = linkFor(printer)?.info else { return [] }
        return [("Manufacturer", info.manufacturer), ("Model number", info.model), ("Serial number", info.serial),
                ("Firmware revision", info.firmware), ("Link-OS", info.linkOs)]
            .map { DetailLine(label: $0.0, value: $0.1 ?? "Not read") }
    }

    /// The speed test's and the Cut-send test's label: the template's size when the builder picked
    /// one at the saved printer's DPI, else 4x2 (Top) or 2x1 (Front), at that DPI.
    var speedSize: AlignmentSize? {
        let s = settings.current()
        return s.printer.map { alignmentSizeFor(kind: s.kind, dpi: $0.dpi, pick: pick()) }
    }

    /// More than one label prints: the tab asks first.
    var speedNeedsConfirm: Bool { speedRuns > 1 }

    /// The mean KB/s of the labels that went out.
    var speedAverage: Double? {
        let rates = speedRows.compactMap(\.kbPerSecond)
        return rates.isEmpty ? nil : rates.reduce(0, +) / Double(rates.count)
    }

    // MARK: Printer details and asking

    /// `~HI`, for Printer details. An answer also lifts a cut font's stop, as Printer Setup's check does.
    @discardableResult func readDetails() -> Task<Void, Never>? { details(reachFrom: .details) }

    /// Connect, beside a printer that forgot this iPad (once it is forgotten in Settings): reads the
    /// printer's details, which connects first. Refused again, the card stays in its section.
    @discardableResult func connectAgain() -> Task<Void, Never>? { details(reachFrom: reachProblem?.action ?? .details) }

    private func details(reachFrom section: TroubleAction) -> Task<Void, Never>? {
        guard let started = begin(.details) else { return nil }
        detailsError = nil
        log("→ Printer details: \(ZebraCommands.hostIdentification)")
        return Task {
            do {
                let id = try await started.zebra.identify()
                hostId = id
                hostIdMilliseconds = stopwatch.milliseconds
                log("← ~HI in \(msText(hostIdMilliseconds)) ms: \(id.model), \(id.firmware), \(id.dotsPerMm) dots/mm, \(id.memory)")
                noteReach(nil, from: section)
            } catch {
                detailsError = troubleText(error, started.printer)
                log("← ~HI failed: \(String(describing: error))")
                noteReach(error, from: section)
            }
            running = nil
        }
    }

    @discardableResult func ask(_ which: PrinterAsk) -> Task<Void, Never>? {
        runQuery(label: which.label, command: which.command, complete: which.complete, action: .ask) { which.meaning($0) }
    }

    /// The command box (admins and developers): the text as typed with straight quotes and CR LF
    /// at the end. Its reply has no known end, so it is read until the printer goes quiet.
    @discardableResult func sendCommand() -> Task<Void, Never>? {
        guard showsCommandBox else { return nil }
        let typed = commandText
            .replacingOccurrences(of: "\u{201C}", with: "\"").replacingOccurrences(of: "\u{201D}", with: "\"")
            .replacingOccurrences(of: "\u{2018}", with: "'").replacingOccurrences(of: "\u{2019}", with: "'")
        guard !kotlinTrimmed(typed).isEmpty else { return nil }
        let command = typed.hasSuffix("\n") ? typed : typed + "\r\n"
        return runQuery(label: "Command", command: command, complete: { _ in false }, action: .command) { _ in nil }
    }

    private func runQuery(label: String, command: String, complete: @escaping @Sendable (Data) -> Bool, action: TroubleAction,
                          meaning: @escaping @Sendable (String) -> String?) -> Task<Void, Never>? {
        guard let started = begin(action) else { return nil }
        nextId += 1
        let id = nextId
        let at = Date()
        log("→ \(label): \(visibleCommand(command))")
        return Task {
            var result = AskResult(id: id, label: label, command: command, at: at)
            do {
                let reply = try await started.zebra.query(command, complete: complete)
                result.reply = reply
                result.meaning = meaning(reply)
                result.milliseconds = stopwatch.milliseconds
                log("← \(label): \(result.bytes) B in \(msText(result.milliseconds)) ms")
                noteReach(nil, from: action)
            } catch is PrinterNoReply where action == .command {
                // A setvar and most raw commands reply nothing by design: it went out.
                result.meaning = COMMAND_SENT_TEXT
                result.milliseconds = stopwatch.milliseconds
                log("← \(label): sent, no reply after \(msText(result.milliseconds)) ms")
                noteReach(nil, from: action)
            } catch {
                result.error = troubleText(error, started.printer)
                result.milliseconds = stopwatch.milliseconds
                log("← \(label) failed after \(msText(result.milliseconds)) ms: \(String(describing: error))")
                noteReach(error, from: action)
            }
            asks.append(result)
            running = nil
        }
    }

    // MARK: Speed test

    /// Sends `speedRuns` speed-test labels of `speedKb` KB, one after another (the tab confirms
    /// first when that's more than one). A failure stops the test.
    @discardableResult func startSpeedTest() -> Task<Void, Never>? {
        guard let size = speedSize, let started = begin(.speed) else { return nil }
        let kb = speedKb
        let runs = speedRuns
        stopRequested = false
        speedStopping = false
        log("Speed test: \(runs) × \(kb) KB on \(size.label) labels at \(size.dpi) dpi")
        return Task {
            await runSpeed(started, size: size, kb: kb, runs: runs)
            speedRunNow = 0
            speedStopping = false
            running = nil
        }
    }

    /// Stop: the label going out finishes (cutting it would leave a half label in the printer),
    /// then the test stops.
    func stopSpeedTest() {
        guard running == .speed else { return }
        stopRequested = true
        speedStopping = true
    }

    private func runSpeed(_ started: Started, size: AlignmentSize, kb: Int, runs: Int) async {
        for run in 1...runs {
            if stopRequested {
                log("Speed test stopped before run \(run)")
                return
            }
            speedRunNow = run
            if started.printer.isBluetooth && linkFor(started.printer)?.connected != true {
                log("Run \(run) includes connecting: the Bluetooth link was down")
            }
            let zpl = speedTestLabel(targetBytes: kb * 1024, widthDots: size.widthDots, heightDots: size.heightDots, run: run)
            let bytes = zpl.utf8.count
            nextId += 1
            let id = nextId
            stopwatch.reset()
            do {
                try await started.zebra.send(zpl)
                let row = SpeedRow(id: id, run: run, targetKb: kb, bytes: bytes, seconds: stopwatch.seconds)
                speedRows.append(row)
                log("Run \(run): \(bytes) B in \(decimal(row.seconds)) s, \(decimal(row.kbPerSecond)) KB/s")
                noteReach(nil, from: .speed)
            } catch {
                speedRows.append(SpeedRow(id: id, run: run, targetKb: kb, bytes: bytes, error: troubleText(error, started.printer)))
                log("Run \(run) failed: \(String(describing: error))")
                noteReach(error, from: .speed)
                return
            }
        }
    }

    // MARK: Cut-send test

    /// D16 on a real printer (developers): the first half of a sample label, marked as a failed
    /// send in the same turn of the lock, then the full label through the normal path, which sends
    /// `~JX` first. Only the full label may print.
    @discardableResult func runCutSendTest() -> Task<Void, Never>? {
        guard showsCutSendTest, let size = speedSize, let started = begin(.cutSend) else { return nil }
        cutSendMessage = nil
        cutSendError = false
        let full = sampleTestLabel(widthDots: size.widthDots, heightDots: size.heightDots, dpi: size.dpi)
        // Plain ASCII: half the characters are half the bytes.
        let half = String(full.prefix(full.count / 2))
        log("Cut-send test: \(half.utf8.count) of \(full.utf8.count) B of a sample label, then all of it")
        return Task {
            do {
                try await started.zebra.sendCut(half)
                log("Half label sent; the printer is marked for a clear")
                try await started.zebra.send(full)
                log("Full label sent")
                cutSendMessage = CUT_SEND_DONE_TEXT
                noteReach(nil, from: .cutSend)
            } catch {
                cutSendMessage = troubleText(error, started.printer)
                cutSendError = true
                log("Cut-send test failed: \(String(describing: error))")
                noteReach(error, from: .cutSend)
            }
            running = nil
        }
    }

    // MARK: Bluetooth scan

    /// Lists every named device nearby, strongest first, until the scan ends (30 s of a ready
    /// Bluetooth, Stop, Bluetooth refused, or a printer call taking the radio, which it then says).
    /// "Nothing heard" only after the full 30 s or Stop. The first scan asks iOS for Bluetooth
    /// permission. Nothing is saved, and no scan starts during a speed test (it shares the radio
    /// with the label's acknowledgments and would lower its KB/s).
    func scan() {
        guard !scanning, !closed, running != .speed else { return }
        scanRun += 1
        let run = scanRun
        scanning = true
        found = []
        scanMessage = nil
        log("Bluetooth scan started")
        let heard = bluetooth.scan()
        scanTask = Task {
            for await list in heard where run == scanRun { found = list }
            guard run == scanRun else { return }
            scanTask = nil
            scanning = false
            let devices = found ?? []
            if let text = bluetoothUnavailableText(bluetooth.availability) {
                scanMessage = text
            } else {
                switch bluetooth.lastScanEnd {
                case .interrupted?: scanMessage = SCAN_CUT_SHORT_TEXT
                case .finished?, .stopped?: if devices.isEmpty { scanMessage = NOTHING_HEARD_TEXT }
                case .closed?, .refused?, .replaced?, nil: break
                }
            }
            log("Bluetooth scan ended: \(devices.count) named devices, \(devices.filter(\.isZebra).count) Zebra"
                + (scanMessage.map { " (\($0))" } ?? ""))
            for d in devices { log("  \(Self.scanLine(d))") }
        }
    }

    func stopScan() { bluetooth.stopScan() }

    /// "D8J224508535 · -52 dBm · Zebra": a device the scan heard, for the log and the report.
    private static func scanLine(_ d: FoundBluetoothPrinter) -> String {
        "\(d.name) · \(d.rssi) dBm\(d.isZebra ? " · Zebra" : "")\(d.advertisesZebra ? " (advertises Zebra)" : "")"
    }

    // MARK: Report

    /// Everything the tab found, as the text Copy and Share send: this device and app, the saved
    /// printer, its connection and details, every ask with its reply, the speed rows, the Cut-send
    /// test, the Bluetooth scan, then the log: the tab's lines and the Bluetooth link's events
    /// ("Bluetooth: …"), in time order. Shared as `printer-report-<yyyyMMdd-HHmmss>.txt`.
    func report(now: Date = Date()) -> (name: String, text: String) {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: now)
        let name = String(format: "printer-report-%04d%02d%02d-%02d%02d%02d.txt",
                          c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
        var out: [String] = []
        out.append("ServerSherpa Kiosk · Printer troubleshooting report")
        out.append("Generated \(ISO8601DateFormatter().string(from: now)) (\(TimeZone.current.identifier))")
        out.append(device())

        out.append("")
        out.append("== Saved printer ==")
        out.append(printer.map(printerSummary) ?? "None set up")

        out.append("")
        out.append("== Connection ==")
        out.append(contentsOf: connectionLines.map { "\($0.label): \($0.value)" })

        out.append("")
        out.append("== Printer details ==")
        if hostId != nil {
            out.append("~HI (\(msText(hostIdMilliseconds)) ms):")
            out.append(contentsOf: hostIdLines.map { "  \($0.label): \($0.value)" })
        } else {
            out.append("~HI: \(detailsError ?? "not asked")")
        }
        if printer?.isBluetooth == true {
            let info = deviceInfoLines
            out.append(info.isEmpty ? "Device Information: not read (the link hasn't been up to this printer)" : "Device Information:")
            out.append(contentsOf: info.map { "  \($0.label): \($0.value)" })
        }

        out.append("")
        out.append("== Ask the printer (\(asks.count)) ==")
        for ask in asks {
            out.append("[\(clockText(ask.at))] \(ask.label) · command \(visibleCommand(ask.command))")
            out.append("  \(ask.bytes) B in \(msText(ask.milliseconds)) ms")
            if let meaning = ask.meaning { out.append("  Meaning: \(meaning)") }
            if let error = ask.error { out.append("  Error: \(error)") }
            if !ask.reply.isEmpty {
                out.append("  Reply:")
                for line in visibleBytes(ask.reply).split(separator: "\n", omittingEmptySubsequences: false) {
                    out.append("    \(line)")
                }
            }
        }

        out.append("")
        out.append("== Speed test (\(speedRows.count) labels) ==")
        if let size = speedSize { out.append("Label: \(size.label) at \(size.dpi) dpi") }
        out.append("run | KB | bytes | seconds | KB/s")
        for row in speedRows {
            if let error = row.error {
                out.append("\(row.run) | \(row.targetKb) | \(row.bytes) | failed: \(error)")
            } else {
                out.append("\(row.run) | \(row.targetKb) | \(row.bytes) | \(decimal(row.seconds)) | \(decimal(row.kbPerSecond))")
            }
        }
        if let average = speedAverage {
            let count = speedRows.compactMap(\.kbPerSecond).count
            out.append("Average: \(decimal(average)) KB/s over \(count) label\(count == 1 ? "" : "s")")
        }

        if let message = cutSendMessage {
            out.append("")
            out.append("== Cut-send test ==")
            out.append(message)
        }

        out.append("")
        out.append("== Bluetooth scan ==")
        if let found {
            out.append("\(found.count) named device\(found.count == 1 ? "" : "s"), strongest first\(scanning ? " (still scanning)" : "")")
            out.append(contentsOf: found.map { "  \(Self.scanLine($0))" })
            if let message = scanMessage { out.append(message) }
        } else {
            out.append("Not run")
        }

        out.append("")
        let events = bluetooth.events
        out.append("== Log (\(logLines.count) lines; the last \(Self.LOG_CAP) are kept) and Bluetooth link events "
                   + "(\(events.count); the last \(ZebraBluetooth.EVENT_CAP) are kept) ==")
        let merged = (logLines + events.map { TroubleLogLine(at: $0.at, text: "Bluetooth: \($0.text)") })
            .enumerated()
            .sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }
            .map(\.element)
        out.append(contentsOf: merged.map { "\(clockText($0.at, millis: true))  \($0.text)" })
        return (name, out.joined(separator: "\n") + "\n")
    }

    /// Adds a line to the log the report carries, keeping the last `LOG_CAP`.
    func log(_ text: String) {
        logLines.append(TroubleLogLine(at: Date(), text: text))
        if logLines.count > Self.LOG_CAP { logLines.removeFirst(logLines.count - Self.LOG_CAP) }
    }

    // MARK: Helpers

    /// The saved printer and its locked transport, for a call the tab starts: nil while another one
    /// runs, the tab is closed, or there's no printer.
    private func begin(_ action: TroubleAction) -> Started? {
        guard running == nil, !closed, let printer else { return nil }
        running = action
        stopwatch.reset()
        let timed = TimedZebra(inner: zebraFor(printer), stopwatch: stopwatch)
        return Started(printer: printer, zebra: LockedZebra(inner: timed, connection: printer.connection, lock: printerLock, guard: printerGuard))
    }

    /// The Bluetooth link's details when they are the saved printer's: the link, up or last up,
    /// was to its serial.
    private func linkFor(_ printer: SavedPrinter) -> BluetoothLinkInfo? {
        guard case .bluetooth(let serial, _) = printer.connection else { return nil }
        let link = bluetooth.link
        guard let linked = link.info?.serial, linked.uppercased() == serial.uppercased() else { return nil }
        return link
    }

    /// Each call's outcome replaces the reach card: a Bluetooth refusal the crew fixes on the iPad
    /// shows with its buttons in `section`; a call that got through, or failed another way, clears it.
    private func noteReach(_ error: Error?, from section: TroubleAction) {
        reachProblem = error.flatMap(bluetoothRefusal).flatMap(printerReachProblem(for:))
            .map { TroubleReachProblem(action: section, problem: $0) }
    }

    /// "On", "Off", … for the Connection lines; nil while Bluetooth hasn't reported (it starts only
    /// when used).
    private static func bluetoothStateText(_ availability: BluetoothAvailability) -> String? {
        switch availability {
        case .unknown: nil
        case .ready: "On"
        case .poweredOff: "Off"
        case .unauthorized: "Not allowed for ServerSherpa Kiosk"
        case .unsupported: "Not supported on this device"
        }
    }

    /// What a failed call says: the app's words for what a crew can act on (unreachable, Local
    /// Network or Bluetooth refused, a printer that forgot this iPad, a cut font), else the error's.
    /// A `~JX` clear that failed reads as its cause: the call itself never went out.
    private func troubleText(_ error: Error, _ printer: SavedPrinter) -> String {
        if let clear = error as? PrinterClearFailed { return troubleText(clear.cause, printer) }
        if error is PrinterNoReply { return "No reply." }
        if error is PrinterNeedsRestart { return FONT_INSTALL_CUT_TEXT }
        if wasLocalNetworkDenied(error) { return LOCAL_NETWORK_PRINTER_DENIED_TEXT }
        if let text = bluetoothRefusal(error)?.errorDescription { return text }
        if error is PrinterUnreachable || error is BluetoothPrinterNotFound { return printerUnreachableText(printer) }
        if error is PrinterTimeout { return "The printer didn't take it in time." }
        return (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
}

/// A call the tab started: the printer, and the way to it under the lock and the guard.
private struct Started {
    var printer: SavedPrinter
    var zebra: LockedZebra
}

/// How long the last call to the printer took. It is timed inside the printer lock, around the
/// transport's call: a wait behind Print Labels isn't counted, and a `~JX` before it is replaced
/// by the call itself.
private final class CallStopwatch: @unchecked Sendable {
    private let lock = NSLock()
    private var last: Duration?

    func reset() { lock.withLock { last = nil } }
    func record(_ duration: Duration) { lock.withLock { last = duration } }

    var seconds: Double? {
        lock.withLock { last }.map { Double($0.components.seconds) + Double($0.components.attoseconds) / 1e18 }
    }

    var milliseconds: Int? { seconds.map { Int(($0 * 1000).rounded()) } }
}

/// `inner`, each call timed on `stopwatch`.
private struct TimedZebra: SetupZebra {
    let inner: SetupZebra
    let stopwatch: CallStopwatch

    func identify() async throws -> HostId { try await timed { try await inner.identify() } }
    func serial() async throws -> String? { try await timed { try await inner.serial() } }
    func status() async throws -> HostStatus { try await timed { try await inner.status() } }
    func peelerPresent() async throws -> Bool? { try await timed { try await inner.peelerPresent() } }
    func fonts() async throws -> [String] { try await timed { try await inner.fonts() } }
    func fontEntries() async throws -> [DirectoryEntry] { try await timed { try await inner.fontEntries() } }
    func send(_ zpl: String) async throws { try await timed { try await inner.send(zpl) } }

    func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        try await timed { try await inner.installFont(name: name, bytes: bytes, progress: progress) }
    }

    func query(_ command: String, complete: @escaping @Sendable (Data) -> Bool) async throws -> String {
        try await timed { try await inner.query(command, complete: complete) }
    }

    private func timed<T>(_ call: () async throws -> T) async throws -> T {
        let start = ContinuousClock.now
        defer { stopwatch.record(ContinuousClock.now - start) }
        return try await call()
    }
}

/// A command on one line, its control bytes visible ("~HI␍␊").
func visibleCommand(_ command: String) -> String { visibleBytes(command).replacingOccurrences(of: "\n", with: "") }

/// "14:05:09", or "14:05:09.123" with `millis`.
private func clockText(_ date: Date, millis: Bool = false) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute, .second, .nanosecond], from: date)
    let text = String(format: "%02d:%02d:%02d", c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    return millis ? text + String(format: ".%03d", (c.nanosecond ?? 0) / 1_000_000) : text
}

private func msText(_ ms: Int?) -> String { ms.map(String.init) ?? "?" }

/// "3.90", or "-" when there's no value.
private func decimal(_ value: Double?) -> String { value.map { String(format: "%.2f", $0) } ?? "-" }

private func yesNo(_ flag: Bool) -> String { flag ? "yes" : "no" }
