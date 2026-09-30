import Foundation
import Observation
import UIKit

/// Where the outbox persists its rows (Android `OutboxStore`).
protocol OutboxStore: Sendable {
    func all() async throws -> [OutboxRow]
    func upsert(_ rows: [OutboxRow]) async throws
    func delete(_ ids: [String]) async throws
}

extension KioskStore: OutboxStore {
    func all() throws -> [OutboxRow] { try outboxAll() }
    func upsert(_ rows: [OutboxRow]) throws { if !rows.isEmpty { try outboxUpsert(rows) } }
    func delete(_ ids: [String]) throws { if !ids.isEmpty { try outboxDelete(ids) } }
}

actor MemoryOutboxStore: OutboxStore {
    private var rows: [String: OutboxRow] = [:]
    func all() -> [OutboxRow] { Array(rows.values) }
    func upsert(_ rows: [OutboxRow]) { for r in rows { self.rows[r.clientScanId] = r } }
    func delete(_ ids: [String]) { for id in ids { rows.removeValue(forKey: id) } }
}

/// Keeps the app alive in the background until an in-flight batch's outcome is saved.
@MainActor protocol BackgroundTasking {
    func begin() -> Int
    func end(_ id: Int)
}

@MainActor struct UIKitBackgroundTasking: BackgroundTasking {
    private final class Handle: @unchecked Sendable { var id: UIBackgroundTaskIdentifier = .invalid }

    /// Nonisolated so it can be the `Outbox` initializer's default argument.
    nonisolated init() {}

    func begin() -> Int {
        let handle = Handle()
        handle.id = UIApplication.shared.beginBackgroundTask(withName: "outbox-flush") {
            // Out of background time: end it now, or the system kills the app.
            UIApplication.shared.endBackgroundTask(handle.id)
        }
        return handle.id.rawValue
    }

    func end(_ id: Int) {
        let task = UIBackgroundTaskIdentifier(rawValue: id)
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }
}

struct NoBackgroundTasking: BackgroundTasking {
    func begin() -> Int { 0 }
    func end(_ id: Int) {}
}

struct OutboxSnapshot: Equatable {
    var rows: [OutboxRow]
    var counts: OutboxCounts
    static let empty = OutboxSnapshot(rows: [], counts: OutboxCounts(queued: 0, accepted: 0, failed: 0, nomatch: 0, total: 0))
}

/// kiosk/src/lib/outbox.ts — durable queue + sender (Android `data/outbox/Outbox.kt`).
/// The decisions live in OutboxMachine; this class owns persistence, the
/// in-memory mirror, the batching window, the retry wake-ups and the no-match sweep.
///
/// Android serializes with a Mutex; here everything runs on the main actor, but
/// every store call and the POST suspend, so state is re-read after each await
/// and `isFlushing` keeps the flush single-flight.
@MainActor @Observable final class Outbox {
    static let STORAGE_ERROR = "Couldn't save this scan on the kiosk. Check its storage."

    private(set) var snapshot = OutboxSnapshot.empty
    /// Set when an operator action (enqueue, retry, clear, discard) couldn't be saved; cleared by the next that could.
    private(set) var storageError: String?

    @ObservationIgnored private let store: OutboxStore
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let serial: @MainActor () -> String
    @ObservationIgnored private let clock: () -> Int64
    @ObservationIgnored private let idGen: () -> String
    @ObservationIgnored private let sleep: (Int64) async throws -> Void
    @ObservationIgnored private let backgroundTask: BackgroundTasking

    @ObservationIgnored private var all: [String: OutboxRow] = [:]
    @ObservationIgnored private var nextSeq: Int64 = 1
    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var loading: Task<Void, Never>?

    /// Started and not stopped (the container runs it while active and signed in).
    @ObservationIgnored private(set) var isRunning = false
    @ObservationIgnored private var isFlushing = false
    /// A flush was asked for while one was running: run another pass after it.
    @ObservationIgnored private var flushAgain = false
    /// The rows of the batch being marked/POSTed/written back right now.
    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var sweepTask: Task<Void, Never>?
    @ObservationIgnored private var pendingFlush: Task<Void, Never>?
    @ObservationIgnored private var pendingDue: Int64?

