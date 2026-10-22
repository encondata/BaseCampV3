import Foundation
import Observation
import SwiftUI

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

/// Opening Print Labels with no printer saved goes straight on to Printer Setup, once per visit:
/// coming back from Printer Setup without saving leaves Print Labels showing its own "Printer
/// Setup" button rather than bouncing again. A device that can't make labels says so instead.
func opensPrinterSetupFirst(printer: SavedPrinter?, phase: LabelBuildPhase, alreadyOpened: Bool) -> Bool {
    printer == nil && phase != .unsupportedDevice && !alreadyOpened
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

/// Why the saved Bluetooth printer can't be reached, for a reason the crew fixes on the iPad, and
/// the buttons that fix it: Open Settings (Bluetooth not allowed) and Connect (a printer that
/// forgot this iPad, once it is forgotten in Settings).
struct PrinterReachProblem: Equatable, Sendable {
    var text: String
    var offersSettings: Bool
    var offersConnect: Bool
}

/// What to show for a refusal (`bluetoothRefusal`): its words, Open Settings for Bluetooth not
/// allowed, and Connect for a printer that forgot this iPad. That one gets no Open Settings: iOS
/// opens only this app's page, not Settings › Bluetooth, so its steps say where to go (Ruling 15).
/// Nil when the refusal has no words.
func printerReachProblem(for refusal: PrinterError) -> PrinterReachProblem? {
    guard let text = refusal.errorDescription else { return nil }
    let forgotten = refusal is BluetoothPairingLost
    let denied = (refusal as? BluetoothUnavailable)?.availability == .unauthorized
    return PrinterReachProblem(text: text, offersSettings: denied, offersConnect: forgotten)
}

/// Print Labels (the laptop's Printing Station, kiosk/src/pages/PrintingStation.tsx; Android's
/// PrintLabelsViewModel): a scan matched by asset ID or serial prints the asset's stored label on
/// the saved printer (network or Bluetooth) and records one Labeled scan through the outbox.
///
/// The jobs run on the container's one `LabelPrintJobs` queue, never on one of this view model's
/// own: every Print Labels screen sends in one scan order, and the list (`entries`) is the
/// queue's, so a re-opened screen shows earlier jobs and can retry them. The screen's scan
/// collection only hands scans in (`follow`); each job runs in a task of its own that nothing
/// cancels, holding the queue and only a weak reference to this view model (for the flash and
/// sound). Leaving the screen (Printer Setup on top, or Back) cancels nothing: labels already
/// scanned still go out and get their Labeled scans, even after this view model is gone.
/// (Android's view model scope cancels the jobs still waiting when the screen is popped; a
/// cancelled waiter would stay "Waiting to print" for good, so iOS lets them finish.) A sign-out
/// or a change of move resets the jobs (`LabelPrintJobs.reset()`), and Retry and Reprint refuse an
/// entry scanned for another move than the kiosk's current one. Building
/// one is cheap: no queue and no task of its own.
///
/// A saved Bluetooth printer is connected in the background when the screen opens (D4), so the
/// first label needn't wait for the link (`connectPrinter`). Nothing waits for that connect and
/// labels go out exactly as before; it only says, on the screen, what the crew must fix on the iPad
/// first (Bluetooth off or not allowed, a printer that forgot this iPad: D10, D11).
@MainActor @Observable
final class PrintLabelsViewModel {
    enum LoadStatus: Equatable { case loading, ready, error }

    /// Retry or Reprint on an entry scanned for another move (iOS copy; Android has no such case).
    static let OTHER_MOVE_TEXT = "This label is from another move."

    private(set) var loadStatus = LoadStatus.loading
    private(set) var rosterSize = 0
    /// Why a scan couldn't be taken at all (no move data yet).
    private(set) var error: String?

    /// Newest first: every job on the kiosk's print queue.
    var entries: [PrintEntry<PrintTarget>] { jobs.entries }
    /// The label build, for the header.
    var build: LabelBuildStatus { buildSource.status }
    var settings: LabelSettings { settingsSource.current() }
    var syncing: Bool { sync.isSyncing }
    /// The background connect to the saved Bluetooth printer is running.
    var connecting: Bool { connectTask != nil }
    /// What stops the saved Bluetooth printer that the crew fixes on the iPad; nil once the link is
    /// up to it (whoever brought it up), or for any other printer.
    var printerProblem: PrinterReachProblem? {
        guard let reachProblem, case .bluetooth(let serial, _)? = settings.printer?.connection else { return nil }
        if let bluetooth, bluetooth.link.connected, bluetooth.link.info?.serial?.uppercased() == serial.uppercased() { return nil }
        return reachProblem
    }

    @ObservationIgnored private let jobs: LabelPrintJobs
    @ObservationIgnored private let store: PrintLabelsStore
    @ObservationIgnored private let sync: PrintLabelsSync
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let settingsSource: LabelSettingsSource
    @ObservationIgnored private let buildSource: LabelBuildStatusSource
    @ObservationIgnored private let bluetooth: BluetoothPrinting?
    private var reachProblem: PrinterReachProblem?
    private var connectTask: Task<Void, Never>?
    @ObservationIgnored private let flash: FlashController
    @ObservationIgnored private let sound: SoundPlayer?
    @ObservationIgnored private var index: ScanIndex<KioskAssetRow>?

    /// `bluetooth` is the container's link (nil: no Bluetooth printer is ever connected ahead).
    init(jobs: LabelPrintJobs, store: PrintLabelsStore, sync: PrintLabelsSync, prefs: KioskPrefs, settings: LabelSettingsSource,
         build: LabelBuildStatusSource, bluetooth: BluetoothPrinting?, flash: FlashController, sound: SoundPlayer?) {
        self.jobs = jobs
        self.store = store
        self.sync = sync
        self.prefs = prefs
        self.settingsSource = settings
        self.buildSource = build
        self.bluetooth = bluetooth
        self.flash = flash
        self.sound = sound
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

    /// Starts printing a scan; nil when it was not taken (blank, or no move data yet). The job
    /// takes the move from Kiosk Setup now. The returned task ends once the scan has printed or
    /// failed (tests await it).
    @discardableResult
    func onScan(_ raw: String) -> Task<Void, Never>? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }
        // A hardware scan can arrive before the roster or the setup is ready (the typed input is
        // disabled then). Say so instead of dropping it silently.
        guard let index, let sel = prefs.setupSelection, rosterSize > 0 else {
            feedback(good: false)
            error = ScanViewModel.NO_MOVE_DATA
            return nil
        }
        error = nil
        // Asset ID or serial only, as the laptop's Printing Station: a tag is not a label request.
        let target = matchAssetOrSerial(index, value).map {
            PrintTarget(asset: $0.asset, siteId: sel.siteId, initiativeId: sel.initiativeId)
        }
        return run { jobs in try await jobs.scan(target, scannedValue: value) }
    }

    /// Prints the entry's asset again (never records); nil when refused (see `fromAnotherMove`).
    @discardableResult
    func reprint(_ entryId: String) -> Task<Void, Never>? {
        if fromAnotherMove(entryId) { return nil }
        return run { jobs in try await jobs.reprint(entryId) }
    }

    /// Runs a failed entry again; nil when refused (see `fromAnotherMove`).
    @discardableResult
    func retry(_ entryId: String) -> Task<Void, Never>? {
        if fromAnotherMove(entryId) { return nil }
        return run { jobs in try await jobs.retry(entryId) }
    }

    /// Belt and braces beside the jobs' reset on a move change: an entry scanned for a move other
    /// than the kiosk's current one is never printed again here. Says so when it is.
    private func fromAnotherMove(_ entryId: String) -> Bool {
        guard let target = entries.first(where: { $0.id == entryId })?.asset,
              target.initiativeId != prefs.setupSelection?.initiativeId else {
            if error == Self.OTHER_MOVE_TEXT { error = nil }
            return false
        }
        feedback(good: false)
        error = Self.OTHER_MOVE_TEXT
        return true
    }

    /// The screen opened (and Connect): connects to the saved Bluetooth printer in the background.
    /// Nothing waits for it (a label scanned meanwhile goes out as always, taking its turn on the
    /// link); there is no poll and no retry. A refusal the crew fixes on the iPad shows as
    /// `printerProblem`; any other failure (the printer off or out of range) shows nothing here,
    /// since a label's own message says it. A network printer starts nothing. Returns the connect
    /// (one at a time), or nil when there is none (tests await it).
    @discardableResult
    func connectPrinter() -> Task<Void, Never>? {
        if let connectTask { return connectTask }
        guard let bluetooth, case .bluetooth(let serial, let peripheralId)? = settings.printer?.connection else { return nil }
        let task = Task { [weak self] in
            var problem: PrinterReachProblem?
            do {
                _ = try await bluetooth.connect(peripheralId: peripheralId, serial: serial)
            } catch {
                problem = bluetoothRefusal(error).flatMap(printerReachProblem(for:))
            }
            self?.reachProblem = problem
            self?.connectTask = nil
        }
        connectTask = task
        return task
    }

    /// Back in the app (from Settings or Control Center) with a reach problem showing: connects
    /// again. Nothing else starts here.
    func cameBackToTheApp() {
        if printerProblem != nil { connectPrinter() }
    }

    /// Runs the move's sync again (labels need a sync since the version 2 upgrade).
    func syncNow() {
        guard let sel = prefs.setupSelection else { return }
        sync.run(initiativeId: sel.initiativeId, initiativeName: sel.initiativeName)
    }

    /// A job in a task of its own: it holds the queue, not this view model, and nothing cancels
    /// it, so a job outlives the screen and the view model that started it.
    private func run(_ job: @escaping @MainActor (LabelPrintJobs) async throws -> PrintEntry<PrintTarget>?) -> Task<Void, Never> {
        let jobs = self.jobs
        return Task { [weak self] in
            guard let entry = try? await job(jobs) else { return }
            self?.feedback(good: entry.state == .printed)
        }
    }

    private func feedback(good: Bool) {
        let look = prefs.appearance
        flash.flash(Color(hsl: good ? look.goodScan : look.notFoundScan), ms: look.flashMs)
        sound?.play(good ? .good : .notFound)
    }
}
