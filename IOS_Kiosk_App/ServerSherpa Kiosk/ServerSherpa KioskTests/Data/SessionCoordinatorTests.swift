import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct SessionCoordinatorTests {
    @MainActor private struct Harness {
        let api = FakeKioskApi()
        let refresher = FakeRefresher()
        let gate = TickGate()
        let prefs = KioskPrefs(defaults: freshDefaults())
        let auth: KioskAuth
        let hb: Heartbeat
        let coordinator: SessionCoordinator
        init() {
            let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            let gate = self.gate
            auth = KioskAuth(api: api, refresher: refresher, identity: identity, prefs: prefs)
            hb = Heartbeat(api: api, identity: identity, prefs: prefs, version: "0.1.0", rawInfo: { [:] }, interval: .seconds(60), sleep: { try await gate.sleep($0) })
            coordinator = SessionCoordinator(refresher: refresher, auth: auth, heartbeat: hb)
        }
    }

    @Test func sessionEndedFlipsToAnonAndStopsHeartbeat() async {
        let h = Harness()
        h.coordinator.start()
        await h.auth.completePair(fakeSession())
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 1 }
        #expect(h.hb.registration == .ok)
        h.refresher.emitSessionEnded()
        await waitUntil { h.auth.state == .anon }
        #expect(h.auth.state == .anon)
        #expect(h.hb.registration == nil)   // stopped
    }

    @Test func heartbeatRunsOnlyWhileAuthedAndForeground() async {
        let h = Harness()
        h.coordinator.evaluate(foreground: true)
        #expect(h.gate.waiterCount == 0)                 // signed out: no heartbeat loop at all
        #expect(h.api.heartbeats.isEmpty)
        await h.auth.completePair(fakeSession())
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 1 }
        #expect(h.api.heartbeats[0].loginMethod == "link")
        await h.gate.waitForSleepers(1)
        h.coordinator.evaluate(foreground: false)
        #expect(h.gate.waiterCount == 0)                 // stopped in the background: its sleep was canceled
        #expect(h.api.heartbeats.count == 1)
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 2 }
        #expect(h.api.heartbeats[1].signIn == false)     // resumed: immediate beat, no sign_in
        await h.auth.completePair(fakeSession(mustChange: true))
        await h.gate.waitForSleepers(1)
        h.coordinator.evaluate(foreground: true)
        #expect(h.gate.waiterCount == 0)                 // must-change-password: the loop stopped
        #expect(h.api.heartbeats.count == 2)
    }

    /// Clear Setup: beats sent for one person (the loop's, and a rename's manual one) whose
    /// answers land after that person signed out and someone else signed in are dropped, so the
    /// next person's session never gets that clear.
    @Test func aClearNeverReachesAnotherPersonsSession() async {
        let h = Harness()
        let hold = HoldGate()
        let answered = MutableBox(0)
        // the portal asks the first person's beats to clear; by the next person's, it was canceled
        h.api.heartbeatResult = { body in
            answered.value += 1
            return HeartbeatResult(deviceId: "d", name: body.name, registration: "ok", clearSetup: answered.value <= 2 ? "x1" : nil)
        }
        h.api.heartbeatGate = { await hold.wait() }
        h.prefs.setupSelection = testSelection(initiativeId: "i1")
        h.prefs.setupState = .complete
        await h.auth.completePair(fakeSession(personId: "p1"))
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 1 }           // the loop's beat is in flight
        let manual = Task { await h.hb.now() }
        await waitUntil { h.api.heartbeats.count == 2 }           // and a manual one
        await h.auth.logout()
        h.coordinator.evaluate(foreground: true)                  // signed out: the heartbeat stops
        await h.auth.completePair(fakeSession(personId: "p2"))    // someone else signs in
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 3 }
        await hold.open()
        await manual.value
        await waitUntil { h.api.heartbeatsAnswered == 3 }
        await waitUntil { h.hb.registration == .ok }              // the new session's beat landed
        for _ in 0..<20 { await Task.yield() }
        #expect(h.prefs.setupClear == nil)
        #expect(h.prefs.setupSelection == testSelection(initiativeId: "i1"))
        #expect(h.prefs.setupState == .complete)
        #expect(h.hb.setupClearSignal == 0)
        h.hb.stop()
    }
}
