import Foundation

/// Asset Lookup's data (Android `data/lookup/AssetLookupRepository.kt`): ask the API first; when
/// the network can't be reached, fall back to the move's synced assets in `KioskStore`. Only a
/// network failure (or the edge's `edge_offline`) falls back; every other error propagates.
/// Nothing here writes anything: no outbox, no scan.
///
/// An actor, so the API calls and the fallback's decode of every synced payload run on its own
/// executor, never on the caller's main actor. The open right after an offline find reuses what
/// that find loaded, once.
actor AssetLookupRepository {
    private let api: KioskApi
    private let store: KioskStore
    /// What the last offline `find` loaded, for the `open` that follows it. Used once.
    private var lastLocal: LocalLookupData?
    /// How many times the synced move was read and decoded (tests check the reuse).
    private(set) var localLoads = 0

    init(api: KioskApi, store: KioskStore) {
        self.api = api
        self.store = store
    }

    private static func isOffline(_ e: ApiError) -> Bool { e.isNetwork || e.code == "edge_offline" }

    /// Looks `value` up. Offline, the synced move is searched by the same rules, and `noMoveData`
    /// says when there was nothing synced to search.
    func find(serial: String, value: String) async throws -> LookupFound {
        lastLocal = nil
        do {
            return LookupFound(offline: false, result: try await api.lookupAssets(serial: serial, value: value))
        } catch let e as ApiError where Self.isOffline(e) {
            let data = try await loadLocal()
            lastLocal = data
            return LookupFound(offline: true, result: matchLocal(data.assets, value), noMoveData: data.assets.isEmpty)
        }
    }

    /// Opens one match. `offline` (the find was answered offline) skips the API; online, a network
    /// failure falls back too. `admin` decides the offline card's admin part (the API decides it
    /// online). A synced asset that isn't there is a nil detail.
    func open(serial: String, id: String, offline: Bool, admin: Bool) async throws -> LookupOpened {
        if !offline {
            do {
                return LookupOpened(offline: false, detail: try await api.assetDetail(serial: serial, assetId: id))
            } catch let e as ApiError where Self.isOffline(e) {}
        }
        let data: LocalLookupData
        if let last = lastLocal {
            lastLocal = nil
            data = last
        } else {
            data = try await loadLocal()
        }
        let asset = data.assets.first { $0.id == id }
        return LookupOpened(offline: true, detail: asset.map { localDetail($0, data, admin: admin) })
    }

    /// The newest `SCAN_LIMIT` scans. Online only: every error propagates (the screen says the
    /// history needs a connection when the card is offline, and never asks then).
    func scans(serial: String, id: String) async throws -> [AssetScanRow] {
        try await api.assetScans(serial: serial, assetId: id, limit: SCAN_LIMIT)
    }

    /// The synced move as an offline lookup searches it. Payloads that don't decode (including the
    /// `{}` of rows stored before payloads were) are skipped; the sites come from the stored label
    /// context, nil when it is missing, unreadable or blank.
    func loadLocal() async throws -> LocalLookupData {
        let snap = try await store.lookupSnapshot()
        localLoads += 1
        let assets = snap.payloads.compactMap { try? KioskJSON.decoder.decode(LocalAsset.self, from: Data($0.json.utf8)) }
        let context = snap.labelContext
            .flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8), options: [.fragmentsAllowed]) } as? [String: Any]
        func text(_ key: String) -> String? { (context?[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        return LocalLookupData(assets: assets, containerNames: snap.containerNames,
                               moveId: snap.meta?.initiativeId ?? "", moveName: snap.meta?.initiativeName ?? "",
                               sourceSite: text("source_site"), destinationSite: text("destination_site"))
    }
}
