import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Android AssetLookupViewModelTest, case for case without the sled's sweeps, plus the iOS states:
/// searching, offline with nothing synced, the scan history that needs a connection, and the scan
/// rows formatted once when they load. The view model runs on the real repository over the fake
/// API and an in-memory store, as Android's does.
// The fake's answers (nonisolated: the fake calls them off the main actor).
private func one(_ id: String) -> KioskLookupResult { KioskLookupResult(matches: [KioskLookupMatch(id: id, name: "Asset \(id)", assetTag: "T-\(id)")]) }
private func detail(_ id: String, full: KioskAssetFull? = nil) -> KioskAssetDetail {
    KioskAssetDetail(id: id, name: "Asset \(id)", assetTag: "T-\(id)", full: full)
}
private let onMove = KioskAssetFull(moves: [KioskAssetMove(initiativeId: "m1", initiativeName: "Move One")])
private func row(_ id: String) -> AssetScanRow { AssetScanRow(id: id, scannedAt: "2026-11-10T12:00:00Z") }

@MainActor
struct AssetLookupViewModelTests {
    private let payload = #"{"id":"a1","asset_id":"A-1","name":"Core switch","serial_number":"SN-100","make_model":"Dell R740","source_rack":"R12","destination_rack":"R40"}"#
    private let payload2 = #"{"id":"a2","asset_id":"A-2","name":"Core router","serial_number":"SN-200","make_model":"Cisco"}"#

    private struct Built {
        let vm: AssetLookupViewModel
        let store: KioskStore
    }

    /// A kiosk with Move One synced (two assets), unless `synced` is false.
    private func build(_ api: FakeKioskApi, admin: Bool = false, scans: Bool = false, synced: Bool = true) async throws -> Built {
        let store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        if synced {
            try await store.replaceRoster(
                assets: [
                    KioskAssetRow(id: "a1", assetId: "A-1", name: "Core switch", serialNumber: "SN-100", makeModel: "Dell R740"),
                    KioskAssetRow(id: "a2", assetId: "A-2", name: "Core router", serialNumber: "SN-200", makeModel: "Cisco"),
                ],
                people: [], containers: [], trucks: [],
                meta: SyncMeta(initiativeId: "m1", initiativeName: "Move One", assets: 2, people: 0, containers: 0, trucks: 0,
                               syncedAt: "2026-11-10T00:00:00Z"),
                payloads: [payload, payload2])
        }
        let vm = AssetLookupViewModel(source: AssetLookupRepository(api: api, store: store), serial: { "K1" },
                                      isAdmin: { admin }, canViewScans: { scans }, zone: TimeZone(identifier: "UTC")!)
        return Built(vm: vm, store: store)
    }

    private func count(_ api: FakeKioskApi, _ prefix: String) -> Int { api.calls.filter { $0.hasPrefix(prefix) }.count }

    /// A gate that holds the named lookup calls until `open()`.
    private func hold(_ api: FakeKioskApi, _ names: Set<String>) -> HoldGate {
        let gate = HoldGate()
        api.lookupGate = { name in if names.contains(name) { await gate.wait() } }
        return gate
    }

    // MARK: idle and searching

    @Test func startsIdle() async throws {
        let api = FakeKioskApi()
        let b = try await build(api)
        #expect(b.vm.ui == LookupUi())
        #expect(!b.vm.ui.searching)
        #expect(api.calls.isEmpty)
    }

