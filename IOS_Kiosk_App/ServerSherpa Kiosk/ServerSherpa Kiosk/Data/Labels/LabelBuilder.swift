import Foundation
import Observation
import os

/// The label build as the UI sees it: the builder publishes here from its actor. Print Labels
/// reads `status`; Printer Setup reads `pick` (nil before the first build with a printer, and
/// after a stop).
@MainActor @Observable final class LabelBuildMonitor {
    fileprivate(set) var status = LabelBuildStatus()
    fileprivate(set) var pick: LabelPick?

    nonisolated init() {}
}

/// Builds and stores the move's labels on the device, as the laptop's label runner does
/// (kiosk_laptop/edge/src/edge/labels/runner.py), the port of Android's `LabelBuilder`: plan
/// every asset with the generator, render only those whose fingerprint differs from the stored
/// label, store each batch as it finishes, then drop the labels of assets no longer on the move.
/// A label stays printable until its new version is stored, and a failed build keeps everything
/// stored so far.
///
/// Every generator call gets an assets body holding only some of the move's assets: a job and
/// a label depend on their own asset, the move's `label_context` and the templates, never on
/// another asset. `buildPlan` goes in chunks of `planChunk` assets (a whole large move in one
/// call can be tens of MB of text), and their plans make one (`combinePlans`). Each
/// `renderLabels` call carries only its batch: the generator re-reads the bodies on every call,
/// so a full body per batch would make a large move quadratic.
///
/// One build at a time: a new request cancels the build in progress (and any request still
/// waiting) before it starts. A build never writes into a move that changed or was cleared
/// while it ran: each write checks the move first, in the same store turn. The planning and
/// rendering run on this actor; only publishing to `monitor` touches the main actor.
actor LabelBuilder {
    /// Assets per `renderLabels` call. Each call carries its batch's payloads and the templates,
    /// and returns the batch's ZPL: 200 assets is about 0.4 MB each way and about 60 ms of
    /// generator work on a laptop, so the progress bar moves and a print waits little behind a batch.
    static let batchSize = 200

    /// Assets per `buildPlan` call: a few MB of payload text at most (From-To columns included)
    /// where a whole move can be tens of MB.
    static let planChunk = 500

    nonisolated let monitor: LabelBuildMonitor

    private let store: KioskStore
    private let engine: LabelEngine
    private let settings: LabelSettingsSource
    private let batchSize: Int
    private let planChunk: Int
    private let warn: @Sendable (String) -> Void

    private var status = LabelBuildStatus()
    private var job: Task<Void, Never>?
    private var following: Task<Void, Never>?
    private var building = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "labels")

    /// `warn` gets the build's count-only warnings (a test reads them; the default logs them).
    init(store: KioskStore, engine: LabelEngine, settings: LabelSettingsSource, monitor: LabelBuildMonitor = LabelBuildMonitor(),
         batchSize: Int = LabelBuilder.batchSize, planChunk: Int = LabelBuilder.planChunk,
         warn: @escaping @Sendable (String) -> Void = { LabelBuilder.log.warning("\($0, privacy: .public)") }) {
        self.store = store
        self.engine = engine
        self.settings = settings
        self.monitor = monitor
        self.batchSize = batchSize
        self.planChunk = planChunk
        self.warn = warn
    }

    /// Builds in the background. `start` calls it after a sync and a kind or printer DPI change.
    func rebuild(reason: String) { replace(.build(reason)) }

    /// Stops any build and resets the status ("Clear local data" emptied the labels).
    func stop() { replace(.stop) }

    private enum Request {
        case build(String)
        case stop
    }

    /// Cancels the running or waiting request at once, then runs `request` after it has finished
    /// (unless a later request cancelled this one first).
    private func replace(_ request: Request) {
        let previous = job
        previous?.cancel()
        job = Task {
            await previous?.value
            if Task.isCancelled { return }
            switch request {
            case .build(let reason): await buildNow(reason)
            case .stop: await reset()
            }
        }
    }

    /// Follows the sync and the settings: each finished sync (and the relaunch's restored one)
    /// builds; a cleared sync (idle) stops; a change of label kind or printer DPI builds again.
    /// The settings' value at the start is not a change. Returns the following task (cancel it to
    /// stop following); a second call replaces the first.
    @discardableResult
    func start(syncStatus: AsyncStream<SyncStatus>) async -> Task<Void, Never> {
        // Subscribed first: no suspension between cancelling the old follower and replacing it.
        let updates = await settings.updates()
        following?.cancel()
        let task = Task {
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    var last: SyncPhase?
                    for await status in syncStatus {
                        if status.phase == last { continue }
                        last = status.phase
                        switch status.phase {
                        case .done: await self.rebuild(reason: "sync")
                        case .idle: await self.stop()
                        default: break
                        }
                    }
                }
                group.addTask {
                    var last: SettingsKey?
                    for await s in updates {
                        let key = SettingsKey(kind: s.kind, dpi: s.printer?.dpi)
                        guard let previous = last else {
                            last = key
                            continue
                        }
                        if key == previous { continue }
                        last = key
                        await self.rebuild(reason: "settings")
                    }
                }
            }
        }
        following = task
        return task
    }

    private struct SettingsKey: Equatable {
        var kind: LabelKind
        var dpi: Int?
    }

    func buildNow(_ reason: String) async {
        await lock()
        defer { unlock() }
        Self.log.info("label build (\(reason, privacy: .public))")
        await setStatus(LabelBuildStatus(phase: .running))
        do {
            try await build()
        } catch {
            if error is CancellationError || Task.isCancelled { return }
            if error is MoveChanged {
                // The labels belong to a move that is gone; the sync that changed it starts over.
                Self.log.info("label build stopped: the move changed or was cleared")
                await setStatus(LabelBuildStatus())
            } else if LabelEngineError.isUnsupported(error) {
                await setStatus(LabelBuildStatus(phase: .unsupportedDevice))
            } else {
                // The message can quote the generator's arguments (asset data): private in the log.
                Self.log.warning("label build failed: \(String(describing: error), privacy: .private)")
                var failed = status
                failed.phase = .error
                failed.error = Self.message(error)
                await setStatus(failed)
            }
        }
    }

    private func reset() async {
        await lock()
        defer { unlock() }
        await setPick(nil)
        await setStatus(LabelBuildStatus())
    }

    private func build() async throws {
        guard await engine.isSupported() else {
            // A cancelled caller also hears false: that says nothing about the device.
            try Task.checkCancellation()
            await setStatus(LabelBuildStatus(phase: .unsupportedDevice))
            return
        }
        let settings = await self.settings.current()
        let printer = settings.printer
        // One snapshot of the synced move, so a sync can't land between the reads; the payloads
        // only when they'll be used.
        let synced = try await store.labelBuildSnapshot(withRows: printer != nil)
        guard let meta = synced.meta, let labelContext = synced.labelContext else {
            // Never synced, or not since the version 2 upgrade: keep whatever is stored.
            await setPick(printer.map { LabelPick(kind: settings.kind, dpi: $0.dpi, synced: false) })
            await setStatus(LabelBuildStatus(phase: .done, needs: .sync))
            return
        }
        guard let printer else {
            await setStatus(LabelBuildStatus(phase: .done, needs: .printer))
            return
        }
        let kind = settings.kind
        let dpi = printer.dpi

        let payloads = synced.payloads
        let templates = synced.templates
        let templatesJson = LabelGenArgs.templatesBody(templates.map(\.json))
        let plan: LabelPlan
        do {
            // An empty move still plans once: the pick comes from the templates.
            let chunk = max(planChunk, 1)
            var chunks = stride(from: 0, to: payloads.count, by: chunk).map { Array(payloads[$0..<min($0 + chunk, payloads.count)]) }
            if chunks.isEmpty { chunks = [[]] }
            var plans: [LabelPlan] = []
            for part in chunks {
                try Task.checkCancellation()
                let body = LabelGenArgs.assetsBody(initiativeId: meta.initiativeId, payloads: part.map(\.json), labelContext: labelContext)
                let answer = try await engine.call("buildPlan", LabelGenArgs.plan(assetsJson: body, templatesJson: templatesJson, kind: kind, dpi: dpi))
                plans.append(try parsePlan(answer))
            }
            plan = try combinePlans(plans)
        } catch {
            if !(error is CancellationError || Task.isCancelled || LabelEngineError.isUnsupported(error)) {
                // Printer Setup's checks stop waiting for this kind and DPI's pick.
                await setPick(LabelPick(kind: kind, dpi: dpi, synced: true, failed: true))
            }
            throw error
        }
        await setPick(Self.pickOf(kind: kind, dpi: dpi, templateJson: plan.templateId.flatMap { id in templates.first { $0.id == id }?.json },
                                  plan: plan))
        var planned = LabelBuildStatus(phase: .running, notes: plan.notes, templateId: plan.templateId, fonts: plan.fonts,
                                       availableDpis: plan.availableDpis)
        if !plan.hasAssetData {
            // Jobs are empty for want of data, not because the move is empty: prune nothing.
            planned.phase = .done
            planned.needs = .sync
            await setStatus(planned)
            return
        }

        // One job per asset; a repeated id keeps its last fingerprint, as the store does.
        var order: [String] = []
        var jobs: [String: String] = [:]
        for job in plan.jobs {
            if jobs[job.assetId] == nil { order.append(job.assetId) }
            jobs[job.assetId] = job.fingerprint
        }
        let stored = Dictionary(try await store.generatedLabelStates().map { ($0.assetId, $0) }, uniquingKeysWith: { _, last in last })
        let changed = order.filter { stored[$0]?.fingerprint != jobs[$0] }
        // The current outcome of every asset whose label is up to date.
        var outcomes: [String: String] = [:]
        for id in order {
            if let s = stored[id], s.fingerprint == jobs[id] { outcomes[id] = s.outcome }
        }

        // Tallied in the plan's order, so the problem codes come in a stable first-seen order.
        func progress(_ done: Int) -> LabelBuildStatus {
            // Only the planned ids count, on purpose: a stored label of an asset off the move isn't ready.
            let tally = tallyOutcomes(order.compactMap { outcomes[$0] })
            var s = planned
            s.done = done
            s.total = changed.count
            s.ready = tally.ready
            s.problems = tally.problems
            return s
        }
        await setStatus(progress(0))

        let payloadById = Dictionary(payloads.map { ($0.id, $0.json) }, uniquingKeysWith: { _, last in last })
        let perCall = max(batchSize, 1)
        var done = 0
        var missing = 0
        var mismatched = 0
        for start in stride(from: 0, to: changed.count, by: perCall) {
            try Task.checkCancellation()
            let batch = Array(changed[start..<min(start + perCall, changed.count)])
            let body = LabelGenArgs.assetsBody(initiativeId: meta.initiativeId, payloads: batch.compactMap { payloadById[$0] },
                                               labelContext: labelContext)
            let answer = try await engine.call("renderLabels", LabelGenArgs.render(assetsJson: body, templatesJson: templatesJson,
                                                                                 kind: kind, dpi: dpi, assetIds: batch))
            let results = try parseRendered(answer)
            // A build cancelled while its batch rendered stores nothing after.
            try Task.checkCancellation()
            let returned = Set(results.map(\.assetId))
            missing += batch.filter { !returned.contains($0) }.count
            mismatched += results.filter { jobs[$0.assetId] != $0.fingerprint }.count
            let rows = results.map {
                GeneratedLabelRow(assetId: $0.assetId, zpl: $0.zpl, outcome: $0.outcome, fingerprint: $0.fingerprint, templateId: plan.templateId)
            }
            guard try await store.storeGeneratedLabels(rows, ifMove: meta.initiativeId) else { throw MoveChanged() }
            for r in results { outcomes[r.assetId] = r.outcome }
            done += batch.count
            await setStatus(progress(done))
        }
        if missing > 0 || mismatched > 0 {
            // Never expected: a missing label renders again next build; a fingerprint unlike the
            // plan's means the batch body changed what the generator saw (renders every build).
            warn("label build: \(missing) labels missing from their batch, \(mismatched) with a fingerprint unlike the plan's")
        }

        let gone = stored.keys.filter { jobs[$0] == nil }
        try Task.checkCancellation()
        guard try await store.deleteGeneratedLabels(gone, ifMove: meta.initiativeId) else { throw MoveChanged() }
        var finished = progress(done)
        finished.phase = .done
        await setStatus(finished)
    }

    private struct MoveChanged: Error {}

    // MARK: Publishing

    private func setStatus(_ value: LabelBuildStatus) async {
        status = value
        let monitor = self.monitor
        await MainActor.run { monitor.status = value }
    }

    private func setPick(_ value: LabelPick?) async {
        let monitor = self.monitor
        await MainActor.run { monitor.pick = value }
    }

    // MARK: One build at a time

    private func lock() async {
        if !building {
            building = true
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    /// Hands the lock straight to the next waiter, if any.
    private func unlock() {
        if waiting.isEmpty {
            building = false
        } else {
            waiting.removeFirst().resume()
        }
    }

    // MARK: Helpers

    /// The pick with the picked template's name and size read off its synced JSON.
    private static func pickOf(kind: LabelKind, dpi: Int, templateJson: String?, plan: LabelPlan) -> LabelPick {
        let t = templateJson.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        func number(_ key: String) -> Double? {
            guard let n = t?[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue > 0 else { return nil }
            return n.doubleValue
        }
        return LabelPick(kind: kind, dpi: dpi, synced: true, templateId: plan.templateId, templateName: t?["name"] as? String,
                         notes: plan.notes, fonts: plan.fonts, availableDpis: plan.availableDpis,
                         widthIn: number("width_in"), heightIn: number("height_in"))
    }

    /// The error's own text (Android's `message`). An `NSError` (SwiftData, Foundation) gives its
    /// localized description, not the verbose `Error Domain=...` text; a `LocalizedError` its
    /// description; anything else its own `description` (a type's name when it has none).
    static func message(_ error: Error) -> String {
        if type(of: error) is NSError.Type { return (error as NSError).localizedDescription }
        if let localized = (error as? LocalizedError)?.errorDescription { return localized }
        return String(describing: error)
    }
}
