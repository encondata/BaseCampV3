import Testing
import Foundation
import SwiftUI
@testable import ServerSherpa_Kiosk

@MainActor
struct ScanViewModelTests {
    private let store: KioskStore
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let api = FakeKioskApi()

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.container(inMemory: true))
    }

    private func seed(_ assets: [KioskAssetRow]) async throws {
        try await store.replaceRoster(assets: assets, people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: assets.count, people: 0, containers: 0, trucks: 0, syncedAt: "now"))
    }

    private func makeOutbox(_ outboxStore: OutboxStore = MemoryOutboxStore()) -> Outbox {
        Outbox(store: outboxStore, api: api, serial: { "kiosk-ios-test" }, backgroundTask: NoBackgroundTasking())
    }

    private func makeVM(_ outbox: Outbox, flash: FlashController? = nil) -> ScanViewModel {
        let sync = Sync(api: api, store: store)
        return ScanViewModel(store: store, sync: sync, outbox: outbox, prefs: prefs, flash: flash ?? FlashController(), sound: nil)
    }

    private let dell = KioskAssetRow(id: "a1", assetId: "A-1", name: "Rack", rfid: "000000000000000000100348", serialNumber: "SN1", makeModel: "Dell")

    @Test func matchedScanQueuesAndFlashesUnmatchedIsNoMatch() async throws {
        try await seed([dell])
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move", siteId: "s1", siteName: "Site", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        let outbox = makeOutbox()
        let flash = FlashController()
        let vm = makeVM(outbox, flash: flash)
        await vm.loadRoster()
        #expect(vm.loadStatus == .ready); #expect(vm.rosterSize == 1)
        await vm.onScan("100348")
        let row = outbox.snapshot.rows[0]
        #expect(row.status == .queued); #expect(row.scanType == "rfid"); #expect(row.asset?.id == "a1"); #expect(row.siteId == "s1")
        #expect(flash.state?.color == Color(hsl: prefs.appearance.goodScan))
        await vm.onScan("zzz")
        let miss = outbox.snapshot.rows[0]
        #expect(miss.status == .nomatch); #expect(miss.asset == nil); #expect(miss.scanType == "barcode")
        #expect(flash.state?.color == Color(hsl: prefs.appearance.notFoundScan))
        #expect(Color(hsl: prefs.appearance.goodScan) != Color(hsl: prefs.appearance.notFoundScan))
        #expect(outbox.snapshot.counts.total == 2)
    }

    /// kiosk/src/pages/Scan.tsx statusLabel(), verbatim.
    @Test func statusLabelsMatchTheWebKiosk() {
        let base = OutboxMachine.newRow(EnqueueInput(scannedValue: "A-1", scanType: "barcode", asset: nil, siteId: "s1", initiativeId: "i1", scanStatus: "pre_stage"), clientScanId: "c1", seq: 1, nowMs: 0)
        func row(_ status: OutboxStatus, attempts: Int = 0, lastError: String? = nil) -> OutboxRow {
            var r = base; r.status = status; r.attempts = attempts; r.lastError = lastError; return r
        }
        #expect(statusLabel(row(.queued)) == "Queued")
        #expect(statusLabel(row(.sending)) == "Sending")
        #expect(statusLabel(row(.accepted)) == "Sent")
        #expect(statusLabel(row(.retrying, attempts: 2)) == "Retrying (2/4)")
        #expect(statusLabel(row(.failed, lastError: "bad_site")) == "Failed: bad_site")
        #expect(statusLabel(row(.failed)) == "Failed: timeout")
        #expect(statusLabel(row(.nomatch)) == "No match")
    }

    /// An outbox store whose writes always throw.
    private struct ThrowingOutboxStore: OutboxStore {
        struct Disk: Error {}
        func all() async throws -> [OutboxRow] { [] }
        func upsert(_ rows: [OutboxRow]) async throws { throw Disk() }
        func delete(_ ids: [String]) async throws { throw Disk() }
    }

    @Test func outboxWriteFailureSurfacesStorageError() async throws {
        try await seed([dell])
        prefs.setupSelection = testSelection(initiativeId: "i1")
        let vm = makeVM(makeOutbox(ThrowingOutboxStore()))
        await vm.loadRoster()
        await vm.onScan("A-1")
        #expect(vm.storageError == "Couldn't save this scan on the kiosk. Check its storage.")
    }

    @Test func aScanWithoutARosterOrSetupSaysSoAndQueuesNothing() async throws {
        let outbox = makeOutbox()
        let flash = FlashController()
        let vm = makeVM(outbox, flash: flash)
        await vm.loadRoster()
        #expect(vm.rosterSize == 0)
        await vm.onScan("A-1")
        #expect(vm.error == "No move data on this kiosk. Sync from Kiosk Setup.")
        #expect(outbox.snapshot.counts.total == 0)
        #expect(flash.state != nil)
    }

    @Test func blankScansAreIgnoredAndValuesTrimmed() async throws {
        try await seed([dell])
        prefs.setupSelection = testSelection(initiativeId: "i1")
        let outbox = makeOutbox()
        let vm = makeVM(outbox)
        await vm.loadRoster()
        await vm.onScan("   ")
        #expect(outbox.snapshot.counts.total == 0)
        await vm.onScan("  A-1 ")
        #expect(outbox.snapshot.rows.first?.scannedValue == "A-1")
    }

    @Test func discardAsksFirstAndKeepCancels() async throws {
        let vm = makeVM(makeOutbox())
        vm.askDiscard(); #expect(vm.confirmDiscard)
        vm.cancelDiscard(); #expect(!vm.confirmDiscard)
    }

    @Test func scanTimeIsHHmmssInTheGivenZone() {
        let ny = TimeZone(identifier: "America/New_York")!
        #expect(scanTime("2026-09-30T18:05:09.123Z", in: ny) == "14:05:09")
        #expect(scanTime("2026-09-30T18:05:09Z", in: ny) == "14:05:09")
        #expect(scanTime("not a date", in: ny) == "not a date")
    }

    @Test func aRosterWithoutASetupSelectionSaysSoAndQueuesNothing() async throws {
        try await seed([dell])
        prefs.setupSelection = nil
        let outbox = makeOutbox()
        let flash = FlashController()
        let vm = makeVM(outbox, flash: flash)
        await vm.loadRoster()
        #expect(vm.rosterSize == 1)
        await vm.onScan("A-1")
        #expect(vm.error == ScanViewModel.NO_MOVE_DATA)
        #expect(outbox.snapshot.counts.total == 0)
        #expect(flash.state?.color == Color(hsl: prefs.appearance.notFoundScan))
    }

    private func outboxWith(_ statuses: [OutboxStatus]) async -> Outbox {
        let memory = MemoryOutboxStore()
        for (i, status) in statuses.enumerated() {
            var r = OutboxMachine.newRow(EnqueueInput(scannedValue: "V\(i)", scanType: "barcode", asset: nil, siteId: "s1", initiativeId: "i1", scanStatus: "pre_stage"), clientScanId: "c\(i)", seq: Int64(i + 1), nowMs: 0)
            r.status = status
            await memory.upsert([r])
        }
        let outbox = makeOutbox(memory)
        await outbox.load()
        return outbox
    }

    @Test func discardFailedRemovesFailedRowsAndClosesTheConfirm() async {
        let outbox = await outboxWith([.failed, .failed, .accepted])
        let vm = makeVM(outbox)
        vm.askDiscard()
        await vm.discardFailed()
        #expect(!vm.confirmDiscard)
        #expect(outbox.snapshot.counts.failed == 0)
        #expect(outbox.snapshot.counts.total == 1)
    }

    @Test func retryFailedRequeuesFailedRows() async {
        let outbox = await outboxWith([.failed, .accepted])
        #expect(outbox.snapshot.counts.failed == 1)
        await makeVM(outbox).retryFailed()
        #expect(outbox.snapshot.counts.failed == 0)
        #expect(outbox.snapshot.counts.total == 2)
    }

    @Test func clearSentRemovesAcceptedAndNoMatchRows() async {
        let outbox = await outboxWith([.accepted, .nomatch, .failed])
        await makeVM(outbox).clearSent()
        #expect(outbox.snapshot.counts.total == 1)
        #expect(outbox.snapshot.counts.failed == 1)
    }

    @Test func aCanceledRosterLoadIsNotAnError() async throws {
        try await seed([dell])
        let vm = makeVM(makeOutbox())
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            await vm.loadRoster()
        }
        await task.value
        #expect(vm.loadStatus == .loading)
        #expect(vm.rosterSize == 0)
    }
}
