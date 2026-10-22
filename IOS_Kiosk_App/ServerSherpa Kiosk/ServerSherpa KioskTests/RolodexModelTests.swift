import Foundation
import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

private let ANA = RolodexRow(personId: "p-ana", firstName: "Ana", lastName: "Ortiz", displayName: "Ana Ortiz", jobTitle: "Rigger",
                             company: RolodexCompany(id: "c1", name: "Summit Crew"), trade: "Rigging", level: "L3",
                             status: "active", statusLabel: "Active", statusColor: "#178a4c", hasPhoto: true,
                             photoUrl: "https://s3.test/ana.jpg", photoVersion: "v1", rfidEnrolled: true)
private let BO = RolodexRow(personId: "p-bo", firstName: "Bo", lastName: "Núñez", displayName: "Bo Núñez", jobTitle: "Mover",
                            status: "standby", statusLabel: "Standby")
private let CARLA = RolodexRow(personId: "p-carla", firstName: "Carla", lastName: "Diaz", displayName: "Carla Diaz", jobTitle: "Mover",
                               company: RolodexCompany(id: "c1", name: "Summit Crew"), status: "blacklist", statusLabel: "Blacklist",
                               hasPhoto: true, photoVersion: "v9")
private let CREW = RolodexOptions(levels: [RolodexLevel(level: "L3", title: "Lead")],
                                  statuses: [RolodexStatus(key: "active", label: "Active"), RolodexStatus(key: "standby", label: "Standby"),
                                             RolodexStatus(key: "blacklist", label: "Blacklist")],
                                  partners: [RolodexPartner(id: "c1", name: "Summit Crew")])

/// Ana's worker page: her row plus contact details and what the admin may change.
private func anaDetail(canEdit: Bool = true, canChangeStatus: Bool = true, statusBlock: String? = nil,
                       _ change: (inout RolodexDetail) -> Void = { _ in }) -> RolodexDetail {
    var d = RolodexDetail(row: ANA, email: "ana.ortiz@example.com", phone: "(312) 555-0142", externalId: "SC-1042",
                          canEdit: canEdit, canChangeStatus: canChangeStatus, editBlockReason: canEdit ? nil : "rank_too_low",
                          statusBlockReason: statusBlock)
    change(&d)
    return d
}

