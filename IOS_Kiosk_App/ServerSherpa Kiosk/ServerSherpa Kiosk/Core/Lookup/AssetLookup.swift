import Foundation

// Port of Android `core/lookup/AssetLookup.kt` (itself kiosk/src/lib/assetLookup.ts): the offline
// half of Asset Lookup, plus the rules the screen reads. Read-only: nothing here records a scan.

/// The most matches a lookup returns (`truncated` past it), as the server.
let LOOKUP_CAP = 25
/// The scan history's length: the newest 50.
let SCAN_LIMIT = 50

/// Asset Lookup's words, Android's exactly (`AssetLookupViewModel.kt`, `AssetLookupScreen.kt`).
enum LookupCopy {
    static func miss(_ value: String) -> String { "No asset matches \(value)." }
    static let offlineNotice = "Offline — showing this move's devices only."
    /// Offline with no synced move to search: Android's Scanning words (`NO_MOVE_DATA`).
    static let noMoveData = "No move data on this kiosk. Sync from Kiosk Setup."
    static let scansOffline = "Scan history needs a connection."
    static let lookupError = "Couldn't look that up. Try again."
    static let loadError = "Couldn't load that asset."
}

/// The synced asset fields this file reads, decoded from the stored `/kiosk/sync/assets` row
/// (`KioskStore.assetPayloads()`). Unknown keys are ignored.
struct LocalAsset: Decodable, Equatable, Sendable {
    var id: String
    var assetId: String = ""
    var name: String?
    var rfid: String?
    var serialNumber: String?
    var make: String?
    var model: String?
    var makeModel: String = ""
    var containerId: String?
    var sourceRack: String?
    var sourceRu: String?
    var sourcePosition: String?
    var sourcePod: String?
    var destinationRack: String?
    var destinationRu: String?
    var destinationPosition: String?
    var destinationPod: String?
    var assetStatus: String?
    var assetStatusLabel: String?
    var locationDetail: String?

    enum CodingKeys: String, CodingKey {
        case id, name, rfid, make, model
        case assetId = "asset_id"
        case serialNumber = "serial_number"
        case makeModel = "make_model"
        case containerId = "container_id"
        case sourceRack = "source_rack"
        case sourceRu = "source_ru"
        case sourcePosition = "source_position"
        case sourcePod = "source_pod"
        case destinationRack = "destination_rack"
        case destinationRu = "destination_ru"
        case destinationPosition = "destination_position"
        case destinationPod = "destination_pod"
        case assetStatus = "asset_status"
        case assetStatusLabel = "asset_status_label"
        case locationDetail = "location_detail"
    }
}

extension LocalAsset {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        assetId = try c.decodeIfPresent(String.self, forKey: .assetId) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name)
        rfid = try c.decodeIfPresent(String.self, forKey: .rfid)
        serialNumber = try c.decodeIfPresent(String.self, forKey: .serialNumber)
        make = try c.decodeIfPresent(String.self, forKey: .make)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        makeModel = try c.decodeIfPresent(String.self, forKey: .makeModel) ?? ""
        containerId = try c.decodeIfPresent(String.self, forKey: .containerId)
        sourceRack = try c.decodeIfPresent(String.self, forKey: .sourceRack)
        sourceRu = try c.decodeIfPresent(String.self, forKey: .sourceRu)
        sourcePosition = try c.decodeIfPresent(String.self, forKey: .sourcePosition)
        sourcePod = try c.decodeIfPresent(String.self, forKey: .sourcePod)
        destinationRack = try c.decodeIfPresent(String.self, forKey: .destinationRack)
        destinationRu = try c.decodeIfPresent(String.self, forKey: .destinationRu)
        destinationPosition = try c.decodeIfPresent(String.self, forKey: .destinationPosition)
        destinationPod = try c.decodeIfPresent(String.self, forKey: .destinationPod)
        assetStatus = try c.decodeIfPresent(String.self, forKey: .assetStatus)
        assetStatusLabel = try c.decodeIfPresent(String.self, forKey: .assetStatusLabel)
        locationDetail = try c.decodeIfPresent(String.self, forKey: .locationDetail)
    }
}

/// What an offline lookup searches: the move's synced assets, the containers' names by id, the
/// move, and its two sites from the stored label context.
struct LocalLookupData: Equatable, Sendable {
    var assets: [LocalAsset]
    var containerNames: [String: String]
    var moveId: String
    var moveName: String
    var sourceSite: String?
    var destinationSite: String?
}

/// A lookup's answer (Android `Found`). `noMoveData`: offline, and the kiosk holds no synced
/// asset to search (never synced, cleared, or only rows from before payloads were stored).
struct LookupFound: Equatable, Sendable {
    var offline: Bool
    var result: KioskLookupResult
    var noMoveData: Bool = false
}

/// An opened asset (Android `Opened`): nil when an offline open finds no such synced asset.
struct LookupOpened: Equatable, Sendable {
    var offline: Bool
    var detail: KioskAssetDetail?
}

/// What a lookup's answer shows (Android's view model `find`).
enum LookupOutcome: Equatable, Sendable {
    /// One match: its card opens.
    case open(id: String)
    /// Several: the list, at most `LOOKUP_CAP`, "Refine your search" when truncated.
    case list(KioskLookupResult)
    /// None: the value stays in the box and this line says so.
    case miss(String)
}

/// One match opens, several list, none misses. A miss offline with nothing synced says there is
/// no move data to search rather than "No asset matches" (`shown`: the value as the box shows it).
func lookupOutcome(_ found: LookupFound, shown: String) -> LookupOutcome {
    let matches = found.result.matches
    if matches.count == 1 { return .open(id: matches[0].id) }
    if matches.count > 1 { return .list(found.result) }
    return .miss(found.offline && found.noMoveData ? LookupCopy.noMoveData : LookupCopy.miss(shown))
}

