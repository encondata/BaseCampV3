import Foundation
import Observation

/// Where Asset Lookup's answers come from: `AssetLookupRepository` in the app (the API, with the
/// synced move as the offline fallback). Debug builds' screenshot sample answers from memory.
protocol AssetLookupSource: Sendable {
    func find(serial: String, value: String) async throws -> LookupFound
    func open(serial: String, id: String, offline: Bool, admin: Bool) async throws -> LookupOpened
    func scans(serial: String, id: String) async throws -> [AssetScanRow]
}

extension AssetLookupRepository: AssetLookupSource {}

/// An admin's scan history under the card (Android `ScanHistory`). `needsConnection`: the card
/// came from the synced move, so the history can't be asked for ("Scan history needs a
/// connection."). `hidden` covers everyone it isn't for, and a device on no move.
enum LookupScans: Equatable, Sendable {
    case hidden, needsConnection, loading, failed
    case rows([LookupScanLine])
}

/// What the screen shows (Android `LookupUi`). `searching`: a lookup or a pick is out.
struct LookupUi: Equatable {
    var value = ""
    var searching = false
    var offline = false
    var list: KioskLookupResult?
    var detail: KioskAssetDetail?
    /// The miss line: "No asset matches X." or, offline with nothing synced, the no-move-data line.
    var miss: String?
    var error: String?
    var scans: LookupScans = .hidden
}

/// Asset Lookup's state (Android `AssetLookupViewModel.kt`, a port of kiosk/src/pages/AssetLookup.tsx):
/// one box, one match opens the card, several show a list, none keeps the value and says so.
/// Read-only: nothing here records, queues or writes anything (no Outbox).
///
/// Every lookup, pick and Clear bumps `requestId` and cancels the older work; an answer started
/// under an older id is dropped, so a slow first answer never replaces a newer one. The screen
/// feeds `onScan` from the scan bus (the box's Enter, a keyboard scanner, the camera).
@MainActor @Observable
final class AssetLookupViewModel {
    private(set) var ui = LookupUi()
    /// Bumped each time a missed or failed value goes back in the box: the box selects it, so the
    /// next scanner burst replaces it rather than appending (the web's `restore`).
    private(set) var restoreCount = 0

    @ObservationIgnored private let source: any AssetLookupSource
    @ObservationIgnored private let serial: @MainActor () -> String
    @ObservationIgnored private let isAdmin: @MainActor () -> Bool
    @ObservationIgnored private let canViewScans: @MainActor () -> Bool
    @ObservationIgnored private let zone: TimeZone
    @ObservationIgnored private var requestId = 0
    /// The lookup, pick or history read for the current request (older ones are canceled).
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var history: Task<Void, Never>?
    /// Every task still running, current or canceled, for `settle()`.
    @ObservationIgnored private var running: [Int: Task<Void, Never>] = [:]
    @ObservationIgnored private var nextTaskKey = 0

    /// `isAdmin` (rank 60+) decides the offline card's admin part; `canViewScans` (`scans:view`)
    /// whether the history is asked for. Both are read when a card opens.
    init(source: any AssetLookupSource, serial: @escaping @MainActor () -> String, isAdmin: @escaping @MainActor () -> Bool,
         canViewScans: @escaping @MainActor () -> Bool, zone: TimeZone = .current) {
        self.source = source
        self.serial = serial
        self.isAdmin = isAdmin
        self.canViewScans = canViewScans
        self.zone = zone
    }

    private func current(_ mine: Int) -> Bool { mine == requestId }

    /// A new request: older answers will be dropped, and their work is canceled.
    private func begin() -> Int {
        requestId += 1
        work?.cancel()
        history?.cancel()
        work = nil
        history = nil
        return requestId
    }

    private func launch(_ body: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        nextTaskKey += 1
        let key = nextTaskKey
        let task = Task { @MainActor [weak self] in
            await body()
            self?.running[key] = nil
        }
        running[key] = task
        return task
    }

    func onValueChange(_ value: String) { ui.value = value }

    /// Search: the box's value, trimmed. An empty box is a no-op.
    func lookup() {
        let q = ui.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return }
        find(q)
    }

    /// A scan (the box's Enter, a keyboard scanner, the camera): into the box, then looked up.
    func onScan(_ value: String) {
        ui.value = value
        lookup()
    }

    private func find(_ q: String) {
        let mine = begin()
        // The box empties now, not on the answer: a scan while this one is out starts fresh.
        ui = LookupUi(searching: true)
        work = launch { [weak self] in
            guard let self else { return }
            do {
                let found = try await self.source.find(serial: self.serial(), value: q)
                guard self.current(mine) else { return }
                switch lookupOutcome(found, shown: q) {
                case .open(let id):
                    self.ui.offline = found.offline
                    try await self.openAsset(id, offline: found.offline, mine: mine)
                case .list(let result):
                    self.ui = LookupUi(offline: found.offline, list: result)
                case .miss(let text):
                    self.ui = LookupUi(value: q, offline: found.offline, miss: text)
                    self.restoreCount += 1
                }
            } catch is CancellationError {
            } catch {
                guard self.current(mine) else { return }
                // A failed open after an offline find keeps the offline notice.
                self.ui = LookupUi(value: q, offline: self.ui.offline, error: LookupCopy.lookupError)
                self.restoreCount += 1
            }
        }
    }

    /// One row of the list: opened with the offline flag that list came with. The list stays.
    func pick(_ id: String) {
        let mine = begin()
        let wasOffline = ui.offline
        ui.detail = nil
        ui.error = nil
        ui.scans = .hidden
        ui.searching = true
        work = launch { [weak self] in
            guard let self else { return }
            do {
                try await self.openAsset(id, offline: wasOffline, mine: mine)
            } catch is CancellationError {
            } catch {
                guard self.current(mine) else { return }
                self.ui.searching = false
                self.ui.error = LookupCopy.lookupError
            }
        }
    }

    func clear() {
        _ = begin()
        ui = LookupUi()
    }

    private func openAsset(_ id: String, offline: Bool, mine: Int) async throws {
        let answer = try await source.open(serial: serial(), id: id, offline: offline, admin: isAdmin())
        guard current(mine) else { return }
        ui.searching = false
        ui.offline = answer.offline
        guard let detail = answer.detail else {
            ui.error = LookupCopy.loadError
            return
        }
        let canScans = canViewScans()
        ui.detail = detail
        // History: online only, only for an admin's card of a device on a move, and only with
        // scans:view. Offline the same card says it needs a connection.
        if wantsScanHistory(detail, offline: answer.offline, canViewScans: canScans) {
            ui.scans = .loading
            loadScans(detail.id, mine: mine)
        } else {
            ui.scans = answer.offline && detail.full != nil && canScans ? .needsConnection : .hidden
        }
    }

    /// Tied to the card it was started for: dropped once anything newer began. The rows are
    /// formatted here, once, not on every render.
    private func loadScans(_ id: String, mine: Int) {
        let zone = zone
        history = launch { [weak self] in
            guard let self else { return }
            let next: LookupScans
            do {
                next = .rows(try await self.source.scans(serial: self.serial(), id: id).map { LookupScanLine($0, zone: zone) })
            } catch is CancellationError {
                return
            } catch {
                next = .failed
            }
            if self.current(mine) { self.ui.scans = next }
        }
    }

    /// Waits for every task still running, canceled ones too (tests).
    func settle() async {
        // Each task removes itself as it ends (it can't start before it is stored: both run here).
        while let task = running.values.first { await task.value }
    }
}
