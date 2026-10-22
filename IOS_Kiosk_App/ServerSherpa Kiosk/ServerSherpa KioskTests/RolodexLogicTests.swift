import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The shared client rules (plan Global Constraints, "Shared client logic"), with the
/// same names and cases as Android's RolodexTest.
struct RolodexLogicTests {
    private func row(_ id: String, _ first: String, _ last: String, preferred: String? = nil, job: String? = nil,
                     company: String? = nil, status: String = "active", hasPhoto: Bool = true) -> RolodexRow {
        RolodexRow(personId: id, firstName: first, lastName: last, preferredName: preferred,
                   displayName: "\(preferred ?? first) \(last)", jobTitle: job,
                   company: company.map { RolodexCompany(id: "c-\($0)", name: $0) },
                   status: status, statusLabel: status.capitalized, hasPhoto: hasPhoto)
    }

    private var crew: [RolodexRow] {
        [
            row("p1", "Amy", "Zane"),
            row("p2", "Bo", "Núñez", job: "Mover"),
            row("p3", "Pat", "O'Brien"),
            row("p4", "Maria", "de la Cruz", status: "standby"),
            row("p5", "Team", "3M Crew", hasPhoto: false),
            row("p6", "Zed", "Adams", status: "blacklist"),
            row("p7", "Ana", "Ortiz", job: "Rigger", company: "Summit Crew", hasPhoto: false),
            row("p8", "Ned", "Nolan"),
            row("p9", "Ike", "Nunn"),
        ]
    }

    private func json(_ patch: RolodexPatch) throws -> String {
        String(decoding: try KioskJSON.encoder.encode(patch), as: UTF8.self)
    }

    // MARK: fold

    @Test func foldLowercasesStripsAccentsAndDropsPunctuationInsideWords() {
        #expect(RolodexLogic.fold("Núñez") == "nunez")
        #expect(RolodexLogic.fold("Ñúñez") == "nunez")
        #expect(RolodexLogic.fold("O'Brien") == "obrien")
        #expect(RolodexLogic.fold("Smith-Jones") == "smithjones")
        #expect(RolodexLogic.fold("  de  la Cruz ") == "de la cruz")
        #expect(RolodexLogic.fold("3M Crew") == "3m crew")
        #expect(RolodexLogic.fold("") == "")
        #expect(RolodexLogic.fold(nil) == "")
    }

    // MARK: sort and sections

    @Test func sortsByFoldedLastNameThenFirstNameThenPersonId() {
        let twins = [row("b", "Lee", "Kim"), row("a", "Lee", "Kim"), row("c", "Al", "Kim")]
        let sorted = RolodexLogic.sortRows(crew + twins)
        #expect(sorted.map(\.personId) == ["p5", "p6", "p4", "c", "a", "b", "p8", "p2", "p9", "p3", "p7", "p1"])
    }

    @Test func nunezSortsAsNunezNotAfterZ() throws {
        let names = RolodexLogic.sortRows(crew).map(\.lastName)
        let n = try #require(names.firstIndex(of: "Núñez"))
        #expect(names[n - 1] == "Nolan")
        #expect(names[n + 1] == "Nunn")
    }

    @Test func sectionLetterIsTheFoldedFirstLetterOrHash() {
        #expect(RolodexLogic.sectionLetter(lastName: "Núñez") == "N")
        #expect(RolodexLogic.sectionLetter(lastName: "Ñúñez") == "N")
        #expect(RolodexLogic.sectionLetter(lastName: "de la Cruz") == "D")
        #expect(RolodexLogic.sectionLetter(lastName: "O'Brien") == "O")
        #expect(RolodexLogic.sectionLetter(lastName: "3M Crew") == "#")
        #expect(RolodexLogic.sectionLetter(lastName: "") == "#")
    }

    @Test func sectionsGroupSortedRowsWithHashLast() {
        let sections = RolodexLogic.sections(crew)
        #expect(sections.map(\.0) == ["A", "D", "N", "O", "Z", "#"])
        let byLetter = Dictionary(uniqueKeysWithValues: sections.map { ($0.0, $0.1.map(\.lastName)) })
        #expect(byLetter["N"] == ["Nolan", "Núñez", "Nunn"])
        #expect(byLetter["D"] == ["de la Cruz"])
        #expect(byLetter["O"] == ["O'Brien", "Ortiz"])
        #expect(byLetter["#"] == ["3M Crew"])
    }

    // MARK: search

    @Test func searchMatchesWordPrefixesAcrossNameJobAndCompany() {
        let rows = Dictionary(uniqueKeysWithValues: crew.map { ($0.personId, $0) })
        #expect(RolodexLogic.matches(rows["p3"]!, query: "obr"))
        #expect(RolodexLogic.matches(rows["p3"]!, query: "O'Br"))
        #expect(RolodexLogic.matches(rows["p4"]!, query: "cruz"))
        #expect(RolodexLogic.matches(rows["p2"]!, query: "nunez"))
        #expect(RolodexLogic.matches(rows["p2"]!, query: "NÚÑ"))
        #expect(RolodexLogic.matches(rows["p7"]!, query: "rig sum"))
        #expect(RolodexLogic.matches(rows["p7"]!, query: "  summit   ana "))
        #expect(!RolodexLogic.matches(rows["p7"]!, query: "rig zzz"))
        #expect(!RolodexLogic.matches(rows["p3"]!, query: "rien"))
    }

