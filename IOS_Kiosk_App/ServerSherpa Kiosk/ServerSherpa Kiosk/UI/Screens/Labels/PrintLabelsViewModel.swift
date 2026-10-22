import Foundation
import Observation
import SwiftUI
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

/// How the header describes the assets left without a label, by reason.
private let PROBLEM_PHRASES: [String: String] = [
    NO_TEMPLATE_AT_DPI: "with no template at this DPI",
    TEMPLATE_FAILED: "whose template couldn't be built",
    TEMPLATE_UNSUPPORTED: "whose template needs an app update",
]

/// "12 labels ready · 2 with no template at this DPI, 1 whose template couldn't be built": the
/// problems in the order their codes were first seen.
func readySummary(_ build: LabelBuildStatus) -> String {
    let ready = "\(build.ready) \(build.ready == 1 ? "label" : "labels") ready"
    let problems = build.problems.filter { $0.count > 0 }
    if problems.isEmpty { return ready }
    return "\(ready) · " + problems.map { "\($0.count) \(PROBLEM_PHRASES[$0.code] ?? "with no label")" }.joined(separator: ", ")
}

let BUILD_FAILED_TEXT = "Labels couldn't be made. Try syncing again."

/// What an entry's chip says.
func printStatusText<A>(_ e: PrintEntry<A>) -> String {
    let text = switch e.state {
    case .queued: "Waiting to print"
    case .sending: "Printing"
    case .printed: "Printed"
    case .failed: "Failed"
    }
    return e.reprint ? "\(text) (reprint)" : text
}

func printStatusTone(_ s: PrintState) -> ChipTone {
    switch s {
    case .printed: .green
    case .queued, .sending: .amber
    case .failed: .red
    }
}

/// "ZD421 at 10.0.0.5 · 203 dpi" ("Zebra" when the printer didn't name its model).
func printerSummary(_ p: SavedPrinter) -> String {
    let model = p.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Zebra" : p.model
    return "\(model) at \(p.host) · \(p.dpi) dpi"
}

