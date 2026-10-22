import Foundation
import SwiftData

/// The meta row holding the last sync (Android `MOVE_META_KEY`).
let syncMetaKey = "sync"

/// The meta row holding the move's `label_context` object from /kiosk/sync/assets,
/// raw JSON text (Android `LABEL_CONTEXT_META_KEY`).
let labelContextMetaKey = "label_context"

/// One read of the synced move for a label build. `payloads` and `templates` are empty unless
/// asked for, and when the move or its label context is missing.
struct LabelBuildSnapshot: Sendable {
    var meta: SyncMeta?
    var labelContext: String?
    var payloads: [(id: String, json: String)] = []
    var templates: [LabelTemplateRow] = []
}

/// The only thing that touches the SwiftData container. Everything crossing
/// the actor boundary is a Core value type, never a `@Model` object.
///
/// Not `@ModelActor`: SwiftData's default executor runs each job on the thread of whoever calls
/// the store, so calls from the main actor (the UI, `Sync`, the outbox) ran their store work on
/// the main thread, and a large label build or sync would freeze the UI. `KioskStoreExecutor`
/// runs every job on the store's own serial queue, and makes the context there.
actor KioskStore: ModelActor {
    nonisolated let modelContainer: ModelContainer
    nonisolated let modelExecutor: any ModelExecutor
    private nonisolated let executor: KioskStoreExecutor

    nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }

    init(modelContainer: ModelContainer) {
        let executor = KioskStoreExecutor(modelContainer: modelContainer)
        self.modelContainer = modelContainer
        self.executor = executor
        self.modelExecutor = executor
    }

    /// Deletes the four move tables and the meta row and inserts the new
    /// rows, then saves once: one save is one SQLite transaction, so a crash
    /// leaves either the old roster or the new one.
    ///
    /// Labels ride in the same save: each asset's raw JSON (`payloads`, by index) and
    /// its server position, the move's raw `labelContext`, and the templates in server
    /// order when they arrived. Nil `templates` keep the stored ones for the same move
    /// and clear them on a move change: another move's templates must never pick
    /// labels for this one. Returns whether the move changed (the stored meta named
    /// another initiative, or there was none).
    @discardableResult
    func replaceRoster(assets: [KioskAssetRow], people: [KioskPersonRow], containers: [KioskContainerRow],
                       trucks: [KioskTruckRow], meta: SyncMeta, payloads: [String] = [], labelContext: String? = nil,
                       templates: [LabelTemplateRow]? = nil) throws -> Bool {
        do {
            let moveChanged = try self.meta()?.initiativeId != meta.initiativeId
            try deleteMoveTables()
            for (i, row) in assets.enumerated() {
                modelContext.insert(AssetRecord(row, payloadJson: i < payloads.count ? payloads[i] : "{}", position: i))
            }
            for row in people { modelContext.insert(PersonRecord(row)) }
            for row in containers { modelContext.insert(ContainerRecord(row)) }
            for row in trucks { modelContext.insert(TruckRecord(row)) }
            if let labelContext {
                try deleteMetaRow(labelContextMetaKey)
                modelContext.insert(MetaRecord(key: labelContextMetaKey, value: labelContext))
            }
            if let templates {
                try modelContext.delete(model: LabelTemplateRecord.self)
                for (i, t) in templates.enumerated() { modelContext.insert(LabelTemplateRecord(id: t.id, position: i, json: t.json)) }
            } else if moveChanged {
                try modelContext.delete(model: LabelTemplateRecord.self)
            }
            modelContext.insert(MetaRecord(key: syncMetaKey, value: encodeJson(meta) ?? "{}"))
            try modelContext.save()
            return moveChanged
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    /// A Time Clock station's people sync (people only: its key reaches no other list). The
    /// people table is replaced in one save; the move tables, the meta row and the labels are
    /// left as they are.
    func replacePeople(_ people: [KioskPersonRow]) throws {
        do {
            try modelContext.delete(model: PersonRecord.self)
            for row in people { modelContext.insert(PersonRecord(row)) }
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    /// In the server's order.
    func assets() throws -> [KioskAssetRow] {
        try modelContext.fetch(FetchDescriptor<AssetRecord>(sortBy: [SortDescriptor(\.position)])).map(\.row)
    }

    /// Each asset's id and raw JSON object text, in the server's order.
    func assetPayloads() throws -> [(id: String, json: String)] {
        try modelContext.fetch(FetchDescriptor<AssetRecord>(sortBy: [SortDescriptor(\.position)])).map { ($0.id, $0.payloadJson) }
    }

    func people() throws -> [KioskPersonRow] { try modelContext.fetch(FetchDescriptor<PersonRecord>()).map(\.row) }

    func counts() throws -> (assets: Int, people: Int, containers: Int, trucks: Int) {
        (try modelContext.fetchCount(FetchDescriptor<AssetRecord>()),
         try modelContext.fetchCount(FetchDescriptor<PersonRecord>()),
         try modelContext.fetchCount(FetchDescriptor<ContainerRecord>()),
         try modelContext.fetchCount(FetchDescriptor<TruckRecord>()))
    }

    /// The last sync's meta row; nil when absent or unreadable.
    func meta() throws -> SyncMeta? {
        let key = syncMetaKey
        let row = try modelContext.fetch(FetchDescriptor<MetaRecord>(predicate: #Predicate { $0.key == key })).first
        return row.flatMap { decodeJson(SyncMeta.self, $0.value) }
    }

    /// The move's raw `label_context` text ("null" when the server sent none); nil before
    /// labels were ever synced.
    func labelContext() throws -> String? {
        let key = labelContextMetaKey
        return try modelContext.fetch(FetchDescriptor<MetaRecord>(predicate: #Predicate { $0.key == key })).first?.value
    }

    /// In the server's order.
    func labelTemplates() throws -> [LabelTemplateRow] {
        try modelContext.fetch(FetchDescriptor<LabelTemplateRecord>(sortBy: [SortDescriptor(\.position)]))
            .map { LabelTemplateRow(id: $0.id, json: $0.json) }
    }

    func labelFonts() throws -> [LabelFontRow] {
        try modelContext.fetch(FetchDescriptor<LabelFontRecord>(sortBy: [SortDescriptor(\.id)]))
            .map { LabelFontRow(id: $0.id, name: $0.name, size: $0.size, resident: $0.resident, fileName: $0.fileName) }
    }

    func labelCounts() throws -> LabelCounts {
        LabelCounts(templates: try modelContext.fetchCount(FetchDescriptor<LabelTemplateRecord>()),
                    fonts: try modelContext.fetchCount(FetchDescriptor<LabelFontRecord>()))
    }

    /// Replaces every font row in one save.
    func replaceLabelFonts(_ rows: [LabelFontRow]) throws {
        do {
            try modelContext.delete(model: LabelFontRecord.self)
            for r in rows {
                modelContext.insert(LabelFontRecord(id: r.id, name: r.name, size: r.size, resident: r.resident, fileName: r.fileName))
            }
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    /// "Clear local data": the move tables, label data and the meta rows — never the outbox.
    func clearLocalData() throws {
        do {
            try deleteMoveTables()
            try modelContext.delete(model: LabelTemplateRecord.self)
            try modelContext.delete(model: LabelFontRecord.self)
            try modelContext.delete(model: GeneratedLabelRecord.self)
            try deleteMetaRow(labelContextMetaKey)
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    /// The move, its label context and, with `withRows` while both exist, the payloads and the
    /// templates: one actor turn with no suspension, so a sync can't land between the reads (the
    /// payloads of one sync with the templates of the next).
    func labelBuildSnapshot(withRows: Bool) throws -> LabelBuildSnapshot {
        let meta = try self.meta()
        let context = try labelContext()
        guard withRows, meta != nil, context != nil else { return LabelBuildSnapshot(meta: meta, labelContext: context) }
        return LabelBuildSnapshot(meta: meta, labelContext: context, payloads: try assetPayloads(), templates: try labelTemplates())
    }

    /// Every stored label's fingerprint and outcome (not its ZPL).
    func generatedLabelStates() throws -> [GeneratedLabelState] {
        var descriptor = FetchDescriptor<GeneratedLabelRecord>()
        descriptor.propertiesToFetch = [\.assetId, \.fingerprint, \.outcome]
        return try modelContext.fetch(descriptor).map { GeneratedLabelState(assetId: $0.assetId, fingerprint: $0.fingerprint, outcome: $0.outcome) }
    }

    /// One asset's stored label (Print Labels reads it per scan); nil when the asset has no row.
    func storedLabel(assetId: String) throws -> StoredLabel? {
        var descriptor = FetchDescriptor<GeneratedLabelRecord>(predicate: #Predicate { $0.assetId == assetId })
        descriptor.fetchLimit = 1
        return try modelContext.fetch(descriptor).first.map { StoredLabel(zpl: $0.zpl, outcome: $0.outcome, templateId: $0.templateId) }
    }

    /// Insert-or-replace by asset id, in one save, only while the stored move is still
    /// `initiativeId`: the check and the write share this actor turn. False (nothing written)
    /// when the move changed or was cleared.
    func storeGeneratedLabels(_ rows: [GeneratedLabelRow], ifMove initiativeId: String) throws -> Bool {
        guard try meta()?.initiativeId == initiativeId else { return false }
        do {
            let ids = rows.map(\.assetId)
            var existing: [String: GeneratedLabelRecord] = [:]
            for chunk in Self.chunks(ids) {
                for r in try modelContext.fetch(FetchDescriptor<GeneratedLabelRecord>(predicate: #Predicate { chunk.contains($0.assetId) })) {
                    existing[r.assetId] = r
                }
            }
            for row in rows {
                if let r = existing[row.assetId] {
                    r.zpl = row.zpl
                    r.outcome = row.outcome
                    r.fingerprint = row.fingerprint
                    r.templateId = row.templateId
                } else {
                    let r = GeneratedLabelRecord(assetId: row.assetId, zpl: row.zpl, outcome: row.outcome, fingerprint: row.fingerprint,
                                                 templateId: row.templateId)
                    modelContext.insert(r)
                    existing[row.assetId] = r
                }
            }
            try modelContext.save()
            return true
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    /// Deletes the labels of `assetIds` in one save, only while the stored move is still
    /// `initiativeId` (checked even when there is nothing to delete). False (nothing deleted)
    /// when the move changed or was cleared.
    func deleteGeneratedLabels(_ assetIds: [String], ifMove initiativeId: String) throws -> Bool {
        guard try meta()?.initiativeId == initiativeId else { return false }
        do {
            for chunk in Self.chunks(assetIds) {
                try modelContext.delete(model: GeneratedLabelRecord.self, where: #Predicate { chunk.contains($0.assetId) })
            }
            try modelContext.save()
            return true
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    /// Ids in groups small enough for one SQLite statement's bound parameters.
    private static func chunks(_ ids: [String], size: Int = 500) -> [[String]] {
        stride(from: 0, to: ids.count, by: size).map { Array(ids[$0..<min($0 + size, ids.count)]) }
    }

    func updateAssetRfid(id: String, rfid: String) throws {
        let rows = try modelContext.fetch(FetchDescriptor<AssetRecord>(predicate: #Predicate { $0.id == id }))
        for row in rows { row.rfid = rfid }
        try modelContext.save()
    }

    func outboxAll() throws -> [OutboxRow] { try modelContext.fetch(FetchDescriptor<OutboxRecord>()).map(\.row) }

    /// Insert-or-replace by `clientScanId`.
    func outboxUpsert(_ rows: [OutboxRow]) throws {
        for row in rows { modelContext.insert(OutboxRecord(row)) }
        try modelContext.save()
    }

    func outboxDelete(_ ids: [String]) throws {
        try modelContext.delete(model: OutboxRecord.self, where: #Predicate { ids.contains($0.clientScanId) })
        try modelContext.save()
    }

    /// A peek at the tables: the first `limit` assets and people, and every meta row.
    func inspect(limit: Int) throws -> (assets: [KioskAssetRow], people: [KioskPersonRow], meta: [(String, String)]) {
        var assets = FetchDescriptor<AssetRecord>(sortBy: [SortDescriptor(\.position)])
        assets.fetchLimit = limit
        var people = FetchDescriptor<PersonRecord>()
        people.fetchLimit = limit
        let meta = try modelContext.fetch(FetchDescriptor<MetaRecord>(sortBy: [SortDescriptor(\.key)]))
        return (try modelContext.fetch(assets).map(\.row), try modelContext.fetch(people).map(\.row), meta.map { ($0.key, $0.value) })
    }

    private func deleteMoveTables() throws {
        try modelContext.delete(model: AssetRecord.self)
        try modelContext.delete(model: PersonRecord.self)
        try modelContext.delete(model: ContainerRecord.self)
        try modelContext.delete(model: TruckRecord.self)
        try deleteMetaRow(syncMetaKey)
    }

    private func deleteMetaRow(_ key: String) throws {
        try modelContext.delete(model: MetaRecord.self, where: #Predicate { $0.key == key })
    }
}

/// The store's executor: its jobs run one at a time on a serial queue of their own, never the
/// main thread. The context is made on that queue on first use and only ever touched there: a
/// context made on the main thread is a UI context (autosave from the main run loop) that could
/// race the store's first write. (`queue.sync` in `init` would not do: GCD runs a sync block on
/// the calling thread.)
final class KioskStoreExecutor: SerialModelExecutor, @unchecked Sendable {
    private let modelContainer: ModelContainer
    private let queue = DispatchQueue(label: "serversherpa.kiosk.store", qos: .userInitiated)
    /// Only read or written on `queue`.
    private var context: ModelContext?

    init(modelContainer: ModelContainer) {
        self.modelContainer = modelContainer
    }

    var modelContext: ModelContext {
        dispatchPrecondition(condition: .onQueue(queue))
        if let context { return context }
        let made = ModelContext(modelContainer)
        context = made
        return made
    }

    func enqueue(_ job: consuming ExecutorJob) {
        let job = UnownedJob(job)
        let executor = asUnownedSerialExecutor()
        queue.async { job.runSynchronously(on: executor) }
    }

    func asUnownedSerialExecutor() -> UnownedSerialExecutor { UnownedSerialExecutor(ordinary: self) }
}
