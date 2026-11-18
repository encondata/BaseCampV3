import Foundation

// The /kiosk/assets/* Asset Lookup payloads (Android `core/model/Lookup.kt`). Each decoder fills
// Android's defaults for a missing member; the decoders live in extensions so the memberwise
// initializers stay.

/// One candidate in `GET /kiosk/assets/lookup`. `matched` names the keys the value hit, in the
/// order asset tag, serial, RFID, or just "name" for a part-name hit.
struct KioskLookupMatch: Codable, Equatable, Sendable {
    var id: String
    var name: String?
    /// The human Asset ID as text, "" when unset.
    var assetTag: String = ""
    var serialNumber: String?
    var matched: [String] = []

    enum CodingKeys: String, CodingKey {
        case id, name, matched
        case assetTag = "asset_tag"
        case serialNumber = "serial_number"
    }
}

/// `GET /kiosk/assets/lookup`. `truncated`: more assets matched than were returned.
struct KioskLookupResult: Codable, Equatable, Sendable {
    var matches: [KioskLookupMatch] = []
    var truncated: Bool = false

    enum CodingKeys: String, CodingKey { case matches, truncated }
}

/// One end (source or destination) of an asset's route.
struct KioskAssetEnd: Codable, Equatable, Sendable {
    var siteName: String?
    var pod: String?
    var rack: String?
    var ru: String?
    var position: String?

    enum CodingKeys: String, CodingKey {
        case pod, rack, ru, position
        case siteName = "site_name"
    }
}

struct KioskAssetRoute: Codable, Equatable, Sendable {
    var initiativeId: String
    var initiativeName: String
    var source: KioskAssetEnd
    var destination: KioskAssetEnd

    enum CodingKeys: String, CodingKey {
        case source, destination
        case initiativeId = "initiative_id"
        case initiativeName = "initiative_name"
    }
}

/// A move the asset is on, with the move's own status.
struct KioskAssetMove: Codable, Equatable, Sendable {
    var initiativeId: String
    var initiativeName: String
    var status: String = ""
    var statusLabel: String = ""
    var statusColor: String = ""

    enum CodingKeys: String, CodingKey {
        case status
        case initiativeId = "initiative_id"
        case initiativeName = "initiative_name"
        case statusLabel = "status_label"
        case statusColor = "status_color"
    }
}

/// The admin-only part of the asset card (rank 60+); nil in `KioskAssetDetail.full` for anyone else.
struct KioskAssetFull: Codable, Equatable, Sendable {
    var status: String = ""
    var statusLabel: String = ""
    /// The server's hex color; "" offline (the synced status has none).
    var statusColor: String = ""
    var moves: [KioskAssetMove] = []
    var containerName: String?
    var truckName: String?
    var locationDetail: String = ""

    enum CodingKeys: String, CodingKey {
        case status, moves
        case statusLabel = "status_label"
        case statusColor = "status_color"
        case containerName = "container_name"
        case truckName = "truck_name"
        case locationDetail = "location_detail"
    }
}

/// `GET /kiosk/assets/{id}`: the details card. `rfid` is the stored, padded tag.
struct KioskAssetDetail: Codable, Equatable, Sendable {
    var id: String
    var name: String?
    var make: String?
    var model: String?
    var makeModel: String = ""
    var assetTag: String = ""
    var serialNumber: String?
    var rfid: String?
    var routes: [KioskAssetRoute] = []
    var full: KioskAssetFull?

    enum CodingKeys: String, CodingKey {
        case id, name, make, model, rfid, routes, full
        case makeModel = "make_model"
        case assetTag = "asset_tag"
        case serialNumber = "serial_number"
    }
}

/// One row of `GET /kiosk/assets/{id}/scans`, newest first. `scannedAt` stays the server's ISO
/// text (`scanWhenText` formats it).
struct AssetScanRow: Codable, Equatable, Sendable {
    var id: String
    var scannedValue: String = ""
    var scanType: String = ""
    var scanTypeLabel: String = ""
    var scanTypeColor: String = ""
    var status: String?
    var statusLabel: String?
    var statusColor: String?
    var scannedAt: String
    var deviceId: String = ""
    var operatorName: String?
    var siteName: String?
    var locationDetail: String = ""
    var offMove: Bool = false

    enum CodingKeys: String, CodingKey {
        case id, status
        case scannedValue = "scanned_value"
        case scanType = "scan_type"
        case scanTypeLabel = "scan_type_label"
        case scanTypeColor = "scan_type_color"
        case statusLabel = "status_label"
        case statusColor = "status_color"
        case scannedAt = "scanned_at"
        case deviceId = "device_id"
        case operatorName = "operator_name"
        case siteName = "site_name"
        case locationDetail = "location_detail"
        case offMove = "off_move"
    }
}

extension KioskLookupMatch {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        assetTag = try c.decodeIfPresent(String.self, forKey: .assetTag) ?? ""
        serialNumber = try c.decodeIfPresent(String.self, forKey: .serialNumber)
        matched = try c.decodeIfPresent([String].self, forKey: .matched) ?? []
    }
}

extension KioskLookupResult {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        matches = try c.decodeIfPresent([KioskLookupMatch].self, forKey: .matches) ?? []
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

extension KioskAssetMove {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        initiativeName = try c.decode(String.self, forKey: .initiativeName)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel) ?? ""
        statusColor = try c.decodeIfPresent(String.self, forKey: .statusColor) ?? ""
    }
}

extension KioskAssetFull {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel) ?? ""
        statusColor = try c.decodeIfPresent(String.self, forKey: .statusColor) ?? ""
        moves = try c.decodeIfPresent([KioskAssetMove].self, forKey: .moves) ?? []
        containerName = try c.decodeIfPresent(String.self, forKey: .containerName)
        truckName = try c.decodeIfPresent(String.self, forKey: .truckName)
        locationDetail = try c.decodeIfPresent(String.self, forKey: .locationDetail) ?? ""
    }
}

extension KioskAssetDetail {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        make = try c.decodeIfPresent(String.self, forKey: .make)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        makeModel = try c.decodeIfPresent(String.self, forKey: .makeModel) ?? ""
        assetTag = try c.decodeIfPresent(String.self, forKey: .assetTag) ?? ""
        serialNumber = try c.decodeIfPresent(String.self, forKey: .serialNumber)
        rfid = try c.decodeIfPresent(String.self, forKey: .rfid)
        routes = try c.decodeIfPresent([KioskAssetRoute].self, forKey: .routes) ?? []
        full = try c.decodeIfPresent(KioskAssetFull.self, forKey: .full)
    }
}

extension AssetScanRow {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scannedValue = try c.decodeIfPresent(String.self, forKey: .scannedValue) ?? ""
        scanType = try c.decodeIfPresent(String.self, forKey: .scanType) ?? ""
        scanTypeLabel = try c.decodeIfPresent(String.self, forKey: .scanTypeLabel) ?? ""
        scanTypeColor = try c.decodeIfPresent(String.self, forKey: .scanTypeColor) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status)
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel)
        statusColor = try c.decodeIfPresent(String.self, forKey: .statusColor)
        scannedAt = try c.decode(String.self, forKey: .scannedAt)
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
        operatorName = try c.decodeIfPresent(String.self, forKey: .operatorName)
        siteName = try c.decodeIfPresent(String.self, forKey: .siteName)
        locationDetail = try c.decodeIfPresent(String.self, forKey: .locationDetail) ?? ""
        offMove = try c.decodeIfPresent(Bool.self, forKey: .offMove) ?? false
    }
}
