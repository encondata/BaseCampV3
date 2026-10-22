import Foundation
import Observation
import os

/// Sends ZPL to the saved printer, the way its connection reaches it (a `ZebraTransport`'s
/// `send` on the device).
typealias LabelSender = @Sendable (_ printer: SavedPrinter, _ zpl: String) async throws -> Void

/// What Print Labels reads from the kiosk's store: the roster to match scans against, and one
/// asset's stored label per scan. `KioskStore` is the real one.
protocol PrintLabelsStore: Sendable {
    func assets() async throws -> [KioskAssetRow]
    func storedLabel(assetId: String) async throws -> StoredLabel?
}

extension KioskStore: PrintLabelsStore {}

/// The label build's status as Print Labels reads it (`LabelBuildMonitor` on the device).
@MainActor protocol LabelBuildStatusSource: AnyObject, Sendable {
    var status: LabelBuildStatus { get }
}

extension LabelBuildMonitor: LabelBuildStatusSource {}

/// The sync as Print Labels uses it: whether one runs (no label prints then), and "Sync now".
@MainActor protocol PrintLabelsSync: AnyObject, Sendable {
    var isSyncing: Bool { get }
    func run(initiativeId: String, initiativeName: String)
}

extension Sync: PrintLabelsSync {
    var isSyncing: Bool { status.phase == .running }
}

/// What one print job prints: the matched asset, and the move (site and initiative) it was
/// scanned for, taken at scan time. A job records its Labeled scan under that move, and only
/// while it is still the kiosk's move in the same signed-in session (`printJobIsLive`): a
/// Kiosk Setup change or a sign-out drops the jobs still waiting, and a label already going out
/// then finishes on the printer without recording.
struct PrintTarget: Equatable, Sendable {
    var asset: KioskAssetRow
    var siteId: String
    var initiativeId: String
}

/// Whether a job may still record its Labeled scan: someone is signed in and the kiosk's saved
/// move and site are still the ones the job was scanned for. Read on the main actor in the same
/// turn as the record, so it lines up exactly with a sign-out (`logout()` and `endSession()` go
/// anonymous synchronously) or a Kiosk Setup write.
func printJobIsLive(auth: KioskAuth, prefs: KioskPrefs) -> @MainActor @Sendable (PrintTarget) -> Bool {
    { target in
        guard case .authed = auth.state, let sel = prefs.setupSelection else { return false }
        return sel.initiativeId == target.initiativeId && sel.siteId == target.siteId
    }
}

/// The outbox couldn't save a printed label's Labeled scan.
private struct LabeledScanNotSaved: Error {}

/// The kiosk's one Print Labels queue, for the app's lifetime (the container owns it). Every
/// Print Labels screen sends through it, so labels go out one at a time in scan order whichever
/// screen scanned them: a screen closed with jobs still waiting and a new one opened can't
/// interleave its labels with the old ones (with a peeler, that would label the wrong asset).
/// `entries` is the queue's list for every screen, so a re-opened screen shows earlier jobs and
/// can retry them. The decisions live in `PrintQueue`.
///
/// The list belongs to one session on one move: `reset()` runs on every sign-out (and a session
/// that ends underneath the kiosk) and on every change of the saved move or site, so the next
/// person never sees, retries or reprints the last one's jobs, and jobs still waiting never
/// print or record for them (see `PrintQueue.reset()`).
@MainActor @Observable
final class LabelPrintJobs {
    /// The scan status a printed label records.
    nonisolated static let LABELED = "labeled"

