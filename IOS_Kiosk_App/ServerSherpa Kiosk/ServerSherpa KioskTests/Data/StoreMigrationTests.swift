import Testing
import Foundation
import SwiftData
import CoreData
@testable import ServerSherpa_Kiosk

private final class FixtureBundle {}

/// Upgrading a kiosk with unsent scans keeps every queued scan and the synced
/// move (Android `MigrationTest`), and a store that will not open is never
/// deleted: only a corrupt one is moved aside, with its queued scans salvaged.
/// Every store here lives in its own temp directory.
struct StoreMigrationTests {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appending(path: "store-migration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func storeUrl(_ dir: URL) -> URL { dir.appending(path: KioskSchema.storeFileName) }

    private func names(_ dir: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false)).sorted()
    }

    private func hashes(_ models: [any PersistentModel.Type]) throws -> [String: String] {
        try #require(KioskStoreOpener.frozenModel(models)).entityVersionHashesByName.mapValues { $0.base64EncodedString() }
    }

    /// The entity version hashes of the models the app shipped before V2,
    /// captured from that build (6d1a7ce0). SwiftData recognizes an installed
    /// store by these, so `KioskSchemaV1` must never drift from them.
    @Test func v1MatchesTheShippedModels() throws {
        #expect(try hashes(KioskSchemaV1.models) == [
            "AssetRecord": "2RsC4/0nScdnLr3WAjUe6/Y6+OAdoimSQ2cV4VH+Fz8=",
            "ContainerRecord": "xiV4SI2FytLhhQH6ZURpHBRwAzqC2PgaAA720FvmiYA=",
            "MetaRecord": "/UsUMHs8eOmw2h9ICHj44owKFCHIXCyREfIUyZs+UB4=",
            "OutboxRecord": "LROWuRXnVT8xKmpj7+FimZDHwkXZWcCls0WiL4Az55Q=",
            "PersonRecord": "o81WD8FTA0vSjoC8WW5EEbkPnBxlVXEa7AgcLUNxy58=",
            "TruckRecord": "xLvsfmI3+YrAuHc1P+zEeNpKSfFEEiMahUiLhWPYmBI=",
        ])
        #expect(KioskSchemaV1.versionIdentifier == Schema.Version(1, 0, 0))
        #expect(KioskSchemaV2.versionIdentifier == Schema.Version(2, 0, 0))
        #expect(KioskSchemaV3.versionIdentifier == Schema.Version(3, 0, 0))
    }

    /// V2's hashes, captured while V2 was the current version. V2's models are
    /// now frozen nested copies (as V1's are), so these never change again.
    @Test func v2MatchesTheCurrentModels() throws {
        #expect(try hashes(KioskSchemaV2.models) == [
            "AssetRecord": "fQPXcFmSak5wb8ueyeBQXH8WchqGLrsHYvemHcL3f+Y=",
            "ContainerRecord": "xiV4SI2FytLhhQH6ZURpHBRwAzqC2PgaAA720FvmiYA=",
            "GeneratedLabelRecord": "egCgr0FGUJOcr4veGo1Vfeq3x4RZ9OPZgFQ8UegKD4g=",
            "LabelFontRecord": "ge1ILpgy/XJqzTU14LZUEFLD3ZF1UISrWhdEwiPEYBs=",
            "LabelTemplateRecord": "UslMw+yEjcSV88BaUmgxPwj4u5j0NP/5T6CbSktt3/U=",
            "MetaRecord": "/UsUMHs8eOmw2h9ICHj44owKFCHIXCyREfIUyZs+UB4=",
            "OutboxRecord": "LROWuRXnVT8xKmpj7+FimZDHwkXZWcCls0WiL4Az55Q=",
            "PersonRecord": "o81WD8FTA0vSjoC8WW5EEbkPnBxlVXEa7AgcLUNxy58=",
            "TruckRecord": "xLvsfmI3+YrAuHc1P+zEeNpKSfFEEiMahUiLhWPYmBI=",
        ])
    }

    /// V3's hashes. They may change only until V3 first ships. After that,
    /// V3's models must be frozen into nested classes (as V1's and V2's are)
    /// before any V4 changes the top-level models, and these never change again.
    @Test func v3MatchesTheCurrentModels() throws {
        #expect(try hashes(KioskSchemaV3.models) == [
            "AssetRecord": "fQPXcFmSak5wb8ueyeBQXH8WchqGLrsHYvemHcL3f+Y=",
            "ContainerRecord": "xiV4SI2FytLhhQH6ZURpHBRwAzqC2PgaAA720FvmiYA=",
            "GeneratedLabelRecord": "egCgr0FGUJOcr4veGo1Vfeq3x4RZ9OPZgFQ8UegKD4g=",
            "LabelFontRecord": "ge1ILpgy/XJqzTU14LZUEFLD3ZF1UISrWhdEwiPEYBs=",
            "LabelTemplateRecord": "UslMw+yEjcSV88BaUmgxPwj4u5j0NP/5T6CbSktt3/U=",
            "MetaRecord": "/UsUMHs8eOmw2h9ICHj44owKFCHIXCyREfIUyZs+UB4=",
            "OutboxRecord": "LROWuRXnVT8xKmpj7+FimZDHwkXZWcCls0WiL4Az55Q=",
            "PersonRecord": "gZ68huHk2JqKVr2KdwPhLEIWYFxt75fHJ9nkbTNBV8A=",
            "TruckRecord": "xLvsfmI3+YrAuHc1P+zEeNpKSfFEEiMahUiLhWPYmBI=",
        ])
    }

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

    /// A V2 store as the shipped V2 build wrote it (through its frozen models):
    /// the two queued scans, one asset with its payload, a person, a label template.
    private func seedV2(at url: URL) throws {
        let model = try #require(KioskStoreOpener.frozenModel(KioskSchemaV2.models))
        let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
        _ = try coordinator.addPersistentStore(type: .sqlite, at: url, options: [NSPersistentHistoryTrackingKey: true])
        let context = NSManagedObjectContext(.privateQueue)
        context.persistentStoreCoordinator = coordinator
        let asset = encodeJson(OutboxAsset(id: "a2", assetId: "A-2", name: "Rack 2", rfid: nil, serialNumber: "SN2", makeModel: "Dell R740"))
        try context.performAndWait {
            func insert(_ entity: String, _ values: [String: Any]) {
                NSManagedObject(entity: model.entitiesByName[entity]!, insertInto: context).setValuesForKeys(values)
            }
            insert("AssetRecord", ["id": "a1", "assetId": "A-1", "makeModel": "Dell R740", "labelJson": "{}",
                                   "payloadJson": "{\"id\":\"a1\"}", "position": 3])
            for i in 1...2 {
                var row: [String: Any] = ["clientScanId": "c\(i)", "seq": Int64(i), "scannedValue": "A-\(i)", "scanType": "barcode",
                                          "scannedAt": "2026-10-21T10:00:0\(i)Z", "matched": true, "status": i == 1 ? "queued" : "retrying",
                                          "attempts": i - 1, "siteId": "s1", "initiativeId": "i1", "scanStatus": "pre_stage"]
                if i == 2, let asset { row["asset"] = asset }
                insert("OutboxRecord", row)
            }
            insert("PersonRecord", ["id": "p1", "displayName": "Pat Doe", "firstName": "Pat", "lastName": "Doe", "rfidTag": "1003",
                                    "isWorker": true, "hasAccount": false])
            insert("LabelTemplateRecord", ["id": "tpl1", "position": 0, "json": "{}"])
            insert("MetaRecord", ["key": "sync", "value": "{\"initiativeId\":\"i1\"}"])
            try context.save()
        }
        for store in coordinator.persistentStores { try coordinator.remove(store) }
    }

    /// A current-version store with two queued scans and one asset, written by the app's own code.
    private func seedCurrent(at url: URL) async throws {
        let store = KioskStore(modelContainer: try KioskSchema.container(url: url))
        try await store.outboxUpsert(outboxRows())
        try await store.replaceRoster(assets: [KioskAssetRow(id: "a1", assetId: "A-1")], people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 1, people: 0, containers: 0,
                                                     trucks: 0, syncedAt: "2026-10-21T10:00:00Z"))
    }

    /// The two rows `seedV1` writes, as the app reads them.
    private func outboxRows() -> [OutboxRow] {
        let asset = OutboxAsset(id: "a2", assetId: "A-2", name: "Rack 2", rfid: nil, serialNumber: "SN2", makeModel: "Dell R740")
        return (1...2).map { (i: Int) -> OutboxRow in
            OutboxRow(clientScanId: "c\(i)", seq: Int64(i), scannedValue: "A-\(i)", scanType: "barcode", scannedAt: "2026-10-21T10:00:0\(i)Z",
                      asset: i == 2 ? asset : nil, matched: true, status: i == 1 ? .queued : .retrying, attempts: i - 1, nextAttemptAt: nil,
                      lastError: nil, siteId: "s1", initiativeId: "i1", scanStatus: "pre_stage")
        }
    }

    /// A store a newer build wrote: V3 plus an attribute this build does not know.
    private func seedNewerVersion(at url: URL) throws {
        let model = try #require(KioskStoreOpener.frozenModel(KioskSchemaV3.models)?.copy() as? NSManagedObjectModel)
        let extra = NSAttributeDescription()
        extra.name = "fromTheFuture"
        extra.type = .string
        extra.isOptional = true
        try #require(model.entitiesByName["AssetRecord"]).properties.append(extra)
        let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
        _ = try coordinator.addPersistentStore(type: .sqlite, at: url, options: [NSPersistentHistoryTrackingKey: true])
        let context = NSManagedObjectContext(.privateQueue)
        context.persistentStoreCoordinator = coordinator
        try context.performAndWait {
            NSManagedObject(entity: model.entitiesByName["MetaRecord"]!, insertInto: context).setValuesForKeys(["key": "sync", "value": "{}"])
            try context.save()
        }
        for store in coordinator.persistentStores { try coordinator.remove(store) }
    }

    /// An opener whose first open fails (a full disk, say) and whose later opens are real.
    private final class FailOnce {
        var calls = 0
        func open(_ url: URL) throws -> ModelContainer {
            calls += 1
            if calls == 1 { throw CocoaError(.fileWriteOutOfSpace) }
            return try KioskSchema.container(url: url)
        }
    }

    private func inMemory() -> ModelContainer { try! KioskSchema.inMemoryContainer() }

    @Test func v1StoreOpensAtTheCurrentVersionWithEveryRow() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedV1(at: storeUrl(dir))

        let container = try KioskSchema.container(url: storeUrl(dir))
        let store = KioskStore(modelContainer: container)
        #expect(try await store.outboxAll().sorted { $0.seq < $1.seq } == outboxRows())
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

        // The people columns V3 added read as nil.
        let people = try context.fetch(FetchDescriptor<PersonRecord>())
        #expect(people.map(\.id) == ["p1"])
        #expect(people[0].badgeUid == nil && people[0].jobTitle == nil && people[0].externalId == nil)

        // A second open of the migrated store is a plain current-version open.
        let reopened = ModelContext(try KioskSchema.container(url: storeUrl(dir)))
        let again = try reopened.fetch(FetchDescriptor<AssetRecord>(sortBy: [SortDescriptor(\.id)]))
        #expect(again[0].payloadJson == "{\"id\":\"a1\",\"n\":1.50}")
        #expect(again[0].position == 7)
        #expect(try reopened.fetch(FetchDescriptor<GeneratedLabelRecord>()).first?.zpl == "^XA^XZ")
        #expect(try reopened.fetch(FetchDescriptor<LabelFontRecord>()).first?.fileName == "f1.ttf")
        #expect(try reopened.fetchCount(FetchDescriptor<OutboxRecord>()) == 2)
    }

    /// `Fixtures/PrechangeKioskStore.sqlite` was written by SwiftData in the
    /// build before versioning (6d1a7ce0): 3 assets, 1 unmatched scan, the sync
    /// meta row. Checkpointed to a single file.
    @Test func aStoreFromThePrechangeBuildOpensAtTheCurrentVersion() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fixture = try #require(Bundle(for: FixtureBundle.self).url(forResource: "PrechangeKioskStore", withExtension: "sqlite"))
        try FileManager.default.copyItem(at: fixture, to: storeUrl(dir))

        let container = try KioskSchema.container(url: storeUrl(dir))
        let store = KioskStore(modelContainer: container)
        #expect(try await store.assets().map(\.id).sorted() == ["a1", "a2", "a3"])
        let outbox = try await store.outboxAll()
        #expect(outbox.map(\.clientScanId) == ["c1"])
        #expect(outbox.first?.status == .nomatch)
        let context = ModelContext(container)
        #expect(try context.fetch(FetchDescriptor<AssetRecord>()).map(\.payloadJson) == ["{}", "{}", "{}"])
        #expect(try context.fetch(FetchDescriptor<MetaRecord>()).map(\.value) == ["{\"initiativeId\":\"i1\"}"])
    }

    /// V2 → V3 keeps every row and adds the person's badge, job title and
    /// Employee ID as nil until the next people sync fills them.
    @Test func v2StoreOpensAtV3WithEveryRow() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedV2(at: storeUrl(dir))
        #expect(KioskStoreOpener.classify(storeAt: storeUrl(dir)) == .known)

        let container = try KioskSchema.container(url: storeUrl(dir))
        let store = KioskStore(modelContainer: container)
        #expect(try await store.outboxAll().sorted { $0.seq < $1.seq } == outboxRows())
        #expect(try await store.assets().map(\.id) == ["a1"])
        let people = try await store.people()
        #expect(people == [KioskPersonRow(id: "p1", displayName: "Pat Doe", firstName: "Pat", lastName: "Doe", rfidTag: "1003",
                                          isWorker: true, hasAccount: false)])

        let context = ModelContext(container)
        let asset = try #require(try context.fetch(FetchDescriptor<AssetRecord>()).first)
        #expect(asset.payloadJson == "{\"id\":\"a1\"}" && asset.position == 3)
        #expect(try context.fetchCount(FetchDescriptor<LabelTemplateRecord>()) == 1)
        #expect(try context.fetch(FetchDescriptor<MetaRecord>()).map(\.value) == ["{\"initiativeId\":\"i1\"}"])

        // A people sync writes the new columns, and they survive a reopen.
        try await store.replaceRoster(assets: [KioskAssetRow(id: "a1", assetId: "A-1")],
                                      people: [KioskPersonRow(id: "p1", displayName: "Pat Doe", firstName: "Pat", lastName: "Doe", rfidTag: "1003",
                                                              badgeUid: "ab12cd34-2222-4333-8444-555555555555", jobTitle: "Lead",
                                                              externalId: "E-7", isWorker: true)],
                                      containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 1, people: 1, containers: 0,
                                                     trucks: 0, syncedAt: "2026-10-21T10:00:00Z"))
        let reopened = KioskStore(modelContainer: try KioskSchema.container(url: storeUrl(dir)))
        let again = try await reopened.people()
        #expect(again.first?.badgeUid == "ab12cd34-2222-4333-8444-555555555555")
        #expect(again.first?.jobTitle == "Lead" && again.first?.externalId == "E-7")
        #expect(try await reopened.outboxAll().count == 2)
    }

    @Test func inMemoryContainerIsV3() throws {
        let context = ModelContext(try KioskSchema.inMemoryContainer())
        context.insert(LabelTemplateRecord(id: "tpl1", position: 0, json: "{}"))
        context.insert(PersonRecord(KioskPersonRow(id: "p1", displayName: "Bea", badgeUid: "b1")))
        try context.save()
        #expect(try context.fetchCount(FetchDescriptor<LabelTemplateRecord>()) == 1)
        #expect(try context.fetch(FetchDescriptor<PersonRecord>()).first?.badgeUid == "b1")
    }

    @Test func classifyReadsTheFileWithoutOpeningIt() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(KioskStoreOpener.classify(storeAt: dir.appending(path: "missing.store")) == .missing)
        let garbage = dir.appending(path: "garbage.store")
        try Data("not a database".utf8).write(to: garbage)
        #expect(KioskStoreOpener.classify(storeAt: garbage) == .corrupt)
        let v1 = dir.appending(path: "v1.store")
        try seedV1(at: v1)
        #expect(KioskStoreOpener.classify(storeAt: v1) == .known)
        let v2 = dir.appending(path: "v2.store")
        try seedV2(at: v2)
        #expect(KioskStoreOpener.classify(storeAt: v2) == .known)
        let current = dir.appending(path: "current.store")
        try await seedCurrent(at: current)
        #expect(KioskStoreOpener.classify(storeAt: current) == .known)
        let newer = dir.appending(path: "newer.store")
        try seedNewerVersion(at: newer)
        #expect(KioskStoreOpener.classify(storeAt: newer) == .unknownVersion)
    }

    @Test func aCorruptStoreIsMovedAsideWithItsSiblings() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let files = ["": Data("this is not a SQLite database, but it is somebody's data".utf8),
                     "-wal": Data("wal bytes".utf8), "-shm": Data("shm bytes".utf8)]
        for (suffix, bytes) in files { try bytes.write(to: dir.appending(path: KioskSchema.storeFileName + suffix)) }

        let opened = KioskStoreOpener.open(directory: dir, now: Date(), protectedDataAvailable: { true }, inMemory: inMemory)

        let folder = try #require(opened.movedAsideTo)
        #expect(folder.lastPathComponent.wholeMatch(of: /serversherpa-kiosk\.store\.failed-\d{8}-\d{6}/) != nil)
        #expect(try names(folder) == ["serversherpa-kiosk.store", "serversherpa-kiosk.store-shm", "serversherpa-kiosk.store-wal"])
        for (suffix, bytes) in files {
            #expect(try Data(contentsOf: folder.appending(path: KioskSchema.storeFileName + suffix)) == bytes)
        }
        #expect(!opened.isTemporary)
        #expect(opened.salvagedScans == 0)
        #expect(opened.container.configurations.first?.url == storeUrl(dir))
        #expect(opened.container.configurations.first?.isStoredInMemoryOnly == false)
        let store = KioskStore(modelContainer: opened.container)
        try await store.outboxUpsert(outboxRows())
        #expect(try await store.outboxAll().count == 2)
    }

    @Test func aLockedDeviceNeverMovesTheStore() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let garbage = Data("unreadable while locked".utf8)
        try garbage.write(to: storeUrl(dir))

        let opened = KioskStoreOpener.open(directory: dir, now: Date(), protectedDataAvailable: { false }, inMemory: inMemory)

        #expect(opened.isTemporary)
        #expect(opened.movedAsideTo == nil)
        #expect(opened.container.configurations.first?.isStoredInMemoryOnly == true)
        #expect(try names(dir) == ["serversherpa-kiosk.store"])
        #expect(try Data(contentsOf: storeUrl(dir)) == garbage)
    }

    @Test func aHealthyStoreThatWillNotOpenIsLeftInPlace() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try await seedCurrent(at: storeUrl(dir))
        let before = try names(dir)

        let opener = FailOnce()
        let opened = KioskStoreOpener.open(directory: dir, now: Date(), protectedDataAvailable: { true }, open: opener.open, inMemory: inMemory)

        #expect(opener.calls == 1)
        #expect(opened.isTemporary)
        #expect(opened.movedAsideTo == nil)
        #expect(opened.container.configurations.first?.isStoredInMemoryOnly == true)
        #expect(try names(dir) == before)
        // The next launch finds every queued scan.
        let next = KioskStore(modelContainer: try KioskSchema.container(url: storeUrl(dir)))
        #expect(try await next.outboxAll().count == 2)
    }

    @Test func aStoreFromANewerBuildIsLeftInPlace() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedNewerVersion(at: storeUrl(dir))
        let before = try names(dir)

        let opened = KioskStoreOpener.open(directory: dir, now: Date(), protectedDataAvailable: { true }, inMemory: inMemory)

        #expect(opened.isTemporary)
        #expect(opened.movedAsideTo == nil)
        #expect(try names(dir) == before)
        #expect(KioskStoreOpener.classify(storeAt: storeUrl(dir)) == .unknownVersion)
    }

    /// A corrupt file cannot be read for salvage, so these force the move on a
    /// readable store to prove the salvage reads V1, V2 and V3 stores alike.
    @Test(arguments: [1, 2, 3]) func aMovedStoreHasItsOutboxSalvaged(version: Int) async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        switch version {
        case 1: try seedV1(at: storeUrl(dir))
        case 2: try seedV2(at: storeUrl(dir))
        default: try await seedCurrent(at: storeUrl(dir))
        }

        let opened = KioskStoreOpener.open(directory: dir, now: Date(), protectedDataAvailable: { true }, open: FailOnce().open,
                                           classify: { _ in .corrupt }, inMemory: inMemory)

        let folder = try #require(opened.movedAsideTo)
        #expect(try names(folder).contains(KioskSchema.storeFileName))
        #expect(!opened.isTemporary)
        #expect(opened.salvagedScans == 2)
        let fresh = KioskStore(modelContainer: opened.container)
        #expect(try await fresh.outboxAll().sorted { $0.seq < $1.seq } == outboxRows())
        #expect(try await fresh.assets().isEmpty)
    }

    @Test func aSecondFailureInTheSameSecondGetsItsOwnFolder() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let now = Date()
        try Data("one".utf8).write(to: storeUrl(dir))
        let first = try #require(KioskStoreOpener.moveAside(directory: dir, now: now))
        try Data("two".utf8).write(to: storeUrl(dir))
        let second = try #require(KioskStoreOpener.moveAside(directory: dir, now: now))
        #expect(second.lastPathComponent == first.lastPathComponent + "-2")
        #expect(try Data(contentsOf: first.appending(path: KioskSchema.storeFileName)) == Data("one".utf8))
        #expect(try Data(contentsOf: second.appending(path: KioskSchema.storeFileName)) == Data("two".utf8))
    }

    @MainActor @Test func theAppOpensAHealthyStoreInPlace() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedV1(at: storeUrl(dir))

        let opened = AppContainer.openStore(directory: dir)
        #expect(!opened.isTemporary)
        #expect(try await KioskStore(modelContainer: opened.container).outboxAll().count == 2)
        #expect(!(try names(dir)).contains { $0.contains(".failed-") })
    }

    @Test func failedNameStampsTheMoment() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 9, minute: 5, second: 7))!
        #expect(KioskSchema.failedStoreName(at: date) == "serversherpa-kiosk.store.failed-20261021-090507")
    }
}