/// "A12 · RU 22", or a dash when the move has neither (the laptop's placement()). `side` is
/// `source` or `destination`.
func labelPlacement(_ label: [String: String], _ side: String) -> String {
    func value(_ key: String) -> String? {
        guard let v = label[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        return v
    }
    let parts = [value("\(side)_raw"), value("\(side)_ru").map { "RU \($0)" }].compactMap { $0 }
    return parts.isEmpty ? "—" : parts.joined(separator: " · ")
}

/// The text, or nil when it is missing or only whitespace.
func nonBlankText(_ s: String?) -> String? {
    guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return s
}

/// A list row's second line: "Rack 1 · SN1", a dash when the asset has neither, or "No match".
func printEntryLine(_ asset: KioskAssetRow?) -> String {
    guard let asset else { return "No match" }
    let parts = [nonBlankText(asset.name), nonBlankText(asset.serialNumber)].compactMap { $0 }
    return parts.isEmpty ? "—" : parts.joined(separator: " · ")
}

/// The current card's title: the asset's name, else its asset ID.
func printEntryTitle(_ asset: KioskAssetRow) -> String { nonBlankText(asset.name) ?? asset.assetId }

/// The outbox couldn't save a printed label's Labeled scan.
private struct LabeledScanNotSaved: Error {}

/// Print Labels (the laptop's Printing Station, kiosk/src/pages/PrintingStation.tsx; Android's
/// PrintLabelsViewModel): a scan matched by asset ID or serial prints the asset's stored label on
/// the saved network printer and records one Labeled scan through the outbox. The decisions live
/// in `PrintQueue`.
///
/// The view model owns every print it starts: the screen's scan collection only hands scans in
/// (`follow`), and each print runs in its own task that holds the queue, never the screen's.
/// When the screen goes off screen (Printer Setup on top, or Back) nothing is cancelled: labels
/// already scanned still go out and get their Labeled scans, even after the view model is gone.
/// (Android's view model scope cancels the jobs still waiting when the screen is popped; a
/// cancelled waiter here would stay "Waiting to print" for good, so iOS lets them finish.)
@MainActor @Observable
final class PrintLabelsViewModel {
    enum LoadStatus: Equatable { case loading, ready, error }

    /// The scan status a printed label records.
    static let LABELED = "labeled"

    private(set) var loadStatus = LoadStatus.loading
    private(set) var rosterSize = 0
    /// Why a scan couldn't be taken at all (no move data yet).
    private(set) var error: String?
    /// Newest first.
    private(set) var entries: [PrintEntry<KioskAssetRow>] = []

    /// The label build, for the header.
    var build: LabelBuildStatus { buildSource.status }
    var settings: LabelSettings { settingsSource.current() }
    var syncing: Bool { sync.isSyncing }

    @ObservationIgnored private let store: PrintLabelsStore
    @ObservationIgnored private let sync: PrintLabelsSync
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let settingsSource: LabelSettingsSource
    @ObservationIgnored private let buildSource: LabelBuildStatusSource
    @ObservationIgnored private let flash: FlashController
    @ObservationIgnored private let sound: SoundPlayer?
    @ObservationIgnored private let queue: PrintQueue<KioskAssetRow>
    @ObservationIgnored private var index: ScanIndex<KioskAssetRow>?

    nonisolated static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "labels")

    init(store: PrintLabelsStore, sync: PrintLabelsSync, outbox: Outbox, prefs: KioskPrefs, settings: LabelSettingsSource,
         build: LabelBuildStatusSource, engine: LabelEngine, sender: @escaping LabelSender,
         flash: FlashController, sound: SoundPlayer?) {
        self.store = store
        self.sync = sync
        self.prefs = prefs
        self.settingsSource = settings
        self.buildSource = build
        self.flash = flash
        self.sound = sound
        let log: @Sendable (String, Error) -> Void = { message, error in
            // An error can quote the label or the printer's address: private in the log.
            PrintLabelsViewModel.log.warning("print labels: \(message, privacy: .public): \(String(describing: error), privacy: .private)")
        }
        queue = PrintQueue(deps: PrintQueueDeps(
            settings: { await MainActor.run { settings.current() } },
            label: { asset in
                let stored = try await store.storedLabel(assetId: asset.id)
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
            record: { asset, scannedValue in
                guard let sel = await MainActor.run(body: { prefs.setupSelection }) else { throw LabeledScanNotSaved() }
                let row = await outbox.enqueue(EnqueueInput(
                    scannedValue: scannedValue, scanType: "barcode", asset: asset.outboxAsset,
                    siteId: sel.siteId, initiativeId: sel.initiativeId, scanStatus: PrintLabelsViewModel.LABELED))
                if row == nil { throw LabeledScanNotSaved() }
            },
            log: log
        ), now: { isoMillis(nowMs()) })
        let changes = queue.changes
        Task { [weak self] in
            for await list in changes { self?.entries = list }
        }
    }

    /// Rebuilds the match index from the local roster; the screen calls it again whenever
    /// `sync.rosterVersion` changes (a sync finished, or local data was cleared).
    func loadRoster() async {
        do {
            let assets = try await store.assets()
            try Task.checkCancellation()
            index = buildScanIndex(assets)
            rosterSize = assets.count
            loadStatus = .ready
        } catch is CancellationError {
            // A newer roster version superseded this load; it reports its own result.
        } catch {
            loadStatus = .error
        }
    }

    /// The screen's scan collection: hands each scan in and moves on. Ending it (the screen went
    /// off screen) cancels nothing already scanned.
    func follow(_ events: AsyncStream<ScanEvent>) async {
        for await event in events { onScan(event.value) }
    }

    /// Starts printing a scan; nil when it was not taken (blank, or no move data yet). The
    /// returned task ends once the scan has printed or failed (tests await it).
    @discardableResult
    func onScan(_ raw: String) -> Task<Void, Never>? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }
        // A hardware scan can arrive before the roster or the setup is ready (the typed input is
        // disabled then). Say so instead of dropping it silently.
        guard let index, prefs.setupSelection != nil, rosterSize > 0 else {
            feedback(good: false)
            error = ScanViewModel.NO_MOVE_DATA
            return nil
        }
        error = nil
        // Asset ID or serial only, as the laptop's Printing Station: a tag is not a label request.
        let asset = matchAssetOrSerial(index, value)?.asset
        return run { queue in try await queue.scan(asset, scannedValue: value) }
    }

    /// Prints the entry's asset again (never records).
    @discardableResult
    func reprint(_ entryId: String) -> Task<Void, Never> { run { queue in try await queue.reprint(entryId) } }

    /// Runs a failed entry again.
    @discardableResult
    func retry(_ entryId: String) -> Task<Void, Never> { run { queue in try await queue.retry(entryId) } }

    /// Runs the move's sync again (labels need a sync since the version 2 upgrade).
    func syncNow() {
        guard let sel = prefs.setupSelection else { return }
        sync.run(initiativeId: sel.initiativeId, initiativeName: sel.initiativeName)
    }

    /// A queue job in a task of its own: it holds the queue, not the view model, and nothing
    /// cancels it, so a job outlives the screen and the view model that started it.
    private func run(_ job: @escaping @Sendable (PrintQueue<KioskAssetRow>) async throws -> PrintEntry<KioskAssetRow>?) -> Task<Void, Never> {
        let queue = self.queue
        return Task { [weak self] in
            guard let entry = try? await job(queue) else { return }
            self?.feedback(good: entry.state == .printed)
        }
    }

    private func feedback(good: Bool) {
        let look = prefs.appearance
        flash.flash(Color(hsl: good ? look.goodScan : look.notFoundScan), ms: look.flashMs)
        sound?.play(good ? .good : .notFound)
    }
}
