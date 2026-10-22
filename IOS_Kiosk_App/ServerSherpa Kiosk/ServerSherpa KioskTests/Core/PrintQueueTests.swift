import Foundation
import Testing
@testable import ServerSherpa_Kiosk

private struct Asset: Equatable, Sendable {
    let id: String
    init(_ id: String) { self.id = id }
}

private struct SendFailed: Error {}
private struct DiskFull: Error {}

/// Opens once; every waiter (before or after) goes on.
private actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func open() {
        isOpen = true
        for w in waiters { w.resume() }
        waiters = []
    }
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

/// Records every call; `label` answers the asset's stored label, `failSends` fails that many sends.
private final class Fake: @unchecked Sendable {
    private let lock = NSLock()
    private var _settings = LabelSettings(printer: SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203),
                                          offsetX: 4, offsetY: -2, peel: true)
    private var _label: @Sendable (Asset) -> PrintStep = { .ready("^XA^FD\($0.id)^FS^XZ") }
    private var _prepare: (@Sendable (String, LabelSettings) async throws -> PrintStep)?
    private var _failSends = 0
    private var _failRecord = false
    private var _onSend: @Sendable () async -> Void = {}
    private var _onLabel: @Sendable () async -> Void = {}
    private var _sendError: @Sendable () -> Error = { SendFailed() }
    private var _prepared: [String] = []
    private var _sent: [(SavedPrinter, String)] = []
    private var _recorded: [(Asset, String)] = []
    private var _logged: [String] = []
    private var _labelCalls = 0

    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    var settings: LabelSettings { get { locked { _settings } } set { locked { _settings = newValue } } }
    var label: @Sendable (Asset) -> PrintStep { get { locked { _label } } set { locked { _label = newValue } } }
    var prepare: (@Sendable (String, LabelSettings) async throws -> PrintStep)? { get { locked { _prepare } } set { locked { _prepare = newValue } } }
    var failSends: Int { get { locked { _failSends } } set { locked { _failSends = newValue } } }
    var failRecord: Bool { get { locked { _failRecord } } set { locked { _failRecord = newValue } } }
    /// Runs inside each send, before it succeeds or fails.
    var onSend: @Sendable () async -> Void { get { locked { _onSend } } set { locked { _onSend = newValue } } }
    /// Runs inside each label read.
    var onLabel: @Sendable () async -> Void { get { locked { _onLabel } } set { locked { _onLabel = newValue } } }
    var sendError: @Sendable () -> Error { get { locked { _sendError } } set { locked { _sendError = newValue } } }
    var prepared: [String] { locked { _prepared } }
    var sent: [(SavedPrinter, String)] { locked { _sent } }
    var recorded: [(Asset, String)] { locked { _recorded } }
    var logged: [String] { locked { _logged } }
    var labelCalls: Int { locked { _labelCalls } }

    var deps: PrintQueueDeps<Asset> {
        PrintQueueDeps(
            settings: { self.settings },
            label: { asset in
                self.locked { self._labelCalls += 1 }
                await self.onLabel()
                return self.label(asset)
            },
            prepare: { zpl, settings in
                if let prepare = self.prepare { return try await prepare(zpl, settings) }
                self.locked { self._prepared.append(zpl) }
                return .ready("[\(settings.offsetX),\(settings.offsetY),\(settings.peel)]\(zpl)")
            },
            send: { printer, zpl in
                await self.onSend()
                // A real send stops when its task is cancelled.
                if Task.isCancelled { throw CancellationError() }
                let error: Error? = self.locked {
                    if self._failSends > 0 { self._failSends -= 1; return self._sendError() }
                    self._sent.append((printer, zpl))
                    return nil
                }
                if let error { throw error }
            },
            record: { asset, value in
                if Task.isCancelled { throw CancellationError() }
                let fail: Bool = self.locked {
                    if self._failRecord { return true }
                    self._recorded.append((asset, value))
                    return false
                }
                if fail { throw DiskFull() }
            },
            log: { message, _ in self.locked { self._logged.append(message) } }
        )
    }

    /// Each send as `[host, zpl]`.
    func sentPairs() -> [[String]] { sent.map { [$0.0.host ?? "", $0.1] } }
    func recordedPairs() -> [[String]] { recorded.map { [$0.0.id, $0.1] } }
}