    @Test func searchCoversPreferredNameAndHyphenatedWords() {
        let r = row("x", "Robert", "Smith-Jones", preferred: "Bobby")
        #expect(RolodexLogic.matches(r, query: "bob"))
        #expect(RolodexLogic.matches(r, query: "jon"))
        #expect(RolodexLogic.matches(r, query: "smi rob"))
    }

    @Test func emptyQueryMatchesEveryone() {
        #expect(crew.allSatisfy { RolodexLogic.matches($0, query: "") })
        #expect(crew.allSatisfy { RolodexLogic.matches($0, query: "   ") })
    }

    // MARK: filters

    @Test func filtersByAllStatusKeyAndNoPhoto() {
        #expect(RolodexLogic.applyFilter(crew, filter: "all").count == crew.count)
        #expect(RolodexLogic.applyFilter(crew, filter: "standby").map(\.personId) == ["p4"])
        #expect(RolodexLogic.applyFilter(crew, filter: "blacklist").map(\.personId) == ["p6"])
        #expect(RolodexLogic.applyFilter(crew, filter: "no_photo").map(\.personId) == ["p5", "p7"])
    }

    @Test func filterCountsIncludeAllEachStatusAndNoPhoto() {
        let counts = RolodexLogic.filterCounts(crew, statusKeys: ["active", "standby", "blacklist"])
        #expect(counts == ["all": 9, "active": 7, "standby": 1, "blacklist": 1, "no_photo": 2])
    }

    @Test func filterCountsAreTakenOverTheSearchFilteredList() {
        let searched = crew.filter { RolodexLogic.matches($0, query: "o") }   // O'Brien, Ortiz
        let counts = RolodexLogic.filterCounts(searched, statusKeys: ["active", "standby", "blacklist"])
        #expect(counts == ["all": 2, "active": 2, "standby": 0, "blacklist": 0, "no_photo": 1])
    }

    // MARK: patch

    private var detail: RolodexDetail {
        RolodexDetail(
            row: RolodexRow(personId: "p7", firstName: "Ana", lastName: "Ortiz", displayName: "Ana Ortiz", jobTitle: "Rigger",
                            company: RolodexCompany(id: "c1", name: "Summit Crew"), trade: "Rigging", level: "L2",
                            status: "active", statusLabel: "Active", hasPhoto: true),
            email: "ana@example.com", phone: "(312) 555-0142", externalId: "E-7", statusNote: nil, canEdit: true, canChangeStatus: true)
    }

