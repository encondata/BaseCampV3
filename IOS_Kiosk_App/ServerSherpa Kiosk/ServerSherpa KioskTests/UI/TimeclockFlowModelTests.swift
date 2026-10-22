import Foundation
import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// The flow model's side effects: people, lookups, punches, timers, feedback.
/// Mirrors Android TimeclockFlowViewModelTest; the timers run on a ManualSleeper.
@MainActor
struct TimeclockFlowModelTests {
    private let backend = FakeTcBackend()
    private let sleeper = ManualSleeper()
    /// Never clears on its own, so a test can read the last flash.
    private let flash = FlashController(sleep: { _ in try? await Task.sleep(for: .seconds(600)) })
    private let images = ImageLog()

    private let unreachable = "Can't reach the portal. Your punch was not recorded. Try again."
    private let changed = "Your status changed. Please choose again."
    private let notFound = "We couldn't find that code."

    private var good: Color { Color(hsl: DEFAULT_APPEARANCE.goodScan) }
    private var bad: Color { Color(hsl: DEFAULT_APPEARANCE.notFoundScan) }

    init() {
        backend.peopleResult = { [TC_JIMMY, TC_TINA] }
    }

    private func rig(_ mode: TcMode = .kiosk, exits: ExitLog? = nil) async -> TimeclockFlowModel {
        let sleeper = self.sleeper
        let images = self.images
        let model = TimeclockFlowModel(mode: mode, backend: backend, flash: flash, sound: nil, appearance: { DEFAULT_APPEARANCE },
                                       fetchImage: { try await images.fetch($0) },
                                       sleep: { try await sleeper.sleep($0) })
        if let exits { model.onExit = { exits.count += 1 } }
        model.start()
        await model.settle()
        return model
    }

    /// Name → Jimmy (by badge) → Is this you? → Yes.
    private func toAction(_ m: TimeclockFlowModel) async {
        m.onScan("B-UID-1"); await m.settle()
        #expect(m.step == .confirm)
        m.confirmYes()
        #expect(m.step == .action)
    }

    private func waitForSleeper(_ d: Duration) async {
        let sleeper = self.sleeper
        await waitUntil { sleeper.pending(d) > 0 }
    }

    // MARK: start, people, finding a person

    @Test func kioskModeStartsOnNameAndLoadsThePeople() async {
        let m = await rig()
        #expect(m.step == .name)
        #expect(backend.calls == ["people"])
        #expect(m.rosterSize == 2)
    }

    @Test func aTypedBadgeIdentifiesAtOnceButAnAmbiguousPrefixWaits() async {
        let m = await rig()
        m.onType("1003")                                      // 1003 is also the start of 100348
        #expect(m.step == .name)
        #expect(m.query == "1003")
        m.onType("100348"); await m.settle()
        #expect(m.step == .confirm)
        #expect(m.state.status?.person.id == "p1")
        #expect(m.query == "")
        #expect(flash.state?.color == good)
    }

    @Test func searchShowsMatchesAndSearchPicksASingleOne() async {
        let m = await rig()
        m.onType("hen jim")
        #expect(m.results.map(\.id) == ["p1"])
        m.onSearch(); await m.settle()
        #expect(m.step == .confirm)
        m.confirmNo()
        #expect(m.step == .name)
        #expect(m.query == "")
        m.onType("nobody")
        #expect(m.noMatches)
        m.onSearch()
        #expect(m.shownMessage == "No one matches that name.")
        #expect(m.query == "nobody")                           // a name that matches nobody stays to fix
        #expect(!m.noMatches)                                 // the message replaces the hint
    }

    @Test func aResultRowConfirmsItsPerson() async {
        let m = await rig()
        m.onType("tin")
        #expect(m.results.map(\.id) == ["p2"])
        m.pick(TC_TINA); await m.settle()
        #expect(m.step == .confirm)
        #expect(m.state.status?.person.id == "p2")
    }

    @Test func anUnknownQrShowsNotFoundAndTheNotFoundFlashThenClears() async {
        let m = await rig()
        m.onScan("ASSET-000123")
        #expect(m.step == .name)
        #expect(m.shownMessage == notFound)
        #expect(flash.state?.color == bad)
        #expect(backend.calls == ["people"])                   // no status read for a code nobody owns
        await waitForSleeper(TcTimers.message)
        sleeper.fire(TcTimers.message)
        await waitUntil { m.shownMessage == nil }
        #expect(m.shownMessage == nil)
    }

