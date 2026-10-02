import Foundation

struct KioskScanIn: Codable, Equatable, Sendable {
    var clientScanId: String
    var scannedValue: String
    var scanType: String
    var scannedAt: String
    var assetId: String?
    var siteId: String?
    var initiativeId: String?
    var scanStatus: String?

    enum CodingKeys: String, CodingKey {
        case clientScanId = "client_scan_id"
        case scannedValue = "scanned_value"
        case scanType = "scan_type"
        case scannedAt = "scanned_at"
        case assetId = "asset_id"
        case siteId = "site_id"
        case initiativeId = "initiative_id"
        case scanStatus = "scan_status"
    }

    init(clientScanId: String, scannedValue: String, scanType: String, scannedAt: String, assetId: String? = nil, siteId: String? = nil, initiativeId: String? = nil, scanStatus: String? = nil) {
        self.clientScanId = clientScanId
        self.scannedValue = scannedValue
        self.scanType = scanType
        self.scannedAt = scannedAt
        self.assetId = assetId
        self.siteId = siteId
        self.initiativeId = initiativeId
        self.scanStatus = scanStatus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientScanId = try c.decode(String.self, forKey: .clientScanId)
        scannedValue = try c.decode(String.self, forKey: .scannedValue)
        scanType = try c.decode(String.self, forKey: .scanType)
        scannedAt = try c.decode(String.self, forKey: .scannedAt)
        assetId = try c.decodeIfPresent(String.self, forKey: .assetId)
        siteId = try c.decodeIfPresent(String.self, forKey: .siteId)
        initiativeId = try c.decodeIfPresent(String.self, forKey: .initiativeId)
        scanStatus = try c.decodeIfPresent(String.self, forKey: .scanStatus)
    }
}

struct KioskScanBatchIn: Codable, Equatable, Sendable {
    var serial: String
    var scans: [KioskScanIn]

    enum CodingKeys: String, CodingKey {
        case serial
        case scans
    }

    init(serial: String, scans: [KioskScanIn]) {
        self.serial = serial
        self.scans = scans
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        scans = try c.decode([KioskScanIn].self, forKey: .scans)
    }
}

struct KioskScanRejected: Codable, Equatable, Sendable {
    var clientScanId: String
    var code: String

    enum CodingKeys: String, CodingKey {
        case clientScanId = "client_scan_id"
        case code
    }

    init(clientScanId: String, code: String) {
        self.clientScanId = clientScanId
        self.code = code
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientScanId = try c.decode(String.self, forKey: .clientScanId)
        code = try c.decode(String.self, forKey: .code)
    }
}

struct KioskScanBatchOut: Codable, Equatable, Sendable {
    var accepted: [String]
    var rejected: [KioskScanRejected]

    enum CodingKeys: String, CodingKey {
        case accepted
        case rejected
    }

    init(accepted: [String] = [], rejected: [KioskScanRejected] = []) {
        self.accepted = accepted
        self.rejected = rejected
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accepted = try c.decodeIfPresent([String].self, forKey: .accepted) ?? []
        rejected = try c.decodeIfPresent([KioskScanRejected].self, forKey: .rejected) ?? []
    }
}

struct KioskRfidEnrollIn: Codable, Equatable, Sendable {
    var serial: String
    var rfidTag: String
    var scanStatus: String
    var clientScanId: String
    var siteId: String?
    var initiativeId: String?

    enum CodingKeys: String, CodingKey {
        case serial
        case rfidTag = "rfid_tag"
        case scanStatus = "scan_status"
        case clientScanId = "client_scan_id"
        case siteId = "site_id"
        case initiativeId = "initiative_id"
    }

    init(serial: String, rfidTag: String, scanStatus: String, clientScanId: String, siteId: String? = nil, initiativeId: String? = nil) {
        self.serial = serial
        self.rfidTag = rfidTag
        self.scanStatus = scanStatus
        self.clientScanId = clientScanId
        self.siteId = siteId
        self.initiativeId = initiativeId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        rfidTag = try c.decode(String.self, forKey: .rfidTag)
        scanStatus = try c.decode(String.self, forKey: .scanStatus)
        clientScanId = try c.decode(String.self, forKey: .clientScanId)
        siteId = try c.decodeIfPresent(String.self, forKey: .siteId)
        initiativeId = try c.decodeIfPresent(String.self, forKey: .initiativeId)
    }
}

struct KioskRfidEnroll: Codable, Equatable, Sendable {
    var assetId: String
    var assetName: String?
    var assetTag: String
    var serialNumber: String?
    var rfidTag: String
    var alreadyHadTag: Bool

    enum CodingKeys: String, CodingKey {
        case assetId = "asset_id"
        case assetName = "asset_name"
        case assetTag = "asset_tag"
        case serialNumber = "serial_number"
        case rfidTag = "rfid_tag"
        case alreadyHadTag = "already_had_tag"
    }

    init(assetId: String, assetName: String? = nil, assetTag: String = "", serialNumber: String? = nil, rfidTag: String, alreadyHadTag: Bool = false) {
        self.assetId = assetId
        self.assetName = assetName
        self.assetTag = assetTag
        self.serialNumber = serialNumber
        self.rfidTag = rfidTag
        self.alreadyHadTag = alreadyHadTag
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        assetId = try c.decode(String.self, forKey: .assetId)
        assetName = try c.decodeIfPresent(String.self, forKey: .assetName)
        assetTag = try c.decodeIfPresent(String.self, forKey: .assetTag) ?? ""
        serialNumber = try c.decodeIfPresent(String.self, forKey: .serialNumber)
        rfidTag = try c.decode(String.self, forKey: .rfidTag)
        alreadyHadTag = try c.decodeIfPresent(Bool.self, forKey: .alreadyHadTag) ?? false
    }
}
