import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Android AssetLookupRepositoryTest, case for case, plus offline with nothing synced.
@MainActor
struct AssetLookupRepositoryTests {
    private let payload = #"{"id":"a1","asset_id":"A-1","name":"Core switch","rfid":null,"serial_number":"SN-100","make":"Dell","model":"R740","make_model":"Dell R740","container_id":"c1","source_rack":"R12","source_ru":"14","destination_rack":"R40","destination_ru":"20","asset_status":"staged","asset_status_label":"Staged","location_detail":"","extra_unknown":1}"#

    private func seeded(labelContext: String = #"{"source_site":"Old DC","destination_site":"New DC","other":1}"#) async throws -> KioskStore {
        let store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        try await store.replaceRoster(
            assets: [
                KioskAssetRow(id: "a1", assetId: "A-1", name: "Core switch", serialNumber: "SN-100", make: "Dell", model: "R740",
                              makeModel: "Dell R740", containerId: "c1"),
                KioskAssetRow(id: "bad", assetId: "B-1", name: "Broken"),
            ],
            people: [],
            containers: [KioskContainerRow(id: "c1", name: "Crate 7", status: "open", statusLabel: "Open", assetCount: 1)],
            trucks: [],
            meta: SyncMeta(initiativeId: "m1", initiativeName: "Move One", assets: 1, people: 0, containers: 1, trucks: 0,
                           syncedAt: "2026-11-10T00:00:00Z"),
            payloads: [payload, "not json"], labelContext: labelContext)
        return store
    }

