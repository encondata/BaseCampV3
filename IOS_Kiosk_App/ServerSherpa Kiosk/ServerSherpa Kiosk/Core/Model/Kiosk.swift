import Foundation

struct PairCreateIn: Codable, Equatable, Sendable {
    var serial: String
    var name: String

    enum CodingKeys: String, CodingKey {
        case serial
        case name
    }

    init(serial: String, name: String) {
        self.serial = serial
        self.name = name
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        name = try c.decode(String.self, forKey: .name)
    }
}

struct PairCreated: Codable, Equatable, Sendable {
    var code: String
    var pollToken: String
    var linkUrl: String
    var expiresAt: String

    enum CodingKeys: String, CodingKey {
        case code
        case pollToken = "poll_token"
        case linkUrl = "link_url"
        case expiresAt = "expires_at"
    }

    init(code: String, pollToken: String, linkUrl: String, expiresAt: String) {
        self.code = code
        self.pollToken = pollToken
        self.linkUrl = linkUrl
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        pollToken = try c.decode(String.self, forKey: .pollToken)
        linkUrl = try c.decode(String.self, forKey: .linkUrl)
        expiresAt = try c.decode(String.self, forKey: .expiresAt)
    }
}

struct PairPollIn: Codable, Equatable, Sendable {
    var pollToken: String

    enum CodingKeys: String, CodingKey {
        case pollToken = "poll_token"
    }

    init(pollToken: String) {
        self.pollToken = pollToken
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pollToken = try c.decode(String.self, forKey: .pollToken)
    }
}

struct PairPollOut: Codable, Equatable, Sendable {
    var status: String
    var session: SessionData?

    enum CodingKeys: String, CodingKey {
        case status
        case session
    }

    init(status: String, session: SessionData? = nil) {
        self.status = status
        self.session = session
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(String.self, forKey: .status)
        session = try c.decodeIfPresent(SessionData.self, forKey: .session)
    }
}

struct HeartbeatIn: Codable, Equatable, Sendable {
    var serial: String
    var name: String
    var mode: String
    var version: String?
    var rawInfo: [String: String]
    var signIn: Bool
    var loginMethod: String?

    enum CodingKeys: String, CodingKey {
        case serial
        case name
        case mode
        case version
        case rawInfo = "raw_info"
        case signIn = "sign_in"
        case loginMethod = "login_method"
    }

    init(serial: String, name: String, mode: String = "ios", version: String? = nil, rawInfo: [String: String] = [:], signIn: Bool = false, loginMethod: String? = nil) {
        self.serial = serial
        self.name = name
        self.mode = mode
        self.version = version
        self.rawInfo = rawInfo
        self.signIn = signIn
        self.loginMethod = loginMethod
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        name = try c.decode(String.self, forKey: .name)
        mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "ios"
        version = try c.decodeIfPresent(String.self, forKey: .version)
        rawInfo = try c.decodeIfPresent([String: String].self, forKey: .rawInfo) ?? [:]
        signIn = try c.decodeIfPresent(Bool.self, forKey: .signIn) ?? false
        loginMethod = try c.decodeIfPresent(String.self, forKey: .loginMethod)
    }
}

struct HeartbeatResult: Codable, Equatable, Sendable {
    var deviceId: String
    var name: String
    var registration: String
    var tokenExpiresAt: String?

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case name
        case registration
        case tokenExpiresAt = "token_expires_at"
    }

    init(deviceId: String, name: String, registration: String, tokenExpiresAt: String? = nil) {
        self.deviceId = deviceId
        self.name = name
        self.registration = registration
        self.tokenExpiresAt = tokenExpiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        name = try c.decode(String.self, forKey: .name)
        registration = try c.decode(String.self, forKey: .registration)
        tokenExpiresAt = try c.decodeIfPresent(String.self, forKey: .tokenExpiresAt)
    }
}

struct KioskSignOutIn: Codable, Equatable, Sendable {
    var serial: String

    enum CodingKeys: String, CodingKey {
        case serial
    }

    init(serial: String) {
        self.serial = serial
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
    }
}

struct SetupOptionSite: Codable, Equatable, Sendable {
    var id: String
    var name: String

    enum CodingKeys: String, CodingKey {
        case id
        case name
    }

    init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
    }
}

struct SetupOptionInitiative: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var status: String
    var statusLabel: String
    var clientName: String?
    var scheduledStart: String?
    var scheduledEnd: String?
    var sourceSite: SetupOptionSite?
    var destinationSite: SetupOptionSite?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case status
        case statusLabel = "status_label"
        case clientName = "client_name"
        case scheduledStart = "scheduled_start"
        case scheduledEnd = "scheduled_end"
        case sourceSite = "source_site"
        case destinationSite = "destination_site"
    }

    init(id: String, name: String, status: String, statusLabel: String, clientName: String? = nil, scheduledStart: String? = nil, scheduledEnd: String? = nil, sourceSite: SetupOptionSite? = nil, destinationSite: SetupOptionSite? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.statusLabel = statusLabel
        self.clientName = clientName
        self.scheduledStart = scheduledStart
        self.scheduledEnd = scheduledEnd
        self.sourceSite = sourceSite
        self.destinationSite = destinationSite
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        status = try c.decode(String.self, forKey: .status)
        statusLabel = try c.decode(String.self, forKey: .statusLabel)
        clientName = try c.decodeIfPresent(String.self, forKey: .clientName)
        scheduledStart = try c.decodeIfPresent(String.self, forKey: .scheduledStart)
        scheduledEnd = try c.decodeIfPresent(String.self, forKey: .scheduledEnd)
        sourceSite = try c.decodeIfPresent(SetupOptionSite.self, forKey: .sourceSite)
        destinationSite = try c.decodeIfPresent(SetupOptionSite.self, forKey: .destinationSite)
    }
}

