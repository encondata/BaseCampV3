import Foundation

struct KioskTimeclockPerson: Codable, Equatable, Sendable {
    var id: String
    var displayName: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var avatarUrl: String?
    var rfidTag: String?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case avatarUrl = "avatar_url"
        case rfidTag = "rfid_tag"
    }

    init(id: String, displayName: String, firstName: String = "", lastName: String = "", preferredName: String? = nil, avatarUrl: String? = nil, rfidTag: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.avatarUrl = avatarUrl
        self.rfidTag = rfidTag
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decode(String.self, forKey: .displayName)
        firstName = try c.decodeIfPresent(String.self, forKey: .firstName) ?? ""
        lastName = try c.decodeIfPresent(String.self, forKey: .lastName) ?? ""
        preferredName = try c.decodeIfPresent(String.self, forKey: .preferredName)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        rfidTag = try c.decodeIfPresent(String.self, forKey: .rfidTag)
    }
}

struct KioskTimeclockEntry: Codable, Equatable, Sendable {
    var id: String
    var startedAt: String
    var initiativeId: String?
    var initiativeName: String?
    var siteId: String?
    var siteName: String?

    enum CodingKeys: String, CodingKey {
        case id
        case startedAt = "started_at"
        case initiativeId = "initiative_id"
        case initiativeName = "initiative_name"
        case siteId = "site_id"
        case siteName = "site_name"
    }

    init(id: String, startedAt: String, initiativeId: String? = nil, initiativeName: String? = nil, siteId: String? = nil, siteName: String? = nil) {
        self.id = id
        self.startedAt = startedAt
        self.initiativeId = initiativeId
        self.initiativeName = initiativeName
        self.siteId = siteId
        self.siteName = siteName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        startedAt = try c.decode(String.self, forKey: .startedAt)
        initiativeId = try c.decodeIfPresent(String.self, forKey: .initiativeId)
        initiativeName = try c.decodeIfPresent(String.self, forKey: .initiativeName)
        siteId = try c.decodeIfPresent(String.self, forKey: .siteId)
        siteName = try c.decodeIfPresent(String.self, forKey: .siteName)
    }
}

struct KioskTimeclockLastEntry: Codable, Equatable, Sendable {
    var id: String
    var startedAt: String
    var endedAt: String
    var minutes: Int

    enum CodingKeys: String, CodingKey {
        case id
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case minutes
    }

    init(id: String, startedAt: String, endedAt: String, minutes: Int) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.minutes = minutes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        startedAt = try c.decode(String.self, forKey: .startedAt)
        endedAt = try c.decode(String.self, forKey: .endedAt)
        minutes = try c.decode(Int.self, forKey: .minutes)
    }
}

struct KioskTimeclockStatus: Codable, Equatable, Sendable {
    var person: KioskTimeclockPerson
    var clockedIn: Bool
    var entry: KioskTimeclockEntry?
    var lastEntry: KioskTimeclockLastEntry?

    enum CodingKeys: String, CodingKey {
        case person
        case clockedIn = "clocked_in"
        case entry
        case lastEntry = "last_entry"
    }

    init(person: KioskTimeclockPerson, clockedIn: Bool, entry: KioskTimeclockEntry? = nil, lastEntry: KioskTimeclockLastEntry? = nil) {
        self.person = person
        self.clockedIn = clockedIn
        self.entry = entry
        self.lastEntry = lastEntry
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        person = try c.decode(KioskTimeclockPerson.self, forKey: .person)
        clockedIn = try c.decode(Bool.self, forKey: .clockedIn)
        entry = try c.decodeIfPresent(KioskTimeclockEntry.self, forKey: .entry)
        lastEntry = try c.decodeIfPresent(KioskTimeclockLastEntry.self, forKey: .lastEntry)
    }
}

struct ClockInIn: Codable, Equatable, Sendable {
    var serial: String
    var personId: String
    var siteId: String?
    var initiativeId: String?

    enum CodingKeys: String, CodingKey {
        case serial
        case personId = "person_id"
        case siteId = "site_id"
        case initiativeId = "initiative_id"
    }

    init(serial: String, personId: String, siteId: String? = nil, initiativeId: String? = nil) {
        self.serial = serial
        self.personId = personId
        self.siteId = siteId
        self.initiativeId = initiativeId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        personId = try c.decode(String.self, forKey: .personId)
        siteId = try c.decodeIfPresent(String.self, forKey: .siteId)
        initiativeId = try c.decodeIfPresent(String.self, forKey: .initiativeId)
    }
}

struct ClockOutIn: Codable, Equatable, Sendable {
    var serial: String
    var personId: String

    enum CodingKeys: String, CodingKey {
        case serial
        case personId = "person_id"
    }

    init(serial: String, personId: String) {
        self.serial = serial
        self.personId = personId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        personId = try c.decode(String.self, forKey: .personId)
    }
}
