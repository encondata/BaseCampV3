import Foundation

/// The worker edit form's fields, as typed. Text fields are never nil (a blank one
/// means "none"); `partnerId` and `level` are nil for None; `status` is a status key.
/// Also the New worker form (whose status isn't shown or sent).
struct RolodexEdit: Equatable, Sendable {
    var firstName = ""
    var lastName = ""
    var preferredName = ""
    var jobTitle = ""
    var phone = ""
    var email = ""
    var partnerId: String? = nil
    var trade = ""
    var level: String? = nil
    var status = ""
    var statusNote = ""
}

extension RolodexEdit {
    /// The form as it opens for `detail`.
    init(_ detail: RolodexDetail) {
        self.init(firstName: detail.firstName, lastName: detail.lastName, preferredName: detail.preferredName ?? "",
                  jobTitle: detail.jobTitle ?? "", phone: detail.phone ?? "", email: detail.email ?? "",
                  partnerId: detail.company?.id, trade: detail.trade ?? "", level: detail.level,
                  status: detail.status, statusNote: detail.statusNote ?? "")
    }
}

/// The Rolodex list rules both apps share (the plan's "Shared client logic"; Android
/// `core/people/Rolodex.kt` mirrors this function for function).
enum RolodexLogic {
    /// The one status that needs a note (the portal's `WORKER_BLACKLIST`).
    static let blacklistKey = "blacklist"
    static let filterAll = "all"
    static let filterNoPhoto = "no_photo"

    // MARK: fold, sort, sections

    /// Lowercased, accents stripped (`Núñez` → `nunez`), and anything but letters and
    /// digits dropped inside each word (`O'Brien` → `obrien`). Words stay apart by one space.
    static func fold(_ s: String?) -> String {
        guard let s, !s.isEmpty else { return "" }
        return s.lowercased().decomposedStringWithCanonicalMapping
            .split(whereSeparator: \.isWhitespace)
            .map { word in
                var kept = String.UnicodeScalarView()
                kept.append(contentsOf: word.unicodeScalars.filter(isLetterOrDigit))
                return String(kept)
            }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Letters and numbers in any script (Android's `\p{L}\p{N}`). The combining
    /// accents NFD split off are marks, so they go.
    private static func isLetterOrDigit(_ u: Unicode.Scalar) -> Bool {
        switch u.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: true
        default: false
        }
    }

    /// By folded last name, then folded first name, then person id.
    static func sortRows(_ rows: [RolodexRow]) -> [RolodexRow] {
        rows.map { (key: (fold($0.lastName), fold($0.firstName), $0.personId), row: $0) }
            .sorted { $0.key < $1.key }
            .map(\.row)
    }

    /// The folded last name's first letter when it is `a`–`z` (uppercased), else `#`.
    static func sectionLetter(lastName: String) -> String {
        guard let first = fold(lastName).unicodeScalars.first, ("a"..."z").contains(first) else { return "#" }
        return String(first).uppercased()
    }

    /// The rows sorted and grouped by `sectionLetter`: A–Z, then `#` last (as Contacts).
    static func sections(_ rows: [RolodexRow]) -> [(String, [RolodexRow])] {
        var groups: [String: [RolodexRow]] = [:]
        for row in sortRows(rows) { groups[sectionLetter(lastName: row.lastName), default: []].append(row) }
        return groups.keys
            .sorted { a, b in a == "#" ? false : b == "#" ? true : a < b }
            .map { ($0, groups[$0]!) }
    }

    // MARK: search and filters

    /// Every whitespace-separated query term (folded) must prefix a word of the first,
    /// last or preferred name, job title or company. The words are each field's
    /// whitespace-split words, folded whole (`Smith-Jones` → `smithjones`, so
    /// "smith-jones" finds it) and also split on hyphens (`smith`, `jones`). An empty
    /// query matches everyone.
    static func matches(_ row: RolodexRow, query: String) -> Bool {
        let terms = query.split(whereSeparator: \.isWhitespace).map { fold(String($0)) }.filter { !$0.isEmpty }
        if terms.isEmpty { return true }
        let words = [row.firstName, row.lastName, row.preferredName, row.jobTitle, row.company?.name]
            .compactMap { $0 }
            .flatMap { $0.split(whereSeparator: \.isWhitespace) }
            .flatMap { word in [fold(String(word))] + word.split(separator: "-").map { fold(String($0)) } }
            .filter { !$0.isEmpty }
        return terms.allSatisfy { term in words.contains { $0.hasPrefix(term) } }
    }

    /// `all`, a status key, or `no_photo`.
    static func applyFilter(_ rows: [RolodexRow], filter: String) -> [RolodexRow] {
        switch filter {
        case filterAll: rows
        case filterNoPhoto: rows.filter { !$0.hasPhoto }
        default: rows.filter { $0.status == filter }
        }
    }

    /// A count per filter chip (`all`, each status key, `no_photo`) over `rows`, which the
    /// caller has already narrowed by the search.
    static func filterCounts(_ rows: [RolodexRow], statusKeys: [String]) -> [String: Int] {
        var counts = [filterAll: rows.count, filterNoPhoto: rows.filter { !$0.hasPhoto }.count]
        for key in statusKeys { counts[key] = rows.filter { $0.status == key }.count }
        return counts
    }

    // MARK: edit

    /// Trimmed; nil when blank.
    static func clean(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    /// Only the fields `edited` changed from `original`, trimmed; a field cleared to
    /// blank or None goes out as null. A blank status is never sent (it can't be cleared).
    static func buildPatch(original: RolodexDetail, edited: RolodexEdit) -> RolodexPatch {
        let pairs: [(RolodexPatch.Field, String?, String?)] = [
            (.firstName, original.firstName, edited.firstName),
            (.lastName, original.lastName, edited.lastName),
            (.preferredName, original.preferredName, edited.preferredName),
            (.jobTitle, original.jobTitle, edited.jobTitle),
            (.phone, original.phone, edited.phone),
            (.email, original.email, edited.email),
            (.partnerId, original.company?.id, edited.partnerId),
            (.trade, original.trade, edited.trade),
            (.level, original.level, edited.level),
            (.statusNote, original.statusNote, edited.statusNote),
        ]
        var patch = RolodexPatch()
        for (field, before, after) in pairs {
            let value = clean(after)
            if clean(before) != value { patch.set(field, value) }
        }
        if let status = clean(edited.status), status != clean(original.status) { patch.set(.status, status) }
        return patch
    }

    /// The first problem that blocks saving, as shown to the admin, or nil.
    static func validate(_ edit: RolodexEdit) -> String? {
        if clean(edit.firstName) == nil || clean(edit.lastName) == nil { return "First and last name are required." }
        if clean(edit.status) == blacklistKey && clean(edit.statusNote) == nil { return "Add a note to blacklist someone." }
        return nil
    }
}
