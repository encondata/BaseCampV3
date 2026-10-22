import Testing
import Foundation
import SwiftUI
@testable import ServerSherpa_Kiosk

/// The two send-time helpers, spelled out so a test can see which settings went in (Android's
/// `PrintHelperEngine`). Main-actor state: tests set it up and read it between awaits.
@MainActor private final class PrintHelperEngine: LabelEngine {
    private(set) var calls: [String] = []
    var timeoutsLeft = 0
    var unsupported = false

    nonisolated init() {}

    nonisolated func isSupported() async -> Bool { true }

    nonisolated func call(_ fn: String, _ argsJson: String) async throws -> String { try await answer(fn, argsJson) }

    private func answer(_ fn: String, _ argsJson: String) throws -> String {
        if unsupported { throw LabelEngineError.unsupported }
        if timeoutsLeft > 0 {
            timeoutsLeft -= 1
            throw LabelEngineError.timeout(fn)
        }
        let a = FakeLabelEngine.object(argsJson)
        calls.append(fn)
        let zpl = a["zpl"] as? String ?? ""
        let out: String
        switch fn {
        case "applyPrintSettings": out = "LT\(a["verticalOffset"] as? Int ?? 0)LS\(a["horizontalOffset"] as? Int ?? 0)|\(zpl)"
        case "withPrintMode": out = zpl + ((a["peel"] as? Bool) == true ? "|MMP" : "|MMT")
        default: throw LabelGenException("unexpected \(fn)")
        }
        return FakeLabelEngine.text(["zpl": out])
    }
}

/// The printer: records what it was sent, fails the next `failures` sends (unreachable, or a
/// timeout with `timeouts`), and holds a send while `hold` is set.
@MainActor private final class FakePrinter {
    private(set) var sent: [(host: String, zpl: String)] = []
    /// Every send's ZPL in the order the sends began (held or not).
    private(set) var started: [String] = []
    var failures = 0
    var timeouts = false
    var hold = false
    private(set) var atHold = false

    func send(_ host: String, _ zpl: String) async throws {
        started.append(zpl)
        while hold {
            atHold = true
            try await Task.sleep(for: .milliseconds(2))
        }
        if failures > 0 {
            failures -= 1
            if timeouts { throw PrinterTimeout(host: host) }
            throw PrinterUnreachable(host: host)
        }
        sent.append((host, zpl))
    }
}

@MainActor private final class FakeBuildStatus: LabelBuildStatusSource {
    var status: LabelBuildStatus
    init(_ status: LabelBuildStatus) { self.status = status }
}

@MainActor private final class FakePrintSync: PrintLabelsSync {
    var isSyncing = false
    private(set) var runs: [String] = []
    func run(initiativeId: String, initiativeName: String) { runs.append("\(initiativeId) \(initiativeName)") }
}

