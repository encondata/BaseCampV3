import Foundation
import Observation
import os

enum SyncPhase: Sendable { case idle, running, done, error }

enum PartState: Sendable { case waiting, running, done, failed }

/// One download of a sync: assets|people|containers|trucks|templates|fonts. `count` once done.
struct SyncPart: Equatable, Sendable {
    var name: String
    var state: PartState
    var count: Int? = nil

    /// The parts in display order. The first four are the move (all or nothing); templates and
    /// fonts are soft: a failure sets `SyncStatus.labelsError` and keeps their previous rows when
    /// the move is unchanged (a move change clears them instead).
    static let names = ["assets", "people", "containers", "trucks", "templates", "fonts"]
    static let moveNames = Array(names.prefix(4))

    static var waiting: [SyncPart] { names.map { SyncPart(name: $0, state: .waiting) } }
}

struct SyncStatus: Equatable, Sendable {
    var phase: SyncPhase = .idle
    var assets: Int? = nil
    var people: Int? = nil
    var containers: Int? = nil
    var trucks: Int? = nil
    var syncedAt: String? = nil
    var error: String? = nil
    var parts: [SyncPart] = SyncPart.waiting
    /// The code of the first failed label download (templates, then fonts); the move sync still finishes.
    var labelsError: String? = nil
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
///
/// Labels ride along (Android `Sync`): the label templates are fetched beside the move and
/// stored in the same save when they arrived; the fonts follow once the move is stored, each
/// non-resident font downloaded to `fontsDir` (skipped when the file is already there at the
/// listed size). Neither can fail the move sync. A nil `fontsDir` keeps font metadata only.
@MainActor @Observable final class Sync {
    private(set) var status = SyncStatus() {
        didSet {
            if status != oldValue { for follower in statusFollowers.values { follower.yield(status) } }
        }
    }
    /// Bumped after every successful replace or clear; screens rebuild their index when it changes.
    private(set) var rosterVersion = 0

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let clock: () -> Int64
    @ObservationIgnored private let fontsDir: URL?
    @ObservationIgnored private var currentRun = 0
    @ObservationIgnored private var hydrated = false
    @ObservationIgnored private var statusFollowers: [UUID: AsyncStream<SyncStatus>.Continuation] = [:]

    /// `Application Support/label-fonts`: one `<font id>.ttf` per downloaded font.
    nonisolated static var defaultFontsDir: URL { URL.applicationSupportDirectory.appendingPathComponent("label-fonts", isDirectory: true) }

    init(api: KioskApi, store: KioskStore, clock: @escaping () -> Int64 = nowMs, fontsDir: URL? = nil) {
        self.api = api
        self.store = store
        self.clock = clock
        self.fontsDir = fontsDir
    }

