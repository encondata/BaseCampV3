import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// A printer that records what reaches it: each send's text, each font as `font NAME`, and the
/// queries it was asked. A write that fails never counts as written.
private final class RecordingZebra: SetupZebra, @unchecked Sendable {
    private let lock = NSLock()
    private var _written: [String] = []
    private var _asked: [String] = []
    private var _failWrites = 0
    private var _answers = true

    /// Sends and fonts that reached the printer, in order.
    var written: [String] { lock.withLock { _written } }
    var asked: [String] { lock.withLock { _asked } }
    /// Queries fail with no reply while false.
    var answers: Bool {
        get { lock.withLock { _answers } }
        set { lock.withLock { _answers = newValue } }
    }

    /// The next `n` writes (sends or fonts) fail part-way.
    func failWrites(_ n: Int) { lock.withLock { _failWrites = n } }

    private func write(_ what: String) throws {
        let failed: Bool = lock.withLock {
            if _failWrites > 0 {
                _failWrites -= 1
                return true
            }
            _written.append(what)
            return false
        }
        if failed { throw PrinterUnreachable(host: "10.0.0.5") }
    }

    private func ask(_ what: String) throws {
        let answers: Bool = lock.withLock {
            _asked.append(what)
            return _answers
        }
        if !answers { throw PrinterNoReply(host: "10.0.0.5") }
    }

    func identify() async throws -> HostId {
        try ask("identify")
        return HostId(model: "ZD421", firmware: "V1", dotsPerMm: 8, memory: "8192", dpi: 203)
    }

    func serial() async throws -> String? {
        try ask("serial")
        return "S1"
    }

    func status() async throws -> HostStatus {
        try ask("status")
        return HostStatus(paperOut: false, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false, partialFormat: false,
                          corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false,
                          thermalTransfer: false, printMode: "0", labelWaiting: false, labelsRemaining: 0)
    }

    func peelerPresent() async throws -> Bool? {
        try ask("peeler")
        return nil
    }

    func fonts() async throws -> [String] {
        try ask("fonts")
        return []
    }

    func fontEntries() async throws -> [DirectoryEntry] {
        try ask("fontEntries")
        return []
    }

    func send(_ zpl: String) async throws { try write(zpl) }

    func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        try write("font \(name)")
    }
}

