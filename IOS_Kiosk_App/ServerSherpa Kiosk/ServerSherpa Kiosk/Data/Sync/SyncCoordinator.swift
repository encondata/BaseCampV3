import Foundation
import Observation

enum SyncPhase: Sendable { case idle, running, done, error }

struct SyncStatus: Equatable, Sendable {
    var phase: SyncPhase = .idle
    var assets: Int? = nil
    var people: Int? = nil
    var containers: Int? = nil
    var trucks: Int? = nil
    var syncedAt: String? = nil
    var error: String? = nil
}

/// The `sync` meta row. Local storage only, so the JSON keys are camelCase.
struct SyncMeta: Codable, Equatable, Sendable {
    var initiativeId: String
    var initiativeName: String
    var assets: Int
    var people: Int
    var containers: Int
    var trucks: Int
    var syncedAt: String
}

/// kiosk/src/lib/sync.ts: fetch all four endpoints in parallel, then
/// replace all four tables and the meta row in ONE save. A failed fetch
/// leaves the cached rows untouched. Sync never touches setup state.
@MainActor @Observable final class Sync {
    private(set) var status = SyncStatus()
    /// Bumped after every successful replace or clear; screens rebuild their index when it changes.
    private(set) var rosterVersion = 0

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let clock: () -> Int64
    @ObservationIgnored private var currentRun = 0
    @ObservationIgnored private var hydrated = false

    init(api: KioskApi, store: KioskStore, clock: @escaping () -> Int64 = nowMs) {
        self.api = api
        self.store = store
        self.clock = clock
    }

    /// Reads the persisted meta row once so a relaunch shows `done` with counts.
    func hydrate() async {
        if hydrated { return }
        hydrated = true
        guard let meta = (try? await store.meta()) ?? nil else { return }
        if status.phase != .idle { return }
        status = SyncStatus(phase: .done, assets: meta.assets, people: meta.people, containers: meta.containers,
                            trucks: meta.trucks, syncedAt: meta.syncedAt)
    }

    func run(initiativeId: String, initiativeName: String) {
        Task { await runNow(initiativeId: initiativeId, initiativeName: initiativeName) }
    }

    func runNow(initiativeId: String, initiativeName: String) async {
        currentRun += 1
        let myRun = currentRun
        let previous = status
        status.phase = .running
        status.error = nil

        let assets: KioskAssetsSync, people: KioskPeopleSync, containers: KioskContainersSync, trucks: KioskTrucksSync
        do {
            async let a = api.syncAssets(initiativeId: initiativeId)
            async let p = api.syncPeople()
            async let c = api.syncContainers(initiativeId: initiativeId)
            async let t = api.syncTrucks(initiativeId: initiativeId)
            (assets, people, containers, trucks) = try await (a, p, c, t)
        } catch is CancellationError {
            return
        } catch {
            if myRun != currentRun { return }
            var failed = previous
            failed.phase = .error
            failed.error = (error as? ApiError)?.code ?? "unknown_error"
            status = failed
            return
        }
        if myRun != currentRun { return }

        let syncedAt = Self.instantString(clock())
        let meta = SyncMeta(initiativeId: initiativeId, initiativeName: initiativeName, assets: assets.assets.count,
                            people: people.people.count, containers: containers.containers.count,
                            trucks: trucks.trucks.count, syncedAt: syncedAt)
        do {
            try await store.replaceRoster(assets: assets.assets, people: people.people, containers: containers.containers,
                                          trucks: trucks.trucks, meta: meta)
            rosterVersion += 1
            if myRun != currentRun { return }
            hydrated = true
            let counts = try await store.counts()
            if myRun != currentRun { return }
            status = SyncStatus(phase: .done, assets: counts.assets, people: counts.people, containers: counts.containers,
                                trucks: counts.trucks, syncedAt: syncedAt)
        } catch {
            if myRun != currentRun { return }
            var failed = previous
            failed.phase = .error
            failed.error = "storage"
            status = failed
        }
    }

    /// "Clear local data": the move tables and the meta row — never the outbox.
    func clearLocalData() async throws {
        try await store.clearLocalData()
        hydrated = false
        status = SyncStatus()
        rosterVersion += 1
    }

    /// "2:14 PM" — the time alone; the kiosk syncs per shift.
    static func formatSyncedAt(_ iso: String) -> String { formatSyncedAt(iso, timeZone: .current) }

    static func formatSyncedAt(_ iso: String, timeZone: TimeZone) -> String {
        guard let date = parseInstant(iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }

    /// Java `Instant.toString()`: `2023-11-14T22:13:20Z`, with `.SSS` only when the milliseconds are non-zero.
    private static func instantString(_ ms: Int64) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = ms % 1000 == 0 ? [.withInternetDateTime] : [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    private static func parseInstant(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }
}