    @Test func scansAreIgnoredOffTheTypingSteps() async {
        let m = await rig()
        await toAction(m)
        m.onScan("1003")
        m.onType("1003")
        #expect(m.step == .action)
        #expect(m.state.status?.person.id == "p1")
    }

    @Test func aStatusReadThatFailsSaysSoAndStaysOnName() async {
        let m = await rig()
        backend.statusResult = { _ in throw ApiError(status: 0, code: "network") }
        m.onScan("B-UID-1"); await m.settle()
        #expect(m.step == .name)
        #expect(m.shownMessage == "Can't reach the portal. Try again.")
        #expect(flash.state?.color == bad)
        backend.statusResult = { _ in throw ApiError(status: 500, code: "boom") }
        m.onScan("B-UID-1"); await m.settle()
        #expect(m.shownMessage == "Something went wrong. Try again.")
    }

    @Test func aStatusReadTimesOutAfterTenSeconds() async {
        let m = await rig()
        let gate = HoldGate()
        backend.statusResult = { id in await gate.wait(); return tcOff(id) }
        m.onScan("B-UID-1")
        #expect(m.looking)
        await waitForSleeper(TcTimers.readTimeout)
        #expect(m.looking)
        sleeper.fire(TcTimers.readTimeout)
        await waitUntil { !m.looking }
        #expect(m.shownMessage == "Can't reach the portal. Try again.")
        await gate.open()                                     // the hung answer finally lands: dropped
        await waitUntil { backend.finished.contains("status:p1") }
        await m.settle()
        #expect(m.step == .name)
        #expect(m.state.status == nil)
    }

    @Test func aLateStatusAnswerAfterLeavingIsDropped() async {
        let exits = ExitLog()
        let m = await rig(exits: exits)
        let gate = HoldGate()
        backend.statusResult = { id in await gate.wait(); return tcOff(id) }
        m.onScan("B-UID-1")
        m.back()                                              // kiosk: Back on Name leaves
        #expect(exits.count == 1)
        await gate.open()
        await waitUntil { backend.finished.contains("status:p1") }
        await m.settle()
        #expect(m.step == .name)
        #expect(m.state.status == nil)
        #expect(!m.looking)
    }

    @Test func noPeopleOnAKioskSaysSyncFromKioskSetup() async {
        backend.peopleResult = { [] }
        let m = await rig()
        #expect(m.shownMessage == "No people on this kiosk. Sync from Kiosk Setup.")
    }

    @Test func aPeopleListThatFailsToLoadSaysSo() async {
        backend.peopleResult = { throw ApiError(status: 0, code: "network") }
        let m = await rig()
        #expect(m.shownMessage == "Can't load the people list. Try again shortly.")
    }

    @Test func aKioskReloadsThePeopleWhenASyncFinishes() async {
        let m = await rig()
        backend.peopleResult = { [TC_JIMMY] }
        m.loadPeople(); await m.settle()
        #expect(backend.count("people") == 2)
        #expect(m.rosterSize == 1)
    }

    // MARK: station mode: Welcome

    @Test func stationModeStartsOnWelcomeAndBackFromNameReturnsThere() async {
        let exits = ExitLog()
        let m = await rig(.station, exits: exits)
        #expect(m.step == .welcome)
        m.enterName()
        #expect(m.step == .name)
        #expect(m.hasBack)
        m.back(); await m.settle()
        #expect(m.step == .welcome)
        #expect(exits.count == 0)
        #expect(backend.count("people") == 2)                  // back at the start, the people are read again
        #expect(m.shownMessage == nil)
    }

    @Test func stationModeNeverShowsTheKioskSyncHint() async {
        backend.peopleResult = { [] }
        let m = await rig(.station)
        #expect(m.shownMessage == nil)
    }