/// The Rolodex view model (plan Task 9; Android RolodexViewModelTest): the list and its offline
/// copy, the worker page, Edit and Save (Review Focus 3 and 4).
@MainActor
struct RolodexModelTests {
    private let api = FakeKioskApi()
    private let store: KioskStore
    private let owner = RolodexModel.Owner(personId: "admin1", apiUrl: "https://api.test")
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        api.rolodexWorkersResult = { RolodexList(generatedAt: "now", workers: [CARLA, BO, ANA]) }
        api.rolodexOptionsResult = { CREW }
        api.rolodexWorkerResult = { id in
            guard id == ANA.personId else { throw ApiError(status: 404, code: "person_not_found") }
            return anaDetail()
        }
    }

    private func model(owner: RolodexModel.Owner? = nil, at now: Date? = nil) -> RolodexModel {
        let who = owner ?? self.owner
        let when = now ?? t0
        return RolodexModel(api: api, store: store, owner: { who }, now: { when })
    }

    /// Loaded, with Ana's page open.
    private func anaOpen() async -> RolodexModel {
        let m = model()
        await m.load()
        await m.select(ANA.personId)
        return m
    }

    private func cacheJson() async throws -> [String: Any] {
        let text = try #require(try await store.rolodexCache())
        return try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    // MARK: the list and its offline copy

    @Test func loadSortsByLastNameAndCachesTheListWithoutEmailOrPhone() async throws {
        let m = model()
        await m.load()
        #expect(m.rows.map(\.personId) == ["p-carla", "p-bo", "p-ana"])   // Diaz, Núñez, Ortiz
        #expect(m.sections.map(\.letter) == ["D", "N", "O"])
        #expect(!m.offline && m.cachedAt == nil && m.listError == nil)
        #expect(m.options == CREW)

        let cache = try await cacheJson()
        #expect(cache["owner_id"] as? String == "admin1")
        #expect(cache["api_url"] as? String == "https://api.test")
        let workers = try #require(cache["workers"] as? [[String: Any]])
        #expect(workers.compactMap { $0["person_id"] as? String } == ["p-carla", "p-bo", "p-ana"])
        for worker in workers { #expect(worker["email"] == nil && worker["phone"] == nil) }
    }

    @Test(arguments: [ApiError.network(), ApiError(status: 503, code: "unknown_error")])
    func noConnectionShowsTheLastListWithItsTime(_ failure: ApiError) async throws {
        await model(at: t0).load()
        api.rolodexWorkersResult = { throw failure }
        api.rolodexOptionsResult = { throw failure }
        let later = model(at: t0.addingTimeInterval(3600))
        await later.load()
        #expect(later.offline)
        #expect(later.cachedAt == t0)
        #expect(later.rows.map(\.personId) == ["p-carla", "p-bo", "p-ana"])
        #expect(later.listError == nil)
        // the chips come from the rows when the options can't load
        #expect(later.filterChips.map(\.key) == ["all", "blacklist", "standby", "active", "no_photo"])
    }

    @Test func anotherAdminsOrServersListIsNeverShown() async throws {
        await model().load()
        api.rolodexWorkersResult = { throw ApiError.network() }
        for other in [RolodexModel.Owner(personId: "admin2", apiUrl: "https://api.test"),
                      RolodexModel.Owner(personId: "admin1", apiUrl: "https://api.other")] {
            let m = model(owner: other)
            await m.load()
            #expect(m.rows.isEmpty)
            #expect(!m.offline)
            #expect(m.listError == "No connection. Try again when you're back online.")
        }
    }

    @Test func aRefusedAccountSeesTheSpecCopyAndNoCachedList() async throws {
        await model().load()
        api.rolodexWorkersResult = { throw ApiError(status: 403, code: "forbidden") }
        let m = model()
        await m.load()
        #expect(m.rows.isEmpty && !m.offline)
        #expect(m.listError == "Your account can't use the Rolodex.")
    }

    @Test func aRefreshThatLosesTheConnectionKeepsTheListAndGoesOffline() async throws {
        let m = model()
        await m.load()
        api.rolodexWorkersResult = { throw ApiError.network() }
        await m.refresh()
        #expect(m.offline && m.cachedAt == t0)
        #expect(m.rows.count == 3)
        api.rolodexWorkersResult = { RolodexList(workers: [ANA]) }
        await m.refresh()
        #expect(!m.offline && m.cachedAt == nil)
        #expect(m.rows.map(\.personId) == ["p-ana"])
    }

    @Test func offlineBannerNamesTheTimeOfTheList() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let at = utc.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 15, minute: 42))!
        let us = Locale(identifier: "en_US")
        func text(_ now: Date) -> String {
            RolodexModel.offlineText(cachedAt: at, now: now, calendar: utc, locale: us).replacingOccurrences(of: "\u{202F}", with: " ")
        }
        #expect(text(at.addingTimeInterval(600)) == "Offline · showing the list from 3:42 PM. Changes need a connection.")
        // an older list says which day
        #expect(text(at.addingTimeInterval(86_400)) == "Offline · showing the list from Oct 22 at 3:42 PM. Changes need a connection.")
    }

    @Test func listCallsRunOffTheMainThread() async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.jobTitle = "Lead rigger"
        api.rolodexUpdateResult = { _, _ in anaDetail { $0.jobTitle = "Lead rigger" } }
        #expect(await m.save())
        #expect(api.calls.contains("rolodexWorkers") && api.calls.contains("rolodexWorker") && api.calls.contains("rolodexUpdate"))
        #expect(api.mainThreadCalls.filter { $0.hasPrefix("rolodex") }.isEmpty)
    }

    @Test func clearForgetsTheListAndDeletesTheOfflineCopy() async throws {
        let m = await anaOpen()
        m.query = "ana"
        await m.clear().value
        #expect(m.rows.isEmpty && m.sections.isEmpty && m.detail == nil && m.selectedId == nil)
        #expect(m.query == "" && m.filter == RolodexLogic.filterAll)
        #expect(try await store.rolodexCache() == nil)
    }

    // MARK: search and filters

    @Test func searchNarrowsTheListAndTheCountsFollowIt() async throws {
        let m = model()
        await m.load()
        m.query = "mov"
        #expect(m.sections.flatMap(\.rows).map(\.personId) == ["p-carla", "p-bo"])
        #expect(m.counts == ["all": 2, "active": 0, "standby": 1, "blacklist": 1, "no_photo": 1])
        #expect(m.filterChips.map(\.label) == ["All", "Active", "Standby", "Blacklist", "No photo"])
        m.filter = "standby"
        #expect(m.sections.flatMap(\.rows).map(\.personId) == ["p-bo"])
        m.query = "nunez mov"
        #expect(m.sections.map(\.letter) == ["N"])
        m.filter = RolodexLogic.filterNoPhoto
        m.query = ""
        #expect(m.sections.flatMap(\.rows).map(\.personId) == ["p-bo"])
        // the sections are exactly the shared rule's
        m.filter = RolodexLogic.filterAll
        let shared = RolodexLogic.sections(m.rows).map { RolodexSection(letter: $0.0, rows: $0.1) }
        #expect(m.sections == shared)
    }

    // MARK: the worker page

    @Test func selectingLoadsTheWorkerPage() async throws {
        let m = await anaOpen()
        #expect(m.selectedId == ANA.personId)
        #expect(m.detail?.email == "ana.ortiz@example.com")
        #expect(m.shownRow?.personId == ANA.personId)
        #expect(m.canEdit)
    }

    @Test func aLateAnswerForTheLastWorkerDoesNotReplaceTheNextOne() async throws {
        let m = model()
        await m.load()
        let hold = HoldGate()
        api.rolodexWorkerResult = { id in
            if id == ANA.personId { await hold.wait(); return anaDetail() }
            return RolodexDetail(row: BO, phone: "555", canEdit: true)
        }
        let first = Task { await m.select(ANA.personId) }
        #expect(await waitUntil { m.detailLoading })
        await m.select(BO.personId)
        await hold.open()
        await first.value
        #expect(m.selectedId == BO.personId)
        #expect(m.detail?.personId == BO.personId)
    }

    @Test func canEditFalseBlocksStartEdit() async throws {
        api.rolodexWorkerResult = { _ in anaDetail(canEdit: false) }
        let m = await anaOpen()
        #expect(!m.canEdit)
        m.startEdit()
        #expect(m.editing == nil)
        #expect(m.editBlockText == "This person has a portal login ranked above yours.")
    }

    @Test func statusBlockReasonsReadAsTheSpecSays() async throws {
        api.rolodexWorkerResult = { _ in anaDetail(canChangeStatus: false, statusBlock: "self") }
        let m = await anaOpen()
        #expect(m.statusBlockText == "You can't change your own status.")
        api.rolodexWorkerResult = { _ in anaDetail(canChangeStatus: false, statusBlock: "rank_too_low") }
        await m.select(nil)
        await m.select(ANA.personId)
        #expect(m.statusBlockText == "This person has a portal login ranked above yours.")
    }

    @Test func offlineBlocksStartEdit() async throws {
        await model().load()
        api.rolodexWorkersResult = { throw ApiError.network() }
        let m = model()
        await m.load()
        await m.select(ANA.personId)   // the page itself may still load
        #expect(m.offline && m.detail != nil)
        #expect(!m.canEdit)
        m.startEdit()
        #expect(m.editing == nil)
    }

    // MARK: Save

    @Test func saveSendsOnlyTheChangesAndUpdatesTheListTheRosterAndTheCache() async throws {
        try await store.replacePeople([KioskPersonRow(id: ANA.personId, displayName: "Ana Ortiz", firstName: "Ana", lastName: "Ortiz",
                                                      rfidTag: "T-1", badgeUid: "B-1", jobTitle: "Rigger", externalId: "SC-1042",
                                                      isWorker: true)])
        let m = await anaOpen()
        m.startEdit()
        m.editing?.jobTitle = "Lead rigger "
        m.editing?.phone = ""
        let saved = anaDetail { $0.jobTitle = "Lead rigger"; $0.phone = nil }
        api.rolodexUpdateResult = { _, _ in saved }
        #expect(await m.save())

        let sent = try #require(api.rolodexPatches.first)
        #expect(sent.id == ANA.personId)
        #expect(sent.patch == RolodexLogic.buildPatch(original: anaDetail(), edited: {
            var e = RolodexEdit(anaDetail()); e.jobTitle = "Lead rigger "; e.phone = ""; return e
        }()))
        #expect(sent.patch.fields.count == 2)
        #expect(m.editing == nil && !m.saving && m.errorText == nil)
        #expect(m.detail == saved)
        #expect(m.rows.first { $0.personId == ANA.personId }?.jobTitle == "Lead rigger")

        // the Time Clock's roster follows, keeping the tag and badge the edit can't carry
        let person = try #require(try await store.people().first { $0.id == ANA.personId })
        #expect(person.jobTitle == "Lead rigger")
        #expect(person.rfidTag == "T-1" && person.badgeUid == "B-1")

        // the offline copy follows too, still without email or phone
        let text = try #require(try await store.rolodexCache())
        #expect(text.contains("Lead rigger"))
        #expect(!text.contains("ana.ortiz@example.com") && !text.contains("555-0142"))
    }

    @Test func aWorkerMissingFromTheRosterIsAddedAfterASave() async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.preferredName = "Annie"
        api.rolodexUpdateResult = { _, _ in anaDetail { $0.preferredName = "Annie"; $0.displayName = "Annie Ortiz" } }
        #expect(await m.save())
        let person = try #require(try await store.people().first { $0.id == ANA.personId })
        #expect(person.displayName == "Annie Ortiz" && person.preferredName == "Annie")
        #expect(person.isWorker && person.externalId == "SC-1042")
        #expect(person.rfidTag == nil)
    }

    /// Review Focus 3: a double tap on Save changes sends one request.
    @Test func secondSaveWhileSavingSendsOneRequest() async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.jobTitle = "Lead rigger"
        let hold = HoldGate()
        api.rolodexGate = { name in if name == "rolodexUpdate" { await hold.wait() } }
        api.rolodexUpdateResult = { _, _ in anaDetail { $0.jobTitle = "Lead rigger" } }
        let first = Task { await m.save() }
        #expect(await waitUntil { m.saving })
        #expect(await m.save() == false)
        #expect(api.rolodexPatches.count == 1)
        await hold.open()
        #expect(await first.value)
        #expect(api.rolodexPatches.count == 1)
        #expect(m.detail?.jobTitle == "Lead rigger" && m.editing == nil)
    }

    /// Review Focus 4: a failed save keeps everything the admin typed and shows the spec's copy.
    @Test(arguments: zip(
        [ApiError.network(), ApiError(status: 423, code: "read_only_mode"), ApiError(status: 409, code: "email_in_use"),
         ApiError(status: 403, code: "rank_too_low"), ApiError(status: 403, code: "cannot_target_self"),
         ApiError(status: 422, code: "blacklist_requires_note"), ApiError(status: 500, code: "unknown_error")],
        ["No connection. Try again when you're back online.",
         "The system is in read-only mode, so changes can't be saved right now.",
         "Another person already uses that email.",
         "This person has a portal login ranked above yours.",
         "You can't change your own status.",
         "Add a note to blacklist someone.",
         "Something went wrong. Try again."]))
    func failedSaveKeepsEditingAndSetsTheSpecCopy(_ failure: ApiError, _ copy: String) async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.jobTitle = "Lead rigger"
        m.editing?.email = "ana@new.example"
        m.editing?.status = "blacklist"
        m.editing?.statusNote = "No-show twice"
        let typed = m.editing
        api.rolodexUpdateResult = { _, _ in throw failure }
        #expect(await m.save() == false)
        #expect(m.editing == typed)
        #expect(m.errorText == copy)
        #expect(!m.saving)
        #expect(m.detail == anaDetail())
        #expect(m.rows.first { $0.personId == ANA.personId }?.jobTitle == "Rigger")
    }

    @Test func aFormThatDoesNotValidateSendsNothing() async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.lastName = "  "
        #expect(await m.save() == false)
        #expect(m.errorText == "First and last name are required.")
        #expect(api.rolodexPatches.isEmpty)
        #expect(m.editing?.lastName == "  ")
    }

    @Test func savingNothingChangedJustClosesTheForm() async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.jobTitle = " Rigger "
        #expect(await m.save())
        #expect(api.rolodexPatches.isEmpty)
        #expect(m.editing == nil)
    }

    @Test func cancelDropsTheFormAndItsError() async throws {
        let m = await anaOpen()
        m.startEdit()
        m.editing?.lastName = ""
        _ = await m.save()
        m.cancelEdit()
        #expect(m.editing == nil && m.errorText == nil)
    }

    // MARK: copy

    @Test func errorCopyFollowsTheSpec() {
        #expect(RolodexModel.errorText(code: "forbidden") == "Your account can't use the Rolodex.")
        #expect(RolodexModel.errorText(code: "move_locked") == "Your account can't use the Rolodex.")
        #expect(RolodexModel.errorText(code: "read_only_mode") == "The system is in read-only mode, so changes can't be saved right now.")
        #expect(RolodexModel.errorText(code: "email_in_use") == "Another person already uses that email.")
        #expect(RolodexModel.errorText(code: "rank_too_low") == "This person has a portal login ranked above yours.")
        #expect(RolodexModel.errorText(code: "cannot_target_self") == "You can't change your own status.")
        #expect(RolodexModel.errorText(code: "blacklist_requires_note") == "Add a note to blacklist someone.")
        for code in ["file_too_large", "empty_file", "invalid_file_type", "unreadable_image", "image_too_large"] {
            #expect(RolodexModel.errorText(code: code) == "That photo couldn't be used. Take or choose another one.")
        }
        #expect(RolodexModel.errorText(code: "network") == "No connection. Try again when you're back online.")
        #expect(RolodexModel.errorText(code: "person_not_found") == "Something went wrong. Try again.")
        #expect(RolodexModel.errorText(code: nil) == "Something went wrong. Try again.")
        // a 423 says read-only whatever its code; a transport failure is "no connection"
        #expect(RolodexModel.errorText(for: ApiError(status: 423, code: "unknown_error"))
                == "The system is in read-only mode, so changes can't be saved right now.")
        #expect(RolodexModel.errorText(for: ApiError.network()) == "No connection. Try again when you're back online.")
    }
}

