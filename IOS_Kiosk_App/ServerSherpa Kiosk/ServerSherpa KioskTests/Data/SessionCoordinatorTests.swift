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
        h.auth.completePair(fakeSession())
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
        try? await Task.sleep(for: .milliseconds(50))
        #expect(h.api.heartbeats.isEmpty)
        h.auth.completePair(fakeSession())
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 1 }
        #expect(h.api.heartbeats[0].loginMethod == "link")
        h.coordinator.evaluate(foreground: false)
        await h.gate.tick()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(h.api.heartbeats.count == 1)             // stopped in the background
        h.coordinator.evaluate(foreground: true)
        await waitUntil { h.api.heartbeats.count == 2 }
        #expect(h.api.heartbeats[1].signIn == false)     // resumed: immediate beat, no sign_in
        h.auth.completePair(fakeSession(mustChange: true))
        h.coordinator.evaluate(foreground: true)
        await h.gate.tick()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(h.api.heartbeats.count == 2)             // must-change-password: no heartbeat
    }
}
