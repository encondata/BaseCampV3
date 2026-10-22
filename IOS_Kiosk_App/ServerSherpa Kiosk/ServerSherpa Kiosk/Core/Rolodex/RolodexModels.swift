import Foundation

// Wire models for `/kiosk/rolodex/*` (the plan's API contract). Rows and the list
// never carry email or phone: they load with the worker's detail only.

struct RolodexCompany: Codable, Equatable, Hashable, Sendable {
    var id: String
    var name: String
}

/// One worker in the list (and in the offline cache).
struct RolodexRow: Codable, Equatable, Sendable, Identifiable {
    var personId: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var displayName: String
    var jobTitle: String?
    var company: RolodexCompany?
    var trade: String?
    var level: String?
    var levelColor: String?
    var status: String
    var statusLabel: String
    var statusColor: String?
    var hasPhoto: Bool
    /// Presigned and short-lived: cache photo bytes by `personId` + `photoVersion`, never by URL.
    var photoUrl: String?
    var photoVersion: String?
    var rfidEnrolled: Bool
    var hasAccount: Bool

    var id: String { personId }

    enum CodingKeys: String, CodingKey {
        case personId = "person_id"
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case displayName = "display_name"
        case jobTitle = "job_title"
        case company, trade, level
        case levelColor = "level_color"
        case status
        case statusLabel = "status_label"
        case statusColor = "status_color"
        case hasPhoto = "has_photo"
        case photoUrl = "photo_url"
        case photoVersion = "photo_version"
        case rfidEnrolled = "rfid_enrolled"
        case hasAccount = "has_account"
    }

    init(personId: String, firstName: String = "", lastName: String = "", preferredName: String? = nil, displayName: String = "",
         jobTitle: String? = nil, company: RolodexCompany? = nil, trade: String? = nil, level: String? = nil, levelColor: String? = nil,
         status: String = "active", statusLabel: String = "", statusColor: String? = nil, hasPhoto: Bool = false,
         photoUrl: String? = nil, photoVersion: String? = nil, rfidEnrolled: Bool = false, hasAccount: Bool = false) {
        self.personId = personId
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.displayName = displayName
        self.jobTitle = jobTitle
        self.company = company
        self.trade = trade
        self.level = level
        self.levelColor = levelColor
        self.status = status
        self.statusLabel = statusLabel
        self.statusColor = statusColor
        self.hasPhoto = hasPhoto
        self.photoUrl = photoUrl
        self.photoVersion = photoVersion
        self.rfidEnrolled = rfidEnrolled
        self.hasAccount = hasAccount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personId = try c.decode(String.self, forKey: .personId)
        firstName = try c.decodeIfPresent(String.self, forKey: .firstName) ?? ""
        lastName = try c.decodeIfPresent(String.self, forKey: .lastName) ?? ""
        preferredName = try c.decodeIfPresent(String.self, forKey: .preferredName)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        jobTitle = try c.decodeIfPresent(String.self, forKey: .jobTitle)
        company = try c.decodeIfPresent(RolodexCompany.self, forKey: .company)
        trade = try c.decodeIfPresent(String.self, forKey: .trade)
        level = try c.decodeIfPresent(String.self, forKey: .level)
        levelColor = try c.decodeIfPresent(String.self, forKey: .levelColor)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel) ?? ""
        statusColor = try c.decodeIfPresent(String.self, forKey: .statusColor)
        hasPhoto = try c.decodeIfPresent(Bool.self, forKey: .hasPhoto) ?? false
        photoUrl = try c.decodeIfPresent(String.self, forKey: .photoUrl)
        photoVersion = try c.decodeIfPresent(String.self, forKey: .photoVersion)
        rfidEnrolled = try c.decodeIfPresent(Bool.self, forKey: .rfidEnrolled) ?? false
        hasAccount = try c.decodeIfPresent(Bool.self, forKey: .hasAccount) ?? false
    }
}

/// `GET /kiosk/rolodex/workers`.
struct RolodexList: Codable, Equatable, Sendable {
    var generatedAt: String
    var workers: [RolodexRow]

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case workers
    }

    init(generatedAt: String = "", workers: [RolodexRow] = []) {
        self.generatedAt = generatedAt
        self.workers = workers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decodeIfPresent(String.self, forKey: .generatedAt) ?? ""
        workers = try c.decodeIfPresent([RolodexRow].self, forKey: .workers) ?? []
    }
}

