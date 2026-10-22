import Foundation
import SwiftData

// The store's schema versions (Android `KioskDatabase` versions 1 to 3).
// SwiftData recognizes a store on disk by its entities' version hashes, so a
// shipped version is frozen: never edit `KioskSchemaV1`'s models. A new
// version copies the current models in here and adds a stage to the plan.

/// The models every kiosk shipped with before labels: frozen copies, attribute
/// for attribute, of the unversioned schema the app used to open. They only
/// describe the old store to the migration; the app never instantiates them
/// (they share entity names with the current models; `@Model` requires the inits).
enum KioskSchemaV1: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(1, 0, 0) }

    static var models: [any PersistentModel.Type] {
        [AssetRecord.self, PersonRecord.self, ContainerRecord.self, TruckRecord.self, MetaRecord.self, OutboxRecord.self]
    }

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
        var labelJson: String

        init(id: String, assetId: String, name: String? = nil, rfid: String? = nil, serialNumber: String? = nil, make: String? = nil,
             model: String? = nil, makeModel: String, containerId: String? = nil, labelJson: String) {
            self.id = id
            self.assetId = assetId
            self.name = name
            self.rfid = rfid
            self.serialNumber = serialNumber
            self.make = make
            self.model = model
            self.makeModel = makeModel
            self.containerId = containerId
            self.labelJson = labelJson
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

        init(id: String, displayName: String, firstName: String, lastName: String, preferredName: String? = nil, rfidTag: String? = nil,
             isWorker: Bool = true, hasAccount: Bool = false) {
            self.id = id
            self.displayName = displayName
            self.firstName = firstName
            self.lastName = lastName
            self.preferredName = preferredName
            self.rfidTag = rfidTag
            self.isWorker = isWorker
            self.hasAccount = hasAccount
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

        init(id: String, name: String, rfidTag: String? = nil, labelTag: String? = nil, containerType: String? = nil, status: String,
             statusLabel: String, siteId: String? = nil, siteName: String? = nil, assetCount: Int = 0) {
            self.id = id
            self.name = name
            self.rfidTag = rfidTag
            self.labelTag = labelTag
            self.containerType = containerType
            self.status = status
            self.statusLabel = statusLabel
            self.siteId = siteId
            self.siteName = siteName
            self.assetCount = assetCount
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

        init(id: String, name: String, loadNumber: String? = nil, status: String, statusLabel: String, driverName: String? = nil,
             startSiteId: String? = nil, startSiteName: String? = nil, endSiteId: String? = nil, endSiteName: String? = nil,
             containerCount: Int = 0) {
            self.id = id
            self.name = name
            self.loadNumber = loadNumber
            self.status = status
            self.statusLabel = statusLabel
            self.driverName = driverName
            self.startSiteId = startSiteId
            self.startSiteName = startSiteName
            self.endSiteId = endSiteId
            self.endSiteName = endSiteName
            self.containerCount = containerCount
        }
    }

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
        var asset: String?
        var matched: Bool
        var status: String
        var attempts: Int
        var nextAttemptAt: Int64?
        var lastError: String?
        var siteId: String
        var initiativeId: String
        var scanStatus: String

        init(clientScanId: String, seq: Int64, scannedValue: String, scanType: String, scannedAt: String, asset: String? = nil,
             matched: Bool, status: String, attempts: Int = 0, nextAttemptAt: Int64? = nil, lastError: String? = nil, siteId: String,
             initiativeId: String, scanStatus: String) {
            self.clientScanId = clientScanId
            self.seq = seq
            self.scannedValue = scannedValue
            self.scanType = scanType
            self.scannedAt = scannedAt
            self.asset = asset
            self.matched = matched
            self.status = status
            self.attempts = attempts
            self.nextAttemptAt = nextAttemptAt
            self.lastError = lastError
            self.siteId = siteId
            self.initiativeId = initiativeId
            self.scanStatus = scanStatus
        }
    }
}

