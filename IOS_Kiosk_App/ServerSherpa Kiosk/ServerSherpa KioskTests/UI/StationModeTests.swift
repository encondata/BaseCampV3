import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The Time Clock station on iOS (Android StationModeTest): it rests on Welcome signed out,
/// survives a relaunch, drops a revoked key to the waiting copy, pauses on a lapsed
/// registration, takes the gear to sign-in and back, and shows three Home tiles.
@MainActor
struct StationModeTests {
    private let secrets = MemorySecretStore()
    private let api = FakeStationApi()
    private let sleeper = ManualSleeper()
    private let flash = FlashController(sleep: { _ in try? await Task.sleep(for: .seconds(600)) })

    init() {
        api.peopleResult = { [TC_JIMMY, TC_TINA] }
    }

    private func makeStation() -> TimeclockStation {
        let sleeper = self.sleeper
        return TimeclockStation(keys: StationKeyStore(secrets: secrets), serial: { "SER-1" }, sleep: { try await sleeper.sleep($0) })
    }

    private func makeStore() throws -> KioskStore { KioskStore(modelContainer: try KioskSchema.inMemoryContainer()) }

    /// The station's flow as StationWelcomeHost builds it, started and settled.
    private func rig(_ station: TimeclockStation, store: KioskStore) async -> TimeclockFlowModel {
        let backend = StationTcBackend(api: api, store: store, station: station, timeZone: TimeZone(identifier: "America/Chicago")!)
        let sleeper = self.sleeper
        let model = TimeclockFlowModel(mode: .station, backend: backend, flash: flash, sound: nil, appearance: { DEFAULT_APPEARANCE },
                                       fetchImage: { _ in throw ApiError.network() }, sleep: { try await sleeper.sleep($0) })
        applyStationState(station, to: model)
        model.start()
        await model.settle()
        applyStationState(station, to: model)
        return model
    }

    private func container(_ defaults: UserDefaults) throws -> AppContainer {
        AppContainer(defaults: defaults, secrets: secrets, modelContainer: try KioskSchema.inMemoryContainer(),
                     backgroundTask: NoBackgroundTasking(), labelEngine: FakeLabelEngine())
    }

    // MARK: the review-focus cases

    @Test func aRelaunchedArmedStationRestsOnWelcome() async throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"   // nothing listens: the restore fails at once
        do {
            let first = try container(defaults)
            first.prefs.setupSelection = timeclockSelection()
            first.prefs.setupState = .complete
            first.station.storeKey("k3y")
        }
        // the app was killed: a new container over the same defaults and secret store
        let relaunched = try container(defaults)
        await relaunched.launch()
        #expect(relaunched.auth.state == .anon)
        #expect(relaunched.station.hasKey)
        #expect(!relaunched.station.loginRequested)
        let rests = stationRests(selection: relaunched.prefs.setupSelection, loginRequested: relaunched.station.loginRequested)
        #expect(guardScreen(for: relaunched.auth.state, stationResting: rests) == .stationResting)
        #expect(guardScreen(for: .loading, stationResting: rests) == .spinner)   // the restore still runs first