    init(store: OutboxStore, api: KioskApi, serial: @escaping @MainActor () -> String,
         clock: @escaping () -> Int64 = nowMs,
         idGen: @escaping () -> String = { UUID().uuidString.lowercased() },
         sleep: @escaping (Int64) async throws -> Void = { try await Task.sleep(for: .milliseconds($0)) },
         backgroundTask: BackgroundTasking = UIKitBackgroundTasking()) {
        self.store = store
        self.api = api
        self.serial = serial
        self.clock = clock
        self.idGen = idGen
        self.sleep = sleep
        self.backgroundTask = backgroundTask
    }

    private func rebuild() {
        let rows = all.values.sorted { $0.seq > $1.seq }
        snapshot = OutboxSnapshot(rows: Array(rows.prefix(OutboxMachine.LIST_CAP)), counts: OutboxMachine.counts(rows))
    }

    private func mirror(_ rows: [OutboxRow]) {
        for r in rows { all[r.clientScanId] = r }
        rebuild()
    }

    /// Persists and mirrors `rows`; nothing is mirrored if the store throws.
    private func save(_ rows: [OutboxRow]) async throws {
        try await store.upsert(rows)
        mirror(rows)
    }

    func load() async {
        if loaded { return }
        if let loading { await loading.value; return }
        let task = Task { @MainActor in
            // A failed read leaves `loaded` false so the next start() reads the store again.
            guard let rows = try? await store.all() else { return }
            all = Dictionary(rows.map { ($0.clientScanId, $0) }, uniquingKeysWith: { _, b in b })
            nextSeq = (rows.map(\.seq).max() ?? 0) + 1
            rebuild()
            loaded = true
        }
        loading = task
        await task.value
        loading = nil
    }

    /// Rows left `sending` by a sender that died mid-POST go back to queued. Runs on
    /// EVERY start(); a batch whose POST is still in flight is not stranded, so it's skipped.
    private func recoverStranded() async {
        let stranded = OutboxMachine.recoverStranded(Array(all.values)).filter { !inFlight.contains($0.clientScanId) }
        if stranded.isEmpty { return }
        do { try await save(stranded) } catch {
            // Storage failed: still mirror them so this pass resends them anyway.
            mirror(stranded)
        }
    }