/// The `~JX` clear after a failed send (D16) and the stop after a cut font install (D8), on both
/// ways bytes reach the printer: Print Labels' sender and Printer Setup's `LockedZebra`.
struct PrinterGuardTests {
    private let printer = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203)

    /// The container's Print Labels sender over `zebra`.
    private func sender(_ zebra: RecordingZebra, _ printerGuard: PrinterGuard) -> LabelSender {
        lockedSender(PrinterLock(), printerGuard) { _, zpl in try await zebra.send(zpl) }
    }

    @Test func failedSendClearsBeforeNextLabel() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let send = sender(zebra, printerGuard)
        let printer = self.printer
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await send(printer, "A") }
        #expect(await printerGuard.state == .needsClear)

        try await send(printer, "B")
        #expect(zebra.written == ["~JX", "B"])
        #expect(await printerGuard.state == .clean)

        // A normal label never carries the clear.
        try await send(printer, "C")
        #expect(zebra.written == ["~JX", "B", "C"])
    }

    /// Printer Setup's sends and font installs clear the same way; queries never send the clear
    /// nor drop the mark, and a printer that answers `~HI` still gets its clear.
    @Test func aFailedSetupSendClearsBeforeTheNextSendOrFont() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let setup = LockedZebra(inner: zebra, lock: PrinterLock(), guard: printerGuard)
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.send("TEST") }
        _ = try await setup.identify()
        _ = try await setup.status()
        _ = try await setup.fontEntries()
        #expect(zebra.asked == ["identify", "status", "fontEntries"])
        #expect(zebra.written.isEmpty)
        #expect(await printerGuard.state == .needsClear)

        try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1]))
        #expect(zebra.written == ["~JX", "font ROBOTO.TTF"])
        try await setup.send("TEST")
        #expect(zebra.written == ["~JX", "font ROBOTO.TTF", "TEST"])
    }

    /// The mark clears only once `~JX` is delivered: a clear that fails sends nothing else, and
    /// the next send clears again.
    @Test func aClearThatFailsKeepsTheMark() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let send = sender(zebra, printerGuard)
        let printer = self.printer
        zebra.failWrites(2) // the label, then its clear
        await #expect(throws: PrinterUnreachable.self) { try await send(printer, "A") }
        await #expect(throws: PrinterUnreachable.self) { try await send(printer, "B") }
        #expect(zebra.written.isEmpty)
        #expect(await printerGuard.state == .needsClear)
        try await send(printer, "C")
        #expect(zebra.written == ["~JX", "C"])
    }

    @Test func clearUsesJX() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        await printerGuard.markSendFailed()
        try await sender(zebra, printerGuard)(printer, "^XA^XZ")
        #expect(zebra.written == ["~JX", "^XA^XZ"])
        // Exactly the three bytes of `~JX` (cancel the partial format), never `~JA` (cancel all).
        #expect(ZebraCommands.cancelPartialFormat == "~JX")
        #expect(Data(zebra.written[0].utf8) == Data([0x7E, 0x4A, 0x58]))
    }

    @Test func fontCutBlocksSendsUntilAPrinterAnswers() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let setup = LockedZebra(inner: zebra, lock: PrinterLock(), guard: printerGuard)
        let send = sender(zebra, printerGuard)
        let printer = self.printer
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1, 2])) }
        #expect(await printerGuard.state == .fontCut)

        // Nothing more is sent: test labels, labels, fonts.
        let refused = await #expect(throws: PrinterNeedsRestart.self) { try await setup.send("TEST") }
        #expect(refused?.localizedDescription == FONT_INSTALL_CUT_TEXT)
        await #expect(throws: PrinterNeedsRestart.self) { try await send(printer, "LABEL") }
        await #expect(throws: PrinterNeedsRestart.self) { try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1, 2])) }
        // A failed send doesn't soften it to a clear.
        await printerGuard.markSendFailed()
        #expect(await printerGuard.state == .fontCut)

        // Queries still go out, and one that gets no answer keeps the stop.
        _ = try await setup.status()
        _ = try await setup.fontEntries()
        zebra.answers = false
        await #expect(throws: PrinterNoReply.self) { try await setup.identify() }
        #expect(await printerGuard.state == .fontCut)
        #expect(zebra.written.isEmpty)

        // The printer answers (it was restarted): sends go out again, with no clear first.
        zebra.answers = true
        _ = try await setup.identify()
        #expect(await printerGuard.state == .clean)
        try await send(printer, "LABEL")
        #expect(zebra.written == ["LABEL"])
    }

    /// A font refused before anything is sent (a bad name) cuts nothing.
    @Test func aRefusedFontNeverStopsThePrinter() async throws {
        let printerGuard = PrinterGuard()
        let setup = LockedZebra(inner: NetworkZebra(host: "127.0.0.1", port: 9), lock: PrinterLock(), guard: printerGuard)
        await #expect(throws: FontInstallRefused.self) { try await setup.installFont(name: "A,B.TTF", bytes: Data([1])) }
        #expect(await printerGuard.state == .clean)
    }

    /// The container's one guard belongs to the saved printer: another connection (or none)
    /// starts clean; the same printer saved again with what a check found keeps its state.
    @MainActor @Test func guardResetsWhenThePrinterChanges() async throws {
        let defaults = freshDefaults()
        LabelSettingsStore(prefs: KioskPrefs(defaults: defaults)).setPrinter(printer)
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: FakeLabelEngine())
        let printerGuard = c.printerGuard
        await printerGuard.markSendFailed()

        c.labelSettings.setPrinter(SavedPrinter(host: "10.0.0.5", model: "ZT230", serial: "S2", dpi: 300))
        try await Task.sleep(for: .milliseconds(100))
        #expect(await printerGuard.state == .needsClear)

        c.labelSettings.setPrinter(SavedPrinter(host: "10.0.0.6", model: "ZD421", serial: "S3", dpi: 203))
        #expect(await waitUntilAsync { await printerGuard.state == .clean })

        await printerGuard.markFontCut()
        c.labelSettings.setPrinter(SavedPrinter(connection: .bluetooth(serial: "D8J224508535", peripheralId: nil),
                                                model: "ZD421", serial: "D8J224508535", dpi: 300))
        #expect(await waitUntilAsync { await printerGuard.state == .clean })

        await printerGuard.markSendFailed()
        c.labelSettings.setPrinter(nil)
        #expect(await waitUntilAsync { await printerGuard.state == .clean })
    }
}