/// The Rolodex screens' pure rules: who may open it, split or stacked, the jump strip, row text.
struct RolodexScreenRulesTests {
    @Test func onlyAdminsMayOpenTheRolodex() {
        #expect(rolodexAllowed(.authed(fakeSession(roles: ["admin"], maxRank: 60))))
        #expect(rolodexAllowed(.authed(fakeSession(roles: ["developer"], maxRank: 100))))
        #expect(!rolodexAllowed(.authed(fakeSession(roles: ["staff"], maxRank: 40))))
        #expect(!rolodexAllowed(.authed(fakeSession(maxRank: 10, kioskMove: KioskMove(initiativeId: "i1", name: "Move")))))
        #expect(!rolodexAllowed(.anon))
        #expect(!rolodexAllowed(.loading))
    }

    @Test func sideBySideFromARegularWidthOfSevenHundred() {
        #expect(rolodexSplit(sizeClass: .regular, width: 700))
        #expect(rolodexSplit(sizeClass: .regular, width: 1180))
        #expect(!rolodexSplit(sizeClass: .regular, width: 699))
        #expect(!rolodexSplit(sizeClass: .compact, width: 900))
        #expect(!rolodexSplit(sizeClass: nil, width: 900))
        // before the first measurement a regular width starts split
        #expect(rolodexSplit(sizeClass: .regular, width: nil))
        #expect(!rolodexSplit(sizeClass: .compact, width: nil))
    }

