import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// A sleeper the test cranks by hand: `sleep(d)` parks until `fire(d)`. A canceled
/// sleeper removes only its own entry, synchronously, so `pending` is exact the
/// moment `cancel()` returns.
final class ManualSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [(id: Int, duration: Duration, cont: CheckedContinuation<Void, Error>)] = []
    private var canceled: Set<Int> = []
    private var next = 0

    func sleep(_ d: Duration) async throws {
        let id = lock.withLock { next += 1; return next }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                let already = lock.withLock { () -> Bool in
                    if canceled.remove(id) != nil { return true }
                    waiters.append((id, d, c))
                    return false
                }
                if already { c.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let c = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let i = waiters.firstIndex(where: { $0.id == id }) else { canceled.insert(id); return nil }
                return waiters.remove(at: i).cont
            }
            c?.resume(throwing: CancellationError())
        }
    }

    func pending(_ d: Duration) -> Int { lock.withLock { waiters.filter { $0.duration == d }.count } }

    /// Wakes every sleeper that asked for `d`.
    func fire(_ d: Duration) {
        let hit = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            let hit = waiters.filter { $0.duration == d }.map(\.cont)
            waiters.removeAll { $0.duration == d }
            return hit
        }
        for c in hit { c.resume() }
    }
}

/// Android TimeclockViewModelTest, case for case, plus the iOS-specific rules (dropped scans, stale avatar, formats).
@MainActor
struct TimeclockViewModelTests {
    private let store: KioskStore
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let api = FakeKioskApi()
    private let sleeper = ManualSleeper()

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.container(inMemory: true))
    }

    private func build(nowMs: @escaping @Sendable () -> Int64 = { 0 }, zone: TimeZone = TimeZone(identifier: "UTC")!, extraPeople: [KioskPersonRow] = []) async throws -> TimeclockViewModel {
        let people = [
            KioskPersonRow(id: "p1", displayName: "Jimmy Henderson", firstName: "James", lastName: "Henderson", preferredName: "Jimmy", rfidTag: "000000000000000000100348", isWorker: true, hasAccount: true),
            KioskPersonRow(id: "p2", displayName: "Tina Timeclock", firstName: "Tina", lastName: "Timeclock", preferredName: nil, rfidTag: "1003", isWorker: true, hasAccount: false),
        ] + extraPeople
        try await store.replaceRoster(assets: [], people: people, containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 0, people: people.count, containers: 0, trucks: 0, syncedAt: "now"))
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move", siteId: "s1", siteName: "Site", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        api.statusResult = { id in KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: "Tina T"), clockedIn: false) }
        api.clockInResult = { _ in KioskTimeclockStatus(person: KioskTimeclockPerson(id: "p1", displayName: "Tina T"), clockedIn: true) }
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let sleeper = self.sleeper
        let vm = TimeclockViewModel(store: store, api: api, prefs: prefs, identity: identity, flash: FlashController(), sound: nil,
                                    clock: nowMs, sleep: { try await sleeper.sleep($0) }, timeZone: zone)
        await vm.loadRoster()
        return vm
    }

    @Test func badgeAutoSelectsButAmbiguousPrefixWaits() async throws {
        let vm = try await build()
        #expect(vm.loadStatus == .ready)
        vm.onQueryChange("1003")
        #expect(vm.selected == nil)            // 1003 is also a prefix of 100348
        vm.onQueryChange("100348"); await vm.settle()
        #expect(vm.selected?.id == "p1")
        #expect(vm.statusPhase == .ready)
    }

    @Test func typedNameSearchesAndEnterSelectsSingleResult() async throws {
        let vm = try await build()
        vm.onQueryChange("hen jim")
        #expect(vm.results.map(\.id) == ["p1"])
        vm.onSubmit("hen jim"); await vm.settle()
        #expect(vm.selected?.id == "p1")
        vm.cancel(); vm.onSubmit("nobody")
        #expect(vm.error == "No worker found for \"nobody\".")
    }

    @Test func enterWithSeveralMatchesKeepsTheQueryAndResultsAndSelectsNothing() async throws {
        let tim = KioskPersonRow(id: "p3", displayName: "Tim Henderson", firstName: "Tim", lastName: "Henderson", preferredName: nil, rfidTag: nil, isWorker: true, hasAccount: false)
        let vm = try await build(extraPeople: [tim])
        vm.onQueryChange("hen")
        #expect(vm.results.count == 2)
        vm.onSubmit("hen")
        #expect(vm.query == "hen")
        #expect(vm.results.count == 2)
        #expect(vm.selected == nil)
    }

    @Test func enterWithExactlyOneResultSelectsIt() async throws {
        let vm = try await build()
        vm.onQueryChange("tina")
        #expect(vm.results.map(\.id) == ["p2"])
        vm.onSubmit("tina"); await vm.settle()
        #expect(vm.selected?.id == "p2")
    }

    @Test func aPunchHeldAcrossAnIdleResetNeverTouchesTheNewSelection() async throws {
        let vm = try await build()
        let gate = Gate()
        api.clockInGate = { await gate.wait() }
        vm.scan("100348"); await vm.settle()
        #expect(vm.selected?.id == "p1")
        vm.punch()
        #expect(vm.busy)
        await waitForSleepers(20)
        sleeper.fire(.seconds(20))
        await waitUntil { vm.selected == nil }
        vm.onQueryChange("tina"); vm.onSubmit("tina")
        #expect(vm.selected?.id == "p2")
        await gate.open(); await vm.settle()
        #expect(vm.selected?.id == "p2")
        #expect(vm.busy == false)
    }

    @Test func punchClocksInWithSetupThenReturnsToEntryAndIdleResets() async throws {
        let vm = try await build()
        vm.onQueryChange("100348"); await vm.settle()
        vm.punch(); await vm.settle()
        #expect(api.calls.last == "clockIn")
        #expect(vm.toast == "Clocked in — Tina T")
        #expect(vm.selected == nil)
        vm.onQueryChange("100348"); await vm.settle()
        #expect(vm.selected?.id == "p1")
        await waitForSleepers(20)
        sleeper.fire(.seconds(20))
        await waitUntil { vm.selected == nil }
        #expect(vm.selected == nil)
    }

    @Test func punchErrorsMapAndRefreshStatus() async throws {
        let vm = try await build()
        api.clockInResult = { _ in throw ApiError(status: 409, code: "already_clocked_in") }
        vm.onQueryChange("100348"); await vm.settle()
        vm.punch(); await vm.settle()
        #expect(vm.error == "They are already clocked in. Refreshing…")
        #expect(api.calls.filter { $0 == "timeclockStatus" }.count == 2)
        #expect(formatMinutes(192) == "3h 12m"); #expect(formatMinutes(45) == "45m"); #expect(initialsOf("Jimmy Henderson") == "JH")
    }

    @Test func clockInSendsSerialPersonAndSetup() async throws {
        let vm = try await build()
        let seen = BodyBox()
        api.clockInResult = { seen.set($0); return KioskTimeclockStatus(person: KioskTimeclockPerson(id: "p1", displayName: "Tina T"), clockedIn: true) }
        vm.onQueryChange("100348"); await vm.settle()
        vm.punch(); await vm.settle()
        #expect(seen.value?.personId == "p1")
        #expect(seen.value?.siteId == "s1")
        #expect(seen.value?.initiativeId == "i1")
        #expect(seen.value?.serial.isEmpty == false)
    }

    @Test func clockOutToastCarriesTheMinutes() async throws {
        let vm = try await build()
        api.statusResult = { _ in KioskTimeclockStatus(person: KioskTimeclockPerson(id: "p1", displayName: "Jimmy H"), clockedIn: true,
                                                      entry: KioskTimeclockEntry(id: "e1", startedAt: "2026-09-30T09:00:00Z")) }
        api.clockOutResult = { _ in KioskTimeclockStatus(person: KioskTimeclockPerson(id: "p1", displayName: "Jimmy H"), clockedIn: false,
                                                        lastEntry: KioskTimeclockLastEntry(id: "e1", startedAt: "2026-09-30T09:00:00Z", endedAt: "2026-09-30T12:12:00Z", minutes: 192)) }
        vm.onQueryChange("100348"); await vm.settle()
        vm.punch(); await vm.settle()
        #expect(api.calls.last == "clockOut")
        #expect(vm.toast == "Clocked out — Jimmy H · 3h 12m")
    }

    @Test func statusFailureShowsErrorAndMarksStatusUnavailable() async throws {
        let vm = try await build()
        api.statusResult = { _ in throw ApiError(status: 0, code: "network") }
        vm.onQueryChange("100348"); await vm.settle()
        #expect(vm.statusPhase == .error)
        #expect(vm.error == "Can't reach the portal. Try again in a moment.")
    }

    @Test func scansWhileASelectionIsOpenOrPunchInFlightAreDropped() async throws {
        let vm = try await build()
        let gate = Gate()
        api.clockInGate = { await gate.wait() }
        vm.scan("100348"); await vm.settle()
        #expect(vm.selected?.id == "p1")
        vm.scan("1003"); #expect(vm.selected?.id == "p1")     // dropped: a person is already open
        vm.punch()
        #expect(vm.busy)
        vm.punch()                                            // second punch while busy is ignored
        vm.scan("100348")                                     // dropped: a punch is in flight
        await gate.open(); await vm.settle()
        #expect(api.calls.filter { $0 == "clockIn" }.count == 1)
        #expect(vm.selected == nil)
    }

    @Test func scanBeforeTheRosterIsReadyTellsTheOperator() async throws {
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let vm = TimeclockViewModel(store: store, api: api, prefs: prefs, identity: identity, flash: FlashController(), sound: nil,
                                    clock: { 0 }, sleep: { try await self.sleeper.sleep($0) }, timeZone: .gmt)
        vm.scan("100348")
        #expect(vm.error == "No people on this kiosk. Sync from Kiosk Setup.")
        #expect(vm.selected == nil)
    }

    @Test func staleStatusForAnEarlierPersonIsIgnored() async throws {
        let vm = try await build()
        let gate = Gate()
        api.statusGate = { id in if id == "p1" { await gate.wait() } }
        api.statusResult = { id in KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: id == "p1" ? "First" : "Second"), clockedIn: false) }
        vm.select(KioskPersonRow(id: "p1", displayName: "Jimmy Henderson"))   // status held
        vm.select(KioskPersonRow(id: "p2", displayName: "Tina Timeclock"))
        await waitUntil { vm.status?.person.id == "p2" }
        await gate.open()
        await waitUntil { api.finished.contains("timeclockStatus:p1") }   // the stale answer came back
        await drainMainActor(vm)
        #expect(vm.status?.person.id == "p2")
    }

    @Test func avatarLoadsAndAStaleAvatarNeverReplacesTheCurrentOne() async throws {
        let vm = try await build()
        let png = tinyPng()
        let gate = Gate()
        api.statusResult = { id in
            KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: "P", avatarUrl: "https://img/\(id)"), clockedIn: false)
        }
        api.imageGate = { url in if url.hasSuffix("p1") { await gate.wait() } }
        api.imageResult = { url in if url.hasSuffix("p1") { return png }; throw ApiError(status: 404, code: "missing") }
        vm.select(KioskPersonRow(id: "p1", displayName: "One"))
        await waitUntil { vm.statusPhase == .ready }
        vm.cancel()
        vm.select(KioskPersonRow(id: "p2", displayName: "Two"))   // its image fails: initials
        await vm.settle()
        await gate.open()
        await waitUntil { api.finished.contains("image:https://img/p1") }  // the stale image came back
        await drainMainActor(vm)
        #expect(vm.avatar == nil)
        vm.cancel()
        api.imageResult = { _ in png }
        vm.select(KioskPersonRow(id: "p1", displayName: "One")); await vm.settle()
        #expect(vm.avatar != nil)
    }

    @Test func elapsedTickRefreshesTheClockEveryThirtySeconds() async throws {
        let now = NowBox()
        let vm = try await build(nowMs: { now.value })
        vm.onQueryChange("100348"); await vm.settle()
        #expect(vm.nowMs == 0)
        now.value = 30_000
        await waitForSleepers(30)
        sleeper.fire(.seconds(30))
        await waitUntil { vm.nowMs == 30_000 }
        #expect(vm.nowMs == 30_000)
        vm.cancel()
        #expect(sleeper.pending(.seconds(30)) == 0)        // the tick stopped with the selection
    }

    @Test func formats() {
        let utc = TimeZone(identifier: "UTC")!
        #expect(formatMinutes(-5) == "0m"); #expect(formatMinutes(60) == "1h 0m")
        #expect(initialsOf("  ") == "?"); #expect(initialsOf("madonna") == "M"); #expect(initialsOf("ann b cole") == "AC")
        let start = "2026-09-30T09:00:00Z"
        let startMs = Int64(ISO8601DateFormatter().date(from: start)!.timeIntervalSince1970 * 1000)
        #expect(minutesSince(start, nowMs: startMs + 192 * 60_000) == 192)
        #expect(minutesSince(start, nowMs: startMs + 30_000) == 1)       // rounds half up
        #expect(minutesSince(start, nowMs: startMs - 60_000) == 0)
        #expect(minutesSince("garbage", nowMs: 5) == 0)
        #expect(clockTime("2026-09-30T15:05:00Z", timeZone: utc) == "3:05 PM")
        #expect(clockTime("2026-09-30T00:07:00Z", timeZone: utc) == "12:07 AM")
        #expect(clockTime("2026-09-30T15:05:00Z", timeZone: TimeZone(identifier: "America/Chicago")!) == "10:05 AM")
        #expect(clockTime("garbage", timeZone: utc) == "garbage")
    }

    @Test func punchErrorText() {
        func text(_ s: Int, _ c: String) -> String { timeclockPunchErrorText(ApiError(status: s, code: c)) }
        #expect(text(409, "already_clocked_in") == "They are already clocked in. Refreshing…")
        #expect(text(409, "not_clocked_in") == "They are not clocked in. Refreshing…")
        #expect(text(423, "x") == "The portal is in read-only mode. Try again shortly.")
        #expect(text(0, "network") == "Can't reach the portal. The punch was not recorded.")
        #expect(text(500, "boom") == "Couldn't record the punch (boom).")
    }

    private func waitForSleepers(_ seconds: Int) async {
        let sleeper = self.sleeper
        await waitUntil { sleeper.pending(.seconds(seconds)) > 0 }
    }
}

/// Lets main-actor work that is already queued (a stale answer's continuation) run:
/// the view model's own tasks settle, then the main actor is yielded a few times.
@MainActor private func drainMainActor(_ vm: TimeclockViewModel) async {
    await vm.settle()
    for _ in 0..<10 { await Task.yield() }
}

private final class BodyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var v: ClockInIn?
    var value: ClockInIn? { lock.lock(); defer { lock.unlock() }; return v }
    func set(_ b: ClockInIn) { lock.lock(); v = b; lock.unlock() }
}

private final class NowBox: @unchecked Sendable {
    private let lock = NSLock()
    private var v: Int64 = 0
    var value: Int64 { get { lock.lock(); defer { lock.unlock() }; return v } set { lock.lock(); v = newValue; lock.unlock() } }
}

/// Holds a fake API call in flight until `open()`.
private actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() { isOpen = true; let w = waiters; waiters = []; for c in w { c.resume() } }
}

private func tinyPng() -> Data {
    Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")!
}
