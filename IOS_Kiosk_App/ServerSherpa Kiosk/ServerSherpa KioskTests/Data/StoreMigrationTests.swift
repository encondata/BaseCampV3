import Testing
import Foundation
import SwiftData
import CoreData
@testable import ServerSherpa_Kiosk

/// Upgrading a kiosk with unsent scans keeps every queued scan and the synced
/// move (Android `MigrationTest`), and a store that will not open is moved
/// aside, never deleted. Every store here lives in its own temp directory.
struct StoreMigrationTests {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appending(path: "store-migration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func storeUrl(_ dir: URL) -> URL { dir.appending(path: KioskSchema.storeFileName) }

    /// The entity version hashes of the models the app shipped before V2,
    /// captured from that build. SwiftData recognizes an installed store by
    /// these, so `KioskSchemaV1` must never drift from them.
    @Test func v1MatchesTheShippedModels() throws {
        let model = try #require(NSManagedObjectModel.makeManagedObjectModel(for: KioskSchemaV1.models))
        _ = NSPersistentStoreCoordinator(managedObjectModel: model)   // freezes the model, so its checksums are stable
        let hashes = model.entityVersionHashesByName.mapValues { $0.base64EncodedString() }
        #expect(hashes == [
            "AssetRecord": "2RsC4/0nScdnLr3WAjUe6/Y6+OAdoimSQ2cV4VH+Fz8=",
            "ContainerRecord": "xiV4SI2FytLhhQH6ZURpHBRwAzqC2PgaAA720FvmiYA=",
            "MetaRecord": "/UsUMHs8eOmw2h9ICHj44owKFCHIXCyREfIUyZs+UB4=",
            "OutboxRecord": "LROWuRXnVT8xKmpj7+FimZDHwkXZWcCls0WiL4Az55Q=",
            "PersonRecord": "o81WD8FTA0vSjoC8WW5EEbkPnBxlVXEa7AgcLUNxy58=",
            "TruckRecord": "xLvsfmI3+YrAuHc1P+zEeNpKSfFEEiMahUiLhWPYmBI=",
        ])
        #expect(KioskSchemaV1.versionIdentifier == Schema.Version(1, 0, 0))
        #expect(KioskSchemaV2.versionIdentifier == Schema.Version(2, 0, 0))
    }

    /// Writes a V1 store on disk and closes it. It goes through Core Data with
    /// the V1 model SwiftData builds (same entity hashes as the shipped store,
    /// history tracking on as SwiftData sets it) rather than through the
    /// `KioskSchemaV1` classes: those share entity names with the V2 classes,
    /// and SwiftData throws when both are instantiated at once in one process,
    /// which parallel suites do. The app itself never instantiates V1 classes.
    private func seedV1(at url: URL) throws {
        let model = try #require(NSManagedObjectModel.makeManagedObjectModel(for: KioskSchemaV1.models))
        let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
        _ = try coordinator.addPersistentStore(type: .sqlite, at: url, options: [NSPersistentHistoryTrackingKey: true])
        let context = NSManagedObjectContext(.privateQueue)
        context.persistentStoreCoordinator = coordinator
        let asset = encodeJson(OutboxAsset(id: "a2", assetId: "A-2", name: "Rack 2", rfid: nil, serialNumber: "SN2", makeModel: "Dell R740"))
        try context.performAndWait {
            func insert(_ entity: String, _ values: [String: Any]) {
                NSManagedObject(entity: model.entitiesByName[entity]!, insertInto: context).setValuesForKeys(values)
            }
            for i in 1...3 {
                insert("AssetRecord", ["id": "a\(i)", "assetId": "A-\(i)", "name": "Rack \(i)", "serialNumber": "SN\(i)", "make": "Dell",
                                       "model": "R740", "makeModel": "Dell R740", "labelJson": "{\"asset_id\":\"A-\(i)\"}"])
            }
            for i in 1...2 {
                var row: [String: Any] = ["clientScanId": "c\(i)", "seq": Int64(i), "scannedValue": "A-\(i)", "scanType": "barcode",
                                          "scannedAt": "2026-10-21T10:00:0\(i)Z", "matched": true, "status": i == 1 ? "queued" : "retrying",
                                          "attempts": i - 1, "siteId": "s1", "initiativeId": "i1", "scanStatus": "pre_stage"]
                if i == 2, let asset { row["asset"] = asset }
                insert("OutboxRecord", row)
            }
            insert("MetaRecord", ["key": "sync", "value": "{\"initiativeId\":\"i1\"}"])
            insert("PersonRecord", ["id": "p1", "displayName": "Pat Doe", "firstName": "Pat", "lastName": "Doe", "isWorker": true,
                                    "hasAccount": false])
            insert("ContainerRecord", ["id": "k1", "name": "Crate 1", "status": "open", "statusLabel": "Open", "assetCount": 0])
            insert("TruckRecord", ["id": "t1", "name": "Truck 1", "status": "loading", "statusLabel": "Loading", "containerCount": 0])
            try context.save()
        }
        for store in coordinator.persistentStores { try coordinator.remove(store) }
    }

    @Test func v1StoreOpensAtV2WithEveryRow() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedV1(at: storeUrl(dir))

        let container = try KioskSchema.container(url: storeUrl(dir))
        let store = KioskStore(modelContainer: container)
        let outbox = try await store.outboxAll().sorted { $0.seq < $1.seq }
        #expect(outbox.map(\.clientScanId) == ["c1", "c2"])
        #expect(outbox.map(\.status) == [.queued, .retrying])
        #expect(outbox.map(\.attempts) == [0, 1])
        #expect(outbox[1].asset?.name == "Rack 2")
        #expect(outbox[0].asset == nil)
        let assets = try await store.assets().sorted { $0.id < $1.id }
        #expect(assets.map(\.id) == ["a1", "a2", "a3"])
        #expect(assets[2].label["asset_id"] == "A-3")
        let counts = try await store.counts()
        #expect(counts.people == 1 && counts.containers == 1 && counts.trucks == 1)

        let context = ModelContext(container)
        let records = try context.fetch(FetchDescriptor<AssetRecord>(sortBy: [SortDescriptor(\.id)]))
        #expect(records.map(\.payloadJson) == ["{}", "{}", "{}"])
        #expect(records.map(\.position) == [0, 0, 0])
        let meta = try context.fetch(FetchDescriptor<MetaRecord>())
        #expect(meta.map(\.key) == ["sync"])
        #expect(meta.first?.value == "{\"initiativeId\":\"i1\"}")
        #expect(try context.fetchCount(FetchDescriptor<LabelTemplateRecord>()) == 0)
        #expect(try context.fetchCount(FetchDescriptor<LabelFontRecord>()) == 0)
        #expect(try context.fetchCount(FetchDescriptor<GeneratedLabelRecord>()) == 0)

        // The new tables and the label_context meta row take writes.
        context.insert(LabelTemplateRecord(id: "tpl1", position: 0, json: "{}"))
        context.insert(LabelFontRecord(id: "f1", name: "Roboto", size: 10, resident: false, fileName: "f1.ttf"))
        context.insert(GeneratedLabelRecord(assetId: "a1", zpl: "^XA^XZ", outcome: "ok", fingerprint: "fp", templateId: "tpl1"))
        context.insert(MetaRecord(key: labelContextMetaKey, value: "{\"move\":1}"))
        records[0].payloadJson = "{\"id\":\"a1\",\"n\":1.50}"
        records[0].position = 7
        try context.save()

        // A second open of the migrated store is a plain V2 open.
        let reopened = ModelContext(try KioskSchema.container(url: storeUrl(dir)))
        let again = try reopened.fetch(FetchDescriptor<AssetRecord>(sortBy: [SortDescriptor(\.id)]))
        #expect(again[0].payloadJson == "{\"id\":\"a1\",\"n\":1.50}")
        #expect(again[0].position == 7)
        #expect(try reopened.fetch(FetchDescriptor<GeneratedLabelRecord>()).first?.zpl == "^XA^XZ")
        #expect(try reopened.fetch(FetchDescriptor<LabelFontRecord>()).first?.fileName == "f1.ttf")
        #expect(try reopened.fetchCount(FetchDescriptor<OutboxRecord>()) == 2)
    }

    @Test func inMemoryContainerIsV2() throws {
        let context = ModelContext(try KioskSchema.container(inMemory: true))
        context.insert(LabelTemplateRecord(id: "tpl1", position: 0, json: "{}"))
        try context.save()
        #expect(try context.fetchCount(FetchDescriptor<LabelTemplateRecord>()) == 1)
    }

    @MainActor @Test func aStoreThatWillNotOpenIsMovedAsideNeverDeleted() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let garbage = Data("this is not a SQLite database, but it is somebody's data".utf8)
        try garbage.write(to: storeUrl(dir))
        try Data("wal bytes".utf8).write(to: dir.appending(path: KioskSchema.storeFileName + "-wal"))

        let container = AppContainer.openStore(directory: dir)

        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false))
        let failed = try #require(names.first { $0.hasPrefix("serversherpa-kiosk.store.failed-") && !$0.hasSuffix("-wal") && !$0.hasSuffix("-shm") })
        #expect(failed.wholeMatch(of: /serversherpa-kiosk\.store\.failed-\d{8}-\d{6}/) != nil)
        #expect(try Data(contentsOf: dir.appending(path: failed)) == garbage)
        #expect(names.contains(failed + "-wal"))
        #expect(try Data(contentsOf: dir.appending(path: failed + "-wal")) == Data("wal bytes".utf8))

        // A fresh, working store on disk at the usual name.
        #expect(container.configurations.first?.url == storeUrl(dir))
        #expect(container.configurations.first?.isStoredInMemoryOnly == false)
        let store = KioskStore(modelContainer: container)
        try await store.replaceRoster(assets: [KioskAssetRow(id: "a1", assetId: "A-1")], people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 1, people: 0, containers: 0,
                                                     trucks: 0, syncedAt: "2026-10-21T10:00:00Z"))
        #expect(try await store.counts().assets == 1)
    }

    @MainActor @Test func aHealthyStoreIsLeftInPlace() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedV1(at: storeUrl(dir))

        let store = KioskStore(modelContainer: AppContainer.openStore(directory: dir))
        #expect(try await store.outboxAll().count == 2)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false))
        #expect(!names.contains { $0.contains(".failed-") })
    }

    @Test func failedNameStampsTheMoment() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 9, minute: 5, second: 7))!
        #expect(KioskSchema.failedStoreName(at: date) == "serversherpa-kiosk.store.failed-20261021-090507")
    }
}
