import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct HeartbeatTests {
    private func harness(_ api: FakeKioskApi, gate: TickGate, rawInfo: @escaping @MainActor () -> [String: String] = { ["model": "iPad14,8"] }) -> Heartbeat {
        let identity = Identity(prefs: KioskPrefs(defaults: freshDefaults()), secrets: MemorySecretStore())
        return Heartbeat(api: api, identity: identity, version: "0.1.0", rawInfo: rawInfo, interval: .seconds(60), sleep: { try await gate.sleep($0) })
    }

    @Test func beatsImmediatelyThenEveryMinuteAndReportsRegistration() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let hb = harness(api, gate: gate)
        hb.start(signIn: .password)
        await waitUntil { api.heartbeats.count == 1 }
        #expect(api.heartbeats[0].signIn == true); #expect(api.heartbeats[0].loginMethod == "password")
        #expect(api.heartbeats[0].mode == "ios"); #expect(api.heartbeats[0].rawInfo["model"] == "iPad14,8")
        #expect(api.heartbeats[0].version == "0.1.0")
        await waitUntil { hb.registration == .ok }
        #expect(hb.registration == .ok)
        await gate.tick()
        await waitUntil { api.heartbeats.count == 2 }
        #expect(api.heartbeats[1].signIn == false)   // cleared once a beat succeeded
        #expect(api.heartbeats[1].loginMethod == nil)
        hb.stop()
        #expect(hb.registration == nil)
    }

    @Test func failedBeatKeepsPendingSignInAndLastState() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let failing = LockedFlag(true)
        api.heartbeatResult = { body in
            if failing.value { throw ApiError.network() }
            return HeartbeatResult(deviceId: "d", name: body.name, registration: "soon")
        }
        let hb = harness(api, gate: gate)
        hb.start(signIn: .link)
        await waitUntil { api.heartbeats.count == 1 }
        #expect(hb.registration == nil)
        failing.value = false
        await hb.now()
        #expect(api.heartbeats.count == 2)
        #expect(api.heartbeats[1].signIn == true); #expect(api.heartbeats[1].loginMethod == "link")
        #expect(hb.registration == .soon)
        failing.value = true
        await hb.now()
        #expect(hb.registration == .soon)   // last state kept
        hb.stop()
    }

    @Test func unknownRegistrationWireValueReadsAsNone() async {
        let api = FakeKioskApi(); let gate = TickGate()
        api.heartbeatResult = { HeartbeatResult(deviceId: "d", name: $0.name, registration: "weird") }
        let hb = harness(api, gate: gate)
        hb.start(signIn: nil)
        await waitUntil { hb.registration != nil }
        #expect(hb.registration == RegistrationState.none)
        hb.stop()
    }

    @Test func defaultRawInfoIsAppleDeviceInfo() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let identity = Identity(prefs: KioskPrefs(defaults: freshDefaults()), secrets: MemorySecretStore())
        let hb = Heartbeat(api: api, identity: identity, version: "1", sleep: { try await gate.sleep($0) })
        hb.start(signIn: nil)
        await waitUntil { api.heartbeats.count == 1 }
        let raw = api.heartbeats[0].rawInfo
        #expect(raw["manufacturer"] == "Apple")
        #expect(["ipad", "phone"].contains(raw["idiom"]))
        #expect(raw["system_name"]?.isEmpty == false)
        #expect(raw["model"]?.isEmpty == false)
        hb.stop()
    }

    @Test func startCancelsThePreviousLoop() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let hb = harness(api, gate: gate)
        hb.start(signIn: nil)
        await waitUntil { api.heartbeats.count == 1 }
        hb.start(signIn: nil)
        await waitUntil { api.heartbeats.count == 2 }
        #expect(api.heartbeats.count == 2)
        hb.stop()
    }
}

final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock(); private var v: Bool
    init(_ v: Bool) { self.v = v }
    var value: Bool { get { lock.lock(); defer { lock.unlock() }; return v } set { lock.lock(); v = newValue; lock.unlock() } }
}