    @Test func theJumpStripMapsADragToALetter() {
        #expect(rolodexJumpIndex(y: 0, height: 100, count: 4) == 0)
        #expect(rolodexJumpIndex(y: 26, height: 100, count: 4) == 1)
        #expect(rolodexJumpIndex(y: 99, height: 100, count: 4) == 3)
        #expect(rolodexJumpIndex(y: -40, height: 100, count: 4) == 0)
        #expect(rolodexJumpIndex(y: 400, height: 100, count: 4) == 3)
        #expect(rolodexJumpIndex(y: 10, height: 0, count: 4) == nil)
        #expect(rolodexJumpIndex(y: 10, height: 100, count: 0) == nil)
    }

    @Test func rowsShowJobTitleAndCompany() {
        #expect(rolodexSubtitle(ANA) == "Rigger · Summit Crew")
        #expect(rolodexSubtitle(BO) == "Mover")
        #expect(rolodexSubtitle(RolodexRow(personId: "x", company: RolodexCompany(id: "c", name: "Peak")) ) == "Peak")
        #expect(rolodexSubtitle(RolodexRow(personId: "x", jobTitle: "  ")) == nil)
        #expect(rolodexName(ANA) == "Ana Ortiz")
        #expect(rolodexName(RolodexRow(personId: "x", firstName: "Bo", lastName: "Li", preferredName: "B")) == "B Li")
        #expect(rolodexTradeLevel(trade: "Rigging", level: "L3") == "Rigging · L3")
        #expect(rolodexTradeLevel(trade: nil, level: "L3") == "L3")
        #expect(rolodexTradeLevel(trade: " ", level: nil) == nil)
        #expect(rolodexWorkerCount(1) == "1 worker")
        #expect(rolodexWorkerCount(112) == "112 workers")
    }

    @Test func theShellTitlesBothRolodexRoutes() {
        #expect(shellTitle(.rolodex) == "Rolodex")
        #expect(shellTitle(.rolodexWorker("p1")) == "Rolodex")
        #expect(shellTitle(.labelsPrinter) == "Label Printing")
        #expect(shellTitle(nil) == nil)
    }
}
