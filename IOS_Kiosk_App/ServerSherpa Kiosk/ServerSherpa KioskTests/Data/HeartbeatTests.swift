import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct HeartbeatTests {
    private func harness(_ api: FakeKioskApi, gate: TickGate, prefs: KioskPrefs? = nil,
                         rawInfo: @escaping @MainActor () -> [String: String] = { ["model": "iPad14,8"] }) -> Heartbeat {
        let prefs = prefs ?? KioskPrefs(defaults: freshDefaults())
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        return Heartbeat(api: api, identity: identity, prefs: prefs, version: "0.1.0", rawInfo: rawInfo, interval: .seconds(60), sleep: { try await gate.sleep($0) })
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

    @Test func biometricSignInSendsBiometricLoginMethod() async throws {
        let api = FakeKioskApi(); let gate = TickGate()
        let hb = harness(api, gate: gate)
        hb.start(signIn: .biometric)
        try #require(await waitUntil { api.heartbeats.count == 1 })
        #expect(api.heartbeats[0].signIn == true); #expect(api.heartbeats[0].loginMethod == "biometric")
        hb.stop()
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

    /// The station key's retry: one sign-in beat now, with the method this kiosk recorded for the
    /// session (`KioskPrefs.signInMethod`). A failed one leaves nothing pending, so the next beat
    /// does not record a second sign-in.
    @Test func signInNowRecordsOnceEvenWhenItFails() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let failing = LockedFlag(true)
        api.heartbeatResult = { body in
            if failing.value { throw ApiError.network() }
            return HeartbeatResult(deviceId: "d", name: body.name, registration: "ok")
        }
        let prefs = KioskPrefs(defaults: freshDefaults())
        let hb = harness(api, gate: gate, prefs: prefs)
        prefs.signInMethod = .password
        await hb.signInNow()
        #expect(api.heartbeats.count == 1)
        #expect(api.heartbeats[0].signIn == true); #expect(api.heartbeats[0].loginMethod == "password")
        failing.value = false
        await hb.now()
        #expect(api.heartbeats[1].signIn == false)
        prefs.signInMethod = .link
        await hb.signInNow()
        await hb.now()
        #expect(api.heartbeats[2].signIn == true); #expect(api.heartbeats[2].loginMethod == "link")
        #expect(api.heartbeats[3].signIn == false)
    }

    /// Android `signInNowWithNoKnownMethodSendsNoneRatherThanAGuess`: with no method recorded
    /// and none pending, the sign-in beat still goes, without a `login_method`.
    @Test func anUnknownMethodSendsNoLoginMethod() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let hb = harness(api, gate: gate)
        await hb.signInNow()
        #expect(api.heartbeats.count == 1)
        #expect(api.heartbeats[0].signIn == true)
        #expect(api.heartbeats[0].loginMethod == nil)
        await hb.now()
        #expect(api.heartbeats[1].signIn == false)       // nothing left pending
    }

    /// Android `signInNowKeepsAPendingSignInsMethod`: a sign-in whose beat hasn't landed yet is
    /// the session's own, so it goes ahead of the recorded method, and lands with it.
    @Test func aPendingSignInsMethodGoesFirst() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let failing = LockedFlag(true)
        api.heartbeatResult = { body in
            if failing.value { throw ApiError.network() }
            return HeartbeatResult(deviceId: "d", name: body.name, registration: "ok")
        }
        let prefs = KioskPrefs(defaults: freshDefaults())
        prefs.signInMethod = .password
        let hb = harness(api, gate: gate, prefs: prefs)
        hb.start(signIn: .link)
        await waitUntil { api.heartbeatsAnswered == 1 }
        hb.stop()
        failing.value = false
        await hb.signInNow()
        #expect(api.heartbeats.last?.signIn == true); #expect(api.heartbeats.last?.loginMethod == "link")
        await hb.now()
        #expect(api.heartbeats.last?.signIn == false)    // landed: plain again
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

    /// The has-been-registered flag: set by the first reply with any registration but "none",
    /// never cleared by a later "none".
    @Test func aRegisteredReplySetsTheEverRegisteredFlagForGood() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let wire = MutableBox("none")
        api.heartbeatResult = { [wire] in HeartbeatResult(deviceId: "d", name: $0.name, registration: wire.value) }
        let defaults = freshDefaults()
        let prefs = KioskPrefs(defaults: defaults)
        let store = EnvironmentStore(prefs: prefs)
        let hb = harness(api, gate: gate, prefs: prefs)
        await hb.now()
        #expect(hb.registration == RegistrationState.none)
        #expect(!store.everRegistered)
        wire.value = "soon"
        await hb.now()
        #expect(store.everRegistered)
        wire.value = "none"
        await hb.now()
        #expect(store.everRegistered)
        #expect(EnvironmentStore(prefs: KioskPrefs(defaults: defaults)).everRegistered)   // kept across launches
    }

    /// The flag is a fact about this kiosk, not the old session's state: a registered reply that
    /// lands after `stop()` still sets it (the rest of the reply is dropped).
    @Test func aRegisteredReplyAfterStopStillSetsTheFlag() async {
        let api = FakeKioskApi(); let gate = TickGate(); let hold = HoldGate()
        api.heartbeatGate = { await hold.wait() }
        let prefs = KioskPrefs(defaults: freshDefaults())
        let hb = harness(api, gate: gate, prefs: prefs)
        let beat = Task { await hb.now() }
        await waitUntil { api.heartbeats.count == 1 }
        hb.stop()
        await hold.open()
        await beat.value
        #expect(hb.registration == nil)
        #expect(EnvironmentStore(prefs: prefs).everRegistered)
    }

    @Test func defaultRawInfoIsAppleDeviceInfo() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let prefs = KioskPrefs(defaults: freshDefaults())
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let hb = Heartbeat(api: api, identity: identity, prefs: prefs, version: "1", sleep: { try await gate.sleep($0) })
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

    // MARK: Clear Setup (Android HeartbeatTest)

    /// A setup saved as a Time Clock station, with its key.
    private func stationSetUp(_ prefs: KioskPrefs, secrets: SecretStore) -> TimeclockStation {
        prefs.setupSelection = timeclockSelection()
        prefs.setupState = .complete
        let station = TimeclockStation(keys: StationKeyStore(secrets: secrets), serial: { "SER" }, apiUrl: { TEST_API_URL })
        station.storeKey("k3y")
        return station
    }

    /// A `clear_setup` answer while signed in: the saved setup goes, setup is incomplete, the
    /// station key goes (the container's hook), the ack waits for the next beat and the Setup
    /// banner is up. One beat with no loop running: no immediate re-beat.
    @Test func aClearSetupAnswerDropsSetupAndStationKey() async {
        let api = FakeKioskApi(); let gate = TickGate()
        api.heartbeatResult = { HeartbeatResult(deviceId: "d", name: $0.name, registration: "ok", clearSetup: "x1") }
        let prefs = KioskPrefs(defaults: freshDefaults()); let secrets = MemorySecretStore()
        let station = stationSetUp(prefs, secrets: secrets)
        #expect(station.hasKey)
        let hb = harness(api, gate: gate, prefs: prefs)
        AppContainer.dropStationKeyOnSetupClear(heartbeat: hb, station: station)
        await hb.now()
        #expect(api.heartbeats.count == 1)
        #expect(api.heartbeats[0].setupCleared == nil)
        #expect(prefs.setupSelection == nil)
        #expect(prefs.setupState == .incomplete)
        #expect(!station.hasKey)
        #expect(StationKeyStore(secrets: secrets).get() == nil)
        #expect(prefs.pendingSetupClearAck() == "x1")
        #expect(prefs.setupClear == SetupClearRecord(id: "x1", acked: false, notice: true))
        #expect(hb.setupClearSignal == 1)
        #expect(hb.registration == .ok)
    }

    /// The ack rides an immediate re-beat, then every beat while the server still asks (here it
    /// takes two), then stops. The clear is applied once: a repeated id never re-beats at once.
    @Test func theAckIsSentUntilTheServerStopsAsking() async {
        let api = FakeKioskApi(); let gate = TickGate()
        // a fake server: asks for "x1" until it has seen two acknowledgments
        let acksWanted = MutableBox(2)
        api.heartbeatResult = { body in
            if body.setupCleared == "x1" { acksWanted.value -= 1 }
            return HeartbeatResult(deviceId: "d", name: body.name, registration: "ok", clearSetup: acksWanted.value > 0 ? "x1" : nil)
        }
        let prefs = KioskPrefs(defaults: freshDefaults())
        prefs.setupState = .complete
        let hb = harness(api, gate: gate, prefs: prefs)
        let cleared = MutableBox<[String]>([])
        hb.onSetupCleared = { cleared.value.append($0) }
        hb.start(signIn: nil)
        await waitUntil { api.heartbeats.count == 2 }
        await gate.waitForSleepers()                              // parked on the interval: no hot loop
        #expect(api.heartbeats.count == 2)
        #expect(api.heartbeats[0].setupCleared == nil)
        #expect(api.heartbeats[1].setupCleared == "x1")           // the immediate re-beat acks
        #expect(prefs.setupState == .incomplete)
        #expect(prefs.pendingSetupClearAck() == "x1")             // the server still asks
        await gate.tick()
        await waitUntil { api.heartbeats.count == 3 }
        #expect(api.heartbeats[2].setupCleared == "x1")           // acked again
        await waitUntil { prefs.setupClear?.acked == true }
        await gate.tick()
        await waitUntil { api.heartbeats.count == 4 }
        #expect(api.heartbeats[3].setupCleared == nil)            // the server stopped asking
        #expect(cleared.value == ["x1"])
        #expect(hb.setupClearSignal == 1)
        hb.stop()
    }

    /// A beat sent before the clear was applied carries no ack, so its empty answer settles
    /// nothing; the beat that carried it does.
    @Test func theAckSettlesOnlyOnTheBeatThatCarriedIt() async {
        let api = FakeKioskApi(); let gate = TickGate(); let hold = HoldGate()
        api.heartbeatResult = { HeartbeatResult(deviceId: "d", name: $0.name, registration: "ok") }   // nothing asked
        api.heartbeatGate = { await hold.wait() }
        let prefs = KioskPrefs(defaults: freshDefaults())
        let hb = harness(api, gate: gate, prefs: prefs)
        let early = Task { await hb.now() }
        await waitUntil { api.heartbeats.count == 1 }             // in flight, without an ack
        #expect(prefs.applySetupClear("x4"))                      // applied meanwhile
        await hold.open()
        await early.value
        #expect(api.heartbeats[0].setupCleared == nil)
        #expect(prefs.pendingSetupClearAck() == "x4")             // that answer settled nothing
        await hb.now()
        #expect(api.heartbeats[1].setupCleared == "x4")
        #expect(prefs.pendingSetupClearAck() == nil)              // the beat that carried it did
        #expect(prefs.setupClear == SetupClearRecord(id: "x4", acked: true, notice: true))
    }

    @Test func aFailedBeatKeepsTheUnsentAck() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let failing = LockedFlag(true)
        api.heartbeatResult = { body in
            if failing.value { throw ApiError.network() }
            return HeartbeatResult(deviceId: "d", name: body.name, registration: "ok")
        }
        let prefs = KioskPrefs(defaults: freshDefaults())
        prefs.applySetupClear("f1")
        let hb = harness(api, gate: gate, prefs: prefs)
        await hb.now()
        #expect(api.heartbeats[0].setupCleared == "f1")
        #expect(prefs.pendingSetupClearAck() == "f1")
        failing.value = false
        await hb.now()
        #expect(api.heartbeats[1].setupCleared == "f1")
        #expect(prefs.pendingSetupClearAck() == nil)
    }

    /// A beat in flight when the heartbeat stops (sign-out, the app leaving the front) is dropped
    /// whole when its answer lands: no clear, no ack, no registration. The loop's beat and a
    /// rename's manual beat alike.
    @Test func aClearAnsweredAfterStopIsNeverApplied() async {
        let api = FakeKioskApi(); let gate = TickGate(); let hold = HoldGate()
        api.heartbeatResult = { HeartbeatResult(deviceId: "d", name: $0.name, registration: "ok", clearSetup: "x9") }
        api.heartbeatGate = { await hold.wait() }
        let prefs = KioskPrefs(defaults: freshDefaults()); let secrets = MemorySecretStore()
        let station = stationSetUp(prefs, secrets: secrets)
        let hb = harness(api, gate: gate, prefs: prefs)
        let cleared = MutableBox<[String]>([])
        hb.onSetupCleared = { cleared.value.append($0); station.clearKey() }
        hb.start(signIn: nil)
        await waitUntil { api.heartbeats.count == 1 }             // the loop's beat is in flight
        let manual = Task { await hb.now() }
        await waitUntil { api.heartbeats.count == 2 }             // and a manual one
        hb.stop()
        await hold.open()
        await manual.value
        await waitUntil { api.heartbeatsAnswered == 2 }
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(50))             // let the loop's beat take its answer
        #expect(api.heartbeats.count == 2)                        // no re-beat either
        #expect(prefs.setupClear == nil)
        #expect(prefs.setupSelection != nil)
        #expect(prefs.setupState == .complete)
        #expect(station.hasKey)
        #expect(cleared.value.isEmpty)
        #expect(hb.setupClearSignal == 0)
        #expect(hb.registration == nil)
    }

    @Test func anUnackedIdFromBeforeARestartIsAckedNotReapplied() async {
        let api = FakeKioskApi(); let gate = TickGate()
        api.heartbeatResult = { HeartbeatResult(deviceId: "d", name: $0.name, registration: "ok") }
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).applySetupClear("x3")
        let prefs = KioskPrefs(defaults: defaults)                // the app was relaunched
        prefs.setupState = .complete                              // set up again since
        let hb = harness(api, gate: gate, prefs: prefs)
        hb.start(signIn: nil)
        await waitUntil { prefs.setupClear?.acked == true }
        #expect(api.heartbeats[0].setupCleared == "x3")
        #expect(prefs.setupState == .complete)                    // not re-cleared
        #expect(hb.setupClearSignal == 0)
        hb.stop()
    }

    /// A re-request is a new id: applied again after the first was acknowledged.
    @Test func aNewerIdIsApplied() async {
        let api = FakeKioskApi(); let gate = TickGate()
        let asked = MutableBox<String?>("a1")
        api.heartbeatResult = { HeartbeatResult(deviceId: "d", name: $0.name, registration: "ok", clearSetup: asked.value == $0.setupCleared ? nil : asked.value) }
        let prefs = KioskPrefs(defaults: freshDefaults())
        let hb = harness(api, gate: gate, prefs: prefs)
        hb.start(signIn: nil)
        await waitUntil { prefs.setupClear?.acked == true }
        #expect(hb.setupClearSignal == 1)
        prefs.setupState = .complete
        prefs.dismissSetupClearNotice()
        asked.value = "a2"
        await gate.tick()
        await waitUntil { prefs.setupClear?.id == "a2" && prefs.setupClear?.acked == true }
        #expect(hb.setupClearSignal == 2)
        #expect(prefs.setupClear == SetupClearRecord(id: "a2", acked: true, notice: true))
        #expect(prefs.setupState == .incomplete)
        hb.stop()
    }
}

final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock(); private var v: Bool
    init(_ v: Bool) { self.v = v }
    var value: Bool { get { lock.lock(); defer { lock.unlock() }; return v } set { lock.lock(); v = newValue; lock.unlock() } }
}