    @Test func welcomeForgetsAnUnfinishedValueAfterAQuietSpellButSettlesAnExactOne() async {
        let m = await rig(.station)
        m.onType("zz")
        await waitForSleeper(TcTimers.scanQuiet)
        sleeper.fire(TcTimers.scanQuiet)
        await waitUntil { m.query == "" }
        #expect(m.step == .welcome)
        m.onType("1003")                                      // waits: also the start of 100348
        #expect(m.step == .welcome)
        await waitForSleeper(TcTimers.scanQuiet)
        sleeper.fire(TcTimers.scanQuiet)
        await waitUntil { m.step == .confirm }
        #expect(m.state.status?.person.id == "p2")
    }

    @Test func enterOnWelcomeWithAnUnknownCodeIsNotFoundAndClears() async {
        let m = await rig(.station)
        m.onType("nope"); m.onSearch()
        #expect(m.shownMessage == notFound)
        #expect(m.query == "")
        #expect(flash.state?.color == bad)
    }

    @Test func aPausedWelcomeTakesNobody() async {
        let m = await rig(.station)
        m.paused = true
        m.onType("B-UID-1")
        m.onScan("B-UID-1")
        m.enterName()
        #expect(m.step == .welcome)
        #expect(backend.count("status") == 0)
    }

    // MARK: timers

    @Test func idleOffTheStartLeavesAfterTwentySecondsAndATouchRestartsIt() async {
        let exits = ExitLog()
        let m = await rig(exits: exits)
        #expect(sleeper.started(TcTimers.idle) == 0)            // no idle timer on the start step
        m.onScan("B-UID-1"); await m.settle()
        await waitForSleeper(TcTimers.idle)
        m.onActivity()
        await waitUntil { sleeper.started(TcTimers.idle) == 2 }
        #expect(sleeper.pending(TcTimers.idle) == 1)          // the first countdown was dropped
        #expect(m.step == .confirm)
        #expect(exits.count == 0)
        await waitForSleeper(TcTimers.idle)
        sleeper.fire(TcTimers.idle)
        await waitUntil { exits.count == 1 }
        #expect(m.step == .name)
        #expect(m.state.status == nil)
    }

    @Test func idleOnAStationReturnsToWelcome() async {
        let exits = ExitLog()
        let m = await rig(.station, exits: exits)
        m.enterName()
        await waitForSleeper(TcTimers.idle)
        sleeper.fire(TcTimers.idle)
        await waitUntil { m.step == .welcome }
        #expect(exits.count == 0)
    }

    @Test func allSetLeavesAfterEightSecondsAndIdleDoesNotRunThere() async {
        backend.statusResult = { tcOn($0) }
        let exits = ExitLog()
        let m = await rig(exits: exits)
        await toAction(m)
        m.chooseOut()
        #expect(m.step == .clockOut)
        m.confirmClockOut(); await m.settle()
        #expect(m.step == .done)
        #expect(sleeper.pending(TcTimers.idle) == 0)
        await waitForSleeper(TcTimers.done)
        #expect(exits.count == 0)
        sleeper.fire(TcTimers.done)
        await waitUntil { exits.count == 1 }
        #expect(m.step == .name)
        #expect(sleeper.pending(TcTimers.idle) == 0)
    }

    @Test func doneLeavesAtOnce() async {
        backend.statusResult = { tcOn($0) }
        let exits = ExitLog()
        let m = await rig(exits: exits)
        await toAction(m)
        m.chooseOut(); m.confirmClockOut(); await m.settle()
        m.done()
        #expect(exits.count == 1)
        #expect(sleeper.pending(TcTimers.done) == 0)
    }

    @Test func printingMovesToVerifyAfterThreeSeconds() async {
        let exits = ExitLog()
        let m = await rig(exits: exits)
        await toAction(m)
        m.chooseIn(); await m.settle()
        #expect(m.step == .badge)
        m.badgeNew()
        #expect(m.step == .printing)
        await waitForSleeper(TcTimers.printing)
        sleeper.fire(TcTimers.printing)
        await waitUntil { m.step == .verify }
        m.verifyContinue()
        #expect(m.step == .done)
        m.done()
        #expect(exits.count == 1)
    }

    @Test func myBadgeWorksSkipsToAllSet() async {
        let m = await rig()
        await toAction(m)
        m.chooseIn(); await m.settle()
        m.badgeExisting()
        #expect(m.step == .done)
        #expect(m.firstName == "Jimmy")
    }

    // MARK: punches