    /// While the lookup is out the screen says it is searching, with nothing else on it; the box
    /// has emptied for the next scan.
    @Test func searchingWhileTheLookupIsOut() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult(matches: [KioskLookupMatch(id: "x1")]) }
        api.assetDetailResult = { _, id in KioskAssetDetail(id: id) }
        let gate = hold(api, ["lookupAssets:A-1"])
        let b = try await build(api)
        b.vm.onScan("A-1")
        #expect(await waitUntil { api.calls.contains("lookupAssets:A-1") })
        #expect(b.vm.ui == LookupUi(searching: true))
        await gate.open()
        await b.vm.settle()
        #expect(!b.vm.ui.searching)
        #expect(b.vm.ui.detail?.id == "x1")
    }

    /// A pick keeps the list and searches for the card.
    @Test func searchingWhileAPickIsOut() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult(matches: [KioskLookupMatch(id: "x1"), KioskLookupMatch(id: "x2")]) }
        api.assetDetailResult = { _, id in KioskAssetDetail(id: id) }
        let gate = hold(api, ["assetDetail:x2"])
        let b = try await build(api)
        b.vm.onScan("x")
        await b.vm.settle()
        b.vm.pick("x2")
        #expect(await waitUntil { api.calls.contains("assetDetail:x2") })
        #expect(b.vm.ui.searching)
        #expect(b.vm.ui.list?.matches.count == 2)
        #expect(b.vm.ui.detail == nil)
        await gate.open()
        await b.vm.settle()
        #expect(!b.vm.ui.searching)
        #expect(b.vm.ui.detail?.id == "x2")
    }

    // MARK: one, many, none

    @Test func oneMatchOpensDetail() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("x1") }
        api.assetDetailResult = { _, id in detail(id) }
        let b = try await build(api)
        b.vm.onScan("A-1")
        await b.vm.settle()
        let ui = b.vm.ui
        #expect(ui.detail?.id == "x1")
        #expect(ui.value == "")
        #expect(ui.list == nil && ui.miss == nil && ui.error == nil)
        #expect(!ui.offline)
        #expect(ui.scans == .hidden)
        #expect(api.calls == ["lookupAssets:A-1", "assetDetail:x1"])
        #expect(try await b.store.outboxAll().isEmpty)
    }

    @Test func severalMatchesShowList() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in
            KioskLookupResult(matches: [KioskLookupMatch(id: "x1", name: "One"), KioskLookupMatch(id: "x2", name: "Two")])
        }
        api.assetDetailResult = { _, id in detail(id) }
        let b = try await build(api)
        b.vm.onValueChange("core")
        b.vm.lookup()
        await b.vm.settle()
        #expect(b.vm.ui.list?.matches.map(\.id) == ["x1", "x2"])
        #expect(b.vm.ui.detail == nil)
        #expect(count(api, "assetDetail") == 0)

        b.vm.pick("x2")
        await b.vm.settle()
        #expect(b.vm.ui.detail?.id == "x2")
        #expect(b.vm.ui.list?.matches.count == 2, "the list stays, as on the web")
        #expect(api.calls.last == "assetDetail:x2")
    }

    /// A pick opens with the offline flag the list came with: offline, no API detail call.
    @Test func pickFromAnOfflineListUsesSyncedRows() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError.network() }
        api.assetDetailResult = { _, id in detail(id) }
        let b = try await build(api)
        b.vm.onScan("core")
        await b.vm.settle()
        #expect(b.vm.ui.offline)
        #expect(b.vm.ui.list?.matches.map(\.id) == ["a2", "a1"])
        b.vm.pick("a1")
        await b.vm.settle()
        #expect(b.vm.ui.detail?.name == "Core switch")
        #expect(b.vm.ui.offline)
        #expect(count(api, "assetDetail") == 0)
    }

    @Test func noMatchKeepsValueAndSaysSo() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult() }
        let b = try await build(api)
        let restores = b.vm.restoreCount
        b.vm.onScan("zz-9")
        await b.vm.settle()
        #expect(b.vm.ui.miss == "No asset matches zz-9.")
        #expect(b.vm.ui.value == "zz-9")
        #expect(b.vm.ui.error == nil)
        #expect(b.vm.restoreCount == restores + 1, "the value goes back selected, so the next scan replaces it")
    }

    /// Text typed while a lookup is out stays in the box when the list (or the card) lands.
    @Test func aListAnswerKeepsWhatWasTypedMeanwhile() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, v in
            v == "core" ? KioskLookupResult(matches: [KioskLookupMatch(id: "x1"), KioskLookupMatch(id: "x2")]) : one("x9")
        }
        api.assetDetailResult = { _, id in detail(id) }
        let gate = hold(api, ["lookupAssets:core", "lookupAssets:A-9"])
        let b = try await build(api)
        b.vm.onScan("core")
        #expect(await waitUntil { api.calls.contains("lookupAssets:core") })
        b.vm.onValueChange("A-1")
        await gate.open()
        await b.vm.settle()
        #expect(b.vm.ui.list?.matches.count == 2)
        #expect(b.vm.ui.value == "A-1")

        b.vm.onScan("A-9")
        b.vm.onValueChange("B-2")
        await b.vm.settle()
        #expect(b.vm.ui.detail?.id == "x9")
        #expect(b.vm.ui.value == "B-2")
    }

    @Test func lookupTrimsTheBox() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult() }
        let b = try await build(api)
        b.vm.onValueChange("  A-1 ")
        b.vm.lookup()
        await b.vm.settle()
        #expect(api.calls == ["lookupAssets:A-1"])
        #expect(b.vm.ui.value == "A-1")
    }

    // MARK: offline

    @Test func offlineFindsOnTheSyncedMove() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError.network() }
        let b = try await build(api)
        b.vm.onScan("SN-100")
        await b.vm.settle()
        #expect(b.vm.ui.offline)
        #expect(b.vm.ui.detail?.id == "a1")
        #expect(b.vm.ui.detail?.routes.first?.source.rack == "R12")
        #expect(b.vm.ui.detail?.full == nil, "a worker's card offline has no admin part")
        #expect(b.vm.ui.scans == .hidden)
        #expect(count(api, "assetDetail") == 0)
        #expect(try await b.store.outboxAll().isEmpty)
    }

    /// Offline with nothing synced there is nothing to search: it says so, and keeps the value.
    @Test func offlineWithNothingSyncedSaysThereIsNoMoveData() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError.network() }
        let b = try await build(api, synced: false)
        b.vm.onScan("102466")
        await b.vm.settle()
        #expect(b.vm.ui.offline)
        #expect(b.vm.ui.miss == "No move data on this kiosk. Sync from Kiosk Setup.")
        #expect(b.vm.ui.value == "102466")
    }

    /// Offline, an admin still gets the full card; with scans:view the history says it needs a
    /// connection, and no history call is made.
    @Test func offlineAdminCardSaysScansNeedAConnection() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError.network() }
        api.assetScansResult = { _, _, _ in [row("s1")] }
        let b = try await build(api, admin: true, scans: true)
        b.vm.onScan("SN-100")
        await b.vm.settle()
        let ui = b.vm.ui
        #expect(ui.offline)
        #expect(ui.detail?.id == "a1")
        #expect(ui.detail?.full?.moves.map(\.initiativeName) == ["Move One"])
        #expect(ui.scans == .needsConnection)
        #expect(count(api, "assetScans") == 0)
    }

    /// Offline without scans:view there is no history line at all.
    @Test func offlineAdminWithoutScansViewHasNoHistoryLine() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError.network() }
        let b = try await build(api, admin: true, scans: false)
        b.vm.onScan("SN-100")
        await b.vm.settle()
        #expect(b.vm.ui.detail?.full != nil)
        #expect(b.vm.ui.scans == .hidden)
    }

    // MARK: errors

    @Test func errorKeepsValue() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in throw ApiError(status: 500, code: "boom") }
        let b = try await build(api)
        let restores = b.vm.restoreCount
        b.vm.onScan("A-1")
        await b.vm.settle()
        #expect(b.vm.ui.error == "Couldn't look that up. Try again.")
        #expect(b.vm.ui.value == "A-1")
        #expect(b.vm.ui.miss == nil)
        #expect(!b.vm.ui.searching)
        #expect(b.vm.restoreCount == restores + 1)
    }

    /// The lookup finds it online, the details call drops off the network, and the synced copy
    /// doesn't have it: "Couldn't load that asset."
    @Test func missingDetailSaysCouldNotLoad() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("gone") }
        api.assetDetailResult = { _, _ in throw ApiError.network() }
        let b = try await build(api)
        b.vm.onScan("gone")
        await b.vm.settle()
        #expect(b.vm.ui.error == "Couldn't load that asset.")
        #expect(b.vm.ui.offline)
        #expect(b.vm.ui.detail == nil)
        #expect(!b.vm.ui.searching)
    }

    @Test func pickErrorSaysCouldNotLookUp() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult(matches: [KioskLookupMatch(id: "x1"), KioskLookupMatch(id: "x2")]) }
        api.assetDetailResult = { _, _ in throw ApiError(status: 500, code: "boom") }
        let b = try await build(api)
        b.vm.onScan("x")
        await b.vm.settle()
        b.vm.pick("x1")
        await b.vm.settle()
        #expect(b.vm.ui.error == "Couldn't look that up. Try again.")
        #expect(b.vm.ui.detail == nil)
        #expect(b.vm.ui.list?.matches.count == 2)
        #expect(!b.vm.ui.searching)
    }

    // MARK: the newer lookup wins

    @Test func newerLookupWins() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, v in v == "first" ? one("old") : one("new") }
        api.assetDetailResult = { _, id in detail(id) }
        let gate = hold(api, ["lookupAssets:first"])
        let b = try await build(api)
        b.vm.onScan("first")
        #expect(await waitUntil { api.calls.contains("lookupAssets:first") })
        b.vm.onScan("second")
        #expect(await waitUntil { b.vm.ui.detail?.id == "new" })
        await gate.open()
        await b.vm.settle()
        #expect(b.vm.ui.detail?.id == "new")
        #expect(!api.calls.contains("assetDetail:old"))
        #expect(b.vm.ui.error == nil)
        #expect(!b.vm.ui.searching)
    }

    /// A slow first card never replaces the card of a newer pick.
    @Test func newerPickWins() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in KioskLookupResult(matches: [KioskLookupMatch(id: "x1"), KioskLookupMatch(id: "x2")]) }
        api.assetDetailResult = { _, id in detail(id) }
        let gate = hold(api, ["assetDetail:x1"])
        let b = try await build(api)
        b.vm.onScan("x")
        await b.vm.settle()
        b.vm.pick("x1")
        #expect(await waitUntil { api.calls.contains("assetDetail:x1") })
        b.vm.pick("x2")
        #expect(await waitUntil { b.vm.ui.detail?.id == "x2" })
        await gate.open()
        await b.vm.settle()
        #expect(b.vm.ui.detail?.id == "x2")
    }

    @Test func clearDropsInFlightAnswer() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("x1") }
        api.assetDetailResult = { _, id in detail(id) }
        let gate = hold(api, ["lookupAssets:A-1"])
        let b = try await build(api)
        b.vm.onScan("A-1")
        #expect(await waitUntil { api.calls.contains("lookupAssets:A-1") })
        b.vm.clear()
        await gate.open()
        await b.vm.settle()
        #expect(b.vm.ui == LookupUi())
        #expect(count(api, "assetDetail") == 0)
    }

    @Test func clearEmptiesAShownCard() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("x1") }
        api.assetDetailResult = { _, id in detail(id) }
        let b = try await build(api)
        b.vm.onScan("A-1")
        await b.vm.settle()
        #expect(b.vm.ui.detail != nil)
        b.vm.clear()
        #expect(b.vm.ui == LookupUi())
    }

    // MARK: admin extras and the scans gate

    @Test(arguments: [
        ("worker", false, false, false, 0),
        ("admin without scans:view", true, false, true, 0),
        ("admin on no move", true, true, false, 0),
        ("admin + scans:view + move", true, true, true, 1),
    ])
    func scansOnlyForAdminWithScansViewOnMovedDevice(name: String, admin: Bool, scans: Bool, moved: Bool, calls: Int) async throws {
        let full: KioskAssetFull? = admin ? (moved ? onMove : KioskAssetFull()) : nil
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("x1") }
        api.assetDetailResult = { _, id in detail(id, full: full) }
        api.assetScansResult = { _, _, limit in
            #expect(limit == 50)
            return [row("s1"), row("s2")]
        }
        let b = try await build(api, admin: admin, scans: scans)
        b.vm.onScan("A-1")
        await b.vm.settle()
        #expect(b.vm.ui.detail?.id == "x1", "\(name)")
        #expect(b.vm.ui.detail?.full == full, "\(name): the card carries what the API sent")
        #expect(count(api, "assetScans") == calls, "\(name)")
        if calls == 1 {
            guard case .rows(let rows) = b.vm.ui.scans else { Issue.record("\(name): \(b.vm.ui.scans)"); return }
            #expect(rows.map(\.id) == ["s1", "s2"])
        } else {
            #expect(b.vm.ui.scans == .hidden, "\(name)")
        }
    }

    /// The rows are formatted once, when they load: the time is the 24-hour text, blanks are "—".
    @Test func scanRowsAreFormattedWhenTheyLoad() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("x1") }
        api.assetDetailResult = { _, id in detail(id, full: onMove) }
        api.assetScansResult = { _, _, _ in
            [AssetScanRow(id: "s1", scanTypeLabel: "Barcode", scanTypeColor: "#3366ff", status: "packed", statusLabel: "Packed",
                          statusColor: "#22aa55", scannedAt: "2026-11-08T21:05:00Z", deviceId: "K-1", operatorName: "Person A",
                          siteName: "Site A", offMove: true),
             AssetScanRow(id: "s2", scannedAt: "2026-11-08T07:04:00.123456Z")]
        }
        let b = try await build(api, admin: true, scans: true)
        b.vm.onScan("A-1")
        await b.vm.settle()
        guard case .rows(let rows) = b.vm.ui.scans else { Issue.record("\(b.vm.ui.scans)"); return }
        #expect(rows == [
            LookupScanLine(id: "s1", status: "Packed", statusColor: "#22aa55", offMove: true, when: "2026-11-08 21:05",
                           method: "Barcode", methodColor: "#3366ff", device: "K-1", operatorName: "Person A", site: "Site A"),
            LookupScanLine(id: "s2", status: nil, statusColor: nil, offMove: false, when: "2026-11-08 07:04",
                           method: nil, methodColor: "", device: "—", operatorName: "—", site: "—"),
        ])
    }

    @Test func scanFailureShowsFailed() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, _ in one("x1") }
        api.assetDetailResult = { _, id in detail(id, full: onMove) }
        api.assetScansResult = { _, _, _ in throw ApiError(status: 500, code: "boom") }
        let b = try await build(api, admin: true, scans: true)
        b.vm.onScan("A-1")
        await b.vm.settle()
        #expect(b.vm.ui.scans == .failed)
        #expect(b.vm.ui.detail?.id == "x1")
        #expect(b.vm.ui.error == nil)
    }

    @Test func scanHistoryShowsLoadingThenDropsWhenStale() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, v in one(v) }
        api.assetDetailResult = { _, id in detail(id, full: id == "x1" ? onMove : nil) }
        api.assetScansResult = { _, _, _ in [row("s1")] }
        let gate = hold(api, ["assetScans:x1"])
        let b = try await build(api, admin: true, scans: true)
        b.vm.onScan("x1")
        #expect(await waitUntil { api.calls.contains("assetScans:x1") })
        #expect(b.vm.ui.scans == .loading)
        #expect(!b.vm.ui.searching, "the card is up; only its history is loading")
        b.vm.onScan("x2")
        #expect(await waitUntil { b.vm.ui.detail?.id == "x2" })
        await gate.open()
        await b.vm.settle()
        #expect(b.vm.ui.detail?.id == "x2")
        #expect(b.vm.ui.scans == .hidden)
    }

    // MARK: no-ops

    @Test func blankLookupIsNoOp() async throws {
        let api = FakeKioskApi()
        let b = try await build(api)
        b.vm.onValueChange("   ")
        b.vm.lookup()
        await b.vm.settle()
        #expect(api.calls.isEmpty)
        #expect(b.vm.ui.value == "   ")
        #expect(b.vm.ui.error == nil && !b.vm.ui.searching)
    }

    /// Nothing the screen does records a scan.
    @Test func nothingReachesTheOutbox() async throws {
        let api = FakeKioskApi()
        api.lookupAssetsResult = { _, v in v == "core" ? KioskLookupResult(matches: [KioskLookupMatch(id: "x1"), KioskLookupMatch(id: "x2")]) : one("x1") }
        api.assetDetailResult = { _, id in detail(id, full: onMove) }
        api.assetScansResult = { _, _, _ in [row("s1")] }
        let b = try await build(api, admin: true, scans: true)
        b.vm.onScan("A-1"); await b.vm.settle()
        b.vm.onScan("core"); await b.vm.settle()
        b.vm.pick("x2"); await b.vm.settle()
        b.vm.clear()
        #expect(try await b.store.outboxAll().isEmpty)
    }
}
