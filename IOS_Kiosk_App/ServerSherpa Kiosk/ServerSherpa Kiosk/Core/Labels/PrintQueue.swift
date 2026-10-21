import Foundation

let NO_PRINTER_TEXT = "No printer set up. Open Printer Setup."
let NO_MATCH_TEXT = "No asset matches that scan."
let DEVICE_UNSUPPORTED_TEXT = "This device can't make labels (its system WebView is too old)."
let SYNC_NEEDED_TEXT = "Sync this kiosk to make labels."
/// The template is a newer design than this app's generator prints (the laptop's NEEDS_UPDATE_TEXT).
let NEEDS_UPDATE_TEXT = "This device needs an app update to print this template."
let LABEL_READ_FAILED_TEXT = "Couldn't read this asset's label on the kiosk."
let PREPARE_FAILED_TEXT = "Couldn't get this label ready for the printer. Try again."
let RECORD_FAILED_TEXT = "Printed, but the scan wasn't recorded: this kiosk couldn't save it."

/// While a sync runs, stored labels may be for the data it replaces.
let SYNCING_TEXT = "This kiosk is syncing. Labels will be ready shortly."
/// The build's plan step, before it has counted the labels to make.
let PREPARING_TEXT = "Labels are being prepared."

func stillBeingMadeText(done: Int, total: Int) -> String {
    total == 0 ? PREPARING_TEXT : "Labels are still being made (\(done) of \(total))."
}

func printerUnreachableText(_ host: String) -> String { "Can't reach the printer at \(host)." }

/// The printer took the connection but not the whole job in time: the label may be out.
let PRINTER_TIMEOUT_TEXT = "The printer didn't finish answering. It may have printed the label — check before you retry."

/// `PrintQueueDeps.send` throws this when the printer took the connection but not the whole job in time.
struct LabelSendTimeout: Error, CustomStringConvertible {
    var cause: Error? = nil
    var description: String { "the printer didn't take the whole label in time" }
}

/// What a scan says for each outcome a label can store (kiosk/src/lib/printQueue.ts LABEL_REASONS).
private let LABEL_REASONS: [String: String] = [
    NO_TEMPLATE_AT_DPI: "No label for this asset: this move has no active label template at this printer's DPI. "
        + "Someone with label access needs to activate one on Labels › Templates.",
    TEMPLATE_FAILED: "No label for this asset: the label template couldn't be built",
    TEMPLATE_UNSUPPORTED: NEEDS_UPDATE_TEXT,
]

func noLabelText(_ outcome: String?) -> String {
    outcome.flatMap { LABEL_REASONS[$0] } ?? "No label for this asset: none was generated for it"
}

/// An asset's stored label (`generated_labels`).
struct StoredLabel: Equatable, Sendable {
    var zpl: String?
    var outcome: String
    var templateId: String?
}

/// One step of a print job: the ZPL so far, or why the job stops here.
enum PrintStep: Equatable, Sendable {
    case ready(String)
    case refused(String)
}

/// What a scan prints, from the asset's stored label and the label build. While a build runs no
/// label prints, as on the laptop (its edge answers `labels_regenerating`): any stored label may
/// be the one being replaced. Nor while the kiosk is `syncing`: the build that follows the sync
/// hasn't started yet, so a stored label may be for the data the sync replaces.
func labelFor(_ stored: StoredLabel?, _ status: LabelBuildStatus, syncing: Bool = false) -> PrintStep {
    if status.phase == .unsupportedDevice { return .refused(DEVICE_UNSUPPORTED_TEXT) }
    if syncing { return .refused(SYNCING_TEXT) }
    if status.phase == .running { return .refused(stillBeingMadeText(done: status.done, total: status.total)) }
    guard let stored else {
        return .refused(status.needs == .sync ? SYNC_NEEDED_TEXT : noLabelText(nil))
    }
    if stored.outcome == OUTCOME_OK, let zpl = stored.zpl { return .ready(zpl) }
    return .refused(noLabelText(stored.outcome == OUTCOME_OK ? nil : stored.outcome))
}

/// The send-time helpers share the generator with the label build, so one can wait behind a
/// batch, or time out right after a cancelled build while the engine restarts: ask once more.
func askingAgainOnTimeout(isTimeout: (Error) -> Bool, _ call: () async throws -> String) async throws -> String {
    do {
        return try await call()
    } catch where isTimeout(error) {
        return try await call()
    }
}