    @Test func editStartsFromTheDetail() {
        let e = RolodexEdit(detail)
        #expect(e == RolodexEdit(firstName: "Ana", lastName: "Ortiz", preferredName: "", jobTitle: "Rigger", phone: "(312) 555-0142",
                                 email: "ana@example.com", partnerId: "c1", trade: "Rigging", level: "L2", status: "active", statusNote: ""))
    }

    @Test func unchangedEditBuildsAnEmptyPatch() throws {
        let patch = RolodexLogic.buildPatch(original: detail, edited: RolodexEdit(detail))
        #expect(patch.isEmpty)
        #expect(try json(patch) == "{}")
    }

    @Test func clearedPhoneIsSentAsNull() throws {
        var e = RolodexEdit(detail)
        e.phone = ""
        let patch = RolodexLogic.buildPatch(original: detail, edited: e)
        #expect(patch == RolodexPatch([.phone: nil]))
        #expect(try json(patch) == #"{"phone":null}"#)
    }

    @Test func changedLevelOnlySendsTheLevel() throws {
        var e = RolodexEdit(detail)
        e.level = "L4"
        #expect(try json(RolodexLogic.buildPatch(original: detail, edited: e)) == #"{"level":"L4"}"#)
    }

    @Test func patchTrimsAndTreatsBlankAsCleared() throws {
        var e = RolodexEdit(detail)
        e.jobTitle = "  Rigger  "      // the same after trimming: unchanged
        e.email = "   "                // blank: cleared
        e.preferredName = " Annie "    // new: sent trimmed
        #expect(try json(RolodexLogic.buildPatch(original: detail, edited: e)) == #"{"email":null,"preferred_name":"Annie"}"#)
    }

    @Test func patchCarriesCompanyStatusAndNote() throws {
        var e = RolodexEdit(detail)
        e.partnerId = nil
        e.status = "blacklist"
        e.statusNote = "No-show twice"
        #expect(try json(RolodexLogic.buildPatch(original: detail, edited: e))
                == #"{"partner_id":null,"status":"blacklist","status_note":"No-show twice"}"#)
    }

    @Test func aBlankStatusIsNeverSent() throws {
        var e = RolodexEdit(detail)
        e.status = "  "
        #expect(try json(RolodexLogic.buildPatch(original: detail, edited: e)) == "{}")
    }

    // MARK: validate

    @Test func validateNeedsFirstAndLastName() {
        #expect(RolodexLogic.validate(RolodexEdit(firstName: " ", lastName: "Ortiz")) == "First and last name are required.")
        #expect(RolodexLogic.validate(RolodexEdit(firstName: "Ana", lastName: "")) == "First and last name are required.")
        #expect(RolodexLogic.validate(RolodexEdit(firstName: "Ana", lastName: "Ortiz")) == nil)
    }

    @Test func validateNeedsANoteToBlacklist() {
        var e = RolodexEdit(firstName: "Ana", lastName: "Ortiz", status: "blacklist", statusNote: "  ")
        #expect(RolodexLogic.validate(e) == "Add a note to blacklist someone.")
        e.statusNote = "No-show twice"
        #expect(RolodexLogic.validate(e) == nil)
    }

    // MARK: wire models

    @Test func rowAndDetailDecodeTheContract() throws {
        let rowJSON = """
            {"person_id":"p7","first_name":"Ana","last_name":"Ortiz","preferred_name":null,"display_name":"Ana Ortiz",
             "job_title":"Rigger","company":{"id":"c1","name":"Summit Crew"},"trade":"Rigging","level":"L2","level_color":"#336699",
             "status":"active","status_label":"Active","status_color":"#16a34a","has_photo":true,
             "photo_url":"https://s3.example/a.jpg","photo_version":"0123456789abcdef","rfid_enrolled":true,"has_account":false
            """
        let list = try KioskJSON.decoder.decode(RolodexList.self, from: Data(#"{"generated_at":"2026-10-22T15:42:00Z","workers":[\#(rowJSON)}]}"#.utf8))
        #expect(list.generatedAt == "2026-10-22T15:42:00Z")
        let r = try #require(list.workers.first)
        #expect(r.personId == "p7"); #expect(r.company?.name == "Summit Crew"); #expect(r.levelColor == "#336699")
        #expect(r.statusLabel == "Active"); #expect(r.hasPhoto); #expect(r.photoVersion == "0123456789abcdef"); #expect(r.rfidEnrolled)

        let d = try KioskJSON.decoder.decode(RolodexDetail.self, from: Data("""
            \(rowJSON),"email":"ana@example.com","phone":null,"external_id":"E-7","status_note":null,
             "can_edit":false,"can_change_status":false,"edit_block_reason":"rank_too_low","status_block_reason":"self"}
            """.utf8))
        #expect(d.row == r)
        #expect(d.email == "ana@example.com"); #expect(d.phone == nil); #expect(d.externalId == "E-7")
        #expect(!d.canEdit); #expect(!d.canChangeStatus)
        #expect(d.editBlockReason == "rank_too_low"); #expect(d.statusBlockReason == "self")
    }

    @Test func aRowNeverEncodesEmailOrPhone() throws {
        let text = String(decoding: try KioskJSON.encoder.encode(detail.row), as: UTF8.self)
        #expect(!text.contains("email")); #expect(!text.contains("phone"))
        #expect(try KioskJSON.decoder.decode(RolodexRow.self, from: Data(text.utf8)) == detail.row)
    }

    @Test func optionsAndMatchesDecode() throws {
        let o = try KioskJSON.decoder.decode(RolodexOptions.self, from: Data("""
            {"levels":[{"level":"L1","title":"Helper","color":null}],"statuses":[{"key":"active","label":"Active","color":"#16a34a"}],
             "partners":[{"id":"c1","name":"Summit Crew"}]}
            """.utf8))
        #expect(o.levels == [RolodexLevel(level: "L1", title: "Helper", color: nil)])
        #expect(o.statuses == [RolodexStatus(key: "active", label: "Active", color: "#16a34a")])
        #expect(o.partners == [RolodexPartner(id: "c1", name: "Summit Crew")])
        let m = try KioskJSON.decoder.decode(RolodexMatch.self, from: Data("""
            {"person_id":"p1","display_name":"Ana Ortiz","job_title":null,"company":"Summit Crew","is_worker":false,
             "has_account":true,"photo_url":null,"photo_version":null,"matched_on":["name","email"]}
            """.utf8))
        #expect(m.company == "Summit Crew"); #expect(!m.isWorker); #expect(m.hasAccount); #expect(m.matchedOn == ["name", "email"])
    }

    @Test func createBodyIsTrimmedWithBlanksLeftOut() throws {
        let body = RolodexCreateIn(RolodexEdit(firstName: " Marcus ", lastName: "Reed", jobTitle: "Mover", phone: "  ", partnerId: "c1", level: "L1"),
                                   photoSkipped: true)
        #expect(String(decoding: try KioskJSON.encoder.encode(body), as: UTF8.self)
                == #"{"allow_duplicate":false,"first_name":"Marcus","job_title":"Mover","last_name":"Reed","level":"L1","partner_id":"c1","photo_skipped":true}"#)
    }

    @Test func patchRoundTripsThroughJSON() throws {
        let patch = RolodexPatch([.phone: nil, .level: "L4"])
        #expect(try KioskJSON.decoder.decode(RolodexPatch.self, from: try KioskJSON.encoder.encode(patch)) == patch)
    }
}
