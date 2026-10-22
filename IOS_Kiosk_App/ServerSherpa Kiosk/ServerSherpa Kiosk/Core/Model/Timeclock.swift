import Foundation

struct KioskTimeclockPerson: Codable, Equatable, Sendable {
    var id: String
    var displayName: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var avatarUrl: String?
    var rfidTag: String?
    var jobTitle: String?
    /// Shown as "Employee ID".
    var externalId: String?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case avatarUrl = "avatar_url"
        case rfidTag = "rfid_tag"
        case jobTitle = "job_title"
        case externalId = "external_id"
    }

    init(id: String, displayName: String, firstName: String = "", lastName: String = "", preferredName: String? = nil, avatarUrl: String? = nil, rfidTag: String? = nil,
         jobTitle: String? = nil, externalId: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.avatarUrl = avatarUrl
        self.rfidTag = rfidTag
        self.jobTitle = jobTitle
        self.externalId = externalId
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
        jobTitle = try c.decodeIfPresent(String.self, forKey: .jobTitle)
        externalId = try c.decodeIfPresent(String.self, forKey: .externalId)
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

/// One entry's share of today, for the Clock Out screen's list of today's punches:
/// `minutes` is clipped to today; `clockOutAt` is nil while the entry is open.
struct KioskTimeclockTodayEntry: Codable, Equatable, Sendable {
    var clockInAt: String
    var clockOutAt: String?
    var minutes: Int

    enum CodingKeys: String, CodingKey {
        case clockInAt = "clock_in_at"
        case clockOutAt = "clock_out_at"
        case minutes
    }

    init(clockInAt: String, clockOutAt: String? = nil, minutes: Int) {
        self.clockInAt = clockInAt
        self.clockOutAt = clockOutAt
        self.minutes = minutes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clockInAt = try c.decode(String.self, forKey: .clockInAt)
        clockOutAt = try c.decodeIfPresent(String.self, forKey: .clockOutAt)
        minutes = try c.decode(Int.self, forKey: .minutes)
    }
}

struct KioskTimeclockStatus: Codable, Equatable, Sendable {
    var person: KioskTimeclockPerson
    var clockedIn: Bool
    var entry: KioskTimeclockEntry?
    var lastEntry: KioskTimeclockLastEntry?
    /// Minutes worked today (the kiosk's site's day), every entry's share summed.
    var todayMinutes: Int
    /// Today's entries, oldest punch first.
    var todayEntries: [KioskTimeclockTodayEntry]

    enum CodingKeys: String, CodingKey {
        case person
        case clockedIn = "clocked_in"
        case entry
        case lastEntry = "last_entry"
        case todayMinutes = "today_minutes"
        case todayEntries = "today_entries"
    }

    init(person: KioskTimeclockPerson, clockedIn: Bool, entry: KioskTimeclockEntry? = nil, lastEntry: KioskTimeclockLastEntry? = nil,
         todayMinutes: Int = 0, todayEntries: [KioskTimeclockTodayEntry] = []) {
        self.person = person
        self.clockedIn = clockedIn
        self.entry = entry
        self.lastEntry = lastEntry
        self.todayMinutes = todayMinutes
        self.todayEntries = todayEntries
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        person = try c.decode(KioskTimeclockPerson.self, forKey: .person)
        clockedIn = try c.decode(Bool.self, forKey: .clockedIn)
        entry = try c.decodeIfPresent(KioskTimeclockEntry.self, forKey: .entry)
        lastEntry = try c.decodeIfPresent(KioskTimeclockLastEntry.self, forKey: .lastEntry)
        todayMinutes = try c.decodeIfPresent(Int.self, forKey: .todayMinutes) ?? 0
        todayEntries = try c.decodeIfPresent([KioskTimeclockTodayEntry].self, forKey: .todayEntries) ?? []
    }
}

struct ClockInIn: Codable, Equatable, Sendable {
    var serial: String
    var personId: String
    var siteId: String?
    var initiativeId: String?
    /// The kiosk's own IANA zone: "today" when the site has none.
    var tz: String?

    enum CodingKeys: String, CodingKey {
        case serial
        case personId = "person_id"
        case siteId = "site_id"
        case initiativeId = "initiative_id"
        case tz
    }

    init(serial: String, personId: String, siteId: String? = nil, initiativeId: String? = nil, tz: String? = nil) {
        self.serial = serial
        self.personId = personId
        self.siteId = siteId
        self.initiativeId = initiativeId
        self.tz = tz
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        personId = try c.decode(String.self, forKey: .personId)
        siteId = try c.decodeIfPresent(String.self, forKey: .siteId)
        initiativeId = try c.decodeIfPresent(String.self, forKey: .initiativeId)
        tz = try c.decodeIfPresent(String.self, forKey: .tz)
    }
}

struct ClockOutIn: Codable, Equatable, Sendable {
    var serial: String
    var personId: String
    /// As `ClockInIn.tz`.
    var tz: String?

    enum CodingKeys: String, CodingKey {
        case serial
        case personId = "person_id"
        case tz
    }

    init(serial: String, personId: String, tz: String? = nil) {
        self.serial = serial
        self.personId = personId
        self.tz = tz
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        personId = try c.decode(String.self, forKey: .personId)
        tz = try c.decodeIfPresent(String.self, forKey: .tz)
    }
}

/// A Time Clock station's punch under its station key, for both clock-in and
/// clock-out (api `KioskStationClockIn`): no site or move, the device's setup holds them.
struct StationClockIn: Codable, Equatable, Sendable {
    var serial: String
    var personId: String
    var tz: String?

    enum CodingKeys: String, CodingKey {
        case serial
        case personId = "person_id"
        case tz
    }

    init(serial: String, personId: String, tz: String? = nil) {
        self.serial = serial
        self.personId = personId
        self.tz = tz
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serial = try c.decode(String.self, forKey: .serial)
        personId = try c.decode(String.self, forKey: .personId)
        tz = try c.decodeIfPresent(String.self, forKey: .tz)
    }
}

/// `POST /kiosk/station-key`'s body and answer: the key is shown once.
struct StationKeyIn: Codable, Equatable, Sendable {
    var serial: String
}

struct StationKeyOut: Codable, Equatable, Sendable {
    var key: String
}