/// `GET /kiosk/rolodex/workers/{id}` (and the answer to create and edit): the row's
/// fields plus contact details and what the signed-in admin may change.
struct RolodexDetail: Codable, Equatable, Sendable, Identifiable {
    var personId: String
    var firstName: String
    var lastName: String
    var preferredName: String?
    var displayName: String
    var jobTitle: String?
    var company: RolodexCompany?
    var trade: String?
    var level: String?
    var levelColor: String?
    var status: String
    var statusLabel: String
    var statusColor: String?
    var hasPhoto: Bool
    var photoUrl: String?
    var photoVersion: String?
    var rfidEnrolled: Bool
    var hasAccount: Bool
    var email: String?
    var phone: String?
    /// Shown as "Employee ID" (read-only here).
    var externalId: String?
    var statusNote: String?
    var canEdit: Bool
    var canChangeStatus: Bool
    /// `rank_too_low` or nil.
    var editBlockReason: String?
    /// `self`, `rank_too_low` or nil.
    var statusBlockReason: String?

    var id: String { personId }

    enum CodingKeys: String, CodingKey {
        case personId = "person_id"
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case displayName = "display_name"
        case jobTitle = "job_title"
        case company, trade, level
        case levelColor = "level_color"
        case status
        case statusLabel = "status_label"
        case statusColor = "status_color"
        case hasPhoto = "has_photo"
        case photoUrl = "photo_url"
        case photoVersion = "photo_version"
        case rfidEnrolled = "rfid_enrolled"
        case hasAccount = "has_account"
        case email, phone
        case externalId = "external_id"
        case statusNote = "status_note"
        case canEdit = "can_edit"
        case canChangeStatus = "can_change_status"
        case editBlockReason = "edit_block_reason"
        case statusBlockReason = "status_block_reason"
    }

    init(row: RolodexRow, email: String? = nil, phone: String? = nil, externalId: String? = nil, statusNote: String? = nil,
         canEdit: Bool = false, canChangeStatus: Bool = false, editBlockReason: String? = nil, statusBlockReason: String? = nil) {
        personId = row.personId
        firstName = row.firstName
        lastName = row.lastName
        preferredName = row.preferredName
        displayName = row.displayName
        jobTitle = row.jobTitle
        company = row.company
        trade = row.trade
        level = row.level
        levelColor = row.levelColor
        status = row.status
        statusLabel = row.statusLabel
        statusColor = row.statusColor
        hasPhoto = row.hasPhoto
        photoUrl = row.photoUrl
        photoVersion = row.photoVersion
        rfidEnrolled = row.rfidEnrolled
        hasAccount = row.hasAccount
        self.email = email
        self.phone = phone
        self.externalId = externalId
        self.statusNote = statusNote
        self.canEdit = canEdit
        self.canChangeStatus = canChangeStatus
        self.editBlockReason = editBlockReason
        self.statusBlockReason = statusBlockReason
    }

    init(from decoder: Decoder) throws {
        self.init(row: try RolodexRow(from: decoder))
        let c = try decoder.container(keyedBy: CodingKeys.self)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        phone = try c.decodeIfPresent(String.self, forKey: .phone)
        externalId = try c.decodeIfPresent(String.self, forKey: .externalId)
        statusNote = try c.decodeIfPresent(String.self, forKey: .statusNote)
        canEdit = try c.decodeIfPresent(Bool.self, forKey: .canEdit) ?? false
        canChangeStatus = try c.decodeIfPresent(Bool.self, forKey: .canChangeStatus) ?? false
        editBlockReason = try c.decodeIfPresent(String.self, forKey: .editBlockReason)
        statusBlockReason = try c.decodeIfPresent(String.self, forKey: .statusBlockReason)
    }

    /// The list row for this worker (no email or phone).
    var row: RolodexRow {
        RolodexRow(personId: personId, firstName: firstName, lastName: lastName, preferredName: preferredName, displayName: displayName,
                   jobTitle: jobTitle, company: company, trade: trade, level: level, levelColor: levelColor, status: status,
                   statusLabel: statusLabel, statusColor: statusColor, hasPhoto: hasPhoto, photoUrl: photoUrl, photoVersion: photoVersion,
                   rfidEnrolled: rfidEnrolled, hasAccount: hasAccount)
    }
}

struct RolodexLevel: Codable, Equatable, Sendable, Identifiable {
    var level: String
    var title: String
    var color: String?

    var id: String { level }

