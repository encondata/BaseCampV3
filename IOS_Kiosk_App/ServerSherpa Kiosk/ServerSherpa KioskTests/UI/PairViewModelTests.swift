import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// Android PairViewModelTest.kt. Time is hand-cranked: each `TickGate.tick()`
/// waits for the loop's next 1 s sleep, releases it and moves the injected clock forward by it.
@MainActor
struct PairViewModelTests {
    /// The clock the view model reads; the sleep advances it.
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var _now = Date(timeIntervalSince1970: 1_000_000_000)
        var now: Date { lock.lock(); defer { lock.unlock() }; return _now }
        func advance(_ d: Duration) { lock.lock(); _now += Double(d.components.seconds); lock.unlock() }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var _n = 0
        var n: Int { lock.lock(); defer { lock.unlock() }; return _n }
        func bump() -> Int { lock.lock(); defer { lock.unlock() }; _n += 1; return _n }
    }

    @MainActor private struct Harness {
        let api = FakeKioskApi()
        let auth: KioskAuth
        let gate = TickGate()
        let clock = TestClock()
        let vm: PairViewModel
        init() {
            let prefs = KioskPrefs(defaults: freshDefaults())
            let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
            api.pairCreated = { PairCreated(code: "ABCD1234", pollToken: "pt", linkUrl: "https://portal/link/ABCD1234", expiresAt: "2001-09-09T01:51:40Z") }
            let gate = gate, clock = clock
            vm = PairViewModel(api: api, identity: identity, auth: auth,
                               sleep: { d in try await gate.sleep(d); clock.advance(d) },
                               clock: { clock.now })
        }

        func tick(_ n: Int) async { for _ in 0..<n { #expect(await gate.tick()) } }
    }

    private func isAuthed(_ auth: KioskAuth) -> Bool {
        if case .authed = auth.state { return true }
        return false
    }

    @Test func requestsThenPollsUntilApproved() async {
        let h = Harness()
        let polls = Counter()
        h.api.pollResult = { polls.bump() < 3 ? PairPoll(status: .pending, session: nil) : PairPoll(status: .approved, session: fakeSession()) }
        await h.vm.request()
        #expect(h.vm.phase == .showing)
        #expect(h.vm.remainingSec == 300)   // the clock starts at 1e9 s = 2001-09-09T01:46:40Z
        h.vm.startPolling()
        await h.tick(2)
        await waitUntil { polls.n == 1 }
        #expect(polls.n == 1)
        await h.tick(4)
        await waitUntil { self.isAuthed(h.auth) }
        #expect(isAuthed(h.auth))
        #expect(h.auth.takePendingSignIn() == .link)
        #expect(formatPairCode(h.vm.pair!.code) == "ABCD-1234")
    }

    @Test func deniedAndRateLimited() async {
        let h = Harness()
        h.api.pollResult = { PairPoll(status: .denied, session: nil) }
        await h.vm.request()
        h.vm.startPolling()
        await h.tick(2)
        await waitUntil { h.vm.phase == .denied }
        #expect(h.vm.phase == .denied)
        h.api.pairCreated = { throw ApiError(status: 429, code: "pair_rate_limited") }
        await h.vm.request()
        #expect(h.vm.phase == .error)
        #expect(h.vm.error == "too many codes requested — wait a few minutes")
    }

    @Test func stopHaltsTheLoop() async {
        let h = Harness()
        let polls = Counter()
        h.api.pollResult = { _ = polls.bump(); return PairPoll(status: .pending, session: nil) }
        await h.vm.request()
        h.vm.startPolling()
        h.vm.stop()
        #expect(h.gate.waiterCount == 0)      // the canceled loop left its sleep and never parks again
        #expect(polls.n == 0)
        #expect(!isAuthed(h.auth))
    }

    /// A relayout (rotation) rebuilds the views but neither begins nor stops the
    /// model: the same code keeps being polled, one code request in all.
    @Test func aRelayoutKeepsTheSameCodeBeingPolled() async {
        let h = Harness()
        let created = Counter()
        let polls = Counter()
        h.api.pairCreated = { _ = created.bump(); return PairCreated(code: "ABCD1234", pollToken: "pt", linkUrl: "u", expiresAt: "2001-09-09T01:51:40Z") }
        h.api.pollResult = { _ = polls.bump(); return PairPoll(status: .pending, session: nil) }
        await h.vm.begin()
        let code = h.vm.pair?.code
        await h.tick(2)
        await waitUntil { polls.n == 1 }
        // rotate: nothing is called on the model
        await h.tick(2)
        await waitUntil { polls.n == 2 }
        #expect(polls.n == 2)
        #expect(created.n == 1)
        #expect(h.vm.pair?.code == code)
        await h.gate.waitForSleepers(1)
        h.vm.stop()
        #expect(h.gate.waiterCount == 0)      // stopped: no sleeper left to wake
        #expect(polls.n == 2)
    }

    @Test func theCountdownRunsOutToExpired() async {
        let h = Harness()
        h.api.pairCreated = { PairCreated(code: "ABCD1234", pollToken: "pt", linkUrl: "u", expiresAt: "2001-09-09T01:46:42Z") }
        await h.vm.request()
        #expect(h.vm.remainingSec == 2)
        h.vm.startPolling()
        await h.tick(1)
        await waitUntil { h.vm.remainingSec == 1 }
        #expect(h.vm.remainingSec == 1)
        await h.tick(1)
        await waitUntil { h.vm.phase == .expired }
        #expect(h.vm.phase == .expired)
    }

    @Test func helpers() {
        #expect(formatPairCode("ABCD1234") == "ABCD-1234")
        #expect(formatPairCode("ABCD") == "ABCD")
        #expect(portalHost("https://portal.dev.serversherpa.com") == "portal.dev.serversherpa.com")
        #expect(portalHost("not a url") == "not a url")
        #expect(formatRemaining(125) == "2:05")
        #expect(formatRemaining(9) == "0:09")
    }
}
