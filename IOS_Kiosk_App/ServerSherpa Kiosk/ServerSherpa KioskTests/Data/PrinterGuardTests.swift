import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// A printer that records what reaches it, in order: each send's text, each font as `font NAME`,
/// and each query as `?name`. A write that fails never counts as written.
private final class RecordingZebra: SetupZebra, @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [String] = []
    private var _failWrites = 0
    private var _refuse = 0
    private var _timeouts = false
    private var _answers = true

    /// Everything that reached the printer, in order.
    var events: [String] { lock.withLock { _events } }
    /// Sends and fonts only.
    var written: [String] { events.filter { !$0.hasPrefix("?") } }
    /// Queries only, without the `?`.
    var asked: [String] { events.filter { $0.hasPrefix("?") }.map { String($0.dropFirst()) } }
    /// Queries fail with no reply while false.
    var answers: Bool {
        get { lock.withLock { _answers } }
        set { lock.withLock { _answers = newValue } }
    }

    /// The next `n` writes fail part-way: a font after its bytes started (it reports progress
    /// first), a send as unreachable, or as a timeout once `timeouts(true)`.
    func failWrites(_ n: Int) { lock.withLock { _failWrites = n } }
    func timeouts(_ on: Bool) { lock.withLock { _timeouts = on } }
    /// The next `n` writes find nothing listening: they fail before anything is sent.
    func refuse(_ n: Int) { lock.withLock { _refuse = n } }

    private enum Outcome { case refused, failed, written }

    private func write(_ what: String) -> Outcome {
        lock.withLock {
            if _refuse > 0 {
                _refuse -= 1
                return .refused
            }
            if _failWrites > 0 {
                _failWrites -= 1
                return .failed
            }
            _events.append(what)
            return .written
        }
    }

    private func failure() -> Error {
        lock.withLock { _timeouts } ? PrinterTimeout(host: "10.0.0.5") : PrinterUnreachable(host: "10.0.0.5")
    }

    private func ask(_ what: String) throws {
        let answers: Bool = lock.withLock {
            _events.append("?" + what)
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

    func send(_ zpl: String) async throws {
        switch write(zpl) {
        case .refused: throw PrinterUnreachable(host: "10.0.0.5")
        case .failed: throw failure()
        case .written: break
        }
    }

    func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        switch write("font \(name)") {
        case .refused:
            throw PrinterUnreachable(host: "10.0.0.5")
        case .failed:
            progress?(0, bytes.count) // the download started
            throw failure()
        case .written:
            progress?(0, bytes.count)
            progress?(bytes.count, bytes.count)
        }
    }
}