    private func offlineApi() -> FakeKioskApi {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError.network() }
        api.assetDetailResult = { _, _ in throw ApiError.network() }
        api.assetScansResult = { _, _, _ in throw ApiError.network() }
        return api
    }

    @Test func onlineUsesTheApi() async throws {
        let store = try await seeded()
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult(matches: [KioskLookupMatch(id: "x9", name: "Remote", assetTag: "R-9")]) }
        let found = try await AssetLookupRepository(api: api, store: store).find(serial: "K1", value: "SN-100")
        #expect(!found.offline)
        #expect(!found.noMoveData)
        #expect(found.result.matches.map(\.id) == ["x9"])
        #expect(api.calls == ["lookupAssets:SN-100"])
        #expect(try await store.outboxAll().isEmpty)
    }

    @Test func networkErrorFallsBackToSyncedAssets() async throws {
        let store = try await seeded()
        let found = try await AssetLookupRepository(api: offlineApi(), store: store).find(serial: "K1", value: "SN-100")
        #expect(found.offline)
        #expect(!found.noMoveData)
        #expect(found.result.matches.map(\.id) == ["a1"])
        #expect(try await store.outboxAll().isEmpty)
    }

    @Test func edgeOfflineCodeFallsBack() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError(status: 502, code: "edge_offline") }
        #expect(try await AssetLookupRepository(api: api, store: try await seeded()).find(serial: "K1", value: "SN-100").offline)
    }

    @Test func detailFallsBackWhenNetworkDropsAfterLookup() async throws {
        let api = offlineApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult(matches: [KioskLookupMatch(id: "a1", name: "Core switch", assetTag: "A-1")]) }
        let repo = AssetLookupRepository(api: api, store: try await seeded())
        #expect(try await !repo.find(serial: "K1", value: "A-1").offline)
        let opened = try await repo.open(serial: "K1", id: "a1", offline: false, admin: true)
        #expect(opened.offline)
        #expect(opened.detail?.id == "a1")
        #expect(opened.detail?.full?.containerName == "Crate 7")
    }

    @Test func offlineSkipsTheApiAndNonAdminHasNoFullCard() async throws {
        let api = FakeKioskApi()
        let opened = try await AssetLookupRepository(api: api, store: try await seeded()).open(serial: "K1", id: "a1", offline: true, admin: false)
        #expect(opened.offline)
        #expect(opened.detail != nil)
        #expect(opened.detail?.full == nil)
        #expect(api.calls.isEmpty)
    }

    @Test func onlineDetailPassesThrough() async throws {
        let api = FakeKioskApi()
        api.assetDetailResult = { _, id in KioskAssetDetail(id: id) }
        let opened = try await AssetLookupRepository(api: api, store: try await seeded()).open(serial: "K1", id: "zz", offline: false, admin: true)
        #expect(!opened.offline)
        #expect(opened.detail?.id == "zz")
        #expect(api.calls == ["assetDetail:zz"])
    }

    @Test(arguments: [404, 403])
    func forbiddenDoesNotFallBack(status: Int) async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError(status: status, code: "nope") }
        api.assetDetailResult = { _, _ in throw ApiError(status: status, code: "nope") }
        let repo = AssetLookupRepository(api: api, store: try await seeded())
        await #expect(throws: ApiError(status: status, code: "nope")) { try await repo.find(serial: "K1", value: "SN-100") }
        await #expect(throws: ApiError(status: status, code: "nope")) { try await repo.open(serial: "K1", id: "a1", offline: false, admin: true) }
    }

    @Test func offlineDetailCarriesSitesFromLabelContext() async throws {
        let d = try #require(try await AssetLookupRepository(api: offlineApi(), store: try await seeded())
            .open(serial: "K1", id: "a1", offline: false, admin: false).detail)
        #expect(d.routes.count == 1)
        let route = try #require(d.routes.first)
        #expect(route.initiativeId == "m1")
        #expect(route.initiativeName == "Move One")
        #expect(route.source.siteName == "Old DC")
        #expect(route.destination.siteName == "New DC")
        #expect(route.source.rack == "R12")
        #expect(route.destination.ru == "20")
    }

    @Test(arguments: ["null", "{not json", #"{"source_site":"","destination_site":5}"#])
    func blankOrUnreadableLabelContextGivesNoSites(context: String) async throws {
        let data = try await AssetLookupRepository(api: offlineApi(), store: try await seeded(labelContext: context)).loadLocal()
        #expect(data.sourceSite == nil)
        #expect(data.destinationSite == nil)
    }

    @Test func unknownIdOfflineIsNull() async throws {
        let opened = try await AssetLookupRepository(api: offlineApi(), store: try await seeded()).open(serial: "K1", id: "nope", offline: true, admin: true)
        #expect(opened.offline)
        #expect(opened.detail == nil)
    }

    @Test func loadLocalSkipsUndecodableRows() async throws {
        let data = try await AssetLookupRepository(api: offlineApi(), store: try await seeded()).loadLocal()
        #expect(data.assets.map(\.id) == ["a1"])
        #expect(data.containerNames["c1"] == "Crate 7")
        #expect(data.moveId == "m1" && data.moveName == "Move One")
    }

    @Test func scansUseTheLimitAndPropagateErrors() async throws {
        let api = FakeKioskApi()
        api.assetScansResult = { _, _, limit in
            #expect(limit == 50)
            return []
        }
        #expect(try await AssetLookupRepository(api: api, store: try await seeded()).scans(serial: "K1", id: "a1").isEmpty)
        #expect(api.calls == ["assetScans:a1"])
        await #expect(throws: ApiError.network()) {
            try await AssetLookupRepository(api: self.offlineApi(), store: try await self.seeded()).scans(serial: "K1", id: "a1")
        }
    }

    /// Reading and decoding every synced payload is work for the repository's own actor, not the
    /// caller's main actor, and happens only when the lookup actually falls back. (Android counts
    /// dispatcher hops; here the API calls are checked off main and the local reads counted.)
    @Test func offlineDecodeRunsOffTheCallersThread() async throws {
        let online = FakeKioskApi()
        online.lookupAssetsResult = { _, _ in KioskLookupResult() }
        let onlineRepo = AssetLookupRepository(api: online, store: try await seeded())
        _ = try await onlineRepo.find(serial: "K1", value: "SN-100")
        #expect(await onlineRepo.localLoads == 0, "an online answer decodes nothing")
        #expect(online.mainThreadCalls.isEmpty)

        let offline = offlineApi()
        let repo = AssetLookupRepository(api: offline, store: try await seeded())
        let found = try await repo.find(serial: "K1", value: "SN-100")
        #expect(found.result.matches.map(\.id) == ["a1"])
        #expect(await repo.localLoads == 1, "the fallback reads the synced move")
        #expect(offline.mainThreadCalls.isEmpty)
    }

    /// One offline lookup decodes once: the single match's open reuses what find loaded.
    @Test func anOfflineOpenReusesTheFindsData() async throws {
        let repo = AssetLookupRepository(api: offlineApi(), store: try await seeded())
        _ = try await repo.find(serial: "K1", value: "SN-100")
        let afterFind = await repo.localLoads
        let opened = try await repo.open(serial: "K1", id: "a1", offline: true, admin: false)
        #expect(opened.detail?.id == "a1")
        #expect(await repo.localLoads == afterFind, "no second decode")
        _ = try await repo.open(serial: "K1", id: "a1", offline: true, admin: false)
        #expect(await repo.localLoads > afterFind, "used once: a later open loads fresh")
    }

    @Test func nothingIsWrittenToTheOutbox() async throws {
        let store = try await seeded()
        let repo = AssetLookupRepository(api: offlineApi(), store: store)
        _ = try await repo.find(serial: "K1", value: "A-1")
        _ = try await repo.open(serial: "K1", id: "a1", offline: false, admin: true)
        _ = try await repo.loadLocal()
        #expect(try await store.outboxAll().isEmpty)
        #expect(try await store.assets().count == 2)
    }

    // MARK: offline with nothing synced (Review Focus 4)

    /// A kiosk with no synced move has nothing to search offline: the answer says so (Android's
    /// Scanning words), never "No asset matches".
    @Test func offlineWithNoSyncedMoveSaysSo() async throws {
        let empty = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        let found = try await AssetLookupRepository(api: offlineApi(), store: empty).find(serial: "K1", value: "102466")
        #expect(found.offline)
        #expect(found.noMoveData)
        #expect(found.result.matches.isEmpty)
        #expect(lookupOutcome(found, shown: "102466") == .miss("No move data on this kiosk. Sync from Kiosk Setup."))

        // Clear local data leaves nothing synced either.
        let store = try await seeded()
        try await store.clearLocalData()
        let cleared = try await AssetLookupRepository(api: offlineApi(), store: store).find(serial: "K1", value: "SN-100")
        #expect(lookupOutcome(cleared, shown: "SN-100") == .miss("No move data on this kiosk. Sync from Kiosk Setup."))
    }

    /// With a synced move, an offline miss is still a miss; online, an empty store never matters.
    @Test func aSyncedMoveOrAnOnlineAnswerMissesAsUsual() async throws {
        let found = try await AssetLookupRepository(api: offlineApi(), store: try await seeded()).find(serial: "K1", value: "nothing-like-it")
        #expect(found.offline && !found.noMoveData)
        #expect(lookupOutcome(found, shown: "nothing-like-it") == .miss("No asset matches nothing-like-it."))

        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult() }
        let empty = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        let online = try await AssetLookupRepository(api: api, store: empty).find(serial: "K1", value: "102466")
        #expect(!online.offline && !online.noMoveData)
        #expect(lookupOutcome(online, shown: "102466") == .miss("No asset matches 102466."))
    }

    /// Rows synced before the payload column (`{}`) can't be searched: that is nothing synced too,
    /// and a sync fixes it.
    @Test func onlyUndecodableRowsCountAsNothingSynced() async throws {
        let store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        try await store.replaceRoster(assets: [KioskAssetRow(id: "old", assetId: "1")], people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "m1", initiativeName: "Move", assets: 1, people: 0, containers: 0, trucks: 0, syncedAt: "x"))
        let found = try await AssetLookupRepository(api: offlineApi(), store: store).find(serial: "K1", value: "1")
        #expect(found.noMoveData)
    }
}
