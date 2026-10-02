import Foundation
import SwiftData

/// The meta row holding the last sync (Android `MOVE_META_KEY`).
let syncMetaKey = "sync"

/// The only thing that touches the SwiftData container. Everything crossing
/// the actor boundary is a Core value type, never a `@Model` object.
@ModelActor actor KioskStore {
    /// Deletes the four move tables and the meta row and inserts the new
    /// rows, then saves once: one save is one SQLite transaction, so a crash
    /// leaves either the old roster or the new one.
    func replaceRoster(assets: [KioskAssetRow], people: [KioskPersonRow], containers: [KioskContainerRow],
                       trucks: [KioskTruckRow], meta: SyncMeta) throws {
        do {
            try deleteMoveTables()
            for row in assets { modelContext.insert(AssetRecord(row)) }
            for row in people { modelContext.insert(PersonRecord(row)) }
            for row in containers { modelContext.insert(ContainerRecord(row)) }
            for row in trucks { modelContext.insert(TruckRecord(row)) }
            modelContext.insert(MetaRecord(key: syncMetaKey, value: encodeJson(meta) ?? "{}"))
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    func assets() throws -> [KioskAssetRow] { try modelContext.fetch(FetchDescriptor<AssetRecord>()).map(\.row) }

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

    /// "Clear local data": the move tables and the meta row — never the outbox.
    func clearLocalData() throws {
        do {
            try deleteMoveTables()
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
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
        var assets = FetchDescriptor<AssetRecord>()
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
        let key = syncMetaKey
        try modelContext.delete(model: MetaRecord.self, where: #Predicate { $0.key == key })
    }
}
