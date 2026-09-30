import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// Virtual time for the outbox (Android's `runTest` scheduler): `now` is the
/// outbox's clock, and every `sleep` parks until `advance(by:)` moves the clock
/// past its due time — so no test ever waits for a real delay.
private final class VirtualTime: @unchecked Sendable {
    private struct Sleeper { let id: Int; let due: Int64; let resume: CheckedContinuation<Void, Error> }
    private let lock = NSLock()
    private var _now: Int64 = 0
    private var sleepers: [Sleeper] = []
    private var nextId = 0

    var now: Int64 { lock.withLock { _now } }
    var sleeperCount: Int { lock.withLock { sleepers.count } }

    func sleep(_ ms: Int64) async throws {
        if ms <= 0 { await Task.yield(); try Task.checkCancellation(); return }
        let id = lock.withLock { nextId += 1; return nextId }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                let cancelled = lock.withLock { () -> Bool in
                    if Task.isCancelled { return true }
                    sleepers.append(Sleeper(id: id, due: _now + ms, resume: c))
                    return false
                }
                if cancelled { c.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let c = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let i = sleepers.firstIndex(where: { $0.id == id }) else { return nil }
                return sleepers.remove(at: i).resume
            }
            c?.resume(throwing: CancellationError())
        }
    }

    /// Moves the clock forward by `ms`, waking each sleeper at its own due time, in order.
    @MainActor func advance(by ms: Int64) async {
        await drain()
        let target = now + ms
        while true {
            let next = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let i = sleepers.indices.filter({ sleepers[$0].due <= target })
                    .min(by: { sleepers[$0].due < sleepers[$1].due }) else { _now = target; return nil }
                let s = sleepers.remove(at: i)
                _now = max(_now, s.due)
                return s.resume
            }
            guard let c = next else { break }
            c.resume()
            await drain()
        }
        await drain()
    }
}

/// The virtual scheduler's "run until idle" between wake-ups inside `advance`:
/// lets the main-actor work a wake-up started, and its store-actor hops, run to
/// their next park. Test bodies never call it; they wait on an observable condition.
@MainActor private func drain() async {
    for _ in 0..<10 {
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(2))
    }
}

/// A store that fails the next N upserts/deletes, then behaves.
private actor FlakyOutboxStore: OutboxStore {
    private let inner = MemoryOutboxStore()
    private var failUpserts = 0
    private var failDeletes = 0
    private(set) var upsertAttempts = 0
    func setFailUpserts(_ n: Int) { failUpserts = n }
    func setFailDeletes(_ n: Int) { failDeletes = n }
    func all() async throws -> [OutboxRow] { try await inner.all() }
    func upsert(_ rows: [OutboxRow]) async throws {
        upsertAttempts += 1
        if failUpserts > 0 { failUpserts -= 1; throw CocoaError(.fileWriteUnknown) }
        try await inner.upsert(rows)
    }
    func delete(_ ids: [String]) async throws {
        if failDeletes > 0 { failDeletes -= 1; throw CocoaError(.fileWriteUnknown) }
        try await inner.delete(ids)
    }
}

/// Records background-task begin/end calls.
@MainActor private final class CountingBackgroundTasking: BackgroundTasking {
    private(set) var begun = 0
    private(set) var ended: [Int] = []
    func begin() -> Int { begun += 1; return begun }
    func end(_ id: Int) { ended.append(id) }
}

/// A one-shot latch a fake POST can wait on until the test opens it.
private actor Gate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() { open = true; let w = waiters; waiters = []; for c in w { c.resume() } }
}

@MainActor
struct OutboxTests {
    private let asset = OutboxAsset(id: "a1", assetId: "A-1", name: "Rack", rfid: nil, serialNumber: "SN", makeModel: "Dell")
    private let time = VirtualTime()
    private let bg = CountingBackgroundTasking()

    private func input(_ value: String = "A-1", matched: Bool = true) -> EnqueueInput {
        EnqueueInput(scannedValue: value, scanType: "barcode", asset: matched ? asset : nil, siteId: "s1", initiativeId: "i1", scanStatus: "pre_stage")
    }

