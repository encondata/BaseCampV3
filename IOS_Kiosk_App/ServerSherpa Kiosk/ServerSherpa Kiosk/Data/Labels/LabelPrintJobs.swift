import Foundation
import Observation
import os

/// Sends ZPL to the network printer at a host (`NetworkZebra.send` on the device).
typealias LabelSender = @Sendable (_ host: String, _ zpl: String) async throws -> Void

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
/// scanned for. The move is taken at scan time, so a job records its Labeled scan under that
/// move even if Kiosk Setup changes before the label goes out.
struct PrintTarget: Equatable, Sendable {
    var asset: KioskAssetRow
    var siteId: String
    var initiativeId: String
}

/// The outbox couldn't save a printed label's Labeled scan.
private struct LabeledScanNotSaved: Error {}

/// The kiosk's one Print Labels queue, for the app's lifetime (the container owns it). Every
/// Print Labels screen sends through it, so labels go out one at a time in scan order whichever
/// screen scanned them: a screen closed with jobs still waiting and a new one opened can't
/// interleave its labels with the old ones (with a peeler, that would label the wrong asset).
/// `entries` is the queue's list for every screen, so a re-opened screen shows earlier jobs and
/// can retry them. The decisions live in `PrintQueue`.
@MainActor @Observable
final class LabelPrintJobs {
    /// The scan status a printed label records.
    nonisolated static let LABELED = "labeled"

    nonisolated static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "labels")

    /// Newest first.
    private(set) var entries: [PrintEntry<PrintTarget>] = []

    @ObservationIgnored private let queue: PrintQueue<PrintTarget>

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
    /// before or after → one Labeled scan through the outbox under the job's move.
    convenience init(store: PrintLabelsStore, sync: PrintLabelsSync, outbox: Outbox, settings: LabelSettingsSource,
                     build: LabelBuildStatusSource, engine: LabelEngine, sender: @escaping LabelSender) {
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
            send: { host, zpl in
                do {
                    try await sender(host, zpl)
                } catch let e as PrinterTimeout {
                    throw LabelSendTimeout(cause: e)
                }
            },
            record: { target, scannedValue in
                let row = await outbox.enqueue(EnqueueInput(
                    scannedValue: scannedValue, scanType: "barcode", asset: target.asset.outboxAsset,
                    siteId: target.siteId, initiativeId: target.initiativeId, scanStatus: LabelPrintJobs.LABELED))
                if row == nil { throw LabeledScanNotSaved() }
            },
            log: log
        ))
    }

    /// See `PrintQueue.scan`; `target` is nil when the scan matched nothing.
    func scan(_ target: PrintTarget?, scannedValue: String) async throws -> PrintEntry<PrintTarget> {
        try await queue.scan(target, scannedValue: scannedValue)
    }

    func reprint(_ entryId: String) async throws -> PrintEntry<PrintTarget>? { try await queue.reprint(entryId) }

    func retry(_ entryId: String) async throws -> PrintEntry<PrintTarget>? { try await queue.retry(entryId) }
}