        let model = await rig(relaunched.station, store: try makeStore())
        #expect(model.step == .welcome)
        #expect(!model.paused); #expect(!model.keyMissing)
        #expect(model.rosterSize == 2)
        #expect(api.calls.first == FakeStationApi.Call(name: "people", key: "k3y", serial: relaunched.identity.current.serial, tz: nil))
        model.stop()
    }

    @Test func aRevokedKeyShowsWaitingForKey() async throws {
        let station = makeStation()
        station.storeKey("k3y")
        api.statusResult = { _ in throw ApiError(status: 401, code: "station_key_invalid") }
        let model = await rig(station, store: try makeStore())
        model.onScan("B-UID-1")                               // Jimmy's badge QR
        await model.settle()
        applyStationState(station, to: model)
        #expect(!station.hasKey)
        #expect(StationKeyStore(secrets: secrets).get() == nil)
        #expect(model.step == .welcome)
        #expect(model.paused); #expect(model.keyMissing)      // "waiting for its station key"
        #expect(station.welcomeKeyMissing)
        // no loop: the next people read sends nothing without a key, and nothing crashes
        let sent = api.calls.count
        model.loadPeople()
        await model.settle()
        #expect(api.calls.count == sent)
        #expect(model.rosterSize == 2)                        // the cached list stays
        model.stop()
    }

    @Test func aWrongStationTypeKeyIsDroppedLikeARevokedOne() async throws {
        let station = makeStation()
        station.storeKey("k3y")
        api.peopleResult = { throw ApiError(status: 403, code: "wrong_station_type") }
        let model = await rig(station, store: try makeStore())
        #expect(!station.hasKey)
        #expect(model.paused); #expect(model.keyMissing)
        model.stop()
    }

    @Test func pausedWhenNotRegistered() async throws {
        let station = makeStation()
        station.storeKey("k3y")
        api.peopleResult = { throw ApiError(status: 403, code: "kiosk_not_registered") }
        let model = await rig(station, store: try makeStore())
        #expect(station.hasKey)                               // the key is kept
        #expect(station.registrationPaused)
        #expect(model.paused); #expect(!model.keyMissing)     // "This time clock is paused…"
        #expect(model.inputOff)
        // renewed (someone signed in here, or an admin on Kiosk Devices): the next read un-pauses
        api.peopleResult = { [TC_JIMMY] }
        model.loadPeople()
        await model.settle()
        applyStationState(station, to: model)
        #expect(!station.registrationPaused)
        #expect(!model.paused)
        model.stop()
    }

    @Test func gearGoesToLoginAndBackReturns() async throws {
        let station = makeStation()
        let sel = timeclockSelection()
        #expect(guardScreen(for: .anon, stationResting: stationRests(selection: sel, loginRequested: station.loginRequested)) == .stationResting)
        station.requestLogin()                                // the gear on Welcome
        #expect(guardScreen(for: .anon, stationResting: stationRests(selection: sel, loginRequested: station.loginRequested)) == .login)
        #expect(loginOffersBackToTimeclock(selection: sel))
        #expect(!loginOffersBackToTimeclock(selection: testSelection(initiativeId: "i1")))
        #expect(!loginOffersBackToTimeclock(selection: nil))
        station.backToTimeclock()                             // "Back to the time clock"
        #expect(guardScreen(for: .anon, stationResting: stationRests(selection: sel, loginRequested: station.loginRequested)) == .stationResting)

        // an untouched sign-in page returns on its own after a quiet minute; activity restarts it
        station.requestLogin()
        await waitUntil { sleeper.pending(TimeclockStation.loginReturn) == 1 }
        station.noteLoginActivity()
        await waitUntil { sleeper.started(TimeclockStation.loginReturn) == 2 && sleeper.pending(TimeclockStation.loginReturn) == 1 }
        #expect(station.loginRequested)
        sleeper.fire(TimeclockStation.loginReturn)
        await waitUntil { !station.loginRequested }
        #expect(!station.loginRequested)

        // signing in ends the request, so a later sign-out rests on Welcome again
        station.requestLogin()
        station.signedIn()
        #expect(!station.loginRequested)
        #expect(sleeper.pending(TimeclockStation.loginReturn) == 0)
    }

    @Test func signingInThroughTheContainerClearsTheGearRequest() async throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"
        let c = try container(defaults)
        c.prefs.setupSelection = timeclockSelection()
        c.station.requestLogin()
        await c.auth.completePair(fakeSession())
        c.authChanged()
        #expect(!c.station.loginRequested)
        c.onBackground()
    }

    @Test func stationHomeShowsThreeTiles() {
        let tiles = homeTiles(setupState: .complete, devMode: false, stationType: KioskSetupSelection.timeclockStation)
        #expect(tiles.map(\.feature.title) == ["Time Clock", "Kiosk Setup", "Settings"])
        #expect(tiles.first?.feature == TIMECLOCK_STATION_FEATURE)
        #expect(tiles.allSatisfy { $0.available })
        #expect(homeTiles(setupState: .complete, devMode: true, stationType: "timeclock").count == 3)
        // a regular kiosk keeps every tile
        #expect(homeTiles(setupState: .complete, devMode: false, stationType: nil).map(\.feature.id) == FEATURES.map(\.id))
        #expect(homeFeatures(stationType: "timeclock").map(\.title) == ["Time Clock", "Kiosk Setup", "Settings"])
    }

    // MARK: the station backend

    @Test func peopleReplaceTheLocalListAndFallBackWhenOffline() async throws {
        let station = makeStation()
        station.storeKey("k3y")
        let store = try makeStore()
        let backend = StationTcBackend(api: api, store: store, station: station, timeZone: TimeZone(identifier: "America/Chicago")!)
        #expect(try await backend.people().map(\.id) == ["p1", "p2"])
        #expect(try await store.people().map(\.id).sorted() == ["p1", "p2"])
        api.peopleResult = { [TC_TINA] }
        _ = try await backend.people()
        #expect(try await store.people().map(\.id) == ["p2"])   // replaced, not added to
        api.peopleResult = { throw ApiError.network() }
        #expect(try await backend.people().map(\.id) == ["p2"]) // offline: the last list
        let empty = StationTcBackend(api: api, store: try makeStore(), station: station)
        await #expect(throws: ApiError.network()) { try await empty.people() }
    }

    @Test func statusAndPunchesGoThroughTheKeyWithTheZoneAndSerial() async throws {
        let station = makeStation()
        station.storeKey("k3y")
        let backend = StationTcBackend(api: api, store: try makeStore(), station: station, timeZone: TimeZone(identifier: "America/Chicago")!)
        _ = try await backend.status(personId: "p1")
        _ = try await backend.clockIn(personId: "p1")
        _ = try await backend.clockOut(personId: "p1")
        #expect(api.calls == [
            .init(name: "status:p1", key: "k3y", serial: "SER-1", tz: "America/Chicago"),
            .init(name: "clockIn:p1", key: "k3y", serial: "SER-1", tz: "America/Chicago"),
            .init(name: "clockOut:p1", key: "k3y", serial: "SER-1", tz: "America/Chicago"),
        ])
    }

    @Test func withNoKeyNothingIsSent() async throws {
        let station = makeStation()
        let backend = StationTcBackend(api: api, store: try makeStore(), station: station)
        await #expect(throws: ApiError(status: 409, code: "station_not_ready")) { try await backend.status(personId: "p1") }
        await #expect(throws: ApiError(status: 409, code: "station_not_ready")) { try await backend.clockIn(personId: "p1") }
        #expect(try await backend.people().isEmpty)
        #expect(api.calls.isEmpty)
    }

    @Test func aRejectionOfAnOldKeyKeepsTheNewOne() async throws {
        let station = makeStation()
        station.storeKey("old")
        let gate = HoldGate()
        api.statusResult = { _ in await gate.wait(); throw ApiError(status: 401, code: "station_key_invalid") }
        let backend = StationTcBackend(api: api, store: try makeStore(), station: station)
        let read = Task { try await backend.status(personId: "p1") }
        await waitUntil { !api.calls.isEmpty }
        station.storeKey("new")                               // a setup issued a fresh key meanwhile
        await gate.open()
        _ = await read.result
        #expect(station.hasKey)
        #expect(StationKeyStore(secrets: secrets).get() == "new")
    }

    @Test func signedInAtAStationTheTimeclockTileStillPunchesThroughTheKey() async throws {
        let c = try container(freshDefaults())
        #expect(kioskTimeclockBackend(container: c) is SessionTcBackend)
        c.prefs.setupSelection = timeclockSelection()
        #expect(kioskTimeclockBackend(container: c) is StationTcBackend)
    }

    @Test func resetAppDropsTheKey() async throws {
        let c = try container(freshDefaults())
        c.prefs.setupSelection = timeclockSelection()
        c.prefs.setupState = .complete
        c.station.storeKey("k3y")
        try await c.resetApp()
        #expect(!c.station.hasKey)
        #expect(c.stationKeys.get() == nil)
    }

    @Test func theFooterLeavesOutAnEmptyScanType() {
        let items = footerItems(selection: timeclockSelection(), sync: SyncStatus(), devMode: false, version: "1")
        #expect(items.first { $0.label == "Move" }?.value == "No move")
        #expect(items.first { $0.label == "Site" }?.value == "No site")
        #expect(!items.contains { $0.label == "Scan" })
    }
}