    /// The current status, then every change in order, for a follower off the main actor (the
    /// label builder). Each caller gets its own stream; it ends when its consumer stops.
    func statusUpdates() -> AsyncStream<SyncStatus> {
        let (stream, continuation) = AsyncStream.makeStream(of: SyncStatus.self)
        let id = UUID()
        statusFollowers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.statusFollowers[id] = nil }
        }
        continuation.yield(status)
        return stream
    }

    /// Reads the persisted meta row once so a relaunch shows `done` with counts.
    func hydrate() async {
        if hydrated { return }
        hydrated = true
        guard let meta = (try? await store.meta()) ?? nil else { return }
        // No label_context row: the labels were never synced (e.g. right after the version 2
        // upgrade), so templates and fonts read waiting and the UI can prompt a sync.
        let labelsSynced = ((try? await store.labelContext()) ?? nil) != nil
        let labels = (try? await store.labelCounts()) ?? LabelCounts(templates: 0, fonts: 0)
        if status.phase != .idle { return }
        let counts = [meta.assets, meta.people, meta.containers, meta.trucks, labels.templates, labels.fonts]
        status = SyncStatus(phase: .done, assets: meta.assets, people: meta.people, containers: meta.containers,
                            trucks: meta.trucks, syncedAt: meta.syncedAt,
                            parts: zip(SyncPart.names, counts).map { name, n in
                                labelsSynced || SyncPart.moveNames.contains(name)
                                    ? SyncPart(name: name, state: .done, count: n) : SyncPart(name: name, state: .waiting)
                            })
    }

    func run(initiativeId: String, initiativeName: String) {
        Task { await runNow(initiativeId: initiativeId, initiativeName: initiativeName) }
    }

    func runNow(initiativeId: String, initiativeName: String) async {
        currentRun += 1
        let myRun = currentRun
        status.phase = .running
        status.error = nil
        status.labelsError = nil
        status.parts = SyncPart.waiting

        let assets: ParsedAssets, people: KioskPeopleSync, containers: KioskContainersSync, trucks: KioskTrucksSync
        let templates: [LabelTemplateRow]?, templatesError: String?
        do {
            // Each download and its decoding run off the main actor; only the part states hop back.
            let api = self.api
            async let a = part(myRun, "assets") { try await Self.fetchAssets(api, initiativeId) }
            async let p = part(myRun, "people") { try await Self.fetchPeople(api) }
            async let c = part(myRun, "containers") { try await Self.fetchContainers(api, initiativeId) }
            async let t = part(myRun, "trucks") { try await Self.fetchTrucks(api, initiativeId) }
            async let l = fetchTemplates(myRun, initiativeId: initiativeId)
            (assets, people, containers, trucks, (templates, templatesError)) = try await (a, p, c, t, l)
        } catch is CancellationError {
            return
        } catch {
            if myRun != currentRun { return }
            // Downloads cut short by the failure never finished: back to waiting.
            status.phase = .error
            status.error = Self.code(of: error)
            status.parts = status.parts.map { $0.state == .running ? SyncPart(name: $0.name, state: .waiting) : $0 }
            return
        }
        if myRun != currentRun { return }

        let syncedAt = Self.instantString(clock())
        let meta = SyncMeta(initiativeId: initiativeId, initiativeName: initiativeName, assets: assets.rows.count,
                            people: people.people.count, containers: containers.containers.count,
                            trucks: trucks.trucks.count, syncedAt: syncedAt)
        let moveChanged: Bool
        do {
            moveChanged = try await store.replaceRoster(assets: assets.rows, people: people.people, containers: containers.containers,
                                                        trucks: trucks.trucks, meta: meta, payloads: assets.payloads,
                                                        labelContext: assets.labelContext, templates: templates)
            rosterVersion += 1
        } catch {
            if myRun != currentRun { return }
            failRunning(error: "storage")
            return
        }
        if myRun != currentRun { return }
        hydrated = true
        // The move is stored; whatever happens from here must still end the sync in a terminal
        // phase. A sync left running makes Print Labels refuse until the app restarts.
        do {
            let counts = try await store.counts()
            setPart(myRun, "assets", .done, counts.assets)
            setPart(myRun, "people", .done, counts.people)
            setPart(myRun, "containers", .done, counts.containers)
            setPart(myRun, "trucks", .done, counts.trucks)
            if templates != nil { setPart(myRun, "templates", .done, try await store.labelCounts().templates) }

            let fontsError = await syncFonts(myRun, initiativeId: initiativeId, moveChanged: moveChanged)
            if myRun != currentRun { return }
            status.phase = .done
            status.assets = counts.assets
            status.people = counts.people
            status.containers = counts.containers
            status.trucks = counts.trucks
            status.syncedAt = syncedAt
            status.error = nil
            status.labelsError = templatesError ?? fontsError
        } catch {
            if myRun != currentRun { return }
            failRunning(error: "storage")
        }
    }

    /// The templates part: never throws. Returns the rows, or nil with the failure code.
    private func fetchTemplates(_ myRun: Int, initiativeId: String) async -> ([LabelTemplateRow]?, String?) {
        do {
            let api = self.api
            return (try await part(myRun, "templates") { try await Self.fetchTemplates(api, initiativeId) }, nil)
        } catch is CancellationError {
            return (nil, nil)
        } catch {
            return (nil, Self.code(of: error))
        }
    }

    /// The fonts part: list, download what is missing, then swap the rows and drop unused files.
    /// Returns the failure code, or nil. A failure leaves the previous rows and files in place
    /// for the same move; on a move change it clears them (they belonged to the other move).
    private func syncFonts(_ myRun: Int, initiativeId: String, moveChanged: Bool) async -> String? {
        setPart(myRun, "fonts", .running)
        do {
            let listed = try await Self.listFonts(api, initiativeId)
            var rows: [LabelFontRow] = []
            for f in listed.fonts {
                let resident = isResidentFont(f.name, residentFlag: f.resident)
                guard !resident, let fontsDir else {
                    rows.append(LabelFontRow(id: f.id, name: f.name, size: f.size, resident: resident, fileName: nil))
                    continue
                }
                // The id names the file: only plain UUID-like ids, never a path.
                guard LabelFontFiles.isSafeId(f.id) else { throw LabelFontFiles.BadFontId() }
                let fileName = "\(f.id).ttf"
                let file = fontsDir.appendingPathComponent(fileName)
                if await !LabelFontFiles.hasFile(file, size: f.size) {
                    let bytes: Data
                    do {
                        bytes = try await Self.downloadFont(api, id: f.id, initiativeId)
                    } catch let e as ApiError where e.status == 403 && e.code == "font_not_servable" {
                        // The server's own resident rule (flag or object name) refused it: built in.
                        rows.append(LabelFontRow(id: f.id, name: f.name, size: f.size, resident: true, fileName: nil))
                        continue
                    }
                    try await LabelFontFiles.write(bytes, to: file)
                }
                rows.append(LabelFontRow(id: f.id, name: f.name, size: f.size, resident: false, fileName: fileName))
            }
            if myRun != currentRun { return nil }
            try await store.replaceLabelFonts(rows)
            // Never throws: a cleanup failure must not undo the swap (stray files go next time).
            if let fontsDir { await LabelFontFiles.deleteUnused(in: fontsDir, keep: Set(rows.compactMap(\.fileName))) }
            setPart(myRun, "fonts", .done, rows.count)
            return nil
        } catch {
            if moveChanged && myRun == currentRun {
                // Best effort: a cleanup that throws too must not hide the original failure.
                try? await store.replaceLabelFonts([])
                if let fontsDir { await LabelFontFiles.deleteUnused(in: fontsDir, keep: []) }
            }
            setPart(myRun, "fonts", .failed)
            return Self.code(of: error)
        }
    }

    /// "Clear local data": the move tables, label data and the meta rows — never the outbox.
    func clearLocalData() async throws {
        try await store.clearLocalData()
        hydrated = false
        status = SyncStatus()
        rosterVersion += 1
        if let fontsDir { await LabelFontFiles.deleteUnused(in: fontsDir, keep: []) }
    }

    /// Runs one download with its part running; a failure marks it failed and rethrows.
    /// A canceled download (a sibling failed) is left running for the caller to reset.
    private func part<T: Sendable>(_ myRun: Int, _ name: String, _ block: @MainActor () async throws -> T) async throws -> T {
        setPart(myRun, name, .running)
        do {
            return try await block()
        } catch {
            if !(error is CancellationError) && !Task.isCancelled { setPart(myRun, name, .failed) }
            throw error
        }
    }

    private func setPart(_ myRun: Int, _ name: String, _ state: PartState, _ count: Int? = nil) {
        if myRun != currentRun { return }
        status.parts = status.parts.map { $0.name == name ? SyncPart(name: name, state: state, count: count) : $0 }
    }

    /// A storage failure: the sync ends in `error` and what was running reads failed.
    private func failRunning(error: String) {
        status.phase = .error
        status.error = error
        status.parts = status.parts.map { $0.state == .running ? SyncPart(name: $0.name, state: .failed) : $0 }
    }

    private nonisolated static func code(of error: Error) -> String { (error as? ApiError)?.code ?? "unknown_error" }

    struct ParsedAssets: Sendable {
        var rows: [KioskAssetRow]
        /// Each asset's JSON object text, by index.
        var payloads: [String]
        /// The raw `label_context` member, "null" when absent.
        var labelContext: String
    }

    // The downloads. `@concurrent`: the API members, their JSON decoding and the parsing below
    // run off the main actor (a nonisolated async member otherwise runs on its caller's actor).

    @concurrent nonisolated static func fetchAssets(_ api: KioskApi, _ initiativeId: String) async throws -> ParsedAssets {
        try parseAssets(try await api.assetsSyncRaw(initiativeId: initiativeId))
    }

    @concurrent nonisolated static func fetchPeople(_ api: KioskApi) async throws -> KioskPeopleSync {
        try await api.syncPeople()
    }

    @concurrent nonisolated static func fetchContainers(_ api: KioskApi, _ initiativeId: String) async throws -> KioskContainersSync {
        try await api.syncContainers(initiativeId: initiativeId)
    }

    @concurrent nonisolated static func fetchTrucks(_ api: KioskApi, _ initiativeId: String) async throws -> KioskTrucksSync {
        try await api.syncTrucks(initiativeId: initiativeId)
    }

    @concurrent nonisolated static func fetchTemplates(_ api: KioskApi, _ initiativeId: String) async throws -> [LabelTemplateRow] {
        try parseTemplates(try await api.labelTemplatesRaw(initiativeId: initiativeId))
    }

    @concurrent nonisolated static func listFonts(_ api: KioskApi, _ initiativeId: String) async throws -> KioskLabelFonts {
        try await api.labelFonts(initiativeId: initiativeId)
    }

    @concurrent nonisolated static func downloadFont(_ api: KioskApi, id: String, _ initiativeId: String) async throws -> Data {
        try await api.labelFontContent(id: id, initiativeId: initiativeId)
    }

    /// One /kiosk/sync/assets body: the typed rows as before, decoded from the same text, plus
    /// each asset's exact JSON object text and the raw `label_context`, from one `RawJson` scan
    /// (it never re-serializes, so `12.0` and `1e-05` stay as sent).
    nonisolated static func parseAssets(_ raw: String) throws -> ParsedAssets {
        do {
            let typed = try KioskJSON.decoder.decode(KioskAssetsSync.self, from: Data(raw.utf8))
            let scanned = try RawJson.arrayElementsAndMember(of: raw, arrayKey: "assets", memberKey: "label_context")
            guard scanned.elements.count == typed.assets.count else { throw RawJson.Malformed(offset: 0) }
            return ParsedAssets(rows: typed.assets, payloads: scanned.elements, labelContext: scanned.member ?? "null")
        } catch {
            throw ApiError(status: 200, code: "unknown_error")
        }
    }

    /// Each template's JSON object text with its string id, in the server's order; elements
    /// that are not objects or have no string id are skipped.
    nonisolated static func parseTemplates(_ raw: String) throws -> [LabelTemplateRow] {
        do {
            return try RawJson.arrayElements(of: raw, key: "templates").compactMap { element in
                guard element.hasPrefix("{"),
                      let id = try RawJson.member(of: element, key: "id"),
                      let decoded = try? JSONDecoder().decode(String.self, from: Data(id.utf8)) else { return nil }
                return LabelTemplateRow(id: decoded, json: element)
            }
        } catch {
            throw ApiError(status: 200, code: "unknown_error")
        }
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

/// The downloaded label font files, one `<id>.ttf` per font in the fonts folder. The file
/// operations are `@concurrent`: never on the main actor.
enum LabelFontFiles {
    struct BadFontId: Error {}

    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "sync")

    /// `[A-Za-z0-9-]{1,64}`: the id becomes a file name, so never a path.
    static func isSafeId(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        return (1...64).contains(bytes.count) && bytes.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == UInt8(ascii: "-")
        }
    }

    /// A regular file already there at the listed size.
    @concurrent static func hasFile(_ url: URL, size: Int) async -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              let length = attrs[.size] as? NSNumber else { return false }
        return length.intValue == size
    }

    /// Written whole or not at all (a temporary file renamed into place).
    @concurrent static func write(_ data: Data, to url: URL) async throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    /// Deletes every file in `dir` not named in `keep`. Never throws (Android's
    /// `listFiles()?.forEach`): a folder that is missing or cannot be listed, or a file that
    /// will not go, is logged and skipped.
    @concurrent static func deleteUnused(in dir: URL, keep: Set<String>) async {
        guard FileManager.default.fileExists(atPath: dir.path) else { return }
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        } catch {
            log.error("label fonts folder could not be listed: \(error.localizedDescription, privacy: .public)")
            return
        }
        for name in names where !keep.contains(name) {
            do {
                try FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            } catch {
                log.error("label font file could not be deleted: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
