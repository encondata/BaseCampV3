import Foundation
import SwiftUI
import Testing
import UIKit
@testable import ServerSherpa_Kiosk

/// The printer's port: every write or query that reached it, in the order they began, and how
/// many were open at once. One whose text contains `hold` stays open while `hold` is set.
@MainActor private final class TroubleLine {
    private(set) var started: [String] = []
    private(set) var open = 0
    private(set) var maxOpen = 0
    var hold: String?
    private(set) var held = false

    func connect(_ what: String) async throws {
        started.append(what)
        open += 1
        maxOpen = max(maxOpen, open)
        defer { open -= 1 }
        while let hold, what.contains(hold) {
            held = true
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    func clearHeld() { held = false }
}

/// A Zebra that records what reached it, in order (each send's text; each query as `?command`),
/// answers queries from `replies` (no entry: no reply), and goes through `line` when one is set.
@MainActor private final class TroubleZebra: SetupZebra {
    var replies: [String: String] = [:]
    var line: TroubleLine?
    /// While set, every call fails with it before anything reaches the printer.
    var failure: Error?
    private(set) var events: [String] = []

    nonisolated init() {}

    private func reach(_ what: String) async throws {
        if let failure { throw failure }
        events.append(what)
        try await line?.connect(what)
    }

    private func answer(_ command: String) async throws -> String {
        try await reach("?" + command)
        guard let reply = replies[command] else { throw PrinterNoReply(host: "10.0.0.5") }
        return reply
    }

    private func identifyNow() async throws -> HostId {
        try await reach("?" + ZebraCommands.hostIdentification)
        return HostId(model: "ZD421-300dpi", firmware: "V93.21.38Z", dotsPerMm: 12, memory: "8176KB", dpi: 300)
    }

    nonisolated func identify() async throws -> HostId { try await identifyNow() }
    nonisolated func serial() async throws -> String? { parseGetvar(try await answer(ZebraCommands.serialNumber)) }
    nonisolated func status() async throws -> HostStatus {
        guard let status = parseHostStatus(try await answer(ZebraCommands.hostStatus)) else { throw PrinterBadReply(host: "10.0.0.5", what: "status") }
        return status
    }
    nonisolated func peelerPresent() async throws -> Bool? { parseGetvar(try await answer(ZebraCommands.peelerPresent)) == "Present" }
    nonisolated func fonts() async throws -> [String] { parseDirectory(try await answer(ZebraCommands.fontDirectory)) }
    nonisolated func fontEntries() async throws -> [DirectoryEntry] { parseDirectoryEntries(try await answer(ZebraCommands.fontDirectory)) }
    nonisolated func send(_ zpl: String) async throws { try await reach(zpl) }
    nonisolated func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        try await reach("font \(name)")
    }
    nonisolated func query(_ command: String, complete: @escaping @Sendable (Data) -> Bool) async throws -> String {
        try await answer(command)
    }
}

// A ZD421-300dpi's replies (2026-10-19 over port 9100, 2026-10-22 over Bluetooth).
private let HS_REPLY = "\u{02}030,0,0,0612,000,0,0,0,000,0,0,0\u{03}\r\n\u{02}000,0,0,0,0,1,6,0,00000000,1,000\u{03}\r\n\u{02}0000,0\u{03}\r\n"
private let HQES_REPLY = "\u{02}\r\n\r\n  PRINTER STATUS                            \r\n   ERRORS:         0 00000000 00000000   \r\n"
    + "   WARNINGS:       0 00000000 00000000   \r\n\u{03}"
private let HW_REPLY = "\u{02}\r\n- DIR E:*.* \r\n* E:TT0003M_.TTF    169188       K  \r\n\r\n-  63311872 bytes free E: ONBOARD FLASH \r\n\u{03}"
private let ZD421_SERIAL = "D8J224508535"
private let DEVICE_TEXT = "Device: iPad16,6 (ipad), iPadOS 27.2\nApp: version 1.0 (build 7)"

/// A failure that isn't one of the app's printer errors, with a message of its own (a socket's or
/// a framework's could say anything).
private struct StrayError: LocalizedError {
    var text: String
    var errorDescription: String? { text }
}

/// Settings › Troubleshooting (D13, D16): every call to the printer goes through the app's printer
/// lock and guard, the command box is for admins and developers, the Cut-send test for developers,
/// and the report carries everything the tab found.
@MainActor
final class TroubleshootingModelTests {
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let settings: LabelSettingsStore
    private let lock = PrinterLock()
    private let printerGuard = PrinterGuard()
    private let bluetooth = FakeBluetoothPrinting()
    private let zebra = TroubleZebra()
    private let network = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203)
    private let peripheral = UUID()
    private var bluetoothPrinter: SavedPrinter {
        SavedPrinter(connection: .bluetooth(serial: ZD421_SERIAL, peripheralId: peripheral), model: "ZD421", serial: ZD421_SERIAL, dpi: 300)
    }

    init() {
        settings = LabelSettingsStore(prefs: prefs)
    }

    private func model(isAdmin: Bool = false, isDeveloper: Bool = false, pick: LabelPick? = nil,
                       device: @escaping @Sendable () throws -> String = { DEVICE_TEXT }) -> TroubleshootingModel {
        let zebra = self.zebra
        return TroubleshootingModel(settings: settings, bluetooth: bluetooth, zebraFor: { _ in zebra },
                                    printerLock: lock, printerGuard: printerGuard, isAdmin: isAdmin, isDeveloper: isDeveloper,
                                    pick: { pick }, device: device)
    }

    /// Print Labels' send, as the container wires it (`lockedSender` around the transport).
    private var printLabels: LabelSender {
        let zebra = self.zebra
        return lockedSender(lock, printerGuard) { _, zpl in try await zebra.send(zpl) }
    }

    /// `m`'s report written off the main actor, as Copy and Share write it: a long one would hold
    /// up every other test waiting on the main actor.
    private func offMainReport(_ m: TroubleshootingModel, now: Date = Date(), maxChars: Int = .max) async throws -> String {
        let draft = m.reportDraft(now: now)
        return try await Task.detached { try draft.report(maxChars: maxChars).text }.value
    }

    private func eventually(_ what: String, _ cond: @MainActor @Sendable () -> Bool) async {
        let ok = await waitUntil(timeout: .seconds(5), cond)
        #expect(ok, "never: \(what)")
    }

    // MARK: The tab

