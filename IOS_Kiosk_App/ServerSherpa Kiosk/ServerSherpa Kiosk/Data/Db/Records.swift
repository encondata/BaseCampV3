import Foundation
import SwiftData

// The local tables (Android `data/db/Entities.kt`), schema version 2 (see
// `KioskSchemaVersions.swift`). Records never leave `KioskStore`: each maps to
// and from its Core value type.

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
    /// The asset's JSON object exactly as /kiosk/sync/assets sent it (number
    /// literals intact): the label generator's input. `{}` on rows synced before V2.
    var payloadJson: String = "{}"
    /// The asset's place in the server's order.
    var position: Int = 0

    init(_ row: KioskAssetRow, payloadJson: String = "{}", position: Int = 0) {
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
        self.payloadJson = payloadJson
        self.position = position
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

/// A key/value row; `value` is a JSON string (the `sync` row holds `SyncMeta`;
/// the `label_context` row holds the move's label context as raw JSON text).
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

/// A label template the move uses, as the server sent it (raw JSON), in server order.
@Model final class LabelTemplateRecord {
    @Attribute(.unique) var id: String
    var position: Int
    var json: String

    init(id: String, position: Int, json: String) {
        self.id = id
        self.position = position
        self.json = json
    }
}

/// A library font the move's templates use. The bytes live in a file, never in
/// the store; `fileName` is nil for a resident font (built into the printer).
@Model final class LabelFontRecord {
    @Attribute(.unique) var id: String
    var name: String
    var size: Int
    var resident: Bool
    var fileName: String?

    init(id: String, name: String, size: Int, resident: Bool, fileName: String?) {
        self.id = id
        self.name = name
        self.size = size
        self.resident = resident
        self.fileName = fileName
    }
}

/// The label generated for one asset: `zpl` when `outcome` is `ok`, else nil
/// with the outcome code. `fingerprint` says which inputs produced it.
@Model final class GeneratedLabelRecord {
    @Attribute(.unique) var assetId: String
    var zpl: String?
    var outcome: String
    var fingerprint: String
    var templateId: String?

    init(assetId: String, zpl: String?, outcome: String, fingerprint: String, templateId: String?) {
        self.assetId = assetId
        self.zpl = zpl
        self.outcome = outcome
        self.fingerprint = fingerprint
        self.templateId = templateId
    }
}

enum KioskSchema {
    /// The store's file name in Application Support (plus SQLite's `-shm` and `-wal`).
    static let storeFileName = "serversherpa-kiosk.store"

    /// An in-memory store at the current version: tests, previews, and the
    /// fallback when the on-disk store cannot be used (see `KioskStoreOpener`).
    static func inMemoryContainer() throws -> ModelContainer {
        let schema = Schema(versionedSchema: KioskSchemaV2.self)
        return try ModelContainer(for: schema, migrationPlan: KioskMigrationPlan.self,
                                  configurations: ModelConfiguration(schema: schema, isStoredInMemoryOnly: true))
    }

    /// The store at `url`, migrated to the current version when older.
    static func container(url: URL) throws -> ModelContainer {
        let schema = Schema(versionedSchema: KioskSchemaV2.self)
        return try ModelContainer(for: schema, migrationPlan: KioskMigrationPlan.self,
                                  configurations: ModelConfiguration(schema: schema, url: url))
    }

    /// The folder a corrupt store is moved into: `serversherpa-kiosk.store.failed-<yyyyMMdd-HHmmss>` (local time).
    static func failedStoreName(at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "\(storeFileName).failed-\(formatter.string(from: date))"
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