/// The label with the saved offsets and peel or tear mode applied by the generator's
/// `applyPrintSettings` and `withPrintMode` (`call` is the engine's call, `fn` and arguments),
/// each asked again once if it times out: a device that can't run the generator says so, any
/// other failure asks the person to try again. Throws only `CancellationError`.
func prepareForPrinter(
    zpl: String, settings: LabelSettings,
    call: (String, String) async throws -> String,
    isTimeout: (Error) -> Bool,
    isUnsupported: (Error) -> Bool,
    log: (String, Error) -> Void = { _, _ in }
) async throws -> PrintStep {
    do {
        let offsetArgs = LabelGenArgs.printSettings(zpl: zpl, offsetX: settings.offsetX, offsetY: settings.offsetY)
        let offset = try parseZpl(try await askingAgainOnTimeout(isTimeout: isTimeout) { try await call("applyPrintSettings", offsetArgs) })
        let modeArgs = LabelGenArgs.printMode(zpl: offset, peel: settings.peel)
        return .ready(try parseZpl(try await askingAgainOnTimeout(isTimeout: isTimeout) { try await call("withPrintMode", modeArgs) }))
    } catch is CancellationError {
        throw CancellationError()
    } catch where isUnsupported(error) {
        return .refused(DEVICE_UNSUPPORTED_TEXT)
    } catch {
        log("couldn't apply the print settings", error)
        return .refused(PREPARE_FAILED_TEXT)
    }
}

enum PrintState: Equatable, Sendable { case queued, sending, printed, failed }

/// One scan (or a Reprint of one) on the Print Labels list. `asset` is nil when the scan matched
/// nothing. `recorded` is true once its Labeled scan is in the outbox; `recordWarning` says why
/// a printed label's scan couldn't be.
struct PrintEntry<A> {
    var id: String
    var asset: A?
    var scannedValue: String
    var scannedAt: String
    var reprint: Bool
    var state: PrintState
    var message: String? = nil
    var recordWarning: String? = nil
    var recorded: Bool = false
}

extension PrintEntry: Equatable where A: Equatable {}
extension PrintEntry: Sendable where A: Sendable {}

/// What the queue needs from the device: settings, labels, the send-time helpers, the printer,
/// the outbox, and the device log.
struct PrintQueueDeps<A: Sendable>: Sendable {
    var settings: @Sendable () async throws -> LabelSettings
    /// The asset's stored label, or why it has none (see `labelFor`).
    var label: @Sendable (A) async throws -> PrintStep
    /// The label with the saved offsets and peel or tear mode applied (see `prepareForPrinter`).
    var prepare: @Sendable (_ zpl: String, _ settings: LabelSettings) async throws -> PrintStep
    /// Sends the ZPL to the printer at the host; throws when it can't (`LabelSendTimeout` when the
    /// job may have gone out).
    var send: @Sendable (_ host: String, _ zpl: String) async throws -> Void
    /// Queues the Labeled scan; throws when it can't be saved.
    var record: @Sendable (_ asset: A, _ scannedValue: String) async throws -> Void
    /// Why a step failed, for the device log (the entry shows the person's message).
    var log: @Sendable (_ message: String, _ error: Error) -> Void = { _, _ in }
}