    @Test func troubleshootingTabVisibleSignedIn() {
        #expect(visibleTabs(isAdmin: false, isDeveloper: false, signedIn: true).map(\.id)
            == [.appearance, .sound, .devices, .troubleshooting, .thisKiosk])
        #expect(!visibleTabs(isAdmin: true, isDeveloper: true, signedIn: false).map(\.id).contains(.troubleshooting))
        let tab = SETTINGS_TABS.first { $0.id == .troubleshooting }
        #expect(tab?.label == "Troubleshooting")
        #expect(tab?.blurb == "Printer connection, tests and a report to share.")
        #expect(SettingsTabId(rawValue: "troubleshooting") == .troubleshooting)
    }

    /// With no printer saved, Connection offers Printer Setup: pushed onto the signed-in Settings'
    /// stack. The login gear's sheet has no stack (and shows Troubleshooting to nobody: it is for
    /// signed-in people), and while Label Printing waits for Kiosk Setup the gate would send
    /// Printer Setup straight back to Home, so neither offers it.
    @Test func printerSetupOpensFromTheSignedInSettingsOnly() throws {
        var path: [Route] = [.settings(.troubleshooting)]
        let binding = Binding(get: { path }, set: { path = $0 })
        let open = try #require(printerSetupOpener(path: binding, setupState: .complete, devMode: false))
        open()
        #expect(path == [.settings(.troubleshooting), .labelsPrinter])
        #expect(printerSetupOpener(path: binding, setupState: .incomplete, devMode: true) != nil)
        #expect(printerSetupOpener(path: binding, setupState: .incomplete, devMode: false) == nil)
        #expect(printerSetupOpener(path: binding, setupState: .failed, devMode: false) == nil)
        #expect(printerSetupOpener(path: nil, setupState: .complete, devMode: true) == nil)
        // Only with no printer saved; the note stays beside the button.
        let m = model()
        #expect(m.printer == nil)
        #expect(NO_TROUBLESHOOTING_PRINTER_TEXT == "No printer set up yet. Choose one in Label Printing › Printer Setup.")
    }

    @Test func nothingStartsBluetoothOrReachesThePrinterUntilTapped() async throws {
        settings.setPrinter(bluetoothPrinter)
        let m = model(isAdmin: true, isDeveloper: true)
        _ = m.connectionLines
        _ = try m.report(now: Date())
        try await Task.sleep(for: .milliseconds(30))
        #expect(bluetooth.scans == 0)
        #expect(bluetooth.connects.isEmpty)
        #expect(zebra.events.isEmpty)
    }

    // MARK: One printer connection at a time

    /// The speed test and Print Labels share the app's printer lock: a speed-test label never goes
    /// out while a scanned label is, nor the other way (Review Focus 5).
    @Test func troubleshootingSendsGoThroughPrinterLock() async throws {
        settings.setPrinter(network)
        let line = TroubleLine()
        zebra.line = line
        let printLabels = self.printLabels
        let network = self.network
        let m = model()

        // A speed-test label going out holds the printer: the scanned label waits its turn.
        line.hold = "START"
        let speed = try #require(m.startSpeedTest())
        await eventually("speed-test label on the printer") { line.held }
        let asset = Task { try await printLabels(network, "^XA^FDASSET^FS^XZ") }
        try await Task.sleep(for: .milliseconds(60))
        #expect(line.started.count == 1)
        line.hold = nil
        try await asset.value
        await speed.value
        #expect(line.started.count == 2)
        #expect(line.started.last == "^XA^FDASSET^FS^XZ")

        // And the other way: a scanned label going out holds the speed test.
        line.clearHeld()
        line.hold = "ASSET"
        let second = Task { try await printLabels(network, "^XA^FDASSET^FS^XZ") }
        await eventually("scanned label on the printer") { line.held }
        let speed2 = try #require(m.startSpeedTest())
        try await Task.sleep(for: .milliseconds(60))
        #expect(line.started.count == 3)
        line.hold = nil
        try await second.value
        await speed2.value
        #expect(line.started.count == 4)
        #expect(line.started.last?.contains("START") == true)
        #expect(line.maxOpen == 1)
        #expect(m.speedRows.count == 2)
        #expect(m.speedRows.allSatisfy { $0.error == nil && $0.seconds != nil })
    }

    /// The ask buttons go through the guard: a printer left needing a clear gets `~JX` first.
    @Test func asksClearFirstWhenThePrinterNeedsIt() async throws {
        settings.setPrinter(network)
        zebra.replies[ZebraCommands.hostStatus] = HS_REPLY
        await printerGuard.markSendFailed(for: network.connection)
        let m = model()
        await m.ask(.status)?.value
        #expect(zebra.events == ["~JX", "?~HS"])
        #expect(await printerGuard.state(for: network.connection) == .clean)
        let result = try #require(m.asks.last)
        #expect(result.reply == HS_REPLY)
        #expect(result.bytes == HS_REPLY.utf8.count)
        #expect(result.milliseconds != nil)
        #expect(result.meaning?.hasPrefix("Ready to print.") == true)
        #expect(result.error == nil)
    }

    @Test func eachAskSendsItsCommandAndSaysWhatTheReplyMeans() async throws {
        settings.setPrinter(network)
        zebra.replies = [ZebraCommands.hostStatus: HS_REPLY, "~HQES": HQES_REPLY,
                         "! U1 getvar \"head.resolution.in_dpi\"\r\n": "\"300\"",
                         ZebraCommands.peelerPresent: "\"Present\"", ZebraCommands.serialNumber: "\"\(ZD421_SERIAL)\"",
                         ZebraCommands.fontDirectory: HW_REPLY]
        let m = model()
        for ask in PrinterAsk.allCases { await m.ask(ask)?.value }
        #expect(zebra.events == PrinterAsk.allCases.map { "?" + $0.command })
        #expect(m.asks.map(\.label) == ["Status", "Error report", "DPI", "Peeler", "Serial number", "Font listing"])
        #expect(m.asks[2].meaning == "300 dpi")
        #expect(m.asks[3].meaning == "Present")
        #expect(m.asks[4].meaning == ZD421_SERIAL)
        #expect(m.asks[5].meaning == "TT0003M_.TTF (169188 bytes)")
        #expect(m.asks.allSatisfy { $0.error == nil && $0.bytes > 0 })

        // No reply says so (and how long it waited).
        zebra.replies = [:]
        await m.ask(.peeler)?.value
        #expect(m.asks.last?.error == "No reply.")
        #expect(m.asks.last?.milliseconds != nil)
    }

    // MARK: The command box and the Cut-send test

    @Test func freeTextOnlyForAdminsAndDevelopers() async throws {
        settings.setPrinter(network)
        let hi = "\u{02}ZD421-300dpi,V93.21.38Z,12,8176KB\u{03}\r\n"
        zebra.replies = ["~HI\r\n": hi, "! U1 getvar \"device.languages\"\r\n": "\"zpl\""]
        let crew = model()
        #expect(!crew.showsCommandBox)
        crew.commandText = "~HI"
        #expect(crew.sendCommand() == nil)
        #expect(zebra.events.isEmpty)

        for (admin, developer) in [(true, false), (false, true)] {
            let m = model(isAdmin: admin, isDeveloper: developer)
            #expect(m.showsCommandBox)
            m.commandText = "~HI"
            await m.sendCommand()?.value
            #expect(m.asks.last?.command == "~HI\r\n")
            #expect(m.asks.last?.reply == hi)
        }
        #expect(zebra.events == ["?~HI\r\n", "?~HI\r\n"])

        // iOS types curly quotes; the printer needs straight ones.
        let admin = model(isAdmin: true)
        admin.commandText = "! U1 getvar \u{201C}device.languages\u{201D}"
        await admin.sendCommand()?.value
        #expect(zebra.events.last == "?! U1 getvar \"device.languages\"\r\n")
        #expect(admin.asks.last?.reply == "\"zpl\"")
    }

    /// The command box is for setvar and other commands that reply nothing by design: no reply
    /// reads as sent, not failed. The ask buttons, which always get a reply, keep "No reply.".
    @Test func aCommandWithNoReplyReadsAsSent() async throws {
        settings.setPrinter(network)
        let admin = model(isAdmin: true)
        admin.commandText = "! U1 setvar \"device.friendly_name\" \"Dock\""
        await admin.sendCommand()?.value
        let result = try #require(admin.asks.last)
        #expect(zebra.events == ["?! U1 setvar \"device.friendly_name\" \"Dock\"\r\n"])
        #expect(result.error == nil)
        #expect(result.meaning == "Sent, no reply.")
        #expect(result.reply.isEmpty)
        #expect(result.milliseconds != nil)
        await admin.ask(.peeler)?.value
        #expect(admin.asks.last?.error == "No reply.")
    }

    /// A label or format typed in the command box (it starts with ^XA) goes out as a send, on the
    /// path Print Labels' labels take: a cut font refuses it, and one cut off part-way marks the
    /// printer for a `~JX`. Anything else is still a query.
    @Test func aFormatInTheCommandBoxGoesOutAsASend() async throws {
        settings.setPrinter(network)
        let m = model(isAdmin: true)
        let label = "  ^xa^FO10,10^A0N,30,30^FDHello^FS^XZ"
        m.commandText = label
        await m.sendCommand()?.value
        #expect(zebra.events == ["\(label)\r\n"])
        let sent = try #require(m.asks.last)
        #expect(FORMAT_SENT_TEXT == "Sent as a label or format; no reply is read.")
        #expect(sent.meaning == FORMAT_SENT_TEXT)
        #expect(sent.error == nil)
        #expect(sent.label == "Command")
        #expect(sent.command == "\(label)\r\n")
        #expect(sent.reply.isEmpty)
        #expect(sent.milliseconds != nil)
        #expect(m.running == nil)
        #expect(m.logLines.map(\.text).contains { $0.hasPrefix("→ Command (sent as a format): ") })
        #expect(m.logLines.map(\.text).contains { $0.hasPrefix("← Command: sent in ") && $0.hasSuffix(" ms") })

        // Cut off part-way: the printer is marked, and the next call clears first.
        zebra.failure = PrinterUnreachable(host: "10.0.0.5")
        await m.sendCommand()?.value
        zebra.failure = nil
        #expect(m.asks.last?.error == "Can't reach the printer at 10.0.0.5.")
        #expect(m.asks.last?.meaning == nil)
        #expect(await printerGuard.state(for: network.connection) == .needsClear)
        #expect(m.logLines.last?.text.hasSuffix(" ms: PrinterUnreachable: No printer answered at 10.0.0.5") == true)
        zebra.replies = ["~HS\r\n": HS_REPLY]
        m.commandText = "~HS"
        await m.sendCommand()?.value
        #expect(Array(zebra.events.suffix(2)) == ["~JX", "?~HS\r\n"])

        // A cut font refuses the format before anything goes out; a query still goes.
        await printerGuard.markFontCut(for: network.connection)
        m.commandText = label
        let before = zebra.events.count
        await m.sendCommand()?.value
        #expect(m.asks.last?.error == FONT_INSTALL_CUT_TEXT)
        #expect(zebra.events.count == before)
        m.commandText = "~HS"
        await m.sendCommand()?.value
        #expect(zebra.events.last == "?~HS\r\n")
    }

    /// A format holding a `^H` host command (`^HH`, `^HW`) asks the printer something, so it stays
    /// a query and its reply is read; `^FH` (field hex) asks nothing.
    @Test func aFormatWithAHostCommandStaysAQuery() async throws {
        settings.setPrinter(network)
        zebra.replies = ["^XA^HH^XZ\r\n": "\u{02}  PRINTER CONFIGURATION\u{03}", "  ^xa^hwE:*.*^xz\r\n": HW_REPLY]
        let m = model(isAdmin: true)
        m.commandText = "^XA^HH^XZ"
        await m.sendCommand()?.value
        #expect(zebra.events.last == "?^XA^HH^XZ\r\n")
        #expect(m.asks.last?.reply == "\u{02}  PRINTER CONFIGURATION\u{03}")
        m.commandText = "  ^xa^hwE:*.*^xz"
        await m.sendCommand()?.value
        #expect(zebra.events.last == "?  ^xa^hwE:*.*^xz\r\n")
        #expect(m.asks.last?.reply == HW_REPLY)
        // ^FH (field hex) isn't a host command: a format with it is still a send.
        for format in ["^XA^FO10,10^FDHello^FS^XZ", "^XA^FH^FDHi_20there^FS^XZ"] {
            m.commandText = format
            await m.sendCommand()?.value
            #expect(zebra.events.last == "\(format)\r\n")
            #expect(m.asks.last?.meaning == FORMAT_SENT_TEXT)
        }
    }

    /// A `~H` host command inside a format (`~HS`, `~HI`) asks too; `~` with any other letter, and
    /// `^H` or `~H` with no letter after it, ask nothing.
    @Test func aFormatWithATildeHostCommandStaysAQuery() async throws {
        #expect(!sendsAsFormat("^XA~HS^XZ"))
        #expect(!sendsAsFormat("^xa~hi^xz"))
        #expect(sendsAsFormat("^XA^FDA~B^FS^XZ"))
        // Where the text starts, and what follows ^H or ~H.
        #expect(sendsAsFormat("\t\u{00A0} ^Xa^FDx^FS^XZ"))
        #expect(!sendsAsFormat("~XA^FDx^FS^XZ"))
        #expect(!sendsAsFormat("x^XA^FDx^FS^XZ"))
        #expect(!sendsAsFormat("~HS"))
        #expect(sendsAsFormat("^XA^FDx^FS^XZ^H"))
        #expect(sendsAsFormat("^XA^H1^XZ"))
        #expect(!sendsAsFormat("^XA^Hé^XZ"))
        #expect(!sendsAsFormat("^XA^FDa^H^HZA^XZ"))
        settings.setPrinter(network)
        zebra.replies = ["^XA~HS^XZ\r\n": HS_REPLY]
        let m = model(isAdmin: true)
        m.commandText = "^XA~HS^XZ"
        await m.sendCommand()?.value
        #expect(zebra.events.last == "?^XA~HS^XZ\r\n")
        #expect(m.asks.last?.reply == HS_REPLY)
        #expect(try m.report().text.contains("␂****,0␃"))
    }

    @Test func cutSendTestSendsJXBeforeTheFullLabel() async throws {
        settings.setPrinter(network)
        let admin = model(isAdmin: true)
        #expect(!admin.showsCutSendTest)
        #expect(admin.runCutSendTest() == nil)
        #expect(zebra.events.isEmpty)

        let developer = model(isDeveloper: true)
        #expect(developer.showsCutSendTest)
        await developer.runCutSendTest()?.value
        try #require(zebra.events.count == 3)
        let full = zebra.events[2]
        #expect(full.hasPrefix("^XA^CI28^PW812^LL406"))
        #expect(full.hasSuffix("^XZ"))
        #expect(full.contains("^FDPrinter test^FS"))
        #expect(zebra.events[0] == String(full.prefix(full.count / 2)))
        #expect(zebra.events[1] == "~JX")
        #expect(await printerGuard.state(for: network.connection) == .clean)
        #expect(developer.cutSendMessage == CUT_SEND_DONE_TEXT)
        #expect(!developer.cutSendError)
    }

    /// The half label and its failure mark go in one turn of the lock: a scanned label queued
    /// behind the half gets the `~JX` first instead of merging into it.
    @Test func cutSendKeepsAQueuedLabelFromMergingIntoTheHalf() async throws {
        settings.setPrinter(network)
        let line = TroubleLine()
        zebra.line = line
        let printLabels = self.printLabels
        let network = self.network
        let m = model(isDeveloper: true)
        line.hold = "Printer test"
        let test = try #require(m.runCutSendTest())
        await eventually("half label on the printer") { line.held }
        let asset = Task { try await printLabels(network, "^XA^FDASSET^FS^XZ") }
        try await Task.sleep(for: .milliseconds(60))
        line.hold = nil
        try await asset.value
        await test.value
        try #require(zebra.events.count == 4)
        #expect(!zebra.events[0].hasSuffix("^XZ"))
        #expect(zebra.events[1] == "~JX")
        #expect(zebra.events[2] == "^XA^FDASSET^FS^XZ")
        #expect(zebra.events[3].hasSuffix("^XZ"))
        #expect(line.maxOpen == 1)
    }

    // MARK: When the printer can't be reached

    /// Bluetooth refusals the crew fixes on the iPad show with their buttons, as on Print Labels: a
    /// printer that forgot this iPad gets the steps with Connect (no Open Settings, Ruling 15),
    /// Bluetooth not allowed gets Open Settings, Bluetooth off neither. The card belongs to the
    /// section whose call met it, and each call replaces it: one that gets through, or fails any
    /// other way, clears it.
    @Test func aRefusalShowsWithItsButtonsUntilTheNextCall() async throws {
        settings.setPrinter(bluetoothPrinter)
        zebra.replies[ZebraCommands.hostStatus] = HS_REPLY
        let m = model(isAdmin: true, isDeveloper: true)
        let forgot = pairingLostText(serial: ZD421_SERIAL)
        zebra.failure = BluetoothPairingLost(host: ZD421_SERIAL)
        await m.readDetails()?.value
        #expect(m.reachProblem == TroubleReachProblem(action: .details, problem: PrinterReachProblem(text: forgot, offersSettings: false, offersConnect: true)))
        #expect(m.detailsError == forgot)

        zebra.failure = BluetoothUnavailable(host: ZD421_SERIAL, availability: .unauthorized)
        await m.ask(.status)?.value
        #expect(m.reachProblem == TroubleReachProblem(action: .ask, problem: PrinterReachProblem(text: BLUETOOTH_DENIED_TEXT, offersSettings: true, offersConnect: false)))
        #expect(m.asks.last?.error == BLUETOOTH_DENIED_TEXT)

        m.commandText = "~HS"
        await m.sendCommand()?.value
        #expect(m.reachProblem?.action == .command)

        // Off, even when it stopped the `~JX` before a speed-test label: its words, no buttons.
        await printerGuard.markSendFailed(for: bluetoothPrinter.connection)
        zebra.failure = BluetoothUnavailable(host: ZD421_SERIAL, availability: .poweredOff)
        await m.startSpeedTest()?.value
        #expect(m.reachProblem == TroubleReachProblem(action: .speed, problem: PrinterReachProblem(text: BLUETOOTH_OFF_TEXT, offersSettings: false, offersConnect: false)))
        #expect(m.speedRows.last?.error == BLUETOOTH_OFF_TEXT)

        zebra.failure = BluetoothPairingLost(host: ZD421_SERIAL)
        await m.runCutSendTest()?.value
        #expect(m.reachProblem?.action == .cutSend)
        #expect(m.reachProblem?.problem.offersConnect == true)

        // The printer off (not something to fix on the iPad): the row says so, the card goes.
        zebra.failure = PrinterUnreachable(host: ZD421_SERIAL)
        await m.ask(.status)?.value
        #expect(m.reachProblem == nil)

        // Connect (Read details) once it's forgotten in Settings: through, and the card goes.
        zebra.failure = BluetoothPairingLost(host: ZD421_SERIAL)
        await m.ask(.status)?.value
        #expect(m.reachProblem?.problem.offersConnect == true)
        zebra.failure = nil
        await m.readDetails()?.value
        #expect(m.reachProblem == nil)
        #expect(m.detailsError == nil)
    }

    /// Connect beside a card lower down (a speed run met the refusal) tries the printer again and,
    /// if it is still refused, keeps the card where the crew is looking.
    @Test func connectKeepsTheCardWhereItWas() async throws {
        settings.setPrinter(bluetoothPrinter)
        let m = model()
        zebra.failure = BluetoothPairingLost(host: ZD421_SERIAL)
        await m.startSpeedTest()?.value
        #expect(m.reachProblem?.action == .speed)
        await m.connectAgain()?.value
        #expect(m.reachProblem?.action == .speed)
        #expect(m.reachProblem?.problem.offersConnect == true)
        zebra.failure = nil
        await m.connectAgain()?.value
        #expect(m.reachProblem == nil)
        #expect(m.hostId != nil)
    }

    /// A clear that fails reads as the printer's own failure (the call itself never went out):
    /// "Can't reach the printer …", never "Couldn't clear the printer at … before sending".
    @Test func aFailedClearReadsAsTheUnreachableCopy() async throws {
        settings.setPrinter(bluetoothPrinter)
        let unreachable = "Can't reach the printer D8J224508535 over Bluetooth."
        let m = model(isDeveloper: true)
        await printerGuard.markSendFailed(for: bluetoothPrinter.connection)
        zebra.failure = PrinterUnreachable(host: ZD421_SERIAL)
        await m.startSpeedTest()?.value
        #expect(m.speedRows.last?.error == unreachable)
        await m.runCutSendTest()?.value
        #expect(m.cutSendMessage == unreachable)
        await m.ask(.status)?.value
        #expect(m.asks.last?.error == unreachable)
        await m.readDetails()?.value
        #expect(m.detailsError == unreachable)
        zebra.failure = PrinterTimeout(host: ZD421_SERIAL)
        await m.startSpeedTest()?.value
        #expect(m.speedRows.last?.error == "The printer didn't take it in time.")
        #expect(await printerGuard.state(for: bluetoothPrinter.connection) == .needsClear)
        #expect(zebra.events.isEmpty)
    }

    /// The Connection lines say whether Bluetooth itself is on, from what it last reported (nothing
    /// starts Bluetooth to find out); a network printer has no such line.
    @Test func connectionLinesSayWhetherBluetoothIsOn() {
        settings.setPrinter(bluetoothPrinter)
        let m = model()
        let cases: [(BluetoothAvailability, String?)] = [
            (.unknown, nil), (.ready, "On"), (.poweredOff, "Off"),
            (.unauthorized, "Not allowed for ServerSherpa Kiosk"), (.unsupported, "Not supported on this device"),
        ]
        for (availability, value) in cases {
            bluetooth.availability = availability
            #expect(m.connectionLines.first { $0.label == "Bluetooth" }?.value == value, "\(availability)")
        }
        #expect(bluetooth.scans == 0)
        #expect(bluetooth.connects.isEmpty)
        settings.setPrinter(network)
        bluetooth.availability = .poweredOff
        #expect(!m.connectionLines.contains { $0.label == "Bluetooth" })
    }

    // MARK: Speed test

    @Test func speedTestPrintsOnTheTemplateSizeAndConfirmsMoreThanOneLabel() async throws {
        settings.setPrinter(network)
        let pick = LabelPick(kind: .top, dpi: 203, synced: true, templateId: "t1", templateName: "Vegas Top", widthIn: 3, heightIn: 1.5)
        let m = model(pick: pick)
        #expect(m.speedSize == AlignmentSize(widthIn: 3, heightIn: 1.5, dpi: 203))
        m.speedRuns = 1
        #expect(!m.speedNeedsConfirm)
        m.speedRuns = 3
        #expect(m.speedNeedsConfirm)
        m.speedKb = 25
        await m.startSpeedTest()?.value
        #expect(zebra.events.count == 3)
        #expect(zebra.events.allSatisfy { $0.hasPrefix("^XA^CI28^PW609^LL305") })
        #expect(m.speedRows.map(\.run) == [1, 2, 3])
        #expect(m.speedRows.allSatisfy { abs($0.bytes - 25 * 1024) <= 512 && $0.targetKb == 25 })
        #expect(m.speedAverage != nil)
    }

    @Test func stoppingTheSpeedTestLetsTheLabelGoingOutFinish() async throws {
        settings.setPrinter(network)
        let line = TroubleLine()
        zebra.line = line
        let m = model()
        m.speedRuns = 5
        line.hold = "Run 1 "
        let run = try #require(m.startSpeedTest())
        await eventually("run 1 on the printer") { line.held }
        m.stopSpeedTest()
        #expect(m.speedStopping)
        line.hold = nil
        await run.value
        #expect(zebra.events.count == 1)
        #expect(m.speedRows.count == 1)
        #expect(m.speedRows.first?.error == nil)
        #expect(!m.speedStopping)
        #expect(m.running == nil)
    }

    @Test func aCutFontStopsTheSpeedTestBeforeAnythingGoesOut() async throws {
        settings.setPrinter(network)
        await printerGuard.markFontCut(for: network.connection)
        let m = model()
        m.speedRuns = 3
        await m.startSpeedTest()?.value
        #expect(zebra.events.isEmpty)
        #expect(m.speedRows.count == 1)
        #expect(m.speedRows.first?.error == FONT_INSTALL_CUT_TEXT)
    }

    // MARK: Bluetooth scan

    @Test func scanListsEveryNamedDeviceFlagsZebrasAndSavesNothing() async throws {
        settings.setPrinter(network)
        let m = model()
        m.scan()
        #expect(m.scanning)
        let zd421 = FoundBluetoothPrinter(id: UUID(), name: ZD421_SERIAL, rssi: -52, advertisesZebra: false)
        let mac = FoundBluetoothPrinter(id: UUID(), name: "James’s Mac mini", rssi: -70, advertisesZebra: false)
        bluetooth.hear([zd421, mac])
        await eventually("heard") { m.found == [zd421, mac] }
        m.stopScan()
        await eventually("scan ended") { !m.scanning }
        #expect(m.found?.filter(\.isZebra) == [zd421])
        #expect(m.scanMessage == nil)
        #expect(settings.current().printer == network)
        #expect(bluetooth.connects.isEmpty)
        #expect(zebra.events.isEmpty)

        // Bluetooth off: says so, then scans again by itself once it is on.
        bluetooth.availability = .poweredOff
        m.scan()
        await eventually("refused") { !m.scanning }
        #expect(m.scanMessage == BLUETOOTH_OFF_TEXT)
        #expect(m.scanMessageIsError)
        let scans = bluetooth.scans
        bluetooth.availability = .ready
        await eventually("scanning again") { bluetooth.scans == scans + 1 && m.scanning }
        #expect(m.scanMessage == nil)
        m.stopScan()
        await eventually("scan ended") { !m.scanning }
        #expect(m.scanMessage == NOTHING_HEARD_TEXT)
        #expect(!m.scanMessageIsError)
        // Once: Bluetooth going off and on again later starts nothing by itself.
        bluetooth.availability = .poweredOff
        bluetooth.availability = .ready
        try await Task.sleep(for: .milliseconds(50))
        #expect(bluetooth.scans == scans + 1)

        // Not allowed: the same once it is allowed, through any other states on the way.
        bluetooth.availability = .unauthorized
        m.scan()
        await eventually("refused") { !m.scanning }
        #expect(m.scanMessage == BLUETOOTH_DENIED_TEXT)
        let deniedAt = bluetooth.scans
        bluetooth.availability = .poweredOff
        try await Task.sleep(for: .milliseconds(30))
        bluetooth.availability = .unknown
        try await Task.sleep(for: .milliseconds(30))
        #expect(bluetooth.scans == deniedAt)
        #expect(!m.scanning)
        bluetooth.availability = .ready
        await eventually("scanning once allowed") { bluetooth.scans == deniedAt + 1 && m.scanning }
        m.stopScan()
        await eventually("scan ended") { !m.scanning }
    }

    /// Back in front (from Settings, say): a scan Bluetooth refused runs again when Bluetooth reads
    /// ready, once, however the app hears of it first.
    @Test func comingBackWithBluetoothReadyRunsTheRefusedScan() async throws {
        settings.setPrinter(network)
        let m = model()
        m.appResumed()
        #expect(bluetooth.scans == 0)
        bluetooth.availability = .poweredOff
        m.scan()
        await eventually("refused") { !m.scanning && m.scanMessage == BLUETOOTH_OFF_TEXT }
        let refusedAt = bluetooth.scans
        m.appResumed()
        #expect(bluetooth.scans == refusedAt)
        // Ready, and the app back in front in the same turn: one scan, not two.
        bluetooth.availability = .ready
        m.appResumed()
        #expect(bluetooth.scans == refusedAt + 1)
        #expect(m.scanning)
        try await Task.sleep(for: .milliseconds(50))
        #expect(bluetooth.scans == refusedAt + 1)
        m.appResumed()
        #expect(bluetooth.scans == refusedAt + 1)
        m.stopScan()
        await eventually("scan ended") { !m.scanning }
    }

    /// Leaving the tab, or tapping Scan again, ends the wait for Bluetooth: nothing scans by itself
    /// while the tab is away.
    @Test func aRefusedScanWaitsOnlyWhileTheTabShows() async throws {
        settings.setPrinter(network)
        let m = model()
        bluetooth.availability = .poweredOff
        m.scan()
        await eventually("refused") { !m.scanning && m.scanMessage == BLUETOOTH_OFF_TEXT }
        let refusedAt = bluetooth.scans
        m.close()
        bluetooth.availability = .ready
        m.appResumed()
        try await Task.sleep(for: .milliseconds(50))
        #expect(bluetooth.scans == refusedAt)
        m.open()
        m.appResumed()
        try await Task.sleep(for: .milliseconds(50))
        #expect(bluetooth.scans == refusedAt)
        #expect(!m.scanning)

        // Scan tapped again, refused again, then a scan that got through: nothing more waits.
        bluetooth.availability = .poweredOff
        m.scan()
        await eventually("refused") { !m.scanning && m.scanMessage == BLUETOOTH_OFF_TEXT }
        bluetooth.availability = .ready
        await eventually("scanning again") { m.scanning }
        let afterRescan = bluetooth.scans
        m.stopScan()
        await eventually("scan ended") { !m.scanning }
        bluetooth.availability = .poweredOff
        bluetooth.availability = .ready
        m.appResumed()
        try await Task.sleep(for: .milliseconds(50))
        #expect(bluetooth.scans == afterRescan)
    }

    /// A scan can't start while a speed test runs: it shares the radio with the label's chunk
    /// acknowledgments and would lower its KB/s.
    @Test func noScanDuringASpeedTest() async throws {
        settings.setPrinter(network)
        let line = TroubleLine()
        zebra.line = line
        let m = model()
        line.hold = "START"
        let speed = try #require(m.startSpeedTest())
        await eventually("label going out") { line.held }
        m.scan()
        #expect(!m.scanning)
        #expect(bluetooth.scans == 0)
        line.hold = nil
        await speed.value
        m.scan()
        #expect(m.scanning)
        m.stopScan()
        await eventually("scan ended") { !m.scanning }

        // Nor when Bluetooth comes on during one, for a scan it refused.
        bluetooth.availability = .poweredOff
        m.scan()
        await eventually("refused") { !m.scanning && m.scanMessage == BLUETOOTH_OFF_TEXT }
        let refusedAt = bluetooth.scans
        line.clearHeld()
        line.hold = "START"
        let speed2 = try #require(m.startSpeedTest())
        await eventually("label going out") { line.held }
        bluetooth.availability = .ready
        try await Task.sleep(for: .milliseconds(50))
        m.appResumed()
        #expect(!m.scanning)
        #expect(bluetooth.scans == refusedAt)
        line.hold = nil
        await speed2.value
    }

    /// A scan cut short by a printer call (a label going out) says so instead of "nothing heard",
    /// which only a full scan of a ready Bluetooth, or Stop, says; one ended by the app going to
    /// the background says nothing.
    @Test func aScanCutShortSaysThePrinterWasInUse() async throws {
        settings.setPrinter(network)
        let m = model()
        m.scan()
        bluetooth.endScanByItself()
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == "The scan stopped because the printer was in use. Scan again.")
        m.scan()
        bluetooth.finishScan()
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == NOTHING_HEARD_TEXT)
        m.scan()
        m.stopScan()
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == NOTHING_HEARD_TEXT)
        m.scan()
        bluetooth.endScanByItself(.closed)
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == nil)
    }

    /// A scan something else ended before its time (another scan took over, or Bluetooth refused
    /// it and was back by the time it ended) says so, as information, and waits for Scan again.
    @Test func aScanEndedEarlySaysSo() async throws {
        settings.setPrinter(network)
        let m = model()
        #expect(SCAN_ENDED_EARLY_TEXT == "The scan stopped early. Scan again.")
        m.scan()
        bluetooth.endScanByItself(.replaced)
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == SCAN_ENDED_EARLY_TEXT)
        #expect(!m.scanMessageIsError)
        #expect(m.logLines.last { $0.text.hasPrefix("Bluetooth scan ended") }?.text.hasSuffix("(\(SCAN_ENDED_EARLY_TEXT))") == true)
        m.scan()
        bluetooth.endScanByItself(.refused)
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == SCAN_ENDED_EARLY_TEXT)
        let scans = bluetooth.scans
        bluetooth.availability = .poweredOff
        bluetooth.availability = .ready
        try await Task.sleep(for: .milliseconds(50))
        #expect(bluetooth.scans == scans)
        // The cut-short note is information too.
        m.scan()
        bluetooth.endScanByItself()
        await eventually("ended") { !m.scanning }
        #expect(m.scanMessage == SCAN_CUT_SHORT_TEXT)
        #expect(!m.scanMessageIsError)
    }

    // MARK: Report

    /// D13 "a log, like the test screen's": the report's log carries the Bluetooth link's own
    /// events beside the tab's lines, in time order.
    @Test func reportMergesTheLinksEventsIntoTheLog() throws {
        settings.setPrinter(bluetoothPrinter)
        let m = model()
        let now = Date()
        m.log("Tab line")
        bluetooth.events = [BluetoothLinkEvent(at: now.addingTimeInterval(-60), text: "Connect to D8J224508535 started"),
                            BluetoothLinkEvent(at: now.addingTimeInterval(60), text: "Link dropped: The link closed"),
                            BluetoothLinkEvent(at: now.addingTimeInterval(61), text: "Connect failed: password=hunter2")]
        let text = try m.report(now: now).text
        let connect = try #require(text.range(of: "  Bluetooth: Connect to D8J224508535 started\n"))
        let tab = try #require(text.range(of: "  Tab line\n"))
        let drop = try #require(text.range(of: "  Bluetooth: Link dropped: The link closed\n"))
        let failed = try #require(text.range(of: "  Bluetooth: Connect failed: password=[redacted]\n"))
        #expect(connect.lowerBound < tab.lowerBound)
        #expect(tab.lowerBound < drop.lowerBound)
        #expect(drop.lowerBound < failed.lowerBound)
        // The link's events are masked as the tab's lines are.
        #expect(!text.contains("hunter2"))
    }

    @Test func reportCarriesEverything() async throws {
        settings.setPrinter(bluetoothPrinter)
        bluetooth.linkUp(BluetoothPrinterInfo(peripheralId: peripheral, manufacturer: "Zebra Technologies", model: "ZD421",
                                              serial: ZD421_SERIAL, firmware: "V93.21.38Z", linkOs: "7.3"))
        zebra.replies = [ZebraCommands.hostStatus: HS_REPLY, "~HQES": HQES_REPLY,
                         "! U1 getvar \"head.resolution.in_dpi\"\r\n": "\"300\"",
                         ZebraCommands.peelerPresent: "\"Present\"", ZebraCommands.serialNumber: "\"\(ZD421_SERIAL)\"",
                         ZebraCommands.fontDirectory: HW_REPLY]
        let m = model()
        await m.readDetails()?.value
        for ask in PrinterAsk.allCases { await m.ask(ask)?.value }
        zebra.failure = PrinterNoReply(host: ZD421_SERIAL)
        await m.ask(.peeler)?.value
        zebra.failure = nil
        await m.startSpeedTest()?.value
        m.scan()
        bluetooth.hear([FoundBluetoothPrinter(id: peripheral, name: ZD421_SERIAL, rssi: -52, advertisesZebra: false),
                        FoundBluetoothPrinter(id: UUID(), name: "James’s Mac mini", rssi: -70, advertisesZebra: false)])
        await eventually("heard") { m.found?.count == 2 }
        m.stopScan()
        await eventually("scan ended") { !m.scanning }

        let report = try m.report(now: Date(timeIntervalSince1970: 1_792_000_000))
        #expect(report.name.range(of: #"^printer-report-\d{8}-\d{6}\.txt$"#, options: .regularExpression) != nil)
        let text = report.text
        // This device and app.
        #expect(text.contains("Device: iPad16,6 (ipad), iPadOS 27.2"))
        #expect(text.contains("App: version 1.0 (build 7)"))
        // The saved printer and its connection.
        #expect(text.contains(printerSummary(bluetoothPrinter)))
        for line in m.connectionLines { #expect(text.contains("\(line.label): \(line.value)")) }
        #expect(text.contains("Bluetooth LE"))
        #expect(text.contains(peripheral.uuidString))
        #expect(text.contains("244 bytes"))
        // The printer's details: ~HI and Device Information.
        #expect(!m.hostIdLines.isEmpty && !m.deviceInfoLines.isEmpty)
        for line in m.hostIdLines + m.deviceInfoLines { #expect(text.contains("\(line.label): \(line.value)")) }
        #expect(text.contains("ZD421-300dpi"))
        #expect(text.contains("Zebra Technologies"))
        // Every ask: its command and reply with the control bytes visible, bytes and milliseconds,
        // and the one that failed with its error.
        #expect(m.asks.count == PrinterAsk.allCases.count + 1)
        for ask in m.asks {
            #expect(text.contains(visibleBytes(ask.command)))
            #expect(text.contains("\(ask.bytes) B in \(ask.milliseconds ?? -1) ms"))
            // ~HS's third string is the printer's front-panel password: masked in the report.
            let reply = ask.command == ZebraCommands.hostStatus
                ? ask.reply.replacingOccurrences(of: "\u{02}0000,0\u{03}", with: "\u{02}****,0\u{03}") : ask.reply
            for line in visibleBytes(reply).split(separator: "\n") { #expect(text.contains(line)) }
        }
        #expect(text.contains("␂030,0,0,0612,000,0,0,0,000,0,0,0␃␍␊"))
        #expect(text.contains("␂****,0␃␍␊"))
        #expect(!text.contains("␂0000,0␃"))
        #expect(text.contains("ERRORS:         0 00000000 00000000"))
        #expect(text.contains("Error: No reply."))
        // The speed rows.
        let row = try #require(m.speedRows.first)
        #expect(text.contains("1 | 10 | \(row.bytes) | "))
        // What the Bluetooth scan heard: the Zebra by its serial, other devices by signal alone,
        // in the scan section and in the log (the tab still lists them by name).
        #expect(text.contains("\(ZD421_SERIAL) · -52 dBm · Zebra"))
        #expect(text.contains("  Other device · -70 dBm\n"))
        #expect(text.contains("Devices that aren't Zebras are listed by signal only."))
        #expect(!text.contains("James"))
        #expect(m.found?.map(\.name) == [ZD421_SERIAL, "James’s Mac mini"])
        // The log.
        #expect(!m.logLines.isEmpty)
        for line in m.logLines { #expect(text.contains(line.text)) }
        #expect(m.logLines.contains { $0.text == "  Other device · -70 dBm" })
    }

    /// A scan that heard only Zebras says nothing about other devices.
    @Test func aScanOfOnlyZebrasNamesThemAll() async throws {
        settings.setPrinter(network)
        let m = model()
        m.scan()
        bluetooth.hear([FoundBluetoothPrinter(id: UUID(), name: ZD421_SERIAL, rssi: -52, advertisesZebra: true)])
        await eventually("heard") { m.found?.count == 1 }
        m.stopScan()
        await eventually("scan ended") { !m.scanning }
        let text = try m.report().text
        #expect(text.contains("  \(ZD421_SERIAL) · -52 dBm · Zebra (advertises Zebra)\n"))
        #expect(!text.contains("Devices that aren't Zebras"))
    }

    /// A token, a key and a password planted in everything the tab hears (a failed call's own
    /// message, the command typed, the printer's replies) never reach the report. The tab never
    /// sees the session, cookies or keys at all: its inputs are the label settings, the link, the
    /// printer and the role checks.
    @Test func reportCarriesNoSecrets() async throws {
        settings.setPrinter(network)
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aW5hIn0.c2VjcmV0LXRva2VuLTdmM2E"
        let key = "sk-station-9c41d2e7b0"
        let password = "Hunter2-Move-Pass"
        let m = model(isAdmin: true)
        zebra.failure = StrayError(text: "Authorization: Bearer \(token); station_key=\(key)")
        await m.ask(.status)?.value
        zebra.failure = StrayError(text: "move password \(password) rejected")
        await m.readDetails()?.value
        zebra.failure = PrinterClearFailed(host: "10.0.0.5", cause: StrayError(text: "cookie: refresh=\(token)"))
        await m.startSpeedTest()?.value
        zebra.failure = PrinterUnreachable(host: "10.0.0.5")
        await m.ask(.serial)?.value
        zebra.failure = nil
        // An admin sets a Wi-Fi password and reads secrets back: the report keeps the command, not the values.
        zebra.replies = [
            "! U1 getvar \"wlan.wpa.psk\"\r\n": "\"\(password)\"",
            "! U1 getvar \"wlan.private_key_password\"\r\n": "\"\(key)\"",
            "! U1 getvar \"bluetooth.bluetooth_pin\"\r\n": "\"\(key)\"",
        ]
        for command in [
            "! U1 setvar \"wlan.wpa.psk\" \"\(password)\"",
            "! U1 getvar \"wlan.wpa.psk\"",
            "! U1 getvar \"wlan.private_key_password\"",
            "! U1 getvar \"bluetooth.bluetooth_pin\"",
            "password=\(password)&token=\(token)",
        ] {
            m.commandText = command
            await m.sendCommand()?.value
        }
        let text = try m.report().text
        for secret in [token, key, password, "Bearer", "rejected", "refresh"] {
            #expect(!text.contains(secret), "the report carries \(secret):\n\(text)")
        }
        // What was asked still shows.
        #expect(text.contains("setvar \"wlan.wpa.psk\""))
        #expect(text.contains("getvar \"wlan.private_key_password\""))
        #expect(text.contains("    [redacted: the reply to a secret setting]"))
        #expect(text.contains("Something went wrong (StrayError)."))
        #expect(text.contains("Can't reach the printer at 10.0.0.5."))
    }

    /// The reply to a secret setting is replaced whole in the report, and its size goes too, on
    /// the ask's line and in the log: it would give away the secret's length. Other replies keep
    /// their size.
    @Test func aSecretReplysSizeIsNotShown() async throws {
        settings.setPrinter(network)
        let m = model(isAdmin: true)
        let password = "Hunter2-Move-Pass-0123456789-abcdefgh"   // 37 characters, quoted: 39 bytes
        zebra.replies = [
            "! U1 getvar \"wlan.wpa.psk\"\r\n": "\"\(password)\"",
            "! U1 getvar \"ip.addr\"\r\n": "\"10.0.0.5\"",
        ]
        for command in ["! U1 getvar \"wlan.wpa.psk\"", "! U1 getvar \"ip.addr\""] {
            m.commandText = command
            await m.sendCommand()?.value
        }
        let secret = try #require(m.asks.first { asksForASecret($0.command) })
        let plain = try #require(m.asks.first { !asksForASecret($0.command) })
        #expect(secret.bytes == 39)
        let hidden = "\(secret.milliseconds ?? -1) ms (size hidden: a secret setting)"
        #expect(askSizeText(command: secret.command, bytes: secret.bytes, milliseconds: secret.milliseconds) == hidden)

        let text = try m.report().text
        #expect(!text.contains(" 39 B"), "the report gives the secret's size:\n\(text)")
        #expect(!text.contains(password))
        #expect(text.contains("  \(hidden)\n  Reply:\n    [redacted: the reply to a secret setting]\n"))
        #expect(text.contains("  \(plain.bytes) B in \(plain.milliseconds ?? -1) ms\n"))
        // The log, which the report carries too.
        #expect(!m.logLines.contains { $0.text.contains(" 39 B") })
        #expect(m.logLines.contains { $0.text == "← Command: \(hidden)" })
        #expect(m.logLines.contains { $0.text == "← Command: \(plain.bytes) B in \(plain.milliseconds ?? -1) ms" })
    }

    /// Copy puts the report on this device's pasteboard only (`.localOnly`: no Universal Clipboard).
    @Test func copyWritesThePlainText() {
        let board = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: board.name) }
        pasteLocalOnly("== Printer report ==", to: board)
        #expect(board.string == "== Printer report ==")
    }

    /// A quoted secret is hidden whole, spaces and all, up to its matching closing quote: in SGD's
    /// `"name" "value"`, `name: "value"`, single quotes, JSON, with an escaped or embedded quote,
    /// and one that never closes; in what an admin types and in what the printer replies.
    @Test func aQuotedSecretWithSpacesIsHiddenWhole() async throws {
        settings.setPrinter(network)
        let m = model(isAdmin: true)
        let replyCommand = "! U1 getvar \"device.config\"\r\n"
        zebra.replies = [replyCommand: "{\"wlan.wpa.psk\": \"uniform7 victor7 whiskey7\", \"ip.addr\": \"10.0.0.5\"}"]
        let typed = [
            "! U1 setvar \"wlan.wpa.psk\" \"horse7 battery7 staple7\"",
            "password: \"alpha7 bravo7 charlie7\"",
            "token='delta7 echo7 foxtrot7'",
            "{\"api_key\": \"golf7 hotel7 india7\", \"user\": \"tina\"}",
            "password=\"juliet7 \\\"kilo7\\\" lima7\"",
            "secret='mike7 \"november7\" oscar7'",
            "! U1 setvar \"wlan.wpa.psk\" \"it's7 papa7 quebec7\"",
            "passphrase: \"romeo7 sierra7 tango7",
            "! U1 getvar \"device.config\"",
        ]
        for command in typed {
            m.commandText = command
            await m.sendCommand()?.value
        }
        let text = try m.report().text
        let words = [
            "horse7", "battery7", "staple7", "alpha7", "bravo7", "charlie7", "delta7", "echo7", "foxtrot7",
            "golf7", "hotel7", "india7", "juliet7", "kilo7", "lima7", "mike7", "november7", "oscar7",
            "it's7", "papa7", "quebec7", "romeo7", "sierra7", "tango7", "uniform7", "victor7", "whiskey7",
        ]
        for word in words { #expect(!text.contains(word), "the report carries \(word):\n\(text)") }
        // What was asked, and what isn't secret, still shows.
        #expect(text.contains("setvar \"wlan.wpa.psk\" \"[redacted]\""))
        #expect(text.contains("\"user\": \"tina\""))
        #expect(text.contains("\"ip.addr\": \"10.0.0.5\""))
    }

    /// A tab typed in the command box (shown as `<09>`) is no way around the masking.
    @Test func aTabTypedInTheCommandBoxIsStillMasked() async throws {
        settings.setPrinter(network)
        let m = model(isAdmin: true)
        m.commandText = "password:\thunter2"
        await m.sendCommand()?.value
        #expect(try !m.report().text.contains("hunter2"))
    }

    /// A stray error's own message could carry anything: the tab says only its kind, and so does
    /// the report.
    @Test func aStrayErrorSaysOnlyItsKind() async throws {
        settings.setPrinter(network)
        let m = model()
        zebra.failure = StrayError(text: "socket said: hello")
        await m.ask(.serial)?.value
        #expect(m.asks.last?.error == "Something went wrong (StrayError).")
        await m.readDetails()?.value
        #expect(m.detailsError == "Something went wrong (StrayError).")
        #expect(try !m.report().text.contains("socket said"))
    }

    /// The log says what kind of failure it was, and its words only when they are the app's own
    /// printer words (its cause's too).
    @Test func aLoggedFailureCarriesOnlyItsKind() async throws {
        settings.setPrinter(network)
        let m = model()
        zebra.failure = StrayError(text: "socket said: hello")
        await m.ask(.serial)?.value
        zebra.failure = PrinterTimeout(host: "10.0.0.5")
        await m.readDetails()?.value
        zebra.failure = PrinterClearFailed(host: "10.0.0.5", cause: StrayError(text: "socket said: bye"))
        await m.ask(.dpi)?.value
        // Last: a failed send marks the printer for a clear, which the next call would send first.
        zebra.failure = PrinterClearFailed(host: "10.0.0.5", cause: PrinterUnreachable(host: "10.0.0.5"))
        await m.startSpeedTest()?.value
        let failures = m.logLines.map(\.text).filter { $0.contains("failed") }
        try #require(failures.count == 4, "\(failures)")
        #expect(failures[0].hasPrefix("← Serial number failed after ") && failures[0].hasSuffix(" ms: StrayError"))
        #expect(failures[1] == "← ~HI failed: PrinterTimeout: The printer at 10.0.0.5 didn't take the job in time")
        #expect(failures[2].hasSuffix(" ms: PrinterClearFailed: Couldn't clear the printer at 10.0.0.5 before sending (cause StrayError)"))
        #expect(failures[3] == "Run 1 failed: PrinterClearFailed: Couldn't clear the printer at 10.0.0.5 before sending"
            + " (cause PrinterUnreachable: No printer answered at 10.0.0.5)")
        #expect(!m.logLines.contains { $0.text.contains("socket said") })
    }

    /// The ask card and the report show `~HS`'s front-panel password as `****`, also when `~HS`
    /// sits inside a format typed in the command box; the reply kept underneath is the printer's.
    @Test func thePanelPasswordIsHiddenOnTheCardAndInTheReport() async throws {
        settings.setPrinter(network)
        zebra.replies = [ZebraCommands.hostStatus: HS_REPLY, "^XA~HS^XZ\r\n": HS_REPLY]
        let m = model(isAdmin: true)
        await m.ask(.status)?.value
        m.commandText = "^XA~HS^XZ"
        await m.sendCommand()?.value
        #expect(m.asks.count == 2)
        for ask in m.asks {
            #expect(ask.reply == HS_REPLY)
            #expect(ask.shownReply.contains("␂****,0␃␍␊"))
            #expect(!ask.shownReply.contains("␂0000,0␃"))
            #expect(ask.shownReply.contains("␂030,0,0,0612,000,0,0,0,000,0,0,0␃␍␊"))
        }
        #expect(m.asks.first?.meaning?.hasPrefix("Ready to print.") == true)
        let text = try m.report().text
        #expect(text.contains("␂****,0␃"))
        #expect(!text.contains("␂0000,0␃"))
        // Any other reply shows as it came.
        zebra.replies = [ZebraCommands.serialNumber: "\"\(ZD421_SERIAL)\""]
        await m.ask(.serial)?.value
        #expect(m.asks.last?.shownReply == visibleBytes("\"\(ZD421_SERIAL)\""))
    }

    /// A pasted label in the command box and a 64 KB one-line reply still make a report quickly.
    @Test func aReportWithAPastedLabelAndAHugeReplyIsQuick() async throws {
        settings.setPrinter(network)
        let hex = String(String(repeating: "0123456789ABCDEF", count: 100_000 / 16 + 1).prefix(100_000))
        zebra.replies = ["! U1 getvar \"device.dump\"\r\n": "\"" + String(hex.prefix(65_000)) + "\""]
        let m = model(isAdmin: true)
        m.commandText = "^XA^FO0,0^GFA,50000,50000,100,\(hex)^FS^XZ"
        await m.sendCommand()?.value
        m.commandText = "! U1 getvar \"device.dump\""
        await m.sendCommand()?.value
        var text = ""
        let elapsed = try ContinuousClock().measure { text = try m.report().text }
        #expect(elapsed < .seconds(1), "the report took \(elapsed)")
        #expect(text.contains(String(hex.prefix(1_000))))
    }

    @Test func logKeepsTheLast5000LinesAndTheSharedReportFits() async throws {
        let m = model()
        for i in 1...5_010 { m.log("line \(i)") }
        #expect(m.logLines.count == 5_000)
        #expect(m.logLines.first?.text == "line 11")
        let text = try await offMainReport(m)
        #expect(text.contains("  line 5010\n"))
        #expect(text.contains("  line 11\n"))
        #expect(!text.contains("  line 10\n"))

        // Copied, it fits the share limit: the oldest log lines go first, and it says so.
        #expect(SHARE_MAX_CHARS == 100_000)
        for i in 1...5_000 { m.log("a long line \(i) " + String(repeating: "x", count: 80)) }
        let now = Date()
        let shared = try await offMainReport(m, now: now, maxChars: SHARE_MAX_CHARS)
        #expect(shared.utf16.count <= SHARE_MAX_CHARS)
        #expect(shared.contains("== Saved printer =="))
        #expect(shared.contains("a long line 5000 "))
        #expect(shared.contains("older log lines left out to fit"))
        #expect(!shared.contains("a long line 1 x"))
        // Whole lines only, newest kept, the count of those left out said once.
        let kept = shared.components(separatedBy: "\n").filter { $0.contains("a long line ") }
        let left = try #require(shared.range(of: #"\((\d+) older log lines left out to fit the share limit\)\n"#, options: .regularExpression))
        let leftOut = Int(shared[left].dropFirst().prefix { $0.isNumber }) ?? -1
        #expect(leftOut + kept.count == 5_000)
        #expect(kept.last?.hasSuffix("a long line 5000 " + String(repeating: "x", count: 80)) == true)
        #expect(shared.hasSuffix("\n"))
        // With no limit, nothing is left out, and up to the cap the text is the same.
        let whole = try await offMainReport(m, now: now)
        #expect(!whole.contains("left out to fit"))
        #expect(whole.contains("  a long line 1 x"))
        #expect(whole.hasSuffix(shared.components(separatedBy: "fit the share limit)\n").last ?? "-"))
    }

    /// What isn't the log (a huge reply, say) past the limit is cut, and the report says where.
    @Test func aReportTooLongWithoutItsLogIsCutAndSaysSo() async throws {
        settings.setPrinter(network)
        let big = String(repeating: "0123456789", count: 15_000)
        zebra.replies = ["! U1 getvar \"device.dump\"\r\n": "\"" + big + "\""]
        let m = model(isAdmin: true)
        m.commandText = "! U1 getvar \"device.dump\""
        await m.sendCommand()?.value
        let shared = try await offMainReport(m, maxChars: SHARE_MAX_CHARS)
        #expect(shared.utf16.count <= SHARE_MAX_CHARS)
        #expect(shared.utf16.count > SHARE_MAX_CHARS - 100)
        #expect(shared.hasSuffix("\n(the report was cut here to fit the share limit)\n"))
        #expect(shared.hasPrefix("ServerSherpa Kiosk · Printer troubleshooting report\n"))
        // A cut never splits a character in two (each printer emoji is two UTF-16 units, so one of
        // two neighboring limits lands inside one).
        let emoji = String(repeating: "\u{1F5A8}", count: 60_000)
        let wide = model(device: { "Device: \(emoji)" })
        let now = Date()
        for limit in 1_000...1_003 {
            let cut = try await offMainReport(wide, now: now, maxChars: limit)
            #expect(cut.utf16.count <= limit)
            #expect(cut.utf16.count >= limit - 1)
            #expect(cut.hasSuffix("\n(the report was cut here to fit the share limit)\n"))
            #expect(cut.unicodeScalars.allSatisfy { $0 != "\u{FFFD}" })
        }
    }

    /// Copy and Share write the report off the main actor (5,000 log lines and a pasted label take
    /// a moment), from what the tab showed when they were tapped.
    @Test func theSharedReportIsBuiltOffTheMainActor() async throws {
        settings.setPrinter(network)
        let device = DeviceLine()
        let m = model(device: { try device.read() })
        m.log("Tapped")
        var pasted: String?
        await m.copyReport { pasted = $0 }?.value
        #expect(pasted?.hasPrefix("ServerSherpa Kiosk · Printer troubleshooting report\n") == true)
        #expect(pasted?.contains("  Tapped\n") == true)
        #expect(device.readsOnMain == [false])
        let url = try await m.reportFile()
        #expect(device.readsOnMain == [false, false])
        let file = try String(contentsOf: url, encoding: .utf8)
        #expect(file.hasPrefix("ServerSherpa Kiosk · Printer troubleshooting report\n"))
        #expect(url.lastPathComponent.range(of: #"^printer-report-\d{8}-\d{6}\.txt$"#, options: .regularExpression) != nil)
    }

    /// Copy puts the report, at most `SHARE_MAX_CHARS`, on the pasteboard and says "Report copied.";
    /// Share sends all of it, as a file (`printer-report-<stamp>.txt`).
    @Test func copyIsCappedAndSaysSoShareSendsItAll() async throws {
        settings.setPrinter(network)
        let m = model()
        for i in 1...5_000 { m.log("a long line \(i) " + String(repeating: "x", count: 80)) }
        #expect(REPORT_COPIED_TEXT == "Report copied.")
        #expect(!m.reportCopied)
        var pasted: String?
        await m.copyReport { pasted = $0 }?.value
        let copied = try #require(pasted)
        #expect(copied.utf16.count <= SHARE_MAX_CHARS)
        #expect(copied.contains("older log lines left out to fit the share limit"))
        #expect(m.reportCopied)
        #expect(!m.reportFailed)
        #expect(!m.reportBuilding)
        let url = try await m.reportFile()
        let file = try String(contentsOf: url, encoding: .utf8)
        #expect(file.utf16.count > SHARE_MAX_CHARS)
        #expect(file.contains("  a long line 1 x"))
        #expect(!file.contains("left out to fit"))
        // Sharing takes the copied note away.
        #expect(!m.reportCopied)
    }

    /// A report that fails to build says so, nothing is copied or shared, and the tab carries on.
    @Test func aReportThatFailsToBuildSaysSoAndTheTabCarriesOn() async throws {
        settings.setPrinter(network)
        let device = DeviceLine()
        let m = model(device: { try device.read() })
        #expect(REPORT_FAILED_TEXT == "Couldn't build the report. Try again.")
        await m.copyReport { _ in }?.value
        #expect(m.reportCopied)
        device.fails = true
        var pasted: String?
        await m.copyReport { pasted = $0 }?.value
        #expect(pasted == nil)
        #expect(m.reportFailed)
        #expect(!m.reportCopied)
        #expect(!m.reportBuilding)
        await #expect(throws: (any Error).self) { try await m.reportFile() }
        #expect(m.reportFailed)
        // The tab still works, and the next good build clears the note.
        await m.readDetails()?.value
        #expect(m.hostId != nil)
        device.fails = false
        await m.copyReport { pasted = $0 }?.value
        #expect(pasted != nil)
        #expect(!m.reportFailed)
        #expect(m.reportCopied)
    }

    /// "Preparing the report…" shows only for a build that takes longer than 400 ms; a second Copy
    /// while one builds does nothing.
    @Test func preparingTheReportShowsOnlyWhenItTakesAMoment() async throws {
        settings.setPrinter(network)
        let device = DeviceLine()
        let m = model(device: { try device.read() })
        await m.copyReport { _ in }?.value
        #expect(!m.reportSlow)

        device.gate = DispatchSemaphore(value: 0)
        let started = ContinuousClock.now
        var pasted = 0
        let copy = try #require(m.copyReport { _ in pasted += 1 })
        #expect(m.reportBuilding)
        #expect(!m.reportSlow)
        #expect(m.copyReport { _ in pasted += 1 } == nil)
        // Generous: other tests' reports can keep the main actor busy; the build waits for the gate.
        #expect(await waitUntil(timeout: .seconds(20)) { m.reportSlow }, "never: preparing shows")
        #expect(ContinuousClock.now - started >= .milliseconds(400))
        #expect(m.reportBuilding)
        device.gate?.signal()
        await copy.value
        #expect(!m.reportSlow)
        #expect(!m.reportBuilding)
        #expect(pasted == 1)
        #expect(m.reportCopied)
    }
}

/// The report's device line as a test sets it: it can fail or wait, and it notes whether each read
/// was on the main thread.
private final class DeviceLine: @unchecked Sendable {
    private let lock = NSLock()
    private var failing = false
    private var reads: [Bool] = []
    private var waitOn: DispatchSemaphore?

    var fails: Bool {
        get { lock.withLock { failing } }
        set { lock.withLock { failing = newValue } }
    }

    /// While set, a read waits for it (up to 30 s).
    var gate: DispatchSemaphore? {
        get { lock.withLock { waitOn } }
        set { lock.withLock { waitOn = newValue } }
    }

    var readsOnMain: [Bool] { lock.withLock { reads } }

    func read() throws -> String {
        lock.withLock { reads.append(Thread.isMainThread) }
        if let gate { _ = gate.wait(timeout: .now() + 30) }
        if fails { throw StrayError(text: "the device line broke") }
        return DEVICE_TEXT
    }
}