/// The `~JX` clear after a failed send (D16) and the stop after a cut font install (D8), on both
/// ways bytes reach the printer: Print Labels' sender and Printer Setup's `LockedZebra`. Each mark
/// belongs to the printer it happened on.
struct PrinterGuardTests {
    private let printer = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203)
    private let other = SavedPrinter(host: "10.0.0.6", model: "ZD421", serial: "S2", dpi: 203)
    private var a: PrinterConnection { printer.connection }

    /// The container's Print Labels sender over `zebra`.
    private func sender(_ zebra: RecordingZebra, _ printerGuard: PrinterGuard) -> LabelSender {
        lockedSender(PrinterLock(), printerGuard) { _, zpl in try await zebra.send(zpl) }
    }

    /// Printer Setup's view of `zebra` as the saved printer.
    private func setup(_ zebra: RecordingZebra, _ printerGuard: PrinterGuard, _ printer: SavedPrinter? = nil) -> LockedZebra {
        LockedZebra(inner: zebra, connection: (printer ?? self.printer).connection, lock: PrinterLock(), guard: printerGuard)
    }

    @Test func failedSendClearsBeforeNextLabel() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let send = sender(zebra, printerGuard)
        let printer = self.printer
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await send(printer, "A") }
        #expect(await printerGuard.state(for: a) == .needsClear)

        try await send(printer, "B")
        #expect(zebra.written == ["~JX", "B"])
        #expect(await printerGuard.state(for: a) == .clean)

        // A normal label never carries the clear.
        try await send(printer, "C")
        #expect(zebra.written == ["~JX", "B", "C"])
    }

    /// D16: Printer Setup's checks clear first too, and the mark clears with that `~JX`.
    @Test func aFailedSendClearsBeforeTheNextQuery() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let setup = setup(zebra, printerGuard)
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.send("TEST") }
        _ = try await setup.identify()
        #expect(zebra.events == ["~JX", "?identify"])
        #expect(await printerGuard.state(for: a) == .clean)
        try await setup.send("TEST")
        #expect(zebra.events == ["~JX", "?identify", "TEST"])
    }

    /// Every query through `LockedZebra` honors a pending clear: identify, serial, status,
    /// peeler, fonts and the font listing.
    @Test func everyQueryClearsFirst() async throws {
        let queries: [(String, @Sendable (LockedZebra) async throws -> Void)] = [
            ("identify", { _ = try await $0.identify() }),
            ("serial", { _ = try await $0.serial() }),
            ("status", { _ = try await $0.status() }),
            ("peeler", { _ = try await $0.peelerPresent() }),
            ("fonts", { _ = try await $0.fonts() }),
            ("fontEntries", { _ = try await $0.fontEntries() }),
        ]
        for (name, query) in queries {
            let zebra = RecordingZebra()
            let printerGuard = PrinterGuard()
            await printerGuard.markSendFailed(for: a)
            let setup = setup(zebra, printerGuard)
            try await query(setup)
            try await query(setup)
            #expect(zebra.events == ["~JX", "?\(name)", "?\(name)"], "\(name)")
        }
    }

    /// Printer Setup's sends and font installs clear the same way.
    @Test func aFailedSetupSendClearsBeforeTheNextFont() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let setup = setup(zebra, printerGuard)
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.send("TEST") }
        try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1]))
        #expect(zebra.written == ["~JX", "font ROBOTO.TTF"])
        try await setup.send("TEST")
        #expect(zebra.written == ["~JX", "font ROBOTO.TTF", "TEST"])
    }

    /// The mark clears only once `~JX` is delivered: a clear that fails is its own error (the job
    /// never went out), sends nothing else, and the next send clears again.
    @Test func aClearThatFailsKeepsTheMark() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let send = sender(zebra, printerGuard)
        let printer = self.printer
        zebra.failWrites(2) // the label, then its clear
        zebra.timeouts(true)
        await #expect(throws: PrinterTimeout.self) { try await send(printer, "A") }
        let failed = await #expect(throws: PrinterClearFailed.self) { try await send(printer, "B") }
        #expect(failed?.cause is PrinterTimeout)
        #expect(failed?.host == "10.0.0.5")
        #expect(zebra.written.isEmpty)
        #expect(await printerGuard.state(for: a) == .needsClear)
        try await send(printer, "C")
        #expect(zebra.written == ["~JX", "C"])
    }

    @Test func clearUsesJX() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        await printerGuard.markSendFailed(for: a)
        try await sender(zebra, printerGuard)(printer, "^XA^XZ")
        #expect(zebra.written == ["~JX", "^XA^XZ"])
        // Exactly the three bytes of `~JX` (cancel the partial format), never `~JA` (cancel all).
        #expect(ZebraCommands.cancelPartialFormat == "~JX")
        #expect(Data(zebra.written[0].utf8) == Data([0x7E, 0x4A, 0x58]))
    }

    @Test func fontCutBlocksSendsUntilAPrinterAnswers() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let setup = setup(zebra, printerGuard)
        let send = sender(zebra, printerGuard)
        let printer = self.printer
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1, 2])) }
        #expect(await printerGuard.state(for: a) == .fontCut)

        // Nothing more is sent: test labels, labels, fonts.
        let refused = await #expect(throws: PrinterNeedsRestart.self) { try await setup.send("TEST") }
        #expect(refused?.localizedDescription == FONT_INSTALL_CUT_TEXT)
        await #expect(throws: PrinterNeedsRestart.self) { try await send(printer, "LABEL") }
        await #expect(throws: PrinterNeedsRestart.self) { try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1, 2])) }
        // A failed send doesn't soften it to a clear.
        await printerGuard.markSendFailed(for: a)
        #expect(await printerGuard.state(for: a) == .fontCut)

        // Queries still go out (no clear: the printer would take it as font data), and one that
        // gets no answer keeps the stop.
        _ = try await setup.status()
        _ = try await setup.fontEntries()
        zebra.answers = false
        await #expect(throws: PrinterNoReply.self) { try await setup.identify() }
        #expect(await printerGuard.state(for: a) == .fontCut)
        #expect(zebra.written.isEmpty)

        // The printer answers (it was restarted): sends go out again, with no clear first.
        zebra.answers = true
        _ = try await setup.identify()
        #expect(await printerGuard.state(for: a) == .clean)
        try await send(printer, "LABEL")
        #expect(zebra.written == ["LABEL"])
    }

    /// Only a download whose bytes started going out leaves the printer waiting for the rest: one
    /// that found nothing listening leaves the state as it was; a refused font name sends nothing.
    @Test func aFontIsCutOnlyOnceItsBytesStarted() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let setup = setup(zebra, printerGuard)
        zebra.refuse(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1, 2])) }
        #expect(await printerGuard.state(for: a) == .clean)

        let refusedName = LockedZebra(inner: NetworkZebra(host: "127.0.0.1", port: 9), connection: a, lock: PrinterLock(), guard: printerGuard)
        await #expect(throws: FontInstallRefused.self) { try await refusedName.installFont(name: "A,B.TTF", bytes: Data([1])) }
        #expect(await printerGuard.state(for: a) == .clean)

        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await setup.installFont(name: "ROBOTO.TTF", bytes: Data([1, 2])) }
        #expect(await printerGuard.state(for: a) == .fontCut)
    }

    /// A mark belongs to the printer it happened on: another printer gets no `~JX` and no stop,
    /// and the marked one keeps its mark.
    @Test func marksBelongToTheirPrinter() async throws {
        let zebra = RecordingZebra()
        let printerGuard = PrinterGuard()
        let send = sender(zebra, printerGuard)
        let other = self.other
        await printerGuard.markSendFailed(for: a)
        try await send(other, "B1")
        _ = try await setup(zebra, printerGuard, other).identify()
        #expect(zebra.events == ["B1", "?identify"])
        #expect(await printerGuard.state(for: a) == .needsClear)

        await printerGuard.markFontCut(for: a)
        try await send(other, "B2")
        try await setup(zebra, printerGuard, other).installFont(name: "ROBOTO.TTF", bytes: Data([1]))
        #expect(zebra.written == ["B1", "B2", "font ROBOTO.TTF"])
        #expect(await printerGuard.state(for: a) == .fontCut)
        #expect(await printerGuard.state(for: other.connection) == .clean)

        // B's own failure marks B alone.
        zebra.failWrites(1)
        await #expect(throws: PrinterUnreachable.self) { try await send(other, "B3") }
        #expect(await printerGuard.state(for: other.connection) == .needsClear)
        #expect(await printerGuard.state(for: a) == .fontCut)
    }

    /// The container's guard starts over for each saved printer: another connection (or none)
    /// drops every mark; the same printer saved again with what a check found keeps its own.
    @MainActor @Test func guardResetsWhenThePrinterChanges() async throws {
        let defaults = freshDefaults()
        LabelSettingsStore(prefs: KioskPrefs(defaults: defaults)).setPrinter(printer)
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: FakeLabelEngine())
        let printerGuard = c.printerGuard
        let a = self.a
        await printerGuard.markSendFailed(for: a)

        c.labelSettings.setPrinter(SavedPrinter(host: "10.0.0.5", model: "ZT230", serial: "S2", dpi: 300))
        try await Task.sleep(for: .milliseconds(100))
        #expect(await printerGuard.state(for: a) == .needsClear)

        c.labelSettings.setPrinter(other)
        #expect(await waitUntilAsync { await printerGuard.state(for: a) == .clean })

        let bluetooth = PrinterConnection.bluetooth(serial: "D8J224508535", peripheralId: nil)
        await printerGuard.markFontCut(for: other.connection)
        c.labelSettings.setPrinter(SavedPrinter(connection: bluetooth, model: "ZD421", serial: "D8J224508535", dpi: 300))
        let otherConnection = other.connection
        #expect(await waitUntilAsync { await printerGuard.state(for: otherConnection) == .clean })

        await printerGuard.markSendFailed(for: bluetooth)
        c.labelSettings.setPrinter(nil)
        #expect(await waitUntilAsync { await printerGuard.state(for: bluetooth) == .clean })
    }
}