    @Test func aSecondTapWhilePunchingIsIgnored() async {
        let gate = HoldGate()
        backend.clockInResult = { id in await gate.wait(); return tcOn(id) }
        let m = await rig()
        await toAction(m)
        m.chooseIn(); m.chooseIn(); m.retry(); m.chooseIn()
        await waitUntil { backend.count("clockIn") == 1 }
        for _ in 0..<20 { await Task.yield() }
        #expect(backend.count("clockIn") == 1)
        #expect(m.busy)
        m.back()
        #expect(m.step == .action)                            // Back waits for the punch
        await gate.open()
        await waitUntil { m.step == .badge }
        #expect(m.state.punched == .in)
        #expect(backend.count("clockIn") == 1)
        #expect(flash.state?.color == good)
    }

    @Test func aPunchNeverTimesOut() async {
        let gate = HoldGate()
        backend.clockInResult = { id in await gate.wait(); return tcOn(id) }
        let m = await rig()
        await toAction(m)
        m.chooseIn()
        await waitUntil { backend.count("clockIn") == 1 }
        #expect(sleeper.pending(TcTimers.readTimeout) == 0)
        #expect(m.busy)
        #expect(m.state.error == nil)
        await gate.open()
        await waitUntil { m.step == .badge }
    }

    @Test func a409ReturnsToActionWithTheNoticeAndRereadsTheStatus() async {
        backend.statusResult = { tcOn($0) }
        backend.clockOutResult = { _ in throw ApiError(status: 409, code: "not_clocked_in") }
        let m = await rig()
        await toAction(m)
        m.chooseOut()
        backend.statusResult = { tcOff($0) }                    // someone clocked them out elsewhere
        m.confirmClockOut(); await m.settle()
        #expect(m.step == .action)
        #expect(m.state.notice == changed)
        #expect(m.state.error == nil)
        #expect(Array(backend.calls.dropFirst()) == ["status:p1", "clockOut:p1", "status:p1"])
        #expect(m.state.status?.clockedIn == false)
        #expect(!m.busy)
        #expect(flash.state?.color == bad)
    }

    @Test func aNetworkFailureKeepsThePersonAndTryAgainRereadsTheStatusFirst() async {
        backend.clockInResult = { _ in throw ApiError(status: 0, code: "network") }
        let m = await rig()
        await toAction(m)
        m.chooseIn(); await m.settle()
        #expect(m.step == .action)
        #expect(m.state.error == unreachable)
        #expect(!m.busy)
        backend.clockInResult = { tcOn($0) }
        m.retry(); await m.settle()
        #expect(Array(backend.calls.dropFirst()) == ["status:p1", "clockIn:p1", "status:p1", "clockIn:p1"])
        #expect(m.step == .badge)
        #expect(m.state.error == nil)
    }

    @Test func tryAgainAfterAPunchThatLandedAnywayDoesNotPunchTwice() async {
        backend.clockInResult = { _ in throw ApiError(status: 0, code: "network") }
        let m = await rig()
        await toAction(m)
        m.chooseIn(); await m.settle()
        backend.statusResult = { tcOn($0) }                     // the dropped POST was recorded
        m.retry(); await m.settle()
        #expect(backend.count("clockIn") == 1)
        #expect(m.step == .badge)
        #expect(m.state.punched == .in)
    }

    @Test func tryAgainWhileStillOfflineShowsTheErrorAgainWithoutPunching() async {
        backend.statusResult = { tcOn($0) }
        backend.clockOutResult = { _ in throw ApiError(status: 0, code: "network") }
        let m = await rig()
        await toAction(m)
        m.chooseOut(); m.confirmClockOut(); await m.settle()
        #expect(m.step == .clockOut)
        backend.statusResult = { _ in throw ApiError(status: 0, code: "network") }
        m.retry(); await m.settle()
        #expect(backend.count("clockOut") == 1)
        #expect(m.state.error == unreachable)
        #expect(m.step == .clockOut)
        #expect(!m.busy)
    }

    @Test func aClockOutPunchesTheClockOutRouteAndEndsOnAllSetWithTheFirstName() async {
        backend.statusResult = { tcOn($0) }
        let m = await rig()
        await toAction(m)
        m.chooseIn(); await m.settle()
        #expect(backend.count("clockIn") == 0)                // Clock In is dimmed for someone already in
        m.chooseOut(); m.confirmClockOut(); await m.settle()
        #expect(m.step == .done)
        #expect(m.firstName == "Jimmy")
        #expect(backend.calls.filter { $0 == "clockOut:p1" }.count == 1)
    }