    private func outbox(_ api: FakeKioskApi, _ store: OutboxStore = MemoryOutboxStore()) -> Outbox {
        var n = 0
        let time = self.time
        return Outbox(store: store, api: api, serial: { "kiosk-ios-test" }, clock: { time.now },
                      idGen: { n += 1; return "c\(n)" }, sleep: { try await time.sleep($0) }, backgroundTask: bg)
    }

    /// Starts the sender and waits for its start pass to finish and the sweep loop to park.
    private func started(_ ob: Outbox) async -> Outbox {
        ob.start()
        await ob.startPass()
        let time = self.time
        await waitUntil { time.sleeperCount >= 1 }
        return ob
    }

    private func accepting(_ body: KioskScanBatchIn) -> KioskScanBatchOut { KioskScanBatchOut(accepted: body.scans.map(\.clientScanId)) }

    @Test func matchedScansBatchAfter500msAndAreAccepted() async {
        let api = FakeKioskApi()
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input()); await time.advance(by: 100); _ = await ob.enqueue(input("A-1"))
        #expect(api.scanBatches.count == 0)                  // virtual time is at 100 ms: the batch window is still open
        await time.advance(by: 500)
        #expect(api.scanBatches.count == 1)
        #expect(api.scanBatches.first?.scans.map(\.clientScanId) == ["c1", "c2"])
        #expect(api.scanBatches.first?.scans.first?.assetId == "a1")
        #expect(api.scanBatches.first?.serial == "kiosk-ios-test")
        #expect(ob.snapshot.rows.first?.status == .accepted)
        #expect(ob.snapshot.counts.accepted == 2)
        #expect(ob.snapshot.rows.first?.seq == 2)   // newest first
        #expect(bg.begun == 1); #expect(bg.ended == [1])
    }

    @Test func unmatchedNeverLeavesAndExpiresAfterTtl() async {
        let api = FakeKioskApi()
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input("zzz", matched: false))
        await time.advance(by: 5_000)
        #expect(api.scanBatches.count == 0)
        #expect(ob.snapshot.counts.nomatch == 1)
        await time.advance(by: OutboxMachine.NOMATCH_TTL_MS + OutboxMachine.NOMATCH_SWEEP_MS + 1)
        #expect(ob.snapshot.counts.total == 0)
    }

    @Test func failureBacksOffThenSucceeds() async {
        let api = FakeKioskApi()
        api.postScansResult = { _ in throw ApiError(status: 0, code: "network") }
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input()); await time.advance(by: 600)
        #expect(api.scanBatches.count == 1)
        let row = ob.snapshot.rows.first
        #expect(row?.status == .retrying); #expect(row?.attempts == 1); #expect(row?.lastError == "network")
        api.postScansResult = { KioskScanBatchOut(accepted: $0.scans.map(\.clientScanId)) }
        await time.advance(by: 2_001)
        #expect(api.scanBatches.count == 2)
        #expect(ob.snapshot.rows.first?.status == .accepted)
    }

    @Test func aThrownNonApiErrorIsATimeout() async {
        let api = FakeKioskApi()
        api.postScansResult = { _ in throw URLError(.notConnectedToInternet) }
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input()); await time.advance(by: 600)
        #expect(ob.snapshot.rows.first?.status == .retrying)
        #expect(ob.snapshot.rows.first?.lastError == "timeout")
    }

    @Test func rejectionFailsImmediatelyAndRetryFailedRequeues() async {
        let api = FakeKioskApi()
        api.postScansResult = { KioskScanBatchOut(rejected: $0.scans.map { KioskScanRejected(clientScanId: $0.clientScanId, code: "bad_site") }) }
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input()); await time.advance(by: 600)
        #expect(ob.snapshot.rows.first?.status == .failed)
        #expect(ob.snapshot.rows.first?.lastError == "bad_site")
        api.postScansResult = { KioskScanBatchOut(accepted: $0.scans.map(\.clientScanId)) }
        await ob.retryFailed()
        await waitUntil { ob.snapshot.rows.first?.status == .accepted }
        #expect(ob.snapshot.rows.first?.status == .accepted)
    }

    @Test func loadRecoversStrandedSendingRowsAndKeepsSeq() async throws {
        let store = MemoryOutboxStore()
        var stranded = OutboxMachine.newRow(input(), clientScanId: "old", seq: 7, nowMs: 0)
        stranded.status = .sending
        try await store.upsert([stranded])
        let api = FakeKioskApi()
        let ob = await started(outbox(api, store))
        await waitUntil { api.scanBatches.count == 1 }
        #expect(api.scanBatches.count == 1)          // resent
        let fresh = await ob.enqueue(input())
        #expect(fresh?.seq == 8)
    }

    /// Android: stop() mid-POST cancels it and the next start() resends the batch.
    /// iOS keeps the POST running through stop() (see the next test), so the next
    /// start() must NOT recover and resend a batch that is still in flight.
    @Test func stopMidPostThenStartDoesNotResendTheInFlightBatch() async {
        let api = FakeKioskApi()
        let gate = Gate()
        api.postScansResult = { body in
            await gate.wait()
            return KioskScanBatchOut(accepted: body.scans.map(\.clientScanId))
        }
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input())
        await time.advance(by: 600)
        #expect(api.scanBatches.count == 1)
        #expect(ob.snapshot.rows.map(\.status) == [.sending])

        ob.stop()
        ob.start(); await ob.startPass()
        #expect(api.scanBatches.count == 1)                   // not resent while in flight
        #expect(ob.snapshot.rows.map(\.status) == [.sending])

        await gate.release()
        await waitUntil { ob.snapshot.rows.map(\.status) == [.accepted] }
        #expect(api.scanBatches.count == 1)
        #expect(ob.snapshot.rows.map(\.status) == [.accepted])
    }

    /// The app is backgrounded mid-POST: the batch's outcome is still written back,
    /// under a background task that ends once it is persisted.
    @Test func writeBackSurvivesStopDuringAnInFlightPost() async throws {
        let api = FakeKioskApi()
        let gate = Gate()
        api.postScansResult = { body in
            await gate.wait()
            return KioskScanBatchOut(accepted: body.scans.map(\.clientScanId))
        }
        let store = MemoryOutboxStore()
        let ob = await started(outbox(api, store))
        _ = await ob.enqueue(input())
        await time.advance(by: 600)
        #expect(api.scanBatches.count == 1)
        #expect(bg.begun == 1); #expect(bg.ended.isEmpty)

        ob.stop()
        await gate.release()
        await waitUntil { bg.ended == [1] }

        #expect(try await store.all().map(\.status) == [.accepted])
        #expect(ob.snapshot.rows.map(\.status) == [.accepted])
        #expect(bg.ended == [1])
    }

    @Test func clearSentAndDiscardFailed() async {
        let api = FakeKioskApi()
        api.postScansResult = { body in
            KioskScanBatchOut(accepted: body.scans.filter { $0.scannedValue == "A-1" }.map(\.clientScanId),
                              rejected: body.scans.filter { $0.scannedValue == "B-2" }.map { KioskScanRejected(clientScanId: $0.clientScanId, code: "bad_status") })
        }
        let ob = await started(outbox(api))
        _ = await ob.enqueue(input("A-1")); _ = await ob.enqueue(input("B-2")); _ = await ob.enqueue(input("nomatch", matched: false))
        await time.advance(by: 600)
        #expect(ob.snapshot.counts.total == 3)
        await ob.clearSent()
        #expect(ob.snapshot.rows.map(\.status) == [.failed])
        await ob.discardFailed()
        #expect(ob.snapshot.rows.isEmpty)
    }

    @Test func storageFailureWhileMarkingSendingDoesNotKillTheSender() async {
        let api = FakeKioskApi()
        let store = FlakyOutboxStore()
        let ob = await started(outbox(api, store))
        _ = await ob.enqueue(input())                    // the enqueue itself persists
        await store.setFailUpserts(1)                    // fail the mark-sending save the 500 ms flush is about to trigger
        await time.advance(by: 600)
        #expect(api.scanBatches.isEmpty)                 // nothing went out; the retry waits out the backoff
        await time.advance(by: OutboxMachine.BACKOFF[0])
        // The failed mark-sending save reverts the row instead of stranding it `sending`,
        // and the sender retries on its own. Exactly one batch ever reaches the API.
        #expect(api.scanBatches.count == 1)
        #expect(api.scanBatches.first?.scans.map(\.clientScanId) == ["c1"])
        #expect(ob.snapshot.rows.first?.status == .accepted)

        // The sender is still alive afterward too.
        _ = await ob.enqueue(input("A-1")); await time.advance(by: 600)
        #expect(api.scanBatches.count == 2)
        #expect(ob.snapshot.rows.first?.status == .accepted)
    }

    /// A store that keeps failing is retried after the back-off, never in a hot loop.
    @Test func aStoreThatKeepsFailingIsRetriedAfterTheBackoff() async {
        let api = FakeKioskApi()
        let store = FlakyOutboxStore()
        let ob = await started(outbox(api, store))
        _ = await ob.enqueue(input())
        let base = await store.upsertAttempts             // the enqueue's own save
        await store.setFailUpserts(Int.max)
        await time.advance(by: 600)                       // the 500 ms flush: marking `sending` fails
        #expect(await store.upsertAttempts == base + 1)
        await time.advance(by: 1_000)                     // 1.6 s: still inside the 2 s back-off
        #expect(await store.upsertAttempts == base + 1)
        await time.advance(by: 1_000)                     // 2.6 s: the 2.5 s retry ran, and failed again
        #expect(await store.upsertAttempts == base + 2)
        await time.advance(by: 2_000)                     // 4.6 s: the 4.5 s retry
        #expect(await store.upsertAttempts == base + 3)
        #expect(api.scanBatches.isEmpty)
        ob.stop()
    }

    /// A write-back that can't be saved re-queues the rows and waits out the back-off before resending.
    @Test func aFailedWriteBackWaitsOutTheBackoff() async {
        let api = FakeKioskApi()
        let store = FlakyOutboxStore()
        api.postScansResult = { body in
            await store.setFailUpserts(1)                 // the write-back after this POST fails
            return KioskScanBatchOut(accepted: body.scans.map(\.clientScanId))
        }
        let ob = await started(outbox(api, store))
        _ = await ob.enqueue(input())
        await time.advance(by: 600)
        #expect(api.scanBatches.count == 1)
        #expect(ob.snapshot.rows.first?.status == .queued)
        await time.advance(by: 1_000)
        #expect(api.scanBatches.count == 1)               // not resent at once
        api.postScansResult = { KioskScanBatchOut(accepted: $0.scans.map(\.clientScanId)) }
        await time.advance(by: 1_000)
        #expect(api.scanBatches.count == 2)
        #expect(ob.snapshot.rows.first?.status == .accepted)
    }

    @Test func storageFailureInSweepDoesNotKillTheSweeper() async {
        let api = FakeKioskApi()
        let store = FlakyOutboxStore()
        let ob = await started(outbox(api, store))
        _ = await ob.enqueue(input("zzz", matched: false))
        await store.setFailDeletes(1)
        await time.advance(by: OutboxMachine.NOMATCH_TTL_MS + OutboxMachine.NOMATCH_SWEEP_MS)
        #expect(ob.snapshot.counts.nomatch == 1)   // delete threw; the sweeper kept the row rather than crash
        await time.advance(by: OutboxMachine.NOMATCH_SWEEP_MS)   // still alive: it retries next tick
        #expect(ob.snapshot.counts.total == 0)
    }

    @Test func enqueueStorageFailureSetsStorageErrorAndSuccessClearsIt() async {
        let api = FakeKioskApi()
        let store = FlakyOutboxStore()
        let ob = await started(outbox(api, store))
        await store.setFailUpserts(1)
        let failed = await ob.enqueue(input())
        #expect(failed == nil)
        #expect(ob.storageError == "Couldn't save this scan on the kiosk. Check its storage.")
        #expect(ob.snapshot.rows.isEmpty)
        let saved = await ob.enqueue(input())
        #expect(saved != nil)
        #expect(ob.storageError == nil)
    }

    @Test func kioskStoreIsAnOutboxStore() async throws {
        let store: OutboxStore = KioskStore(modelContainer: try KioskSchema.container(inMemory: true))
        let row = OutboxMachine.newRow(input(), clientScanId: "x1", seq: 1, nowMs: 0)
        try await store.upsert([row])
        #expect(try await store.all() == [row])
        try await store.delete(["x1"])
        #expect(try await store.all().isEmpty)
    }
}
