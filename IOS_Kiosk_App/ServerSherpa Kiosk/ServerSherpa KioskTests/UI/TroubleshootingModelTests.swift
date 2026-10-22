import Foundation
import Testing
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
    private(set) var events: [String] = []

    nonisolated init() {}

    private func reach(_ what: String) async throws {
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

    private func model(isAdmin: Bool = false, isDeveloper: Bool = false, pick: LabelPick? = nil) -> TroubleshootingModel {
        let zebra = self.zebra
        return TroubleshootingModel(settings: settings, bluetooth: bluetooth, zebraFor: { _ in zebra },
                                    printerLock: lock, printerGuard: printerGuard, isAdmin: isAdmin, isDeveloper: isDeveloper,
                                    pick: { pick }, device: { "Device: iPad16,6 (ipad), iPadOS 27.2\nApp: version 1.0 (build 7)" })
    }

    /// Print Labels' send, as the container wires it (`lockedSender` around the transport).
    private var printLabels: LabelSender {
        let zebra = self.zebra
        return lockedSender(lock, printerGuard) { _, zpl in try await zebra.send(zpl) }
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

    @Test func nothingStartsBluetoothOrReachesThePrinterUntilTapped() async throws {
        settings.setPrinter(bluetoothPrinter)
        let m = model(isAdmin: true, isDeveloper: true)
        _ = m.connectionLines
        _ = m.report(now: Date())
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

        bluetooth.availability = .poweredOff
        m.scan()
        await eventually("refused") { !m.scanning }
        #expect(m.scanMessage == BLUETOOTH_OFF_TEXT)
    }

    // MARK: Report

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
        await m.startSpeedTest()?.value
        m.scan()
        bluetooth.hear([FoundBluetoothPrinter(id: peripheral, name: ZD421_SERIAL, rssi: -52, advertisesZebra: false),
                        FoundBluetoothPrinter(id: UUID(), name: "James’s Mac mini", rssi: -70, advertisesZebra: false)])
        await eventually("heard") { m.found?.count == 2 }
        m.stopScan()
        await eventually("scan ended") { !m.scanning }

        let report = m.report(now: Date(timeIntervalSince1970: 1_792_000_000))
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
        // Every ask: its command and reply with the control bytes visible, bytes and milliseconds.
        #expect(m.asks.count == PrinterAsk.allCases.count)
        for ask in m.asks {
            #expect(text.contains(visibleBytes(ask.command)))
            #expect(text.contains("\(ask.bytes) B in \(ask.milliseconds ?? -1) ms"))
            for line in visibleBytes(ask.reply).split(separator: "\n") { #expect(text.contains(line)) }
        }
        #expect(text.contains("␂030,0,0,0612,000,0,0,0,000,0,0,0␃␍␊"))
        #expect(text.contains("ERRORS:         0 00000000 00000000"))
        // The speed rows.
        let row = try #require(m.speedRows.first)
        #expect(text.contains("1 | 10 | \(row.bytes) | "))
        // What the Bluetooth scan heard.
        #expect(text.contains("\(ZD421_SERIAL) · -52 dBm · Zebra"))
        #expect(text.contains("James’s Mac mini · -70 dBm"))
        // The log.
        #expect(!m.logLines.isEmpty)
        for line in m.logLines { #expect(text.contains(line.text)) }
    }

    @Test func logKeepsTheLast5000Lines() {
        let m = model()
        for i in 1...5_010 { m.log("line \(i)") }
        #expect(m.logLines.count == 5_000)
        #expect(m.logLines.first?.text == "line 11")
        let text = m.report(now: Date()).text
        #expect(text.contains("  line 5010\n"))
        #expect(text.contains("  line 11\n"))
        #expect(!text.contains("  line 10\n"))
    }
}