    init(level: String, title: String = "", color: String? = nil) {
        self.level = level
        self.title = title
        self.color = color
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = try c.decode(String.self, forKey: .level)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        color = try c.decodeIfPresent(String.self, forKey: .color)
    }
}

struct RolodexStatus: Codable, Equatable, Sendable, Identifiable {
    var key: String
    var label: String
    var color: String?

    var id: String { key }

    init(key: String, label: String = "", color: String? = nil) {
        self.key = key
        self.label = label
        self.color = color
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        color = try c.decodeIfPresent(String.self, forKey: .color)
    }
}

struct RolodexPartner: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
}

/// `GET /kiosk/rolodex/options`: active statuses, levels in rank order, non-archived partners.
struct RolodexOptions: Codable, Equatable, Sendable {
    var levels: [RolodexLevel]
    var statuses: [RolodexStatus]
    var partners: [RolodexPartner]

    init(levels: [RolodexLevel] = [], statuses: [RolodexStatus] = [], partners: [RolodexPartner] = []) {
        self.levels = levels
        self.statuses = statuses
        self.partners = partners
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        levels = try c.decodeIfPresent([RolodexLevel].self, forKey: .levels) ?? []
        statuses = try c.decodeIfPresent([RolodexStatus].self, forKey: .statuses) ?? []
        partners = try c.decodeIfPresent([RolodexPartner].self, forKey: .partners) ?? []
    }
}

/// `POST /kiosk/rolodex/duplicates` (names go in the body, never a URL). Nil fields are left out.
struct RolodexDuplicatesIn: Codable, Equatable, Sendable {
    var firstName: String
    var lastName: String
    var preferredName: String?
    var email: String?
    var phone: String?

    enum CodingKeys: String, CodingKey {
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case email, phone
    }

    init(firstName: String, lastName: String, preferredName: String? = nil, email: String? = nil, phone: String? = nil) {
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.email = email
        self.phone = phone
    }
}

/// `{"matches": [...]}`, unwrapped by `KioskApi.rolodexDuplicates`.
struct RolodexDuplicatesOut: Codable, Equatable, Sendable {
    var matches: [RolodexMatch]

    init(matches: [RolodexMatch] = []) { self.matches = matches }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        matches = try c.decodeIfPresent([RolodexMatch].self, forKey: .matches) ?? []
    }
}

/// A person who may be the one being created. `company` is the company's name.
struct RolodexMatch: Codable, Equatable, Sendable, Identifiable {
    var personId: String
    var displayName: String
    var jobTitle: String?
    var company: String?
    var isWorker: Bool
    var hasAccount: Bool
    var photoUrl: String?
    var photoVersion: String?
    /// Any of `name`, `email`, `phone`.
    var matchedOn: [String]

    var id: String { personId }

    enum CodingKeys: String, CodingKey {
        case personId = "person_id"
        case displayName = "display_name"
        case jobTitle = "job_title"
        case company
        case isWorker = "is_worker"
        case hasAccount = "has_account"
        case photoUrl = "photo_url"
        case photoVersion = "photo_version"
        case matchedOn = "matched_on"
    }

    init(personId: String, displayName: String = "", jobTitle: String? = nil, company: String? = nil, isWorker: Bool = false,
         hasAccount: Bool = false, photoUrl: String? = nil, photoVersion: String? = nil, matchedOn: [String] = []) {
        self.personId = personId
        self.displayName = displayName
        self.jobTitle = jobTitle
        self.company = company
        self.isWorker = isWorker
        self.hasAccount = hasAccount
        self.photoUrl = photoUrl
        self.photoVersion = photoVersion
        self.matchedOn = matchedOn
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personId = try c.decode(String.self, forKey: .personId)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        jobTitle = try c.decodeIfPresent(String.self, forKey: .jobTitle)
        company = try c.decodeIfPresent(String.self, forKey: .company)
        isWorker = try c.decodeIfPresent(Bool.self, forKey: .isWorker) ?? false
        hasAccount = try c.decodeIfPresent(Bool.self, forKey: .hasAccount) ?? false
        photoUrl = try c.decodeIfPresent(String.self, forKey: .photoUrl)
        photoVersion = try c.decodeIfPresent(String.self, forKey: .photoVersion)
        matchedOn = try c.decodeIfPresent([String].self, forKey: .matchedOn) ?? []
    }
}

