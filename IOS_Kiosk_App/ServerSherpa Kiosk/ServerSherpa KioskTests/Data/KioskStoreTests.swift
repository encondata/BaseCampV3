import Testing
import Foundation
import SwiftData
@testable import ServerSherpa_Kiosk

struct KioskStoreTests {
    private func store() throws -> KioskStore { KioskStore(modelContainer: try KioskSchema.container(inMemory: true)) }

    private func meta(_ name: String = "Move A", assets: Int = 0) -> SyncMeta {
        SyncMeta(initiativeId: "i1", initiativeName: name, assets: assets, people: 0, containers: 0, trucks: 0, syncedAt: "2023-11-14T22:13:20Z")
    }

    @Test func assetsRoundTripAndMatch() async throws {
        let db = try store()
        let row = KioskAssetRow(id: "a1", assetId: "A-1", name: "Rack", rfid: "000000000000000000100348", serialNumber: "SN1", makeModel: "Dell R740", label: ["asset_id": "A-1"])
        try await db.replaceRoster(assets: [row], people: [], containers: [], trucks: [], meta: meta(assets: 1))
        let all = try await db.assets()
        #expect(all.count == 1)
        #expect(all[0] == row)
        #expect(all[0].label["asset_id"] == "A-1")
        #expect(matchScan(buildScanIndex(all), "100348")?.asset.id == "a1")
        try await db.updateAssetRfid(id: "a1", rfid: "000000000000000000999999")
        #expect(try await db.assets()[0].rfid == "000000000000000000999999")
        #expect(try await db.counts().assets == 1)
        try await db.clearLocalData()
        #expect(try await db.counts().assets == 0)
    }

    @Test func corruptLabelJsonReadsAsEmpty() {
        let record = AssetRecord(KioskAssetRow(id: "a1", assetId: "A-1", label: ["k": "v"]))
        record.labelJson = "not json"
        #expect(record.row.label == [:])
    }

    @Test func metaAndOutbox() async throws {
        let db = try store()
        try await db.replaceRoster(assets: [], people: [], containers: [], trucks: [], meta: meta())
        #expect(try await db.meta() == meta())
        try await db.clearLocalData()
        #expect(try await db.meta() == nil)

        let asset = OutboxAsset(id: "a1", assetId: "A-1", name: "Rack", rfid: nil, serialNumber: "SN1", makeModel: "Dell")
        let r1 = OutboxMachine.newRow(EnqueueInput(scannedValue: "A-1", scanType: "barcode", asset: asset, siteId: "s", initiativeId: "i", scanStatus: "pre_stage"), clientScanId: "c1", seq: 1, nowMs: 0)
        let r2 = OutboxMachine.newRow(EnqueueInput(scannedValue: "zzz", scanType: "barcode", asset: nil, siteId: "s", initiativeId: "i", scanStatus: "pre_stage"), clientScanId: "c2", seq: 2, nowMs: 0)
        try await db.outboxUpsert([r1, r2])
        let rows = try await db.outboxAll().sorted { $0.seq < $1.seq }
        #expect(rows[0] == r1); #expect(rows[1] == r2)
        #expect(rows[1].status == .nomatch)
        var accepted = r1; accepted.status = .accepted
        try await db.outboxUpsert([accepted])
        #expect(try await db.outboxAll().count == 2)
        #expect(try await db.outboxAll().first { $0.clientScanId == "c1" }?.status == .accepted)
        try await db.outboxDelete(["c1", "c2"])
        #expect(try await db.outboxAll().isEmpty)
    }

    @Test func corruptMetaReadsAsNil() async throws {
        let container = try KioskSchema.container(inMemory: true)
        let context = ModelContext(container)
        context.insert(MetaRecord(key: "sync", value: "{broken"))
        try context.save()
        #expect(try await KioskStore(modelContainer: container).meta() == nil)
    }

    @Test func secondReplaceFullyReplacesAllTables() async throws {
        let db = try store()
        try await db.replaceRoster(
            assets: [KioskAssetRow(id: "a1", assetId: "A-1"), KioskAssetRow(id: "a2", assetId: "A-2")],
            people: [KioskPersonRow(id: "p1", displayName: "Tina T"), KioskPersonRow(id: "p2", displayName: "Sam S")],
            containers: [KioskContainerRow(id: "c1", name: "Crate 1")],
            trucks: [KioskTruckRow(id: "t1", name: "Truck 1")],
            meta: meta("Move A", assets: 2)
        )
        try await db.replaceRoster(
            assets: [KioskAssetRow(id: "a2", assetId: "A-2b"), KioskAssetRow(id: "a9", assetId: "A-9")],
            people: [KioskPersonRow(id: "p3", displayName: "Lee L")],
            containers: [], trucks: [KioskTruckRow(id: "t2", name: "Truck 2")],
            meta: meta("Move B", assets: 2)
        )
        #expect(try await db.assets().map(\.id).sorted() == ["a2", "a9"])
        #expect(try await db.assets().first { $0.id == "a2" }?.assetId == "A-2b")
        #expect(try await db.people().map(\.id) == ["p3"])
        let counts = try await db.counts()
        #expect(counts.assets == 2); #expect(counts.people == 1); #expect(counts.containers == 0); #expect(counts.trucks == 1)
        #expect(try await db.meta()?.initiativeName == "Move B")
    }

    @Test func clearLocalDataLeavesOutbox() async throws {
        let db = try store()
        try await db.replaceRoster(assets: [KioskAssetRow(id: "a1")], people: [KioskPersonRow(id: "p1", displayName: "T")],
                                   containers: [KioskContainerRow(id: "c1", name: "C")], trucks: [KioskTruckRow(id: "t1", name: "T")], meta: meta())
        let row = OutboxMachine.newRow(EnqueueInput(scannedValue: "A-1", scanType: "barcode", asset: nil, siteId: "s", initiativeId: "i", scanStatus: "x"), clientScanId: "c1", seq: 1, nowMs: 0)
        try await db.outboxUpsert([row])
        try await db.clearLocalData()
        let counts = try await db.counts()
        #expect(counts.assets == 0); #expect(counts.people == 0); #expect(counts.containers == 0); #expect(counts.trucks == 0)
        #expect(try await db.meta() == nil)
        #expect(try await db.outboxAll() == [row])
    }

    @Test func inspectCapsRowsAndListsMeta() async throws {
        let db = try store()
        try await db.replaceRoster(assets: (1...5).map { KioskAssetRow(id: "a\($0)") }, people: [KioskPersonRow(id: "p1", displayName: "T")],
                                   containers: [], trucks: [], meta: meta())
        let snap = try await db.inspect(limit: 3)
        #expect(snap.assets.count == 3)
        #expect(snap.people.count == 1)
        #expect(snap.meta.map(\.0) == ["sync"])
        #expect(snap.meta[0].1.contains("\"initiativeName\":\"Move A\""))
    }
}