struct SetupOptionScanType: Codable, Equatable, Sendable {
    var key: String
    var label: String
    var color: String

    enum CodingKeys: String, CodingKey {
        case key
        case label
        case color
    }

    init(key: String, label: String, color: String) {
        self.key = key
        self.label = label
        self.color = color
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        color = try c.decode(String.self, forKey: .color)
    }
}

struct SetupOptions: Codable, Equatable, Sendable {
    var initiatives: [SetupOptionInitiative]
    var scanTypes: [SetupOptionScanType]

    enum CodingKeys: String, CodingKey {
        case initiatives
        case scanTypes = "scan_types"
    }

    init(initiatives: [SetupOptionInitiative] = [], scanTypes: [SetupOptionScanType] = []) {
        self.initiatives = initiatives
        self.scanTypes = scanTypes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiatives = try c.decodeIfPresent([SetupOptionInitiative].self, forKey: .initiatives) ?? []
        scanTypes = try c.decodeIfPresent([SetupOptionScanType].self, forKey: .scanTypes) ?? []
    }
}

struct KioskSetupIn: Codable, Equatable, Sendable {
    var serial: String
    var initiativeId: String
    var siteId: String
    var scanStatus: String

    enum CodingKeys: String, CodingKey {
        case serial
        case initiativeId = "initiative_id"
        case siteId = "site_id"
        case scanStatus = "scan_status"
    }

    init(serial: String, initiativeId: String, siteId: String, scanStatus: String) {
        self.serial = serial
        self.initiativeId = initiativeId
        self.siteId = siteId
        self.scanStatus = scanStatus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        siteId = try c.decode(String.self, forKey: .siteId)
        scanStatus = try c.decode(String.self, forKey: .scanStatus)
    }
}

struct KioskSetupResult: Codable, Equatable, Sendable {
    var deviceId: String
    var initiativeId: String
    var initiativeName: String
    var siteId: String
    var siteName: String
    var siteRole: String
    var scanStatus: String
    var scanStatusLabel: String

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case initiativeId = "initiative_id"
        case initiativeName = "initiative_name"
        case siteId = "site_id"
        case siteName = "site_name"
        case siteRole = "site_role"
        case scanStatus = "scan_status"
        case scanStatusLabel = "scan_status_label"
    }

    init(deviceId: String, initiativeId: String, initiativeName: String, siteId: String, siteName: String, siteRole: String, scanStatus: String, scanStatusLabel: String) {
        self.deviceId = deviceId
        self.initiativeId = initiativeId
        self.initiativeName = initiativeName
        self.siteId = siteId
        self.siteName = siteName
        self.siteRole = siteRole
        self.scanStatus = scanStatus
        self.scanStatusLabel = scanStatusLabel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        initiativeName = try c.decode(String.self, forKey: .initiativeName)
        siteId = try c.decode(String.self, forKey: .siteId)
        siteName = try c.decode(String.self, forKey: .siteName)
        siteRole = try c.decode(String.self, forKey: .siteRole)
        scanStatus = try c.decode(String.self, forKey: .scanStatus)
        scanStatusLabel = try c.decode(String.self, forKey: .scanStatusLabel)
    }
}

enum PairStatus: String, Equatable, Sendable {
    case pending, approved, denied, expired

    /// Case-insensitive; anything unknown is treated as expired.
    static func fromWire(_ s: String) -> PairStatus {
        PairStatus(rawValue: s.lowercased()) ?? .expired
    }
}

struct PairPoll: Equatable, Sendable {
    var status: PairStatus
    var session: SessionData?
    /// The refresh cookie an approved answer set. Neither it nor the session is
    /// kept until `KioskAuth.completePair` accepts the answer.
    var cookie: PairCookie? = nil
}

/// An `ss_refresh` value and the API host that set it.
struct PairCookie: Equatable, Sendable {
    var host: String
    var value: String
}

/// What Kiosk Setup saved on this kiosk. Keys are camelCase: this is the web's
/// local-storage shape.
struct KioskSetupSelection: Codable, Equatable, Sendable {
    var initiativeId: String
    var initiativeName: String
    var siteId: String
    var siteName: String
    var siteRole: String
    var scanStatus: String
    var scanLabel: String

    init(initiativeId: String, initiativeName: String, siteId: String, siteName: String, siteRole: String, scanStatus: String, scanLabel: String) {
        self.initiativeId = initiativeId
        self.initiativeName = initiativeName
        self.siteId = siteId
        self.siteName = siteName
        self.siteRole = siteRole
        self.scanStatus = scanStatus
        self.scanLabel = scanLabel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        initiativeName = try c.decode(String.self, forKey: .initiativeName)
        siteId = try c.decode(String.self, forKey: .siteId)
        siteName = try c.decode(String.self, forKey: .siteName)
        siteRole = try c.decode(String.self, forKey: .siteRole)
        scanStatus = try c.decode(String.self, forKey: .scanStatus)
        scanLabel = try c.decode(String.self, forKey: .scanLabel)
    }
}