private func queue(_ fake: Fake, limit: Int = PrintQueue<Asset>.LIST_LIMIT) -> PrintQueue<Asset> {
    PrintQueue(deps: fake.deps, now: { "2026-10-21T12:00:00Z" }, limit: limit)
}

/// The two send-time helpers, spelled out so a test can see which settings went in.
private final class HelperEngine: @unchecked Sendable {
    struct Timeout: Error {}
    struct Unsupported: Error {}
    private let lock = NSLock()
    private var _calls: [(String, [String: Any])] = []
    private var _timeoutsLeft = 0
    var unsupported = false
    var garbage = false

    var calls: [(String, [String: Any])] { lock.lock(); defer { lock.unlock() }; return _calls }
    var timeoutsLeft: Int {
        get { lock.lock(); defer { lock.unlock() }; return _timeoutsLeft }
        set { lock.lock(); _timeoutsLeft = newValue; lock.unlock() }
    }

    func call(_ fn: String, _ argsJson: String) throws -> String {
        if unsupported { throw Unsupported() }
        let timedOut: Bool = {
            lock.lock(); defer { lock.unlock() }
            if _timeoutsLeft > 0 { _timeoutsLeft -= 1; return true }
            return false
        }()
        if timedOut { throw Timeout() }
        if garbage { return "{}" }
        let a = try JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as! [String: Any]
        lock.lock(); _calls.append((fn, a)); lock.unlock()
        let zpl = a["zpl"] as! String
        let out: String
        switch fn {
        case "applyPrintSettings": out = "LT\(a["verticalOffset"] as! Int)LS\(a["horizontalOffset"] as! Int)|\(zpl)"
        case "withPrintMode": out = zpl + ((a["peel"] as! Bool) ? "|MMP" : "|MMT")
        default: fatalError("unexpected \(fn)")
        }
        return "{\"zpl\":" + LabelGenArgs.quote(out) + "}"
    }

    func prepare(_ zpl: String, _ settings: LabelSettings) async throws -> PrintStep {
        try await prepareForPrinter(
            zpl: zpl, settings: settings,
            call: { fn, args in try self.call(fn, args) },
            isTimeout: { $0 is Timeout },
            isUnsupported: { $0 is Unsupported }
        )
    }
}