    func start() {
        if isRunning { return }
        isRunning = true
        startTask = Task { [weak self] in
            guard let self else { return }
            await self.load()
            guard self.isRunning, !Task.isCancelled else { return }
            await self.recoverStranded()
            await self.sweep()
            await self.flushOnce()
        }
        let sleep = self.sleep
        sweepTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await sleep(OutboxMachine.NOMATCH_SWEEP_MS) } catch { return }
                guard let self, !Task.isCancelled else { return }
                await self.sweep()
            }
        }
    }

    /// Waits for the current start pass (load, recover, sweep, first flush) to finish.
    func startPass() async { await startTask?.value }

    /// Stops the scheduled work. A batch already POSTed is still written back
    /// (under a background task), so its rows never strand as `sending`.
    func stop() {
        isRunning = false
        startTask?.cancel(); startTask = nil
        sweepTask?.cancel(); sweepTask = nil
        pendingFlush?.cancel(); pendingFlush = nil; pendingDue = nil
    }

    /// Schedules a flush `delayMs` from now, never later than one already pending.
    private func scheduleFlush(after delayMs: Int64) {
        guard isRunning else { return }
        let due = clock() + delayMs
        if pendingFlush != nil, let pendingDue, pendingDue <= due { return }
        pendingFlush?.cancel()
        pendingDue = due
        let sleep = self.sleep
        pendingFlush = Task { [weak self] in
            do { try await sleep(delayMs) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.pendingFlush = nil
            self.pendingDue = nil
            await self.flushOnce()
        }
    }

    @discardableResult
    func enqueue(_ input: EnqueueInput) async -> OutboxRow? {
        await load()
        let row = OutboxMachine.newRow(input, clientScanId: idGen(), seq: nextSeq, nowMs: clock())
        nextSeq += 1
        do { try await save([row]) } catch {
            storageError = Self.STORAGE_ERROR
            return nil
        }
        storageError = nil
        if row.matched { scheduleFlush(after: OutboxMachine.BATCH_DELAY_MS) }
        return row
    }

    /// One single-flight pass: send the due rows (up to MAX_BATCH) and save the
    /// outcome, then flush again if more is due, or wake at the earliest retry.
    /// A pass whose saves failed waits out the first back-off step before the
    /// next one (its rows are still due: an immediate retry would spin).
    func flushOnce() async {
        if isFlushing { flushAgain = true; return }
        isFlushing = true
        let saved = await sendDueBatch()
        isFlushing = false
        guard isRunning else { return }
        if !saved {
            flushAgain = false
            scheduleFlush(after: OutboxMachine.BACKOFF[0])
        } else if flushAgain || !OutboxMachine.dueRows(Array(all.values), nowMs: clock()).isEmpty {
            flushAgain = false
            scheduleFlush(after: 0)
        } else if let wait = OutboxMachine.nextWake(Array(all.values), nowMs: clock()) {
            scheduleFlush(after: wait)
        }
    }

    /// Sends one batch; false when marking it or writing its outcome back could not be saved.
    private func sendDueBatch() async -> Bool {
        let due = OutboxMachine.dueRows(Array(all.values), nowMs: clock())
        if due.isEmpty { return true }
        let batch = OutboxMachine.markSending(due)
        inFlight = Set(batch.map(\.clientScanId))
        do { try await save(batch) } catch {
            // Storage failed while marking the batch `sending`: nothing goes out this
            // pass, and the rows (never mirrored as sending) stay due for the next one.
            inFlight = []
            return false
        }
        let body = KioskScanBatchIn(serial: serial(), scans: batch.map {
            KioskScanIn(clientScanId: $0.clientScanId, scannedValue: $0.scannedValue, scanType: $0.scanType, scannedAt: $0.scannedAt,
                        assetId: $0.asset?.id, siteId: $0.siteId, initiativeId: $0.initiativeId, scanStatus: $0.scanStatus)
        })
        // The POST and its write-back run in their own task, which stop() never cancels:
        // once a batch goes out, its outcome is saved even if the app is backgrounded.
        let api = self.api
        let bgId = backgroundTask.begin()
        let sent = Task { @MainActor in
            let updated: [OutboxRow]
            do {
                let result = try await api.postScans(body)
                updated = OutboxMachine.applyResponse(batch, accepted: Set(result.accepted),
                                                      rejected: Dictionary(result.rejected.map { ($0.clientScanId, $0.code) }, uniquingKeysWith: { a, _ in a }))
            } catch {
                let code = (error as? ApiError).flatMap { $0.code.isEmpty ? nil : $0.code } ?? "timeout"
                updated = OutboxMachine.applyFailure(batch, code: code, nowMs: clock())
            }
            let saved = await writeBack(updated)
            backgroundTask.end(bgId)
            return saved
        }
        return await sent.value
    }

    /// False when the outcome could not be saved (the rows went back to queued).
    private func writeBack(_ updated: [OutboxRow]) async -> Bool {
        defer { inFlight = [] }
        do { try await save(updated); return true } catch {
            // Storage failed: never leave rows `sending`, or they'd be stranded.
            for row in updated where all[row.clientScanId]?.status == .sending {
                all[row.clientScanId]?.status = .queued
            }
            rebuild()
            return false
        }
    }

    private func sweep() async {
        let stale = OutboxMachine.staleNoMatch(Array(all.values), nowMs: clock())
        if stale.isEmpty { return }
        // A failed delete keeps the rows; the next tick retries.
        guard (try? await store.delete(stale.map(\.clientScanId))) != nil else { return }
        for r in stale { all.removeValue(forKey: r.clientScanId) }
        rebuild()
    }

    func retryFailed() async {
        let rows = OutboxMachine.retryFailed(Array(all.values))
        if !rows.isEmpty {
            do { try await save(rows) } catch { storageError = Self.STORAGE_ERROR; return }
        }
        storageError = nil
        scheduleFlush(after: 0)
    }

    private func dropRows(_ pred: (OutboxRow) -> Bool) async {
        let drop = all.values.filter(pred)
        if !drop.isEmpty {
            do { try await store.delete(drop.map(\.clientScanId)) } catch { storageError = Self.STORAGE_ERROR; return }
            for r in drop { all.removeValue(forKey: r.clientScanId) }
            rebuild()
        }
        storageError = nil
    }

    /// Drops accepted + nomatch; failed rows stay (the portal never got them).
    func clearSent() async { await dropRows { $0.status == .accepted || $0.status == .nomatch } }

    /// The operator confirmed these scans are being abandoned.
    func discardFailed() async { await dropRows { $0.status == .failed } }
}
