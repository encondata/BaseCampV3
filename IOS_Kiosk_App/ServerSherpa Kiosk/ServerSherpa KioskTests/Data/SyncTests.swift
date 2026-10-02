import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct SyncTests {
    private let api: FakeKioskApi
    private let store: KioskStore

    init() throws {
        api = FakeKioskApi()
        // Android's fake answers every sync endpoint with an empty list by default.
        api.assets = { KioskAssetsSync(initiativeId: "i1", initiativeName: "Move A", generatedAt: "now") }
        api.people = { KioskPeopleSync(generatedAt: "now") }
        api.containers = { KioskContainersSync(initiativeId: "i1", generatedAt: "now") }
        api.trucks = { KioskTrucksSync(initiativeId: "i1", generatedAt: "now") }
        store = KioskStore(modelContainer: try KioskSchema.container(inMemory: true))
    }

    private func sync() -> Sync { Sync(api: api, store: store, clock: { 1_700_000_000_000 }) }

    private func assets(_ rows: [KioskAssetRow]) -> @Sendable () async throws -> KioskAssetsSync {
        { KioskAssetsSync(initiativeId: "i1", initiativeName: "Move A", generatedAt: "now", assets: rows) }
    }

    @Test func successReplacesTablesAndWritesMeta() async throws {
        api.assets = assets([KioskAssetRow(id: "a1", assetId: "A-1", makeModel: "X"), KioskAssetRow(id: "a2", assetId: "A-2", makeModel: "Y")])
        api.people = { KioskPeopleSync(generatedAt: "now", people: [KioskPersonRow(id: "p1", displayName: "Tina T", firstName: "Tina", lastName: "T")]) }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let st = s.status
        #expect(st.phase == .done); #expect(st.assets == 2); #expect(st.people == 1); #expect(st.containers == 0); #expect(st.trucks == 0)
        #expect(st.syncedAt == "2023-11-14T22:13:20Z")
        #expect(st.error == nil)
        #expect(try await store.counts().assets == 2)
        let meta = try await store.meta()
        #expect(meta?.initiativeName == "Move A"); #expect(meta?.assets == 2)
        #expect(s.rosterVersion == 1)
        // A second sync with fewer assets replaces, not appends.
        api.assets = assets([KioskAssetRow(id: "a9", assetId: "A-9", makeModel: "Z")])
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(try await store.assets().map(\.id) == ["a9"])
        #expect(s.rosterVersion == 2)
    }

    @Test func successCountsComeFromAllFourTables() async throws {
        api.assets = assets([KioskAssetRow(id: "a1")])
        api.people = { KioskPeopleSync(generatedAt: "now", people: [KioskPersonRow(id: "p1", displayName: "A"), KioskPersonRow(id: "p2", displayName: "B")]) }
        api.containers = { KioskContainersSync(initiativeId: "i1", generatedAt: "now", containers: [KioskContainerRow(id: "c1", name: "C1"), KioskContainerRow(id: "c2", name: "C2"), KioskContainerRow(id: "c3", name: "C3")]) }
        api.trucks = { KioskTrucksSync(initiativeId: "i1", generatedAt: "now", trucks: [KioskTruckRow(id: "t1", name: "T1")]) }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status == SyncStatus(phase: .done, assets: 1, people: 2, containers: 3, trucks: 1, syncedAt: "2023-11-14T22:13:20Z", error: nil))
        #expect(try await store.meta() == SyncMeta(initiativeId: "i1", initiativeName: "Move A", assets: 1, people: 2, containers: 3, trucks: 1, syncedAt: "2023-11-14T22:13:20Z"))
        #expect(Set(api.calls) == ["syncAssets", "syncPeople", "syncContainers", "syncTrucks"])
    }

    @Test func failedFetchLeavesTablesAndReportsCode() async throws {
        api.assets = assets([KioskAssetRow(id: "a1", assetId: "A-1", makeModel: "X")])
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let metaBefore = try await store.meta()
        api.people = { throw ApiError(status: 0, code: "network") }
        await s.runNow(initiativeId: "i1", initiativeName: "Move B")
        #expect(s.status.phase == .error)
        #expect(s.status.error == "network")
        #expect(s.status.assets == 1)          // previous counts kept
        #expect(try await store.counts().assets == 1)
        #expect(try await store.meta() == metaBefore)
        #expect(s.rosterVersion == 1)
    }

    @Test func nonApiFailureReportsUnknownError() async {
        struct Boom: Error {}
        api.trucks = { throw Boom() }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.phase == .error)
        #expect(s.status.error == "unknown_error")
        #expect(s.status.assets == nil)
    }

    @Test func runStartsInTheBackground() async {
        api.assets = assets([KioskAssetRow(id: "a1")])
        let s = sync()
        s.run(initiativeId: "i1", initiativeName: "Move A")
        await waitUntil { s.status.phase == .done }
        #expect(s.status.assets == 1)
    }

    @Test func supersededRunDoesNotOverwriteNewerRun() async throws {
        let gate = TickGate()
        let first = LockedFlag(true)
        api.assets = {
            if first.value {
                first.value = false
                try await gate.sleep(.zero)   // the older run stalls here
                return KioskAssetsSync(initiativeId: "old", initiativeName: "Old", generatedAt: "now", assets: [KioskAssetRow(id: "old1"), KioskAssetRow(id: "old2")])
            }
            return KioskAssetsSync(initiativeId: "new", initiativeName: "New", generatedAt: "now", assets: [KioskAssetRow(id: "new1")])
        }
        let s = sync()
        let older = Task { await s.runNow(initiativeId: "old", initiativeName: "Old") }
        await waitUntil { !first.value }
        await s.runNow(initiativeId: "new", initiativeName: "New")
        #expect(s.status.phase == .done); #expect(s.status.assets == 1)
        await gate.tick()
        await older.value
        #expect(s.status.phase == .done); #expect(s.status.assets == 1)
        #expect(try await store.assets().map(\.id) == ["new1"])
        #expect(try await store.meta()?.initiativeName == "New")
    }

    @Test func supersededFailureDoesNotOverwriteNewerRun() async throws {
        let gate = TickGate()
        let first = LockedFlag(true)
        api.people = {
            if first.value {
                first.value = false
                try await gate.sleep(.zero)
                throw ApiError(status: 0, code: "network")
            }
            return KioskPeopleSync(generatedAt: "now")
        }
        let s = sync()
        let older = Task { await s.runNow(initiativeId: "i1", initiativeName: "Move A") }
        await waitUntil { !first.value }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        await gate.tick()
        await older.value
        #expect(s.status.phase == .done)
        #expect(s.status.error == nil)
    }

    @Test func hydrateReadsMetaAndClearEmptiesMoveTablesOnly() async throws {
        api.assets = assets([KioskAssetRow(id: "a1", assetId: "A-1", makeModel: "X")])
        await sync().runNow(initiativeId: "i1", initiativeName: "Move A")
        try await store.outboxUpsert([OutboxMachine.newRow(EnqueueInput(scannedValue: "A-1", scanType: "barcode", asset: nil, siteId: "s", initiativeId: "i", scanStatus: "x"), clientScanId: "c1", seq: 1, nowMs: 0)])
        let fresh = sync()
        #expect(fresh.status.phase == .idle)
        await fresh.hydrate()
        #expect(fresh.status.phase == .done); #expect(fresh.status.assets == 1)
        #expect(fresh.status.syncedAt == "2023-11-14T22:13:20Z")
        try await fresh.clearLocalData()
        #expect(fresh.status == SyncStatus())
        #expect(fresh.rosterVersion == 1)
        #expect(try await store.counts().assets == 0)
        #expect(try await store.meta() == nil)
        #expect(try await store.outboxAll().count == 1)
    }

    @Test func hydrateWithoutMetaStaysIdle() async {
        let s = sync()
        await s.hydrate()
        #expect(s.status.phase == .idle)
    }

    @Test func formatSyncedAtShowsTheTimeAlone() {
        let utc = TimeZone(identifier: "UTC")!
        #expect(Sync.formatSyncedAt("2023-11-14T22:13:20Z", timeZone: utc) == "10:13 PM")
        #expect(Sync.formatSyncedAt("2023-11-14T09:05:00.123Z", timeZone: utc) == "9:05 AM")
        #expect(Sync.formatSyncedAt("2023-11-14T00:00:00Z", timeZone: utc) == "12:00 AM")
        #expect(Sync.formatSyncedAt("not a date") == "not a date")
    }
}
