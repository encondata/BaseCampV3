import Foundation
import SwiftData

// The local tables (Android `data/db/Entities.kt`). Records never leave
// `KioskStore`: each maps to and from its Core value type.

@Model final class AssetRecord {
    #Index<AssetRecord>([\.rfid], [\.assetId], [\.serialNumber])
    @Attribute(.unique) var id: String
    var assetId: String
    var name: String?
    var rfid: String?
    var serialNumber: String?
    var make: String?
    var model: String?
    var makeModel: String
    var containerId: String?
    /// The label map as a JSON object string.
    var labelJson: String

    init(_ row: KioskAssetRow) {
        id = row.id
        assetId = row.assetId
        name = row.name
        rfid = row.rfid
        serialNumber = row.serialNumber
        make = row.make
        model = row.model
        makeModel = row.makeModel
        containerId = row.containerId
        labelJson = encodeJson(row.label) ?? "{}"
    }

    var row: KioskAssetRow {
        KioskAssetRow(id: id, assetId: assetId, name: name, rfid: rfid, serialNumber: serialNumber, make: make, model: model,
                      makeModel: makeModel, containerId: containerId, label: decodeJson([String: String].self, labelJson) ?? [:])
    }
}

@Model final class PersonRecord {
    #Index<PersonRecord>([\.rfidTag])
    @Attribute(.unique) var id: String
    var displayName: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var rfidTag: String?
    var isWorker: Bool
    var hasAccount: Bool

    init(_ row: KioskPersonRow) {
        id = row.id
        displayName = row.displayName
        firstName = row.firstName
        lastName = row.lastName
        preferredName = row.preferredName
        rfidTag = row.rfidTag
        isWorker = row.isWorker
        hasAccount = row.hasAccount
    }

    var row: KioskPersonRow {
        KioskPersonRow(id: id, displayName: displayName, firstName: firstName, lastName: lastName, preferredName: preferredName,
                       rfidTag: rfidTag, isWorker: isWorker, hasAccount: hasAccount)
    }
}

@Model final class ContainerRecord {
    #Index<ContainerRecord>([\.rfidTag], [\.name])
    @Attribute(.unique) var id: String
    var name: String
    var rfidTag: String?
    var labelTag: String?
    var containerType: String?
    var status: String
    var statusLabel: String
    var siteId: String?
    var siteName: String?
    var assetCount: Int

    init(_ row: KioskContainerRow) {
        id = row.id
        name = row.name
        rfidTag = row.rfidTag
        labelTag = row.labelTag
        containerType = row.containerType
        status = row.status
        statusLabel = row.statusLabel
        siteId = row.siteId
        siteName = row.siteName
        assetCount = row.assetCount
    }

    var row: KioskContainerRow {
        KioskContainerRow(id: id, name: name, rfidTag: rfidTag, labelTag: labelTag, containerType: containerType, status: status,
                          statusLabel: statusLabel, siteId: siteId, siteName: siteName, assetCount: assetCount)
    }
}

@Model final class TruckRecord {
    #Index<TruckRecord>([\.name], [\.loadNumber])
    @Attribute(.unique) var id: String
    var name: String
    var loadNumber: String?
    var status: String
    var statusLabel: String
    var driverName: String?
    var startSiteId: String?
    var startSiteName: String?
    var endSiteId: String?
    var endSiteName: String?
    var containerCount: Int

    init(_ row: KioskTruckRow) {
        id = row.id
        name = row.name
        loadNumber = row.loadNumber
        status = row.status
        statusLabel = row.statusLabel
        driverName = row.driverName
        startSiteId = row.startSiteId
        startSiteName = row.startSiteName
        endSiteId = row.endSiteId
        endSiteName = row.endSiteName
        containerCount = row.containerCount
    }

    var row: KioskTruckRow {
        KioskTruckRow(id: id, name: name, loadNumber: loadNumber, status: status, statusLabel: statusLabel, driverName: driverName,
                      startSiteId: startSiteId, startSiteName: startSiteName, endSiteId: endSiteId, endSiteName: endSiteName,
                      containerCount: containerCount)
    }
}

/// A key/value row; `value` is a JSON string (the `sync` row holds `SyncMeta`).
@Model final class MetaRecord {
    @Attribute(.unique) var key: String
    var value: String

    init(key: String, value: String) {
        self.key = key
        self.value = value
    }
}

@Model final class OutboxRecord {
    #Index<OutboxRecord>([\.status], [\.seq])
    @Attribute(.unique) var clientScanId: String
    var seq: Int64
    var scannedValue: String
    var scanType: String
    var scannedAt: String
    /// The denormalized `OutboxAsset` as a JSON string, nil when unmatched.
    var asset: String?
    var matched: Bool
    /// The status's wire name.
    var status: String
    var attempts: Int
    var nextAttemptAt: Int64?
    var lastError: String?
    var siteId: String
    var initiativeId: String
    var scanStatus: String

    init(_ row: OutboxRow) {
        clientScanId = row.clientScanId
        seq = row.seq
        scannedValue = row.scannedValue
        scanType = row.scanType
        scannedAt = row.scannedAt
        asset = row.asset.flatMap(encodeJson)
        matched = row.matched
        status = row.status.rawValue
        attempts = row.attempts
        nextAttemptAt = row.nextAttemptAt
        lastError = row.lastError
        siteId = row.siteId
        initiativeId = row.initiativeId
        scanStatus = row.scanStatus
    }

    var row: OutboxRow {
        OutboxRow(clientScanId: clientScanId, seq: seq, scannedValue: scannedValue, scanType: scanType, scannedAt: scannedAt,
                  asset: asset.flatMap { decodeJson(OutboxAsset.self, $0) }, matched: matched,
                  status: OutboxStatus(rawValue: status) ?? .queued, attempts: attempts, nextAttemptAt: nextAttemptAt,
                  lastError: lastError, siteId: siteId, initiativeId: initiativeId, scanStatus: scanStatus)
    }
}

enum KioskSchema {
    static let models: [any PersistentModel.Type] = [
        AssetRecord.self, PersonRecord.self, ContainerRecord.self, TruckRecord.self, MetaRecord.self, OutboxRecord.self,
    ]

    /// On disk at Application Support/serversherpa-kiosk.store; in memory for tests.
    static func container(inMemory: Bool) throws -> ModelContainer {
        let schema = Schema(models)
        if inMemory {
            return try ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, isStoredInMemoryOnly: true))
        }
        let dir = URL.applicationSupportDirectory
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: "serversherpa-kiosk.store")
        return try ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, url: url))
    }
}

func encodeJson<T: Encodable>(_ value: T) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) }
}

func decodeJson<T: Decodable>(_ type: T.Type, _ json: String) -> T? {
    try? JSONDecoder().decode(type, from: Data(json.utf8))
}