/// `POST /kiosk/rolodex/workers`. Nil fields are left out; status starts Active on the server.
struct RolodexCreateIn: Codable, Equatable, Sendable {
    var firstName: String
    var lastName: String
    var preferredName: String?
    var jobTitle: String?
    var phone: String?
    var email: String?
    var partnerId: String?
    var trade: String?
    var level: String?
    /// Create even though `/duplicates` found a match (else 409 `possible_duplicate`).
    var allowDuplicate: Bool
    /// The admin confirmed "Create without photo"; the server records it in the audit row.
    var photoSkipped: Bool

    enum CodingKeys: String, CodingKey {
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case jobTitle = "job_title"
        case phone, email
        case partnerId = "partner_id"
        case trade, level
        case allowDuplicate = "allow_duplicate"
        case photoSkipped = "photo_skipped"
    }

    init(firstName: String, lastName: String, preferredName: String? = nil, jobTitle: String? = nil, phone: String? = nil,
         email: String? = nil, partnerId: String? = nil, trade: String? = nil, level: String? = nil,
         allowDuplicate: Bool = false, photoSkipped: Bool = false) {
        self.firstName = firstName
        self.lastName = lastName
        self.preferredName = preferredName
        self.jobTitle = jobTitle
        self.phone = phone
        self.email = email
        self.partnerId = partnerId
        self.trade = trade
        self.level = level
        self.allowDuplicate = allowDuplicate
        self.photoSkipped = photoSkipped
    }

    /// The New worker form's fields, trimmed, with blank ones left out (status isn't sent).
    init(_ edit: RolodexEdit, allowDuplicate: Bool = false, photoSkipped: Bool = false) {
        self.init(firstName: RolodexLogic.clean(edit.firstName) ?? "", lastName: RolodexLogic.clean(edit.lastName) ?? "",
                  preferredName: RolodexLogic.clean(edit.preferredName), jobTitle: RolodexLogic.clean(edit.jobTitle),
                  phone: RolodexLogic.clean(edit.phone), email: RolodexLogic.clean(edit.email),
                  partnerId: RolodexLogic.clean(edit.partnerId), trade: RolodexLogic.clean(edit.trade), level: RolodexLogic.clean(edit.level),
                  allowDuplicate: allowDuplicate, photoSkipped: photoSkipped)
    }
}

/// `PATCH /kiosk/rolodex/workers/{id}`: only the fields that changed. A field mapped to
/// nil is sent as JSON `null` (the server clears it); a field not in `fields` is left out
/// (unchanged). The synthesized encoder would drop nils, so `encode(to:)` is written out.
/// `fields` is read-only outside: `fields[.phone] = nil` would delete the key, not clear it.
struct RolodexPatch: Codable, Equatable, Sendable {
    enum Field: String, CodingKey, CaseIterable, Sendable {
        case firstName = "first_name"
        case lastName = "last_name"
        case preferredName = "preferred_name"
        case jobTitle = "job_title"
        case phone, email
        case partnerId = "partner_id"
        case trade, level, status
        case statusNote = "status_note"
    }

    private(set) var fields: [Field: String?]

    init(_ fields: [Field: String?] = [:]) { self.fields = fields }

    var isEmpty: Bool { fields.isEmpty }

    /// Sends `field` as `value`; nil sends `null` (clears it).
    mutating func set(_ field: Field, _ value: String?) { fields[field] = .some(value) }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Field.self)
        for (field, value) in fields {
            if let value { try c.encode(value, forKey: field) } else { try c.encodeNil(forKey: field) }
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Field.self)
        var fields: [Field: String?] = [:]
        for field in c.allKeys {
            let value: String? = try c.decodeNil(forKey: field) ? nil : c.decode(String.self, forKey: field)
            fields[field] = .some(value)
        }
        self.fields = fields
    }
}

/// `PUT /kiosk/rolodex/workers/{id}/photo`.
struct RolodexPhotoOut: Codable, Equatable, Sendable {
    var photoUrl: String?
    var photoVersion: String?

    enum CodingKeys: String, CodingKey {
        case photoUrl = "photo_url"
        case photoVersion = "photo_version"
    }

    init(photoUrl: String? = nil, photoVersion: String? = nil) {
        self.photoUrl = photoUrl
        self.photoVersion = photoVersion
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        photoUrl = try c.decodeIfPresent(String.self, forKey: .photoUrl)
        photoVersion = try c.decodeIfPresent(String.self, forKey: .photoVersion)
    }
}
