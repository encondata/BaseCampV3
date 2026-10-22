import Testing
@testable import ServerSherpa_Kiosk

private struct P: MatchPerson, Equatable {
    var id: String
    var displayName: String
    var firstName: String = ""
    var lastName: String = ""
    var preferredName: String? = nil
    var rfidTag: String? = nil
    var badgeUid: String? = nil
    var isWorker: Bool = false
    var hasAccount: Bool = false
}

struct PeopleMatchTests {
    private let jimmy = P(id: "0a1b2c3d-1111-4000-8000-000000000001", displayName: "Jimmy Henderson", firstName: "James", lastName: "Henderson", preferredName: "Jimmy", rfidTag: "000000000000000000100348")
    private let tina = P(id: "ffffffff-2222-4000-8000-000000000002", displayName: "Tina Timeclock", firstName: "Tina", lastName: "Timeclock", rfidTag: "1003")
    private let smithJones = P(id: "abcdef01-3333-4000-8000-000000000003", displayName: "Ann Smith-Jones", firstName: "Ann", lastName: "Smith-Jones")
    private var index: PeopleIndex<P> { buildPeopleIndex([jimmy, tina, smithJones]) }

    @Test func exactByBadgeIgnoresPaddingAndCase() {
        #expect(matchPersonExact(index, "100348") == jimmy)
        #expect(matchPersonExact(index, "000000000000000000100348") == jimmy)
        #expect(matchPersonExact(index, "Jimmy") == nil)
    }

    @Test func exactByFullIdAndHexShortId() {
        #expect(matchPersonExact(index, jimmy.id.uppercased()) == jimmy)
        #expect(matchPersonExact(index, "0a1b2c3d") == jimmy)
        #expect(matchPersonExact(index, "abcdef01") == smithJones)
    }

    @Test func anEightLetterNameIsNeverAnId() {
        let hen = P(id: "hendersn-4444-4000-8000-000000000004", displayName: "Hen Dersn")
        let i = buildPeopleIndex([hen])
        #expect(matchPersonExact(i, "hendersn") == nil)
    }

    @Test func ambiguousPrefixOnlyForStrictPrefixes() {
        #expect(isAmbiguousPrefix(index, "1003"))          // 1003 vs 100348
        #expect(!isAmbiguousPrefix(index, "100348"))
        #expect(!isAmbiguousPrefix(index, "9999"))
    }

    @Test func searchByAnyNamePartsInAnyOrder() {
        #expect(searchPeople(index, "jim hen") == [jimmy])
        #expect(searchPeople(index, "hen jim") == [jimmy])
        #expect(searchPeople(index, "james henderson") == [jimmy])
        #expect(searchPeople(index, "henderson j") == [jimmy])
        #expect(searchPeople(index, "jones") == [smithJones])
        #expect(searchPeople(index, "tina tina") == [])   // distinct parts
        #expect(searchPeople(index, "   ") == [])
    }

    @Test func rankingExactFullNameFirstThenFewestPartsThenAlpha() {
        let t1 = P(id: "1", displayName: "Tina Timeclock", firstName: "Tina", lastName: "Timeclock")
        let t2 = P(id: "2", displayName: "Tina T", firstName: "Tina", lastName: "T")
        let t3 = P(id: "3", displayName: "Tina Timeclock Jr", firstName: "Tina", lastName: "Timeclock")
        let i = buildPeopleIndex([t3, t1, t2])
        #expect(searchPeople(i, "tina timeclock").map(\.id) == ["1", "3"])
        #expect(searchPeople(i, "tina").map(\.id) == ["2", "1", "3"])
        #expect(searchPeople(i, "tina", limit: 2).count == 2)
    }

    @Test func exactByBadgeUidInAnyCaseWithStrayWhitespace() {
        let badge = "AB12CD34-2222-4333-8444-555555555555"
        let holder = P(id: "44444444-2222-4333-8444-555555555555", displayName: "Bea Badge", badgeUid: badge.lowercased())
        let i = buildPeopleIndex([jimmy, holder])
        #expect(matchPersonExact(i, badge) == holder)
        #expect(matchPersonExact(i, "  \(badge.lowercased())\n") == holder)
        let upperStored = P(id: "55555555-2222-4333-8444-555555555555", displayName: "Cy Caps", badgeUid: "CD34EF56-2222-4333-8444-555555555555")
        #expect(matchPersonExact(buildPeopleIndex([upperStored]), "cd34ef56-2222-4333-8444-555555555555") == upperStored)
    }

    @Test func rfidBeatsBadgeAndABadgeBeatsNothing() {
        let a = P(id: "a1a1a1a1-2222-4333-8444-555555555555", displayName: "A", rfidTag: "5555")
        let b = P(id: "b1b1b1b1-2222-4333-8444-555555555555", displayName: "B", badgeUid: "b2b2b2b2-2222-4333-8444-555555555555")
        let i = buildPeopleIndex([a, b])
        #expect(matchPersonExact(i, "5555") == a)
        #expect(matchPersonExact(i, "b2b2b2b2-2222-4333-8444-555555555555") == b)
        #expect(matchPersonExact(i, "c3c3c3c3-2222-4333-8444-555555555555") == nil)
    }

    /// Order: RFID, then badge_uid, then full id, then the eight-character short id.
    @Test func aBadgeBeatsSomebodyElsesIdAndShortId() {
        let byId = P(id: "d4d4d4d4-2222-4333-8444-555555555555", displayName: "By Id")
        let byBadge = P(id: "e5e5e5e5-2222-4333-8444-555555555555", displayName: "By Badge", badgeUid: "d4d4d4d4-2222-4333-8444-555555555555")
        let shortBadge = P(id: "f6f6f6f6-2222-4333-8444-555555555555", displayName: "Short Badge", badgeUid: "d4d4d4d4")
        let i = buildPeopleIndex([byId, byBadge, shortBadge])
        #expect(matchPersonExact(i, "d4d4d4d4-2222-4333-8444-555555555555") == byBadge)
        #expect(matchPersonExact(i, "d4d4d4d4") == shortBadge)
        #expect(matchPersonExact(i, "e5e5e5e5") == byBadge)
        let tagged = P(id: "a7a7a7a7-2222-4333-8444-555555555555", displayName: "Tagged", rfidTag: "0042")
        let badged = P(id: "b8b8b8b8-2222-4333-8444-555555555555", displayName: "Badged", badgeUid: "42")
        #expect(matchPersonExact(buildPeopleIndex([badged, tagged]), "42") == tagged)
    }

    @Test func aBlankBadgeMatchesNobody() {
        let blank = P(id: "c9c9c9c9-2222-4333-8444-555555555555", displayName: "Blank", badgeUid: "   ")
        #expect(matchPersonExact(buildPeopleIndex([blank]), " ") == nil)
    }

    @Test func syncedPersonRowIsAMatchPerson() {
        let row = KioskPersonRow(id: "p1", displayName: "Ann Lee", firstName: "Ann", lastName: "Lee", badgeUid: "11111111-2222-4333-8444-555555555555")
        #expect(searchPeople(buildPeopleIndex([row]), "ann lee").map(\.id) == ["p1"])
        #expect(matchPersonExact(buildPeopleIndex([row]), "11111111-2222-4333-8444-555555555555")?.id == "p1")
    }
}