    @Test func aPunchThatAnswersAfterTheScreenIdledOutIsIgnored() async {
        let gate = HoldGate()
        backend.clockInResult = { id in await gate.wait(); return tcOn(id) }
        let exits = ExitLog()
        let m = await rig(exits: exits)
        await toAction(m)
        m.chooseIn()
        await waitForSleeper(TcTimers.idle)
        sleeper.fire(TcTimers.idle)
        await waitUntil { exits.count == 1 }
        await gate.open()
        await waitUntil { backend.finished.contains("clockIn:p1") }
        await m.settle()
        #expect(m.step == .name)
        #expect(m.state.punched == nil)
        #expect(!m.busy)
    }

    // MARK: the confirm card

    @Test func confirmCardWithoutOptionalFields() async {
        backend.statusResult = { id in KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: "Tina Timeclock"), clockedIn: false) }
        let m = await rig()
        m.onScan("1003"); await m.settle()
        let person = m.state.status!.person
        #expect(m.step == .confirm)
        #expect(tcPersonMeta(person).isEmpty)                  // no empty job-title or Employee ID lines
        #expect(initialsOf(person.displayName) == "TT")
        #expect(m.avatar == nil)
        #expect(images.urls.isEmpty)                           // no photo, nothing fetched
    }

    @Test func confirmCardShowsTheJobTitleAndEmployeeIdWhenSet() {
        let person = KioskTimeclockPerson(id: "p1", displayName: "Jimmy Henderson", jobTitle: "Crew lead", externalId: "E-42")
        #expect(tcPersonMeta(person) == ["Crew lead", "Employee ID E-42"])
        #expect(tcPersonMeta(KioskTimeclockPerson(id: "p", displayName: "X", jobTitle: " ", externalId: "")).isEmpty)
    }

    @Test func thePhotoLoadsAndLeavesWithThePerson() async {
        backend.statusResult = { id in
            KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: "Jimmy Henderson", avatarUrl: "https://img/\(id)"), clockedIn: false)
        }
        images.result = { _ in tcTinyPng() }
        let m = await rig()
        m.onScan("B-UID-1"); await m.settle()
        #expect(images.urls == ["https://img/p1"])
        #expect(m.avatar != nil)
        m.confirmNo()
        m.back()                                              // kiosk: leaves
        #expect(m.avatar == nil)
    }

    @Test func aPhotoThatFailsShowsInitials() async {
        backend.statusResult = { id in
            KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: "Jimmy Henderson", avatarUrl: "https://img/\(id)"), clockedIn: false)
        }
        images.result = { _ in throw ApiError(status: 404, code: "missing") }
        let m = await rig()
        m.onScan("B-UID-1"); await m.settle()
        #expect(m.step == .confirm)
        #expect(m.avatar == nil)
    }

    // MARK: the on-screen keyboard

    @Test func onScreenKeysTypeWithCapitalsShiftAndThe123Layer() async {
        let m = await rig()
        m.pressKey(.letter("T")); m.pressKey(.letter("I")); m.pressKey(.letter("N"))
        #expect(m.query == "Tin")
        #expect(m.results.map(\.id) == ["p2"])
        m.pressKey(.backspace); m.pressKey(.backspace); m.pressKey(.backspace)
        #expect(m.query == "")
        m.pressKey(.letter("A")); m.pressKey(.letter("B"))
        m.pressKey(.shift)
        #expect(m.kbShift)
        m.pressKey(.letter("Q")); m.pressKey(.letter("Q"))
        #expect(m.query == "AbQq")
        #expect(!m.kbShift)
        m.pressKey(.space)
        #expect(m.query == "AbQq ")
        m.pressKey(.numbers)
        #expect(m.kbSymbols)
        m.pressKey(.symbol("7")); m.pressKey(.symbol("-"))
        #expect(m.query == "AbQq 7-")
        m.pressKey(.letters)
        #expect(!m.kbSymbols)
    }

    @Test func searchOnTheKeyboardPicksASingleMatch() async {
        let m = await rig()
        for ch in "TINA" { m.pressKey(.letter(String(ch))) }
        m.pressKey(.search); await m.settle()
        #expect(m.step == .confirm)
        #expect(m.state.status?.person.id == "p2")
    }

    @Test func theKeysAreOffWhileALookupRuns() async {
        let gate = HoldGate()
        backend.statusResult = { id in await gate.wait(); return tcOff(id) }
        let m = await rig()
        m.onScan("B-UID-1")
        #expect(m.looking)
        m.pressKey(.letter("T"))
        #expect(m.query == "")
        await gate.open()
        await m.settle()
    }

    @Test func theKeyboardStartsOnLettersEachTimeNameOpens() async {
        let m = await rig(.station)
        m.enterName()
        m.pressKey(.numbers); m.pressKey(.shift)
        m.back()
        m.enterName()
        #expect(!m.kbSymbols)
        #expect(!m.kbShift)
    }

    // MARK: the hardware keys (a badge reader is a keyboard)

    @Test func returnFromAReaderSubmitsAndBackspaceDeletes() async {
        let m = await rig()
        m.keyInsert("tinx")
        m.keyDelete()
        #expect(m.query == "tin")
        m.keyInsert("a\n"); await m.settle()
        #expect(m.step == .confirm)
        #expect(m.state.status?.person.id == "p2")
    }
}