/// Labels: assets keep their raw payload and server order; label templates,
/// fonts and generated labels. Frozen copies, attribute for attribute, of the
/// models V2 shipped with (the top-level models in `Records.swift` before V3);
/// like V1's, they only describe the old store to the migration.
enum KioskSchemaV2: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(2, 0, 0) }

    static var models: [any PersistentModel.Type] {
        [AssetRecord.self, PersonRecord.self, ContainerRecord.self, TruckRecord.self, MetaRecord.self, OutboxRecord.self,
         LabelTemplateRecord.self, LabelFontRecord.self, GeneratedLabelRecord.self]
    }

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
        var labelJson: String
        var payloadJson: String = "{}"
        var position: Int = 0

        init(id: String, assetId: String, name: String? = nil, rfid: String? = nil, serialNumber: String? = nil, make: String? = nil,
             model: String? = nil, makeModel: String, containerId: String? = nil, labelJson: String, payloadJson: String = "{}",
             position: Int = 0) {
            self.id = id
            self.assetId = assetId
            self.name = name
            self.rfid = rfid
            self.serialNumber = serialNumber
            self.make = make
            self.model = model
            self.makeModel = makeModel
            self.containerId = containerId
            self.labelJson = labelJson
            self.payloadJson = payloadJson
            self.position = position
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

        init(id: String, displayName: String, firstName: String, lastName: String, preferredName: String? = nil, rfidTag: String? = nil,
             isWorker: Bool = true, hasAccount: Bool = false) {
            self.id = id
            self.displayName = displayName
            self.firstName = firstName
            self.lastName = lastName
            self.preferredName = preferredName
            self.rfidTag = rfidTag
            self.isWorker = isWorker
            self.hasAccount = hasAccount
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

        init(id: String, name: String, rfidTag: String? = nil, labelTag: String? = nil, containerType: String? = nil, status: String,
             statusLabel: String, siteId: String? = nil, siteName: String? = nil, assetCount: Int = 0) {
            self.id = id
            self.name = name
            self.rfidTag = rfidTag
            self.labelTag = labelTag
            self.containerType = containerType
            self.status = status
            self.statusLabel = statusLabel
            self.siteId = siteId
            self.siteName = siteName
            self.assetCount = assetCount
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

        init(id: String, name: String, loadNumber: String? = nil, status: String, statusLabel: String, driverName: String? = nil,
             startSiteId: String? = nil, startSiteName: String? = nil, endSiteId: String? = nil, endSiteName: String? = nil,
             containerCount: Int = 0) {
            self.id = id
            self.name = name
            self.loadNumber = loadNumber
            self.status = status
            self.statusLabel = statusLabel
            self.driverName = driverName
            self.startSiteId = startSiteId
            self.startSiteName = startSiteName
            self.endSiteId = endSiteId
            self.endSiteName = endSiteName
            self.containerCount = containerCount
        }
    }

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
        var asset: String?
        var matched: Bool
        var status: String
        var attempts: Int
        var nextAttemptAt: Int64?
        var lastError: String?
        var siteId: String
        var initiativeId: String
        var scanStatus: String

        init(clientScanId: String, seq: Int64, scannedValue: String, scanType: String, scannedAt: String, asset: String? = nil,
             matched: Bool, status: String, attempts: Int = 0, nextAttemptAt: Int64? = nil, lastError: String? = nil, siteId: String,
             initiativeId: String, scanStatus: String) {
            self.clientScanId = clientScanId
            self.seq = seq
            self.scannedValue = scannedValue
            self.scanType = scanType
            self.scannedAt = scannedAt
            self.asset = asset
            self.matched = matched
            self.status = status
            self.attempts = attempts
            self.nextAttemptAt = nextAttemptAt
            self.lastError = lastError
            self.siteId = siteId
            self.initiativeId = initiativeId
            self.scanStatus = scanStatus
        }
    }

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
}

/// Time Clock: a person keeps their badge UID, job title and Employee ID. The
/// models are the current ones in `Records.swift`.
enum KioskSchemaV3: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(3, 0, 0) }

    static var models: [any PersistentModel.Type] {
        [AssetRecord.self, PersonRecord.self, ContainerRecord.self, TruckRecord.self, MetaRecord.self, OutboxRecord.self,
         LabelTemplateRecord.self, LabelFontRecord.self, GeneratedLabelRecord.self]
    }
}

/// V1 → V2 adds two defaulted attributes and three tables; V2 → V3 adds three
/// optional person attributes. Both are lightweight stages.
enum KioskMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] { [KioskSchemaV1.self, KioskSchemaV2.self, KioskSchemaV3.self] }

    static var stages: [MigrationStage] {
        [.lightweight(fromVersion: KioskSchemaV1.self, toVersion: KioskSchemaV2.self),
         .lightweight(fromVersion: KioskSchemaV2.self, toVersion: KioskSchemaV3.self)]
    }
}
