import Foundation

struct KioskAssetRow: Codable, Equatable, Sendable {
    var id: String
    var assetId: String
    var name: String?
    var rfid: String?
    var serialNumber: String?
    var make: String?
    var model: String?
    var makeModel: String
    var containerId: String?
    var label: [String: String]

    enum CodingKeys: String, CodingKey {
        case id
        case assetId = "asset_id"
        case name
        case rfid
        case serialNumber = "serial_number"
        case make
        case model
        case makeModel = "make_model"
        case containerId = "container_id"
        case label
    }

    init(id: String, assetId: String = "", name: String? = nil, rfid: String? = nil, serialNumber: String? = nil, make: String? = nil, model: String? = nil, makeModel: String = "", containerId: String? = nil, label: [String: String] = [:]) {
        self.id = id
        self.assetId = assetId
        self.name = name
        self.rfid = rfid
        self.serialNumber = serialNumber
        self.make = make
        self.model = model
        self.makeModel = makeModel
        self.containerId = containerId
        self.label = label
    }

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
        label = try c.decodeIfPresent([String: String].self, forKey: .label) ?? [:]
    }
}

struct KioskAssetsSync: Codable, Equatable, Sendable {
    var initiativeId: String
    var initiativeName: String
    var generatedAt: String
    var assets: [KioskAssetRow]

    enum CodingKeys: String, CodingKey {
        case initiativeId = "initiative_id"
        case initiativeName = "initiative_name"
        case generatedAt = "generated_at"
        case assets
    }

    init(initiativeId: String, initiativeName: String, generatedAt: String, assets: [KioskAssetRow] = []) {
        self.initiativeId = initiativeId
        self.initiativeName = initiativeName
        self.generatedAt = generatedAt
        self.assets = assets
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        initiativeName = try c.decode(String.self, forKey: .initiativeName)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        assets = try c.decodeIfPresent([KioskAssetRow].self, forKey: .assets) ?? []
    }
}

struct KioskPersonRow: Codable, Equatable, Sendable {
    var id: String
    var displayName: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var rfidTag: String?
    var isWorker: Bool
    var hasAccount: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case rfidTag = "rfid_tag"
        case isWorker = "is_worker"
        case hasAccount = "has_account"
    }

    init(id: String, displayName: String, firstName: String = "", lastName: String = "", preferredName: String? = nil, rfidTag: String? = nil, isWorker: Bool = false, hasAccount: Bool = false) {
        self.id = id
        self.displayName = displayName
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.rfidTag = rfidTag
        self.isWorker = isWorker
        self.hasAccount = hasAccount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decode(String.self, forKey: .displayName)
        firstName = try c.decodeIfPresent(String.self, forKey: .firstName) ?? ""
        lastName = try c.decodeIfPresent(String.self, forKey: .lastName) ?? ""
        preferredName = try c.decodeIfPresent(String.self, forKey: .preferredName)
        rfidTag = try c.decodeIfPresent(String.self, forKey: .rfidTag)
        isWorker = try c.decodeIfPresent(Bool.self, forKey: .isWorker) ?? false
        hasAccount = try c.decodeIfPresent(Bool.self, forKey: .hasAccount) ?? false
    }
}

struct KioskPeopleSync: Codable, Equatable, Sendable {
    var generatedAt: String
    var people: [KioskPersonRow]

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case people
    }

    init(generatedAt: String, people: [KioskPersonRow] = []) {
        self.generatedAt = generatedAt
        self.people = people
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        people = try c.decodeIfPresent([KioskPersonRow].self, forKey: .people) ?? []
    }
}

struct KioskContainerRow: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var rfidTag: String?
    var labelTag: String?
    var containerType: String?
    var status: String
    var statusLabel: String
    var siteId: String?
    var siteName: String?
    var assetCount: Int

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case rfidTag = "rfid_tag"
        case labelTag = "label_tag"
        case containerType = "container_type"
        case status
        case statusLabel = "status_label"
        case siteId = "site_id"
        case siteName = "site_name"
        case assetCount = "asset_count"
    }

    init(id: String, name: String, rfidTag: String? = nil, labelTag: String? = nil, containerType: String? = nil, status: String = "", statusLabel: String = "", siteId: String? = nil, siteName: String? = nil, assetCount: Int = 0) {
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

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        rfidTag = try c.decodeIfPresent(String.self, forKey: .rfidTag)
        labelTag = try c.decodeIfPresent(String.self, forKey: .labelTag)
        containerType = try c.decodeIfPresent(String.self, forKey: .containerType)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel) ?? ""
        siteId = try c.decodeIfPresent(String.self, forKey: .siteId)
        siteName = try c.decodeIfPresent(String.self, forKey: .siteName)
        assetCount = try c.decodeIfPresent(Int.self, forKey: .assetCount) ?? 0
    }
}

struct KioskContainersSync: Codable, Equatable, Sendable {
    var initiativeId: String
    var generatedAt: String
    var containers: [KioskContainerRow]

    enum CodingKeys: String, CodingKey {
        case initiativeId = "initiative_id"
        case generatedAt = "generated_at"
        case containers
    }

    init(initiativeId: String, generatedAt: String, containers: [KioskContainerRow] = []) {
        self.initiativeId = initiativeId
        self.generatedAt = generatedAt
        self.containers = containers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        containers = try c.decodeIfPresent([KioskContainerRow].self, forKey: .containers) ?? []
    }
}

struct KioskTruckRow: Codable, Equatable, Sendable {
    var id: String
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

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case loadNumber = "load_number"
        case status
        case statusLabel = "status_label"
        case driverName = "driver_name"
        case startSiteId = "start_site_id"
        case startSiteName = "start_site_name"
        case endSiteId = "end_site_id"
        case endSiteName = "end_site_name"
        case containerCount = "container_count"
    }

    init(id: String, name: String, loadNumber: String? = nil, status: String = "", statusLabel: String = "", driverName: String? = nil, startSiteId: String? = nil, startSiteName: String? = nil, endSiteId: String? = nil, endSiteName: String? = nil, containerCount: Int = 0) {
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

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        loadNumber = try c.decodeIfPresent(String.self, forKey: .loadNumber)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel) ?? ""
        driverName = try c.decodeIfPresent(String.self, forKey: .driverName)
        startSiteId = try c.decodeIfPresent(String.self, forKey: .startSiteId)
        startSiteName = try c.decodeIfPresent(String.self, forKey: .startSiteName)
        endSiteId = try c.decodeIfPresent(String.self, forKey: .endSiteId)
        endSiteName = try c.decodeIfPresent(String.self, forKey: .endSiteName)
        containerCount = try c.decodeIfPresent(Int.self, forKey: .containerCount) ?? 0
    }
}

struct KioskTrucksSync: Codable, Equatable, Sendable {
    var initiativeId: String
    var generatedAt: String
    var trucks: [KioskTruckRow]

    enum CodingKeys: String, CodingKey {
        case initiativeId = "initiative_id"
        case generatedAt = "generated_at"
        case trucks
    }

    init(initiativeId: String, generatedAt: String, trucks: [KioskTruckRow] = []) {
        self.initiativeId = initiativeId
        self.generatedAt = generatedAt
        self.trucks = trucks
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        trucks = try c.decodeIfPresent([KioskTruckRow].self, forKey: .trucks) ?? []
    }
}