/// Port of Android's PrintLabelsViewModelTest, plus the iOS lifetime rules: a scan's print is
/// owned by the view model, never by the screen's scan collection.
@MainActor
struct PrintLabelsViewModelTests {
    private let printer = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203)
    private let store: KioskStore
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let api = FakeKioskApi()
    private let engine = PrintHelperEngine()
    private let device = FakePrinter()
    private let build = FakeBuildStatus(LabelBuildStatus(phase: .done, ready: 1, problems: [OutcomeCount(code: NO_TEMPLATE_AT_DPI, count: 1)],
                                                         templateId: "t1"))
    private let sync = FakePrintSync()
    private let flash = FlashController()
    private let outbox: Outbox
    private let settings: LabelSettingsStore
    /// The container's one queue: every view model of a test shares it.
    private let jobs: LabelPrintJobs

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        outbox = Outbox(store: MemoryOutboxStore(), api: api, serial: { "kiosk-ios-test" }, backgroundTask: NoBackgroundTasking())
        settings = LabelSettingsStore(prefs: prefs)
        let device = self.device
        jobs = LabelPrintJobs(store: store, sync: sync, outbox: outbox, settings: settings, build: build, engine: engine,
                              sender: { host, zpl in try await device.send(host, zpl) })
    }

    /// Three assets: A-1 and A-3 with stored labels, A-2 with none at this DPI; the move's setup; the
    /// printer with offsets (4, -2) and peel unless `withPrinter` is false.
    private func harness(withPrinter: Bool = true) async throws -> PrintLabelsViewModel {
        let assets = [
            KioskAssetRow(id: "a1", assetId: "A-1", name: "Rack 1", rfid: "000000000000000000100348", serialNumber: "SN1", makeModel: "Dell"),
            KioskAssetRow(id: "a2", assetId: "A-2", name: "Rack 2", serialNumber: "SN2", makeModel: "HP"),
            KioskAssetRow(id: "a3", assetId: "A-3", name: "Rack 3", serialNumber: "SN3", makeModel: "Dell"),
        ]
        try await store.replaceRoster(assets: assets, people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 3, people: 0, containers: 0, trucks: 0, syncedAt: "now"))
        _ = try await store.storeGeneratedLabels([
            GeneratedLabelRow(assetId: "a1", zpl: "^XA^FDA-1^FS^XZ", outcome: OUTCOME_OK, fingerprint: "f1", templateId: "t1"),
            GeneratedLabelRow(assetId: "a2", zpl: nil, outcome: NO_TEMPLATE_AT_DPI, fingerprint: "f2", templateId: nil),
            GeneratedLabelRow(assetId: "a3", zpl: "^XA^FDA-3^FS^XZ", outcome: OUTCOME_OK, fingerprint: "f3", templateId: "t1"),
        ], ifMove: "i1")
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move", siteId: "s1", siteName: "Site",
                                                   siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        if withPrinter {
            settings.setPrinter(printer)
            settings.setOffsets(x: 4, y: -2)
            settings.setPeel(true)
        }
        let vm = makeVM()
        await vm.loadRoster()
        return vm
    }

    private func makeVM() -> PrintLabelsViewModel {
        PrintLabelsViewModel(jobs: jobs, store: store, sync: sync, prefs: prefs, settings: settings, build: build, flash: flash, sound: nil)
    }

    /// Runs a scan to its end and waits for the list to show it.
    private func scan(_ vm: PrintLabelsViewModel, _ value: String) async {
        let before = vm.entries.count
        await vm.onScan(value)?.value
        await waitUntil { vm.entries.count > before && vm.entries[0].state != .queued && vm.entries[0].state != .sending }
    }

    private var rows: [OutboxRow] { outbox.snapshot.rows }

    @Test func aScannedAssetIdPrintsItsStoredLabelWithTheSendSettingsAndRecordsOneLabeledScan() async throws {
        let vm = try await harness()
        await scan(vm, "a-1")
        #expect(device.sent.map(\.host) == ["10.0.0.5"])
        #expect(device.sent.map(\.zpl) == ["LT-2LS4|^XA^FDA-1^FS^XZ|MMP"])
        #expect(engine.calls == ["applyPrintSettings", "withPrintMode"])
        #expect(rows.count == 1)
        let row = try #require(rows.first)
        #expect(row.scannedValue == "a-1"); #expect(row.scanType == "barcode"); #expect(row.scanStatus == "labeled")
        #expect(row.asset?.id == "a1"); #expect(row.siteId == "s1"); #expect(row.initiativeId == "i1")
        #expect(vm.entries[0].state == .printed)
        #expect(flash.state?.color == Color(hsl: prefs.appearance.goodScan))

        // Reprint: one more label, no more scans.
        await vm.reprint(vm.entries[0].id).value
        #expect(device.sent.count == 2)
        #expect(rows.count == 1)
        #expect(await waitUntil { vm.entries.count == 2 && vm.entries[0].reprint && vm.entries[0].state == .printed })
    }

    @Test func aSerialMatchesButAnRfidTagDoesNot() async throws {
        let vm = try await harness()
        await scan(vm, "100348")
        #expect(vm.entries[0].message == "No asset matches that scan.")
        #expect(device.sent.isEmpty)
        #expect(flash.state?.color == Color(hsl: prefs.appearance.notFoundScan))
        await scan(vm, "SN1")
        #expect(vm.entries[0].state == .printed)
        #expect(rows.map { $0.asset?.id } == ["a1"])
    }

    @Test func anAssetWithoutALabelSaysWhyAndRecordsNothing() async throws {
        let vm = try await harness()
        await scan(vm, "A-2")
        #expect(vm.entries[0].state == .failed)
        #expect(vm.entries[0].message?.hasPrefix("No label for this asset: this move has no active label template") == true)
        #expect(device.sent.isEmpty)
        #expect(rows.isEmpty)
    }

    @Test func anUnreachablePrinterRecordsNothingUntilARetryPrints() async throws {
        let vm = try await harness()
        device.failures = 1
        await scan(vm, "A-1")
        let failed = vm.entries[0]
        #expect(failed.message == "Can't reach the printer at 10.0.0.5.")
        #expect(rows.isEmpty)
        await vm.retry(failed.id).value
        #expect(await waitUntil { vm.entries[0].state == .printed })
        #expect(rows.count == 1)
        #expect(engine.calls.count == 2) // the retry resent the same bytes
    }

    @Test func aPrinterTimeoutSaysTheLabelMayHavePrinted() async throws {
        let vm = try await harness()
        device.failures = 1
        device.timeouts = true
        await scan(vm, "A-1")
        #expect(vm.entries[0].message == "The printer didn't finish answering. It may have printed the label — check before you retry.")
        #expect(rows.isEmpty)
    }

    @Test func aScanWhileTheBuildRunsIsRefusedEvenWithAStoredLabel() async throws {
        let vm = try await harness()
        build.status = LabelBuildStatus(phase: .running, done: 0, total: 0)
        await scan(vm, "A-1")
        #expect(vm.entries[0].message == "Labels are being prepared.")
        #expect(device.sent.isEmpty)
    }

    @Test func aScanWhileTheKioskSyncsIsRefusedEvenWithAStoredLabel() async throws {
        let vm = try await harness()
        sync.isSyncing = true
        await scan(vm, "A-1")
        #expect(vm.entries[0].state == .failed)
        #expect(vm.entries[0].message == "This kiosk is syncing. Labels will be ready shortly.")
        #expect(device.sent.isEmpty)
        #expect(rows.isEmpty)
    }

    @Test func aPrintHelperThatTimesOutOnceIsAskedAgain() async throws {
        let vm = try await harness()
        engine.timeoutsLeft = 1
        await scan(vm, "A-1")
        #expect(vm.entries[0].state == .printed)
        #expect(device.sent.count == 1)
    }

    /// iOS copy (the plan's ruling), not Android's "system WebView is too old".
    @Test func anUnsupportedEngineSaysSoAndPrintsNothing() async throws {
        let vm = try await harness()
        engine.unsupported = true
        await scan(vm, "A-1")
        #expect(vm.entries[0].message == "This device can't make labels. Restart the app; if it keeps happening, the app needs an update.")
        #expect(device.sent.isEmpty)
        #expect(rows.isEmpty)
    }

    @Test func aScanWhileTheBuildRunsAndTheAssetHasNoRowSaysStillBeingMade() async throws {
        let vm = try await harness()
        _ = try await store.deleteGeneratedLabels(["a1"], ifMove: "i1")
        build.status = LabelBuildStatus(phase: .running, done: 200, total: 800, templateId: "t1")
        await scan(vm, "A-1")
        #expect(vm.entries[0].message == "Labels are still being made (200 of 800).")
        #expect(device.sent.isEmpty)
    }

    @Test func noPrinterSaysOpenPrinterSetup() async throws {
        let vm = try await harness(withPrinter: false)
        await scan(vm, "A-1")
        #expect(vm.entries[0].message == "No printer set up. Open Printer Setup.")
        #expect(engine.calls.isEmpty)
    }

    @Test func theHeaderCountsReadyLabelsAndWhyTheOthersHaveNone() {
        #expect(readySummary(LabelBuildStatus(phase: .done, ready: 1)) == "1 label ready")
        #expect(readySummary(LabelBuildStatus(phase: .done, ready: 12, problems: [
            OutcomeCount(code: NO_TEMPLATE_AT_DPI, count: 2), OutcomeCount(code: TEMPLATE_FAILED, count: 1),
        ])) == "12 labels ready · 2 with no template at this DPI, 1 whose template couldn't be built")
        #expect(readySummary(LabelBuildStatus(phase: .done, problems: [
            OutcomeCount(code: TEMPLATE_UNSUPPORTED, count: 1), OutcomeCount(code: "something_new", count: 4),
        ])) == "0 labels ready · 1 whose template needs an app update, 4 with no label")
        // First-seen order, and a zero count says nothing.
        #expect(readySummary(LabelBuildStatus(phase: .done, ready: 2, problems: [
            OutcomeCount(code: TEMPLATE_FAILED, count: 1), OutcomeCount(code: NO_TEMPLATE_AT_DPI, count: 0),
            OutcomeCount(code: NO_TEMPLATE_AT_DPI + "_x", count: 3),
        ])) == "2 labels ready · 1 whose template couldn't be built, 3 with no label")
    }

    // MARK: iOS

    @Test func aScanBeforeTheRosterOrTheSetupSaysSoAndPrintsNothing() async throws {
        let vm = makeVM()
        await vm.loadRoster()
        #expect(vm.onScan("A-1") == nil)
        #expect(vm.error == "No move data on this kiosk. Sync from Kiosk Setup.")
        #expect(flash.state?.color == Color(hsl: prefs.appearance.notFoundScan))
        #expect(vm.entries.isEmpty)
        #expect(vm.onScan("   ") == nil)

        // Once there is a roster, a scan clears the message.
        let ready = try await harness()
        await scan(ready, "A-1")
        #expect(ready.error == nil)
    }

    /// The screen's scan collection ends whenever the screen goes off screen (Printer Setup on
    /// top, Back). Scans it already passed on still print and record: the job printing and the
    /// one waiting behind it.
    @Test func endingTheScanCollectionNeverCancelsScansAlreadyQueued() async throws {
        let vm = try await harness()
        device.hold = true
        let (events, input) = AsyncStream.makeStream(of: ScanEvent.self)
        let follower = Task { await vm.follow(events) }
        input.yield(ScanEvent(value: "A-1", source: .keyboard, symbology: nil))
        input.yield(ScanEvent(value: "SN1", source: .keyboard, symbology: nil))
        #expect(await waitUntil { device.atHold && vm.entries.count == 2 })
        #expect(vm.entries.map(\.state) == [.queued, .sending])

        follower.cancel()
        // Released before the follower is awaited, so a follower that waited on its prints
        // fails here instead of hanging.
        device.hold = false
        await follower.value
        #expect(await waitUntil { vm.entries.map(\.state) == [.printed, .printed] })
        #expect(device.sent.count == 2)
        #expect(rows.map(\.scannedValue).sorted() == ["A-1", "SN1"])
    }

    /// Leaving the screen releases the view model; a label already scanned still goes out and
    /// gets its Labeled scan, and a screen opened again shows it on the kiosk's one list.
    @Test func aScanOutlivesItsViewModel() async throws {
        var vm: PrintLabelsViewModel? = try await harness()
        device.hold = true
        device.failures = 1
        vm?.onScan("A-1")
        #expect(await waitUntil { device.atHold })
        weak var gone = vm
        vm = nil
        #expect(gone == nil)
        device.hold = false
        #expect(await waitUntil { jobs.entries.first?.state == .failed })

        // Back on the screen: the earlier job is listed and can be retried.
        let again = makeVM()
        await again.loadRoster()
        let failed = try #require(again.entries.first)
        #expect(failed.scannedValue == "A-1")
        await again.retry(failed.id).value
        #expect(await waitUntil { again.entries.first?.state == .printed })
        #expect(device.sent.count == 1)
        #expect(rows.count == 1)
        #expect(rows[0].scanStatus == "labeled")
    }

    /// Two screens, one queue: a screen closed with jobs still waiting and a new one opened
    /// can't interleave labels. A and B scanned on the first go out before E on the second.
    @Test func twoScreensSendInOneScanOrder() async throws {
        let first = try await harness()
        device.hold = true
        first.onScan("A-1")
        first.onScan("A-3")
        #expect(await waitUntil { device.atHold && first.entries.count == 2 })

        let second = makeVM()
        await second.loadRoster()
        second.onScan("SN1")
        #expect(await waitUntil { second.entries.contains { $0.scannedValue == "SN1" } })
        // Room for a wrongly parallel queue to start E's send while A is held.
        try await Task.sleep(for: .milliseconds(100))
        device.hold = false
        #expect(await waitUntil { device.sent.count == 3 })
        #expect(device.started == ["LT-2LS4|^XA^FDA-1^FS^XZ|MMP", "LT-2LS4|^XA^FDA-3^FS^XZ|MMP", "LT-2LS4|^XA^FDA-1^FS^XZ|MMP"])
        #expect(rows.count == 3)
    }

    /// A job records under the move it was scanned for, even when Kiosk Setup changes before
    /// its label goes out.
    @Test func aJobRecordsUnderTheMoveItWasScannedFor() async throws {
        let vm = try await harness()
        device.hold = true
        vm.onScan("A-1")
        #expect(await waitUntil { device.atHold })
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i2", initiativeName: "Other", siteId: "s2", siteName: "Elsewhere",
                                                   siteRole: "destination", scanStatus: "received", scanLabel: "Received")
        device.hold = false
        #expect(await waitUntil { rows.count == 1 })
        #expect(rows[0].siteId == "s1")
        #expect(rows[0].initiativeId == "i1")
    }

    @Test func aRosterWithoutASetupSelectionSaysSoAndPrintsNothing() async throws {
        let vm = try await harness()
        prefs.setupSelection = nil
        #expect(vm.rosterSize == 3)
        #expect(vm.onScan("A-1") == nil)
        #expect(vm.error == "No move data on this kiosk. Sync from Kiosk Setup.")
        #expect(vm.entries.isEmpty)
        #expect(device.started.isEmpty)
    }

    /// The real Sync maps onto Print Labels' sync: syncing while a run is in progress.
    @Test func aRealSyncIsSyncingWhileItRuns() async throws {
        let (gate, open) = AsyncStream.makeStream(of: Void.self)
        api.assets = {
            for await _ in gate {}
            throw ApiError(status: 500, code: "test_done", detail: [:])
        }
        let real = Sync(api: api, store: store)
        #expect(!real.isSyncing)
        real.run(initiativeId: "i1", initiativeName: "Move")
        #expect(await waitUntil { real.isSyncing })
        open.finish()
        #expect(await waitUntil { !real.isSyncing })
    }

    @Test func syncNowRunsTheMovesSync() async throws {
        let vm = makeVM()
        vm.syncNow()
        #expect(sync.runs.isEmpty) // no setup: nothing to sync
        prefs.setupSelection = testSelection(initiativeId: "i1")
        vm.syncNow()
        #expect(sync.runs == ["i1 Move"])
        sync.isSyncing = true
        #expect(vm.syncing)
    }

    @Test func theHeaderReadsTheBuildAndTheSettings() async throws {
        let vm = try await harness(withPrinter: false)
        #expect(vm.build == build.status)
        #expect(vm.settings.printer == nil)
        settings.setPrinter(printer)
        #expect(vm.settings.printer == printer)
    }

    @Test func entryAndPrinterCopy() {
        func entry(_ state: PrintState, reprint: Bool = false) -> PrintEntry<KioskAssetRow> {
            PrintEntry(id: "p-1", asset: nil, scannedValue: "A-1", scannedAt: "now", reprint: reprint, state: state)
        }
        #expect(printStatusText(entry(.queued)) == "Waiting to print")
        #expect(printStatusText(entry(.sending)) == "Printing")
        #expect(printStatusText(entry(.printed)) == "Printed")
        #expect(printStatusText(entry(.failed)) == "Failed")
        #expect(printStatusText(entry(.printed, reprint: true)) == "Printed (reprint)")
        #expect(printStatusTone(.printed) == .green)
        #expect(printStatusTone(.queued) == .amber && printStatusTone(.sending) == .amber)
        #expect(printStatusTone(.failed) == .red)

        #expect(printerSummary(SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S", dpi: 203)) == "ZD421 at 10.0.0.5 · 203 dpi")
        #expect(printerSummary(SavedPrinter(host: "10.0.0.5", model: "  ", serial: "", dpi: 300)) == "Zebra at 10.0.0.5 · 300 dpi")

        #expect(labelPlacement(["source_raw": " A12 ", "source_ru": "22"], "source") == "A12 · RU 22")
        #expect(labelPlacement(["destination_ru": "7"], "destination") == "RU 7")
        #expect(labelPlacement(["source_raw": "  ", "source_ru": ""], "source") == "—")
        #expect(labelPlacement([:], "destination") == "—")
        #expect(BUILD_FAILED_TEXT == "Labels couldn't be made. Try syncing again.")

        let rack = KioskAssetRow(id: "a1", assetId: "A-1", name: "Rack 1", serialNumber: "SN1", makeModel: "Dell")
        #expect(printEntryLine(rack) == "Rack 1 · SN1")
        #expect(printEntryLine(KioskAssetRow(id: "a2", assetId: "A-2", name: " ", serialNumber: "SN2")) == "SN2")
        #expect(printEntryLine(KioskAssetRow(id: "a3", assetId: "A-3")) == "—")
        #expect(printEntryLine(nil) == "No match")
        #expect(printEntryTitle(rack) == "Rack 1")
        #expect(printEntryTitle(KioskAssetRow(id: "a3", assetId: "A-3", name: "")) == "A-3")
    }
}