struct PrintQueueTests {
    @Test func aPrintedScanRecordsOnce() async throws {
        let fake = Fake()
        let q = queue(fake)
        let e = try await q.scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .printed)
        #expect(e.recorded)
        #expect(e.message == nil)
        #expect(fake.sentPairs() == [["10.0.0.5", "[4,-2,true]^XA^FDa1^FS^XZ"]])
        // The send gets the whole saved printer: its connection picks the way there.
        #expect(fake.sent.map(\.0) == fake.settings.printer.map { [$0] })
        #expect(fake.recordedPairs() == [["a1", "A-1"]])
        #expect(await q.entries == [e])
    }

    @Test func aFailedSendThenRetryResendsTheSameBytesAndRecordsOnce() async throws {
        let fake = Fake()
        fake.failSends = 1
        let q = queue(fake)
        let failed = try await q.scan(Asset("a1"), scannedValue: "A-1")
        #expect(failed.state == .failed)
        #expect(failed.message == "Can't reach the printer at 10.0.0.5.")
        #expect(fake.recorded.isEmpty)
        #expect(!failed.recorded)

        // The label changed and the offsets moved since: a Retry still sends what the first attempt built.
        fake.label = { _ in .ready("^XA^FDnew^FS^XZ") }
        fake.settings.offsetX = 99
        let retried = try #require(try await q.retry(failed.id))
        #expect(retried.id == failed.id)
        #expect(retried.state == .printed)
        #expect(fake.sentPairs() == [["10.0.0.5", "[4,-2,true]^XA^FDa1^FS^XZ"]])
        #expect(fake.prepared.count == 1)
        #expect(fake.recordedPairs() == [["a1", "A-1"]])
        // One entry: the retry is the same scan.
        #expect(await q.entries.count == 1)
    }

    @Test func aReprintNeverRecords() async throws {
        let fake = Fake()
        let q = queue(fake)
        let first = try await q.scan(Asset("a1"), scannedValue: "A-1")
        let again = try #require(try await q.reprint(first.id))
        #expect(again.state == .printed)
        #expect(again.reprint)
        #expect(!again.recorded)
        #expect(fake.sent.count == 2)
        #expect(fake.recorded.count == 1)
        #expect(await q.entries.map(\.id) == [again.id, first.id])
    }

    @Test func aFailedReprintRetriedStillNeverRecords() async throws {
        let fake = Fake()
        let q = queue(fake)
        let first = try await q.scan(Asset("a1"), scannedValue: "A-1")
        fake.failSends = 1
        let again = try #require(try await q.reprint(first.id))
        #expect(again.state == .failed)
        #expect(try await q.retry(again.id)?.state == .printed)
        #expect(fake.recorded.count == 1)
    }

    @Test func anAssetWithNoTemplateAtThisDpiShowsTheReasonAndRecordsNothing() async throws {
        let fake = Fake()
        fake.label = { _ in labelFor(StoredLabel(zpl: nil, outcome: NO_TEMPLATE_AT_DPI, templateId: nil), LabelBuildStatus(phase: .done)) }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == "No label for this asset: this move has no active label template at this printer's DPI. "
            + "Someone with label access needs to activate one on Labels › Templates.")
        #expect(fake.sent.isEmpty)
        #expect(fake.recorded.isEmpty)
    }

    @Test func aScanWhileLabelsAreBeingMadeAndNoRowYetSaysSo() async throws {
        let running = LabelBuildStatus(phase: .running, done: 3, total: 10, templateId: "t1")
        let fake = Fake()
        fake.label = { _ in labelFor(nil, running) }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == "Labels are still being made (3 of 10).")
        #expect(fake.sent.isEmpty)
        #expect(fake.recorded.isEmpty)
    }

    @Test func anUnreachablePrinterIsAnErrorAndRecordsNothing() async throws {
        let fake = Fake()
        fake.failSends = 5
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == "Can't reach the printer at 10.0.0.5.")
        #expect(fake.recorded.isEmpty)
    }

    @Test func noPrinterSaysOpenPrinterSetup() async throws {
        let fake = Fake()
        fake.settings = LabelSettings()
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.message == "No printer set up. Open Printer Setup.")
        #expect(fake.prepared.isEmpty)
    }

    @Test func noMatchFailsAtOnceAndHasNothingToRetry() async throws {
        let fake = Fake()
        let q = queue(fake)
        let e = try await q.scan(nil, scannedValue: "ZZZ")
        #expect(e.state == .failed)
        #expect(e.message == "No asset matches that scan.")
        #expect(try await q.retry(e.id) == nil)
        #expect(try await q.reprint(e.id) == nil)
        #expect(fake.sent.isEmpty)
    }

    @Test func aRecordThatFailsKeepsThePrintAndWarns() async throws {
        let fake = Fake()
        fake.failRecord = true
        let q = PrintQueue(deps: fake.deps, now: { "t" })
        let e = try await q.scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .printed)
        #expect(!e.recorded)
        #expect(e.recordWarning == "Printed, but the scan wasn't recorded: this kiosk couldn't save it.")
        // A printed entry has nothing to retry.
        #expect(try await q.retry(e.id) == nil)
        #expect(fake.sent.count == 1)
        #expect(fake.logged == ["couldn't record the Labeled scan"])
    }

    @Test func aLabelThatGoesOutAsTheScreenClosesStillRecordsOnce() async throws {
        let gate = Gate()
        let atSend = Gate()
        let fake = Fake()
        fake.onSend = {
            await atSend.open()
            await gate.wait()
        }
        let q = queue(fake)
        let job = Task { try await q.scan(Asset("a1"), scannedValue: "A-1") }
        await atSend.wait()
        job.cancel()
        #expect(fake.recorded.isEmpty)
        await gate.open()
        let e = try await job.value
        #expect(e.state == .printed)
        #expect(fake.sent.count == 1)
        #expect(fake.recordedPairs() == [["a1", "A-1"]])
        #expect(await q.entries[0].state == .printed)
    }

    /// A caller cancelled before its label goes out sends nothing (Swift: the cancellation surfaces).
    @Test func aScanCancelledBeforeItsLabelGoesOutSendsNothing() async throws {
        let gate = Gate()
        let atLabel = Gate()
        let fake = Fake()
        fake.onLabel = {
            await atLabel.open()
            await gate.wait()
        }
        let q = queue(fake)
        let job = Task { try await q.scan(Asset("a1"), scannedValue: "A-1") }
        await atLabel.wait()
        job.cancel()
        await gate.open()
        await #expect(throws: CancellationError.self) { try await job.value }
        #expect(fake.sent.isEmpty)
        #expect(fake.recorded.isEmpty)
        // The queue still takes the next job.
        fake.onLabel = {}
        #expect(try await q.scan(Asset("a2"), scannedValue: "A-2").state == .printed)
    }

    /// Android's Mutex.withLock: a job cancelled while it waits its turn never starts.
    @Test func aJobCancelledWhileQueuedNeverStarts() async throws {
        let gate = Gate()
        let atSend = Gate()
        let fake = Fake()
        fake.onSend = {
            await atSend.open()
            await gate.wait()
        }
        let q = queue(fake)
        let first = Task { try await q.scan(Asset("a1"), scannedValue: "A-1") }
        await atSend.wait()
        let second = Task { try await q.scan(Asset("a2"), scannedValue: "A-2") }
        while await q.entries.count < 2 { await Task.yield() }
        second.cancel()
        await gate.open()
        #expect(try await first.value.state == .printed)
        await #expect(throws: CancellationError.self) { try await second.value }
        // Only the first job read and prepared its label; the cancelled one is still queued.
        #expect(fake.labelCalls == 1)
        #expect(fake.prepared == ["^XA^FDa1^FS^XZ"])
        #expect(await q.entries.map(\.state) == [.queued, .printed])
        // The queue still runs the next job.
        #expect(try await q.scan(Asset("a3"), scannedValue: "A-3").state == .printed)
        #expect(fake.sent.map(\.1) == ["[4,-2,true]^XA^FDa1^FS^XZ", "[4,-2,true]^XA^FDa3^FS^XZ"])
    }

    @Test func jobsRunOneAtATimeInArrivalOrder() async throws {
        let gate = Gate()
        let atSend = Gate()
        let fake = Fake()
        fake.onSend = {
            await atSend.open()
            await gate.wait()
        }
        let q = queue(fake)
        let first = Task { try await q.scan(Asset("a1"), scannedValue: "A-1") }
        await atSend.wait()
        let second = Task { try await q.scan(Asset("a2"), scannedValue: "A-2") }
        while await q.entries.count < 2 { await Task.yield() }
        #expect(await q.entries.map(\.state) == [.queued, .sending])
        await gate.open()
        #expect(try await first.value.state == .printed)
        #expect(try await second.value.state == .printed)
        #expect(fake.sent.map(\.1) == ["[4,-2,true]^XA^FDa1^FS^XZ", "[4,-2,true]^XA^FDa2^FS^XZ"])
    }

    /// A sign-out or another move: the waiting job never sends, the label going out finishes on
    /// the printer but records nothing and leaves no entry, and nothing old can be retried.
    @Test func aResetDropsWaitingJobsAndTheListAndTheSendingJobNeverRecords() async throws {
        let gate = Gate()
        let atSend = Gate()
        let fake = Fake()
        fake.onSend = {
            await atSend.open()
            await gate.wait()
        }
        let q = queue(fake)
        let first = Task { try await q.scan(Asset("a1"), scannedValue: "A-1") }
        await atSend.wait()
        let second = Task { try await q.scan(Asset("a2"), scannedValue: "A-2") }
        while await q.entries.count < 2 { await Task.yield() }
        let oldIds = await q.entries.map(\.id)

        await q.reset()
        #expect(await q.entries.isEmpty)
        await gate.open()
        _ = try await first.value
        await #expect(throws: CancellationError.self) { try await second.value }
        #expect(fake.sent.map(\.1) == ["[4,-2,true]^XA^FDa1^FS^XZ"])
        #expect(fake.recorded.isEmpty)
        #expect(fake.labelCalls == 1)
        #expect(await q.entries.isEmpty)
        for id in oldIds {
            #expect(try await q.retry(id) == nil)
            #expect(try await q.reprint(id) == nil)
        }

        // The next session prints and records as usual, with ids no old entry had.
        let next = try await q.scan(Asset("a3"), scannedValue: "A-3")
        #expect(next.state == .printed)
        #expect(!oldIds.contains(next.id))
        #expect(fake.recordedPairs() == [["a3", "A-3"]])
        #expect(await q.entries.map(\.id) == [next.id])
    }

    /// A job still reading its label when the reset comes never starts going out.
    @Test func aResetWhileAJobReadsItsLabelStopsItBeforeTheSend() async throws {
        let gate = Gate()
        let atLabel = Gate()
        let fake = Fake()
        fake.onLabel = {
            await atLabel.open()
            await gate.wait()
        }
        let q = queue(fake)
        let job = Task { try await q.scan(Asset("a1"), scannedValue: "A-1") }
        await atLabel.wait()
        await q.reset()
        await gate.open()
        await #expect(throws: CancellationError.self) { try await job.value }
        #expect(fake.sent.isEmpty)
        #expect(fake.recorded.isEmpty)
        #expect(await q.entries.isEmpty)
    }

    @Test func aSendThatTimesOutSaysTheLabelMayHavePrinted() async throws {
        let fake = Fake()
        fake.failSends = 1
        fake.sendError = { LabelSendTimeout() }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == "The printer didn't finish answering. It may have printed the label — check before you retry.")
        #expect(fake.recorded.isEmpty)
    }

    @Test func aSendKeptOffTheLocalNetworkSaysToAllowIt() async throws {
        let fake = Fake()
        fake.failSends = 1
        fake.sendError = { LabelSendLocalNetworkDenied() }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == LOCAL_NETWORK_PRINTER_DENIED_TEXT)
        #expect(fake.recorded.isEmpty)
    }

    /// A cut font install stops sends to the printer until it answers a check: the label says so.
    @Test func printQueueShowsFontCutText() async throws {
        let fake = Fake()
        fake.failSends = 1
        fake.sendError = { PrinterNeedsRestart() }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == FONT_INSTALL_CUT_TEXT)
        #expect(e.message == "The font install was cut off. Turn the printer off and on, then tap Check again.")
        #expect(fake.recorded.isEmpty)
    }

    @Test func aPrepareFailureShowsItsMessage() async throws {
        let fake = Fake()
        fake.prepare = { _, _ in .refused(DEVICE_UNSUPPORTED_TEXT) }
        let e = try await PrintQueue(deps: fake.deps, now: { "t" }).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.message == "This device can't make labels. Restart the app; if it keeps happening, the app needs an update.")
    }

    @Test func aLabelReadThatThrowsSaysSoAndLogs() async throws {
        let fake = Fake()
        fake.prepare = { _, _ in throw DiskFull() }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .failed)
        #expect(e.message == "Couldn't read this asset's label on the kiosk.")
        #expect(fake.logged == ["couldn't read the label or the settings"])
        #expect(fake.sent.isEmpty)
    }

    @Test func theListKeepsTheNewestEntries() async throws {
        let q = queue(Fake(), limit: 3)
        for i in 0..<5 { _ = try await q.scan(Asset("a\(i)"), scannedValue: "A-\(i)") }
        #expect(await q.entries.map(\.scannedValue) == ["A-4", "A-3", "A-2"])
    }

    @Test func changesCarryTheLatestList() async throws {
        let q = queue(Fake())
        let e = try await q.scan(Asset("a1"), scannedValue: "A-1")
        var it = q.changes.makeAsyncIterator()
        #expect(await it.next() == [e])
    }

    // The send-time helpers (Android PrintLabelsViewModel's prepare).

    @Test func thePrintHelpersApplyTheOffsetsThenThePrintMode() async throws {
        let engine = HelperEngine()
        let settings = LabelSettings(offsetX: 12, offsetY: -3, peel: true)
        #expect(try await engine.prepare("^XA^XZ", settings) == .ready("LT-3LS12|^XA^XZ|MMP"))
        #expect(engine.calls.map(\.0) == ["applyPrintSettings", "withPrintMode"])
        #expect(try await engine.prepare("^XA^XZ", LabelSettings()) == .ready("LT0LS0|^XA^XZ|MMT"))
    }

    @Test func aPrintHelperThatTimesOutOnceIsAskedAgain() async throws {
        let engine = HelperEngine()
        engine.timeoutsLeft = 1
        let fake = Fake()
        fake.prepare = { zpl, settings in try await engine.prepare(zpl, settings) }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.state == .printed)
        #expect(fake.sentPairs() == [["10.0.0.5", "LT-2LS4|^XA^FDa1^FS^XZ|MMP"]])
        // Twice in a row is a failure: asked once more, never twice.
        engine.timeoutsLeft = 2
        #expect(try await engine.prepare("^XA^XZ", LabelSettings()) == .refused(PREPARE_FAILED_TEXT))
        #expect(engine.timeoutsLeft == 0)
    }

    @Test func anUnsupportedEngineSaysSoAndPrintsNothing() async throws {
        let engine = HelperEngine()
        engine.unsupported = true
        let fake = Fake()
        fake.prepare = { zpl, settings in try await engine.prepare(zpl, settings) }
        let e = try await queue(fake).scan(Asset("a1"), scannedValue: "A-1")
        #expect(e.message == "This device can't make labels. Restart the app; if it keeps happening, the app needs an update.")
        #expect(fake.sent.isEmpty)
        #expect(fake.recorded.isEmpty)
    }

    @Test func aHelperAnswerWithoutZplAsksToTryAgain() async throws {
        let engine = HelperEngine()
        engine.garbage = true
        #expect(try await engine.prepare("^XA^XZ", LabelSettings()) == .refused("Couldn't get this label ready for the printer. Try again."))
    }

    // labelFor: the stored label and the build's state → what a scan prints or says.

    @Test func theReasonsMatchTheLaptop() {
        let done = LabelBuildStatus(phase: .done)
        func said(_ outcome: String) -> PrintStep { labelFor(StoredLabel(zpl: nil, outcome: outcome, templateId: "t1"), done) }
        #expect(said(TEMPLATE_FAILED) == .refused("No label for this asset: the label template couldn't be built"))
        #expect(said(TEMPLATE_UNSUPPORTED) == .refused("This device needs an app update to print this template."))
        #expect(said("something_new") == .refused("No label for this asset: none was generated for it"))
        #expect(labelFor(nil, done) == .refused("No label for this asset: none was generated for it"))
        // An ok row without its ZPL has no label either.
        #expect(said(OUTCOME_OK) == .refused("No label for this asset: none was generated for it"))
    }

    @Test func aStoredLabelPrints() {
        #expect(labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t1"), LabelBuildStatus(phase: .done)) == .ready("^XA^XZ"))
    }

    /// Laptop parity: its edge refuses every label while its runner runs.
    @Test func whileLabelsAreBeingMadeNoStoredLabelPrints() {
        let waiting = PrintStep.refused("Labels are still being made (1 of 4).")
        let running = LabelBuildStatus(phase: .running, done: 1, total: 4, templateId: "t2")
        #expect(labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t2"), running) == waiting)
        #expect(labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t1"), running) == waiting)
        #expect(labelFor(StoredLabel(zpl: nil, outcome: NO_TEMPLATE_AT_DPI, templateId: "t2"), running) == waiting)
        // The plan step: nothing counted yet.
        #expect(labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t2"), LabelBuildStatus(phase: .running))
            == .refused("Labels are being prepared."))
    }

    /// A stored label may be for the data the running sync replaces: none prints until it's done.
    @Test func whileTheKioskSyncsNoStoredLabelPrints() {
        let syncing = PrintStep.refused("This kiosk is syncing. Labels will be ready shortly.")
        let done = LabelBuildStatus(phase: .done)
        #expect(labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t1"), done, syncing: true) == syncing)
        #expect(labelFor(nil, done, syncing: true) == syncing)
        #expect(labelFor(nil, LabelBuildStatus(phase: .running, done: 1, total: 4), syncing: true) == syncing)
        // A device that can't make labels says so first.
        #expect(labelFor(nil, LabelBuildStatus(phase: .unsupportedDevice), syncing: true)
            == .refused("This device can't make labels. Restart the app; if it keeps happening, the app needs an update."))
        #expect(labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t1"), done, syncing: false) == .ready("^XA^XZ"))
    }

    @Test func anUnsupportedDeviceNeverPrints() {
        let step = labelFor(StoredLabel(zpl: "^XA^XZ", outcome: OUTCOME_OK, templateId: "t1"), LabelBuildStatus(phase: .unsupportedDevice))
        #expect(step == .refused("This device can't make labels. Restart the app; if it keeps happening, the app needs an update."))
    }

    @Test func noLabelAndASyncNeededSaysSync() {
        #expect(labelFor(nil, LabelBuildStatus(phase: .done, needs: .sync)) == .refused("Sync this kiosk to make labels."))
    }

    @Test func stillBeingMadeCopy() {
        #expect(stillBeingMadeText(done: 0, total: 0) == "Labels are being prepared.")
        #expect(stillBeingMadeText(done: 200, total: 800) == "Labels are still being made (200 of 800).")
        #expect(String(describing: LabelSendTimeout()) == "the printer didn't take the whole label in time")
    }
}