func matchLabel(_ kind: String) -> String {
    switch kind {
    case "asset_tag": "Asset tag"
    case "serial": "Serial"
    case "rfid": "RFID"
    case "name": "Name"
    default: kind
    }
}

/// The list's "Matched on" column shows only when some match isn't by name.
func showsMatchedOn(_ matches: [KioskLookupMatch]) -> Bool {
    matches.contains { m in m.matched.contains { $0 != "name" } }
}

/// "Asset tag, RFID": the keys one match hit.
func matchedOnText(_ match: KioskLookupMatch) -> String {
    match.matched.map(matchLabel).joined(separator: ", ")
}

/// The scan history is asked for only online, for an admin's card (`full`) of a device on a move,
/// and only with `scans:view`.
func wantsScanHistory(_ detail: KioskAssetDetail, offline: Bool, canViewScans: Bool) -> Bool {
    guard let full = detail.full else { return false }
    return !full.moves.isEmpty && !offline && canViewScans
}

/// An asset tag is matched only as plain ASCII digits with no leading zero, at most 18 of them
/// (the server's rule).
private func isTagValue(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard let first = bytes.first, bytes.count <= 18, first >= 0x31, first <= 0x39 else { return false }
    return bytes.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
}

private func toMatch(_ a: LocalAsset, _ matched: [String]) -> KioskLookupMatch {
    KioskLookupMatch(id: a.id, name: a.name, assetTag: a.assetId, serialNumber: a.serialNumber, matched: matched)
}

/// The server's lookup over the synced assets: the value (trimmed) against the asset tag, the
/// serial (ignoring case and spaces around it) and the RFID (both padded to 24) at once; exact
/// hits sorted naturally by name then asset tag; else a part-name match sorted by name. At most
/// `LOOKUP_CAP`, `truncated` when more matched.
func matchLocal(_ assets: [LocalAsset], _ raw: String) -> KioskLookupResult {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty { return KioskLookupResult() }
    let wantTag = isTagValue(value)
    let lowered = value.lowercased()
    let rfid = padRfid(value).tag

    var exact: [KioskLookupMatch] = []
    for a in assets {
        var kinds: [String] = []
        if wantTag && a.assetId == value { kinds.append("asset_tag") }
        if let sn = a.serialNumber, !sn.isEmpty, sn.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == lowered {
            kinds.append("serial")
        }
        if let rfid, let ar = a.rfid, !ar.isEmpty, padRfid(ar).tag == rfid { kinds.append("rfid") }
        if !kinds.isEmpty { exact.append(toMatch(a, kinds)) }
    }
    if !exact.isEmpty {
        let sorted = exact.sorted { x, y in
            let c = naturalCompare(x.name, y.name)
            return c != 0 ? c < 0 : naturalCompare(x.assetTag, y.assetTag) < 0
        }
        return KioskLookupResult(matches: Array(sorted.prefix(LOOKUP_CAP)), truncated: sorted.count > LOOKUP_CAP)
    }

    let named = assets
        .filter { $0.name?.range(of: value, options: .caseInsensitive) != nil }
        .sorted { naturalCompare($0.name, $1.name) < 0 }
        .map { toMatch($0, ["name"]) }
    return KioskLookupResult(matches: Array(named.prefix(LOOKUP_CAP)), truncated: named.count > LOOKUP_CAP)
}

/// The card offline, from a synced asset: identity and the synced move's route for everyone; for
/// an admin also the synced status (no color), the synced move (no status), the container's name
/// and the location text. Offline there is no truck.
func localDetail(_ asset: LocalAsset, _ data: LocalLookupData, admin: Bool) -> KioskAssetDetail {
    KioskAssetDetail(
        id: asset.id, name: asset.name, make: asset.make, model: asset.model, makeModel: asset.makeModel,
        assetTag: asset.assetId, serialNumber: asset.serialNumber, rfid: asset.rfid,
        routes: [KioskAssetRoute(
            initiativeId: data.moveId, initiativeName: data.moveName,
            source: KioskAssetEnd(siteName: data.sourceSite, pod: asset.sourcePod, rack: asset.sourceRack,
                                  ru: asset.sourceRu, position: asset.sourcePosition),
            destination: KioskAssetEnd(siteName: data.destinationSite, pod: asset.destinationPod, rack: asset.destinationRack,
                                       ru: asset.destinationRu, position: asset.destinationPosition))],
        full: admin ? KioskAssetFull(
            status: asset.assetStatus ?? "", statusLabel: asset.assetStatusLabel ?? "", statusColor: "",
            // the synced move, the only one known offline; it has no status
            moves: data.moveId.isEmpty ? [] : [KioskAssetMove(initiativeId: data.moveId, initiativeName: data.moveName)],
            containerName: asset.containerId.flatMap { data.containerNames[$0] },
            truckName: nil,
            locationDetail: asset.locationDetail ?? "") : nil)
}

/// "<container> · on <truck>", the container alone, else the location text.
func placementText(_ full: KioskAssetFull) -> String {
    if let c = full.containerName, !c.isEmpty {
        if let t = full.truckName, !t.isEmpty { return "\(c) · on \(t)" }
        return c
    }
    return full.locationDetail
}

/// A scan time, 24-hour (`yyyy-MM-dd HH:mm`) in `zone`; the raw value when it doesn't parse.
/// Fractional seconds of any length are accepted (the server sends microseconds).
func scanWhenText(_ iso: String, zone: TimeZone) -> String {
    let whole = iso.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
    guard let date = parseInstant(iso) ?? parseInstant(whole) else { return iso }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = zone
    f.dateFormat = "yyyy-MM-dd HH:mm"
    return f.string(from: date)
}
