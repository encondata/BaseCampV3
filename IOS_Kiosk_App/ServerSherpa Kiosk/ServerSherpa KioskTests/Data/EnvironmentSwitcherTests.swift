import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// An outbox store whose read fails until `readable` is set; its rows are kept behind it.
private actor UnreadableOutboxStore: OutboxStore {
    let kept = MemoryOutboxStore()
    private var readable = false
    func makeReadable() { readable = true }
    func all() async throws -> [OutboxRow] {
        guard readable else { throw CocoaError(.fileReadUnknown) }
        return await kept.all()
    }
    func upsert(_ rows: [OutboxRow]) async throws { await kept.upsert(rows) }
    func delete(_ ids: [String]) async throws { await kept.delete(ids) }
}

/// The environment switch's gates and what it clears (spec "Who can change what" and "What a
/// switch does"), against a whole container with a fake server (Android EnvironmentSwitcherTest).
/// Nothing here reaches the network or the Keychain: the API is a fake, the secrets are in memory,
/// the biometric keys are software, and the environment list's session is stubbed.
@MainActor
struct EnvironmentSwitcherTests {
    private let api = FakeKioskApi()
    private let secrets = MemorySecretStore()
    private let keys = FakeBiometricKeys()
    private let c: AppContainer
    /// The server the container starts on (a Custom environment, as `useApi` saves it).
    private let server = SavedEnvironment.custom(apiUrl: "http://127.0.0.1:9", portalUrl: "https://portal.example")
    private let uat = Environments.byId("uat")!.asSaved
    private let prod = Environments.byId("prod")!.asSaved
    private let custom = SavedEnvironment.custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "http://10.10.48.103:5173")
    private let asset = OutboxAsset(id: "a1", assetId: "A-1", name: "Rack", rfid: nil, serialNumber: "SN", makeModel: "Dell")

    init() throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).useApi("http://127.0.0.1:9")
        c = AppContainer(defaults: defaults, secrets: secrets, modelContainer: try KioskSchema.inMemoryContainer(),
                         backgroundTask: NoBackgroundTasking(), labelEngine: FakeLabelEngine(), biometricKeys: keys,
                         devicesApi: FakeDevicesApi(), api: api,
                         environmentListSession: .makeEnvironmentListSession(protocolClasses: [StubURLProtocol.self]))
    }

    private var switcher: EnvironmentSwitcher { c.environmentSwitcher }

    private func me(_ rank: Int, global: Bool) -> MeInfo { MeInfo(roles: [], maxRank: rank, isGlobal: global) }

    private func signIn(rank: Int = 20) async { await c.auth.completePair(fakeSession(maxRank: rank)) }

    private var signedIn: Bool { if case .authed = c.auth.state { true } else { false } }

    private func input(_ value: String) -> EnqueueInput {
        EnqueueInput(scannedValue: value, scanType: "barcode", asset: asset, siteId: "s1", initiativeId: "i1", scanStatus: "pre_stage")
    }

    private func rows(_ n: Int) -> [OutboxRow] {
        (1...n).map { OutboxMachine.newRow(input("A-\($0)"), clientScanId: "c\($0)", seq: Int64($0), nowMs: 0) }
    }

    /// `n` unsent (queued) scans in the outbox's store, as a kiosk left them.
    private func unsent(_ n: Int) async throws { try await c.store.outboxUpsert(rows(n)) }

    @Test func aNamedSwitchWithNothingUnsentIsDoneAndLeavesNothingOfTheOldServer() async throws {
        let serial = c.identity.current.serial
        #expect(c.identity.setName("Dock 4"))
        c.environments.markRegistered()
        c.prefs.applySetupClear("clear-1")
        c.prefs.setupSelection = testSelection(initiativeId: "i1")
        c.prefs.setupState = .complete
        _ = try await keys.create(nonce: "nonce-0")
        c.prefs.biometric = BiometricEnrollment(keyId: "key-1", personId: "p1", email: "tina@example.com")
        c.station.storeKey("station-key-1", issuedBy: c.config.apiUrl)
        try await c.store.storeRolodexCache(#"{"workers":[]}"#)
        c.prefs.devMode = true
        c.prefs.cameraPosition = .front
        secrets.set("unrelated", "kept")
        await signIn()
        c.cookies.set(host: "127.0.0.1", value: "refresh-1")
        #expect(c.prefs.signInMethod == .link)

        #expect(try await switcher.switchTo(uat, discard: false) == .done)

        #expect(c.environments.saved == uat)
        #expect(c.config.apiUrl == "https://api.uat.serversherpa.com")
        #expect(c.cookies.value(forHost: "127.0.0.1") == nil)              // the old host's refresh cookie
        #expect(secrets.get("unrelated") == "kept")
        #expect(!c.station.hasKey)
        #expect(c.stationKeys.get() == nil)
        #expect(c.prefs.biometric == nil)
        #expect(keys.deleted == 1)
        #expect(c.prefs.signInMethod == nil)
        #expect(c.prefs.setupClear == nil)                                  // ss.kiosk.setupClear
        #expect(c.prefs.setupSelection == nil)                              // resetApp ran
        #expect(c.prefs.setupState == .incomplete)
        #expect(try await c.store.rolodexCache() == nil)
        #expect(c.auth.state == .anon)
        // Revoked on the old server while still signed in, then signed out there (in the background).
        #expect(api.calls.contains("bioForget"))
        #expect(await waitUntil { api.calls.contains("signOut") && api.calls.contains("logout") })
        #expect(!api.calls.contains("me"), "no access check is needed")
        // Kept: the kiosk itself and its device settings.
        #expect(c.identity.current.serial == serial)
        #expect(c.identity.current.name == "Dock 4")
        #expect(c.environments.everRegistered)
        #expect(c.prefs.devMode)
        #expect(c.prefs.cameraPosition == .front)
    }

    /// Every stored refresh cookie goes, not only the old host's (Android clears them all): a
    /// stale cookie for the target host, kept from before the picker, would otherwise sign the
    /// kiosk back in there at the next launch. Other secrets stay.
    @Test func aSwitchClearsEveryStoredRefreshCookie() async throws {
        let serial = c.identity.current.serial
        secrets.set("unrelated", "kept")
        c.cookies.set(host: "127.0.0.1", value: "refresh-old")                  // the host being left
        c.cookies.set(host: "api.uat.serversherpa.com", value: "refresh-stale") // the target host
        c.cookies.set(host: "10.10.48.103", value: "refresh-earlier")           // an earlier host
        await signIn()

        #expect(try await switcher.switchTo(uat, discard: false) == .done)

        #expect(c.cookies.value(forHost: "127.0.0.1") == nil)
        #expect(c.cookies.value(forHost: "api.uat.serversherpa.com") == nil)
        #expect(c.cookies.value(forHost: "10.10.48.103") == nil)
        #expect(secrets.get("unrelated") == "kept")
        #expect(secrets.get("kiosk.serial") == serial)
    }

    @Test func unsentWorkIsPendingAndChangesNothing() async throws {
        await signIn()
        try await unsent(2)

        #expect(try await switcher.switchTo(uat, discard: false) == .pending(2))

        #expect(switcher.unsentCount == 2)
        #expect(try await c.store.outboxAll().count == 2)
        #expect(signedIn)
        #expect(c.environments.saved == server)
    }

    @Test func discardingWhileSignedOutIsRefused() async throws {
        try await unsent(2)

        #expect(try await switcher.switchTo(uat, discard: true) == .refused("discard_needs_admin"))

        #expect(!api.calls.contains("me"), "nobody to ask about")
        #expect(try await c.store.outboxAll().count == 2)
        #expect(c.environments.saved == server)
    }

    @Test func discardingNeedsRankSixty() async throws {
        await signIn()
        try await unsent(2)
        let info = me(40, global: true)
        api.meResult = { info }

        #expect(try await switcher.switchTo(uat, discard: true) == .refused("discard_needs_admin"))

        #expect(try await c.store.outboxAll().count == 2)
        #expect(signedIn)
    }

    @Test func anAdminCanDiscardAndTheOutboxEnds() async throws {
        await signIn(rank: 60)
        try await unsent(2)
        let info = me(60, global: false)
        api.meResult = { info }

        #expect(try await switcher.switchTo(uat, discard: true) == .done)

        #expect(c.environments.saved == uat)
        #expect(switcher.unsentCount == 0)
        #expect(try await c.store.outboxAll().isEmpty)
    }

    @Test func workQueuedWhileTheSwitchWaitsIsNeverDiscardedUnseen() async throws {
        await signIn(rank: 60)
        try await unsent(2)
        let info = me(60, global: false)
        let c = self.c, late = input("B-1")
        api.meResult = { @MainActor in
            _ = await c.outbox.enqueue(late)
            return info
        }

        #expect(try await switcher.switchTo(uat, discard: true) == .pending(3))

        #expect(try await c.store.outboxAll().count == 3)
        #expect(c.environments.saved == server)
    }

    @Test func customOnANeverRegisteredKioskIsDone() async throws {
        #expect(try await switcher.switchTo(custom, discard: false) == .done)

        #expect(c.environments.saved == custom)
        #expect(c.config.apiUrl == "http://10.10.48.103:8000")
        #expect(!api.calls.contains("me"))
    }

    @Test func customOnARegisteredKioskNeedsAGlobalRankOfEighty() async throws {
        c.environments.markRegistered()
        await signIn(rank: 100)

        let local = me(100, global: false)
        api.meResult = { local }
        #expect(try await switcher.switchTo(custom, discard: false) == .refused("custom_needs_super_admin"))
        #expect(c.environments.saved == server)
        #expect(signedIn)

        let global = me(80, global: true)
        api.meResult = { global }
        #expect(try await switcher.switchTo(custom, discard: false) == .done)
        #expect(c.environments.saved == custom)
    }

    @Test func customOnARegisteredKioskWhileSignedOutIsRefused() async throws {
        c.environments.markRegistered()

        #expect(try await switcher.switchTo(custom, discard: false) == .refused("custom_needs_super_admin"))

        #expect(!api.calls.contains("me"))
        #expect(c.environments.saved == server)
    }

    @Test func anAccessCheckThatCantReachTheServerIsRefused() async throws {
        c.environments.markRegistered()
        await signIn(rank: 100)
        api.meResult = { throw ApiError.network() }

        #expect(try await switcher.switchTo(custom, discard: false) == .refused("access_check_offline"))

        #expect(c.environments.saved == server)
        #expect(signedIn)

        api.meResult = { throw ApiError(status: 503, code: "unknown_error") }
        #expect(try await switcher.switchTo(custom, discard: false) == .refused("access_check_offline"))
    }

    /// A 401/403, or a 200 that didn't decode (a field missing), is no answer: the gate's own refusal.
    @Test func aRefusedOrUnreadableAccessCheckIsTheGatesOwnRefusal() async throws {
        c.environments.markRegistered()
        await signIn(rank: 100)

        api.meResult = { throw ApiError(status: 401, code: "not_authenticated") }
        #expect(try await switcher.switchTo(custom, discard: false) == .refused("custom_needs_super_admin"))
        api.meResult = { throw ApiError(status: 403, code: "forbidden") }
        #expect(try await switcher.switchTo(custom, discard: false) == .refused("custom_needs_super_admin"))
        api.meResult = { throw ApiError(status: 200, code: "unknown_error") }
        #expect(try await switcher.switchTo(custom, discard: false) == .refused("custom_needs_super_admin"))
        #expect(c.environments.saved == server)
    }

    /// Switching away from a dead server (Review Focus 2): nothing unsent, so no check is made.
    @Test func aNamedSwitchAwayFromADeadServerStillWorks() async throws {
        c.environments.markRegistered()
        await signIn()
        api.meResult = { throw ApiError.network() }

        #expect(try await switcher.switchTo(prod, discard: false) == .done)

        #expect(c.environments.saved == prod)
        #expect(!api.calls.contains("me"))
    }

    /// Review Focus 3: a named switch on a registered kiosk doesn't open the way to Custom.
    @Test func aNamedSwitchThenCustomIsRefused() async throws {
        c.environments.markRegistered()
        await signIn()

        #expect(try await switcher.switchTo(prod, discard: false) == .done)
        #expect(try await switcher.switchTo(custom, discard: false) == .refused("custom_needs_super_admin"))

        #expect(c.environments.saved == prod)
        #expect(c.environments.everRegistered)
    }

    /// An outbox whose store can't be read is never taken for an empty one: the switch throws
    /// before doing anything, and the unsent scans stay for the server they belong to.
    @Test func anUnreadableOutboxStopsTheSwitchBeforeAnythingIsCleared() async throws {
        let store = UnreadableOutboxStore()
        await store.kept.upsert(rows(2))
        let outbox = Outbox(store: store, api: api, serial: { "kiosk-ios-test" }, backgroundTask: NoBackgroundTasking())
        let c = self.c
        let switcher = EnvironmentSwitcher(store: c.environments, config: c.config, api: api, auth: c.auth, outbox: outbox,
                                           biometric: c.biometric, heartbeat: c.heartbeat, cookies: c.cookies, prefs: c.prefs,
                                           resetApp: { try await c.resetApp() })
        c.prefs.setupSelection = testSelection(initiativeId: "i1")
        await signIn()
        c.cookies.set(host: "127.0.0.1", value: "refresh-1")

        await #expect(throws: EnvironmentSwitchError.outboxUnreadable) { try await switcher.switchTo(uat, discard: false) }

        #expect(c.environments.saved == server)
        #expect(await store.kept.all().count == 2)
        #expect(signedIn)
        #expect(c.cookies.value(forHost: "127.0.0.1") == "refresh-1")
        #expect(c.prefs.setupSelection != nil)
        #expect(!api.calls.contains("bioForget"))

        await store.makeReadable()                                          // the store reads again
        #expect(try await switcher.switchTo(uat, discard: false) == .pending(2))
    }

    /// A target that couldn't be saved is refused before anything happens.
    @Test func aTargetThatCantBeSavedThrowsAndChangesNothing() async throws {
        await signIn()

        await #expect(throws: EnvironmentSwitchError.invalidEnvironment) {
            try await switcher.switchTo(.custom(apiUrl: "ftp://x", portalUrl: "nope"), discard: false)
        }

        #expect(c.environments.saved == server)
        #expect(signedIn)
        #expect(api.calls.isEmpty)
    }

    /// One switch at a time: a second one asked for meanwhile runs after the first, on what it left.
    @Test func switchesRunOneAtATime() async throws {
        c.environments.markRegistered()
        await signIn(rank: 100)
        let hold = HoldGate()
        let info = me(100, global: true)
        api.meResult = {
            await hold.wait()
            return info
        }
        let first = Task { try await switcher.switchTo(custom, discard: false) }
        #expect(await waitUntil { api.calls.contains("me") })
        let second = Task { try await switcher.switchTo(prod, discard: false) }
        try await Task.sleep(for: .milliseconds(50))
        #expect(c.environments.saved == server)                             // the second waits for the first
        await hold.open()

        #expect(try await first.value == .done)
        #expect(try await second.value == .done)
        #expect(c.environments.saved == prod)
        #expect(api.calls.filter { $0 == "me" }.count == 1)                 // the second needed no check
    }
}