/// The Print Labels queue, as the laptop's Printing Station runs it (kiosk/src/lib/printQueue.ts):
/// jobs run one at a time in arrival order. One job: the asset's stored label → the saved offsets
/// and print mode applied → sent straight to the printer (no status checks before or after) → one
/// Labeled scan, once per scan, on its first label that goes out (its first attempt or a Retry).
/// A Reprint never records. Retry resends the very bytes the failed attempt built, or builds them
/// when it never got that far. A failed record doesn't undo the print: the entry stays printed
/// with a warning.
///
/// `scan`, `reprint` and `retry` throw only `CancellationError`, when the caller is cancelled
/// before its label starts going out. Once it does, the send, its record and the entry's outcome
/// finish even if the caller is cancelled.
actor PrintQueue<A: Sendable> {
    /// Entries the list keeps (newest); older ones drop off.
    static var LIST_LIMIT: Int { 200 }

    /// Per entry: the finished ZPL its last attempt built, whether its scan was tried (it never is
    /// twice), and whether that worked.
    private final class Work {
        var entry: PrintEntry<A>
        var sent: String?
        var recordTried = false
        var recorded = false
        init(_ entry: PrintEntry<A>) { self.entry = entry }
    }

    private let deps: PrintQueueDeps<A>
    private let now: @Sendable () -> String
    private let limit: Int
    private var work: [String: Work] = [:]
    /// Entry ids, oldest first.
    private var order: [String] = []
    private var nextId = 0
    /// One job at a time, in the order they asked.
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    /// The job whose label is going out; kept so nothing but its own end drops it.
    private var finishing: Task<PrintEntry<A>, Never>?
    private let changesContinuation: AsyncStream<[PrintEntry<A>]>.Continuation

    /// Newest first.
    private(set) var entries: [PrintEntry<A>] = []
    /// Every change to `entries` (one consumer; the latest list wins when it falls behind).
    nonisolated let changes: AsyncStream<[PrintEntry<A>]>

    init(deps: PrintQueueDeps<A>, now: @escaping @Sendable () -> String, limit: Int = PrintQueue.LIST_LIMIT) {
        self.deps = deps
        self.now = now
        self.limit = limit
        (changes, changesContinuation) = AsyncStream.makeStream(of: [PrintEntry<A>].self, bufferingPolicy: .bufferingNewest(1))
    }

    deinit { changesContinuation.finish() }

    /// A scan: its entry shows at once; the result once it has printed or failed.
    func scan(_ asset: A?, scannedValue: String) async throws -> PrintEntry<A> {
        guard let asset else { return add(nil, scannedValue, reprint: false, .failed, NO_MATCH_TEXT).entry }
        let w = add(asset, scannedValue, reprint: false, .queued, nil)
        return try await inTurn { try await self.execute(w) }
    }

    /// Prints the entry's asset again as a new entry that never records; nil when there's nothing to print.
    func reprint(_ entryId: String) async throws -> PrintEntry<A>? {
        guard let source = work[entryId]?.entry, let asset = source.asset else { return nil }
        let w = add(asset, source.scannedValue, reprint: true, .queued, nil)
        return try await inTurn { try await self.execute(w) }
    }

    /// Runs a failed entry again; nil unless it failed and has an asset.
    func retry(_ entryId: String) async throws -> PrintEntry<A>? {
        guard let w = work[entryId], w.entry.state == .failed, w.entry.asset != nil else { return nil }
        update(w, .queued, nil)
        return try await inTurn { try await self.execute(w) }
    }

    private func inTurn<T>(_ job: () async throws -> T) async throws -> T {
        if busy {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            busy = true
        }
        defer {
            if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
        }
        return try await job()
    }

    private func add(_ asset: A?, _ scannedValue: String, reprint: Bool, _ state: PrintState, _ message: String?) -> Work {
        nextId += 1
        let w = Work(PrintEntry(id: "p-\(nextId)", asset: asset, scannedValue: scannedValue, scannedAt: now(),
                                reprint: reprint, state: state, message: message))
        work[w.entry.id] = w
        order.append(w.entry.id)
        // Oldest out first.
        while order.count > limit { work.removeValue(forKey: order.removeFirst()) }
        publish()
        return w
    }

    private func publish() {
        entries = order.reversed().compactMap { work[$0]?.entry }
        changesContinuation.yield(entries)
    }

    @discardableResult
    private func update(_ w: Work, _ state: PrintState, _ message: String?, recordWarning: String?? = nil) -> PrintEntry<A> {
        w.entry.state = state
        w.entry.message = message
        if let recordWarning { w.entry.recordWarning = recordWarning }
        w.entry.recorded = w.recorded
        if work[w.entry.id] === w { publish() }
        return w.entry
    }

    private func fail(_ w: Work, _ message: String) -> PrintEntry<A> { update(w, .failed, message) }

    private func execute(_ w: Work) async throws -> PrintEntry<A> {
        guard let asset = w.entry.asset else { return fail(w, NO_MATCH_TEXT) }
        update(w, .sending, nil)
        let printer: SavedPrinter
        let bytes: String
        do {
            let settings = try await deps.settings()
            guard let saved = settings.printer else { return fail(w, NO_PRINTER_TEXT) }
            printer = saved
            if let sent = w.sent {
                bytes = sent
            } else {
                let zpl: String
                switch try await deps.label(asset) {
                case .ready(let z): zpl = z
                case .refused(let message): return fail(w, message)
                }
                switch try await deps.prepare(zpl, settings) {
                case .ready(let z): bytes = z
                case .refused(let message): return fail(w, message)
                }
            }
            try Task.checkCancellation()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            deps.log("couldn't read the label or the settings", error)
            return fail(w, LABEL_READ_FAILED_TEXT)
        }
        w.sent = bytes
        // Once the label starts going out, the send, its record and the entry's outcome finish even
        // if the caller is cancelled: a cancelled send would close the socket mid-label, and a label
        // that did print must get its scan. An unstructured task doesn't inherit the caller's
        // cancellation, and awaiting its value waits for it either way. The send's own deadline
        // bounds this.
        let task = Task { await self.finish(w, asset: asset, printer: printer, bytes: bytes) }
        finishing = task
        let entry = await task.value
        finishing = nil
        return entry
    }

    private func finish(_ w: Work, asset: A, printer: SavedPrinter, bytes: String) async -> PrintEntry<A> {
        do {
            try await deps.send(printer.host, bytes)
        } catch {
            deps.log("couldn't send the label to \(printer.host)", error)
            return fail(w, error is LabelSendTimeout ? PRINTER_TIMEOUT_TEXT : printerUnreachableText(printer.host))
        }
        // A scan records once, on its first label that goes out; a Reprint never does.
        var warning: String?
        if !w.entry.reprint && !w.recordTried {
            w.recordTried = true
            do {
                try await deps.record(asset, w.entry.scannedValue)
                w.recorded = true
            } catch {
                deps.log("couldn't record the Labeled scan", error)
                warning = RECORD_FAILED_TEXT
            }
        }
        return update(w, .printed, nil, recordWarning: warning ?? w.entry.recordWarning)
    }
}