    nonisolated static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "labels")

    /// Newest first.
    private(set) var entries: [PrintEntry<PrintTarget>] = []

    @ObservationIgnored private let queue: PrintQueue<PrintTarget>
    /// Bumped by `reset()`: a job started before one answers `CancellationError`, so its screen
    /// gives no good-scan feedback for a label that belongs to the session before.
    @ObservationIgnored private(set) var generation = 0

    init(deps: PrintQueueDeps<PrintTarget>, now: @escaping @Sendable () -> String = { isoMillis(nowMs()) }) {
        queue = PrintQueue(deps: deps, now: now)
        // `changes` has one consumer: this holder, for the queue's whole life.
        let changes = queue.changes
        Task { [weak self] in
            for await list in changes { self?.entries = list }
        }
    }

    /// The real job: the stored label (refused while a build or a sync runs) → the saved offsets
    /// and print mode applied by the generator → `sender`, straight to the printer with no checks
    /// before or after → one Labeled scan through the outbox under the job's move, only while
    /// `isLive` says the job still belongs to the kiosk's session and move (otherwise nothing
    /// records, with no warning: the scan belongs to the session before).
    convenience init(store: PrintLabelsStore, sync: PrintLabelsSync, outbox: Outbox, settings: LabelSettingsSource,
                     build: LabelBuildStatusSource, engine: LabelEngine, sender: @escaping LabelSender,
                     isLive: @escaping @MainActor @Sendable (PrintTarget) -> Bool) {
        let log: @Sendable (String, Error) -> Void = { message, error in
            // An error can quote the label or the printer's address: private in the log.
            LabelPrintJobs.log.warning("print labels: \(message, privacy: .public): \(String(describing: error), privacy: .private)")
        }
        self.init(deps: PrintQueueDeps(
            settings: { await MainActor.run { settings.current() } },
            label: { target in
                let stored = try await store.storedLabel(assetId: target.asset.id)
                let (status, syncing) = await MainActor.run { (build.status, sync.isSyncing) }
                return labelFor(stored, status, syncing: syncing)
            },
            prepare: { zpl, settings in
                try await prepareForPrinter(zpl: zpl, settings: settings, call: { try await engine.call($0, $1) },
                                            isTimeout: LabelEngineError.isTimeout, isUnsupported: LabelEngineError.isUnsupported, log: log)
            },
            send: { printer, zpl in
                do {
                    try await sender(printer, zpl)
                } catch let e as PrinterTimeout {
                    throw LabelSendTimeout(cause: e)
                } catch let e as PrinterUnreachable where e.localNetworkDenied {
                    throw LabelSendLocalNetworkDenied(cause: e)
                }
            },
            record: { target, scannedValue in
                try await LabelPrintJobs.recordIfLive(target, scannedValue, outbox: outbox, isLive: isLive)
            },
            log: log
        ))
    }

    /// The check and the enqueue start in one main-actor turn, so no sign-out or Setup write
    /// can land between them.
    private static func recordIfLive(_ target: PrintTarget, _ scannedValue: String, outbox: Outbox,
                                     isLive: @MainActor (PrintTarget) -> Bool) async throws {
        guard isLive(target) else { return }
        let row = await outbox.enqueue(EnqueueInput(
            scannedValue: scannedValue, scanType: "barcode", asset: target.asset.outboxAsset,
            siteId: target.siteId, initiativeId: target.initiativeId, scanStatus: LABELED))
        if row == nil { throw LabeledScanNotSaved() }
    }

    /// Starts over for a new session or move: waiting jobs are dropped unsent, the list empties,
    /// and a label already going out finishes on the printer without recording its scan.
    func reset() async {
        generation += 1
        entries = []
        await queue.reset()
    }

    /// See `PrintQueue.scan`; `target` is nil when the scan matched nothing.
    func scan(_ target: PrintTarget?, scannedValue: String) async throws -> PrintEntry<PrintTarget> {
        try await sameGeneration { try await self.queue.scan(target, scannedValue: scannedValue) }
    }

    func reprint(_ entryId: String) async throws -> PrintEntry<PrintTarget>? {
        try await sameGeneration { try await self.queue.reprint(entryId) }
    }

    func retry(_ entryId: String) async throws -> PrintEntry<PrintTarget>? {
        try await sameGeneration { try await self.queue.retry(entryId) }
    }

    private func sameGeneration<T>(_ job: () async throws -> T) async throws -> T {
        let started = generation
        let result = try await job()
        if generation != started { throw CancellationError() }
        return result
    }
}
