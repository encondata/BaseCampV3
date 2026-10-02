import Foundation

struct PersonOut: Codable, Equatable, Sendable {
    var id: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var displayName: String
    var email: String?
    var jobTitle: String?
    var avatarUrl: String?

    enum CodingKeys: String, CodingKey {
        case id
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case displayName = "display_name"
        case email
        case jobTitle = "job_title"
        case avatarUrl = "avatar_url"
    }

    init(id: String, firstName: String, lastName: String, preferredName: String? = nil, displayName: String, email: String? = nil, jobTitle: String? = nil, avatarUrl: String? = nil) {
        self.id = id
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.displayName = displayName
        self.email = email
        self.jobTitle = jobTitle
        self.avatarUrl = avatarUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        firstName = try c.decode(String.self, forKey: .firstName)
        lastName = try c.decode(String.self, forKey: .lastName)
        preferredName = try c.decodeIfPresent(String.self, forKey: .preferredName)
        displayName = try c.decode(String.self, forKey: .displayName)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        jobTitle = try c.decodeIfPresent(String.self, forKey: .jobTitle)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
    }
}

/// The two preferences the kiosk honors; the rest are ignored on decode.
struct UiPreferences: Codable, Equatable, Sendable {
    var accent: String
    var theme: String

    enum CodingKeys: String, CodingKey {
        case accent
        case theme
    }

    init(accent: String = "amber", theme: String = "light") {
        self.accent = accent
        self.theme = theme
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accent = try c.decodeIfPresent(String.self, forKey: .accent) ?? "amber"
        theme = try c.decodeIfPresent(String.self, forKey: .theme) ?? "light"
    }
}

/// The move a move-password session is locked to.
struct KioskMove: Codable, Equatable, Sendable {
    var initiativeId: String
    var name: String

    enum CodingKeys: String, CodingKey {
        case initiativeId = "initiative_id"
        case name
    }

    init(initiativeId: String, name: String) {
        self.initiativeId = initiativeId
        self.name = name
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initiativeId = try c.decode(String.self, forKey: .initiativeId)
        name = try c.decode(String.self, forKey: .name)
    }
}

/// `SessionOut` - what /auth/login, /auth/refresh, and an approved pair poll return.
struct SessionData: Codable, Equatable, Sendable {
    var accessToken: String
    var expiresIn: Int
    var sessionExpiresAt: String
    var person: PersonOut
    var roles: [String]
    var mustChangePassword: Bool
    var preferences: UiPreferences
    var perms: [String: [String: Bool]]
    var maxRank: Int
    var kioskMove: KioskMove?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case expiresIn = "expires_in"
        case sessionExpiresAt = "session_expires_at"
        case person
        case roles
        case mustChangePassword = "must_change_password"
        case preferences
        case perms
        case maxRank = "max_rank"
        case kioskMove = "kiosk_move"
    }

    init(accessToken: String, expiresIn: Int, sessionExpiresAt: String, person: PersonOut, roles: [String] = [], mustChangePassword: Bool = false, preferences: UiPreferences = UiPreferences(), perms: [String: [String: Bool]] = [:], maxRank: Int = 0, kioskMove: KioskMove? = nil) {
        self.accessToken = accessToken
        self.expiresIn = expiresIn
        self.sessionExpiresAt = sessionExpiresAt
        self.person = person
        self.roles = roles
        self.mustChangePassword = mustChangePassword
        self.preferences = preferences
        self.perms = perms
        self.maxRank = maxRank
        self.kioskMove = kioskMove
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        expiresIn = try c.decode(Int.self, forKey: .expiresIn)
        sessionExpiresAt = try c.decode(String.self, forKey: .sessionExpiresAt)
        person = try c.decode(PersonOut.self, forKey: .person)
        roles = try c.decodeIfPresent([String].self, forKey: .roles) ?? []
        mustChangePassword = try c.decodeIfPresent(Bool.self, forKey: .mustChangePassword) ?? false
        preferences = try c.decodeIfPresent(UiPreferences.self, forKey: .preferences) ?? UiPreferences()
        perms = try c.decodeIfPresent([String: [String: Bool]].self, forKey: .perms) ?? [:]
        maxRank = try c.decodeIfPresent(Int.self, forKey: .maxRank) ?? 0
        kioskMove = try c.decodeIfPresent(KioskMove.self, forKey: .kioskMove)
    }
}

struct LoginIn: Codable, Equatable, Sendable {
    var email: String
    var password: String
    var client: String

    enum CodingKeys: String, CodingKey {
        case email
        case password
        case client
    }

    init(email: String, password: String, client: String = "kiosk") {
        self.email = email
        self.password = password
        self.client = client
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        email = try c.decode(String.self, forKey: .email)
        password = try c.decode(String.self, forKey: .password)
        client = try c.decodeIfPresent(String.self, forKey: .client) ?? "kiosk"
    }
}

struct MoveLoginIn: Codable, Equatable, Sendable {
    var password: String

    enum CodingKeys: String, CodingKey {
        case password
    }

    init(password: String) {
        self.password = password
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        password = try c.decode(String.self, forKey: .password)
    }
}

struct SystemStatus: Codable, Equatable, Sendable {
    var readOnly: Bool
    var readOnlyMessage: String
    var workersPaused: Bool
    var banner: String?

    enum CodingKeys: String, CodingKey {
        case readOnly = "read_only"
        case readOnlyMessage = "read_only_message"
        case workersPaused = "workers_paused"
        case banner
    }

    init(readOnly: Bool = false, readOnlyMessage: String = "", workersPaused: Bool = false, banner: String? = nil) {
        self.readOnly = readOnly
        self.readOnlyMessage = readOnlyMessage
        self.workersPaused = workersPaused
        self.banner = banner
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        readOnly = try c.decodeIfPresent(Bool.self, forKey: .readOnly) ?? false
        readOnlyMessage = try c.decodeIfPresent(String.self, forKey: .readOnlyMessage) ?? ""
        workersPaused = try c.decodeIfPresent(Bool.self, forKey: .workersPaused) ?? false
        banner = try c.decodeIfPresent(String.self, forKey: .banner)
    }
}
