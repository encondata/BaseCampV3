import Foundation

// firstName/lastName are non-optional here (Kotlin's null reads as "" in
// every use), so the synced `KioskPersonRow` conforms directly.
protocol MatchPerson {
    var id: String { get }
    var displayName: String { get }
    var firstName: String { get }
    var lastName: String { get }
    var preferredName: String? { get }
    var rfidTag: String? { get }
    var isWorker: Bool { get }
    var hasAccount: Bool { get }
}

extension KioskPersonRow: MatchPerson {}

private struct Entry<P: MatchPerson> {
    var person: P
    var parts: [String]
    var fullNames: [String]
    var sortKey: String
}

struct PeopleIndex<P: MatchPerson> {
    var byRfid: [String: P]
    /// Full id and the eight-character short id, both lower-cased.
    var byId: [String: P]
    fileprivate var entries: [Entry<P>]
    var size: Int
}

private func isShortId(_ s: String) -> Bool {
    s.utf8.count == 8 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) || ($0 >= 0x41 && $0 <= 0x46) }
}

private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

private func collapsed(_ s: String) -> String {
    s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// Whitespace or a hyphen starts a new part ("Smith-Jones" → smith, jones).
private func words(_ value: String?) -> [String] {
    trimmed(value ?? "").lowercased().split(whereSeparator: { $0.isWhitespace || $0 == "-" }).map(String.init)
}

private func peopleRfidKey(_ value: String?) -> String? {
    guard let value, !trimmed(value).isEmpty else { return nil }
    let k = displayRfid(trimmed(value)).uppercased()
    return k.isEmpty ? nil : k
}

private func entryFor<P: MatchPerson>(_ person: P) -> Entry<P> {
    var parts: [String] = []
    func push(_ w: String) { if !w.isEmpty && !parts.contains(w) { parts.append(w) } }
    for source in [person.firstName, person.lastName, person.preferredName] { words(source).forEach(push) }
    words(person.displayName).forEach(push)

    let first = trimmed(person.firstName).lowercased()
    let last = trimmed(person.lastName).lowercased()
    let preferred = trimmed(person.preferredName ?? "").lowercased()
    var fullNames: [String] = []
    func pushFull(_ name: String) {
        let c = collapsed(name)
        if !c.isEmpty && !fullNames.contains(c) { fullNames.append(c) }
    }
    pushFull(person.displayName.lowercased())
    if !first.isEmpty && !last.isEmpty { pushFull("\(first) \(last)") }
    if !preferred.isEmpty && !last.isEmpty { pushFull("\(preferred) \(last)") }
    return Entry(person: person, parts: parts, fullNames: fullNames, sortKey: person.displayName.lowercased())
}

func buildPeopleIndex<P: MatchPerson>(_ people: [P]) -> PeopleIndex<P> {
    var byRfid: [String: P] = [:]
    var byId: [String: P] = [:]
    var entries: [Entry<P>] = []
    entries.reserveCapacity(people.count)
    for person in people {
        if let k = peopleRfidKey(person.rfidTag), byRfid[k] == nil { byRfid[k] = person }
        let id = trimmed(person.id).lowercased()
        if !id.isEmpty, byId[id] == nil { byId[id] = person }
        let short = String(id.prefix(8))
        if short.count == 8, byId[short] == nil { byId[short] = person }
        entries.append(entryFor(person))
    }
    return PeopleIndex(byRfid: byRfid, byId: byId, entries: entries, size: people.count)
}

/// The badge/id door: a value naming exactly one person, or nil.
func matchPersonExact<P: MatchPerson>(_ index: PeopleIndex<P>, _ raw: String) -> P? {
    let t = trimmed(raw)
    if t.isEmpty { return nil }
    if let k = peopleRfidKey(t), let p = index.byRfid[k] { return p }
    let lower = t.lowercased()
    guard let byId = index.byId[lower] else { return nil }
    // The eight-character short form only counts when it looks like hex.
    return (lower.count != 8 || isShortId(lower)) ? byId : nil
}

/// True when `raw` is an exact tag AND a strict prefix of a longer tag
/// ("1003" vs "100348") — too soon to auto-select mid-scan.
func isAmbiguousPrefix<P: MatchPerson>(_ index: PeopleIndex<P>, _ raw: String) -> Bool {
    guard let tag = peopleRfidKey(trimmed(raw)), index.byRfid[tag] != nil else { return false }
    return index.byRfid.keys.contains { $0 != tag && $0.hasPrefix(tag) }
}

/// Every term is a prefix of a distinct part — a tiny bipartite match.
private func assign(_ terms: [String], _ parts: [String]) -> Bool {
    if terms.count > parts.count { return false }
    var used = [Bool](repeating: false, count: parts.count)
    func go(_ i: Int) -> Bool {
        if i == terms.count { return true }
        for j in parts.indices {
            if used[j] || !parts[j].hasPrefix(terms[i]) { continue }
            used[j] = true
            if go(i + 1) { return true }
            used[j] = false
        }
        return false
    }
    return go(0)
}

/// The typed-name door: full-name matches first, then fewest name parts, then alphabetical.
func searchPeople<P: MatchPerson>(_ index: PeopleIndex<P>, _ query: String, limit: Int = 8) -> [P] {
    let terms = trimmed(query).lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
    if terms.isEmpty { return [] }
    let typed = terms.joined(separator: " ")
    let hits = index.entries.enumerated().filter { assign(terms, $0.element.parts) }
    let sorted = hits.sorted { a, b in
        let ra = a.element.fullNames.contains(typed) ? 0 : 1
        let rb = b.element.fullNames.contains(typed) ? 0 : 1
        if ra != rb { return ra < rb }
        if a.element.parts.count != b.element.parts.count { return a.element.parts.count < b.element.parts.count }
        if a.element.sortKey != b.element.sortKey {
            return a.element.sortKey.utf16.lexicographicallyPrecedes(b.element.sortKey.utf16)
        }
        return a.offset < b.offset  // stable, as Kotlin's sortedWith
    }
    return sorted.prefix(limit).map { $0.element.person }
}