// MARK: - The session backend

@MainActor
struct SessionTcBackendTests {
    @Test func sendsTheKiosksZoneAndSerialAndTheSetupOnClockIn() async throws {
        let store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        let api = FakeKioskApi()
        try await store.replaceRoster(assets: [], people: [TC_JIMMY], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 0, people: 1, containers: 0, trucks: 0, syncedAt: "now"))
        let ins = ClockBox<ClockInIn>()
        let outs = ClockBox<ClockOutIn>()
        api.statusResult = { tcOff($0) }
        api.clockInResult = { ins.set($0); return tcOn($0.personId) }
        api.clockOutResult = { outs.set($0); return tcOff($0.personId) }
        let selection = SelectionBox(testSelection(initiativeId: "i1"))
        let backend = SessionTcBackend(store: store, api: api, timeZone: TimeZone(identifier: "America/Chicago")!) {
            (serial: "SER-1", selection: selection.value)
        }
        #expect(try await backend.people().map(\.id) == ["p1"])
        _ = try await backend.status(personId: "p1")
        #expect(api.statusQueries.last?.serial == "SER-1")
        #expect(api.statusQueries.last?.tz == "America/Chicago")
        _ = try await backend.clockIn(personId: "p1")
        #expect(ins.value == ClockInIn(serial: "SER-1", personId: "p1", siteId: "s1", initiativeId: "i1", tz: "America/Chicago"))
        _ = try await backend.clockOut(personId: "p1")
        #expect(outs.value == ClockOutIn(serial: "SER-1", personId: "p1", tz: "America/Chicago"))
        // a selection with no move or site never posts ""
        selection.value = KioskSetupSelection.timeclock(initiativeId: nil, initiativeName: nil, siteId: nil, siteName: nil, siteRole: nil)
        _ = try await backend.clockIn(personId: "p1")
        #expect(ins.value?.siteId == nil)
        #expect(ins.value?.initiativeId == nil)
    }
}

private final class SelectionBox: @unchecked Sendable {
    var value: KioskSetupSelection?
    init(_ value: KioskSetupSelection?) { self.value = value }
}

final class ExitLog: @unchecked Sendable {
    var count = 0
}

private final class ClockBox<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T?
    var value: T? { lock.withLock { v } }
    func set(_ b: T) { lock.withLock { v = b } }
}

/// The photos the model asked for, and what each fetch answers.
final class ImageLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _urls: [String] = []
    private var _result: @Sendable (String) throws -> Data = { _ in throw ApiError(status: 404, code: "missing") }
    var urls: [String] { lock.withLock { _urls } }
    var result: @Sendable (String) throws -> Data {
        get { lock.withLock { _result } } set { lock.withLock { _result = newValue } }
    }
    func fetch(_ url: String) async throws -> Data {
        lock.withLock { _urls.append(url) }
        return try result(url)
    }
}

func tcTinyPng() -> Data {
    Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")!
}
