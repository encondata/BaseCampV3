import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct SessionCoordinatorTests {
    @MainActor private struct Harness {
        let api = FakeKioskApi()
        let refresher = FakeRefresher()
        let gate = TickGate()
        let auth: KioskAuth
        let hb: Heartbeat
        let coordinator: SessionCoordinator
        init() {
            let prefs = KioskPrefs(defaults: freshDefaults())
            let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            let gate = self.gate
            auth = KioskAuth(api: api, refresher: refresher, identity: identity, prefs: prefs)
            hb = Heartbeat(api: api, identity: identity, version: "0.1.0", rawInfo: { [:] }, interval: .seconds(60), sleep: { try await gate.sleep($0) })
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
}
