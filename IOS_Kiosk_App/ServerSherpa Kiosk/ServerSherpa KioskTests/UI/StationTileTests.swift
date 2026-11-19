import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// A Time Clock station's Home tile (Android `HomeScreen.startTimeclock`, `AppContainer.startTimeclock`):
/// without a station key it issues one under the signed-in session first (one sign-in beat and
/// one retry on `not_signed_in_here`), stores it, then signs out to the station's Welcome. A key
/// that can't be had keeps the person signed in, with one of Android's red messages.
@MainActor @Suite(.timeLimit(.minutes(1)))
struct StationTileTests {
    private let api = FakeKioskApi()
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let secrets = MemorySecretStore()
    private let identity: Identity
    private let auth: KioskAuth
    private let heartbeat: Heartbeat
    private let station: TimeclockStation

    init() async {
        prefs.setupSelection = timeclockSelection()
        prefs.setupState = .complete
        identity = Identity(prefs: prefs, secrets: secrets)
        auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
        heartbeat = Heartbeat(api: api, identity: identity, prefs: prefs, version: "1", rawInfo: { [:] })
        let identity = self.identity
        station = TimeclockStation(keys: StationKeyStore(secrets: secrets), serial: { identity.current.serial }, apiUrl: { TEST_API_URL })
        api.stationKeyResult = { _ in "k3y" }
        await auth.completePair(fakeSession())   // signed in by pairing a phone
    }

    private func makeTile() -> StationTileModel {
        StationTileModel(api: api, station: station, heartbeat: heartbeat, auth: auth, prefs: prefs)
    }

    private var keyStored: String? { StationKeyStore(secrets: secrets).get() }
    private var issues: Int { api.calls.filter { $0 == "issueStationKey" }.count }
    private var signedIn: Bool {
        if case .authed = auth.state { return true }
        return false
    }

    @Test func aStationWithoutAKeyIssuesOneThenSignsOut() async {
        #expect(!station.hasKey)
        let tile = makeTile()
        await tile.start()
        #expect(issues == 1)
        #expect(api.heartbeats.isEmpty)                      // the portal knew who is signed in here
        #expect(keyStored == "k3y")
        #expect(StationKeyStore(secrets: secrets).origin() == apiOrigin(TEST_API_URL))
        #expect(station.hasKey)
        #expect(!signedIn)                                   // signed out: the station rests on Welcome
        #expect(stationRests(selection: prefs.setupSelection, loginRequested: station.loginRequested))
        #expect(tile.error == nil)
        #expect(!tile.starting)
    }

    @Test func aStationWithAKeyJustSignsOut() async {
        station.storeKey("old")
        let tile = makeTile()
        await tile.start()
        #expect(issues == 0)
        #expect(api.heartbeats.isEmpty)
        #expect(keyStored == "old")
        #expect(!signedIn)
        #expect(tile.error == nil)
    }

    /// The portal issues a key only to whoever it last saw sign in here: one sign-in beat, with
    /// this session's own method (the pair), then one more try. A second refusal stops there.
    @Test func aRefusedIssueRetriesOnceOnNotSignedInHere() async {
        let tries = LockedCounter()
        api.stationKeyResult = { _ in
            if tries.next() == 1 { throw ApiError(status: 403, code: "not_signed_in_here") }
            return "k3y"
        }
        let tile = makeTile()
        await tile.start()
        #expect(issues == 2)
        #expect(api.heartbeats.count == 1)
        #expect(api.heartbeats.first?.signIn == true)
        #expect(api.heartbeats.first?.loginMethod == "link")
        #expect(keyStored == "k3y")
        #expect(!signedIn)

        // signed in again, and the portal refuses twice: no loop, and no sign-out
        await auth.completePair(fakeSession())
        station.clearKey()
        api.stationKeyResult = { _ in throw ApiError(status: 403, code: "not_signed_in_here") }
        await tile.start()
        #expect(issues == 4)
        #expect(api.heartbeats.count == 2)
        #expect(tile.error == "Couldn't start the time clock (not_signed_in_here). Try again.")
        #expect(keyStored == nil)
        #expect(signedIn)
    }

    @Test func issueFailuresShowAndroidsThreeMessagesAndStaySignedIn() async {
        let cases: [(ApiError, String)] = [
            (ApiError.network(), "The station key hasn't arrived yet. Check the connection and try again in a minute."),
            (ApiError(status: 403, code: "move_locked"), "A move password can't start the time clock. Sign in with your own account."),
            (ApiError(status: 409, code: "setup_clear_pending"), "Couldn't start the time clock (setup_clear_pending). Try again."),
        ]
        let tile = makeTile()
        for (error, text) in cases {
            #expect(startTimeclockError(error) == text)
            api.stationKeyResult = { _ in throw error }
            await tile.start()
            #expect(tile.error == text)
            #expect(tile.shownError == text)
            #expect(!tile.starting)                          // the tile can be tapped again
            #expect(signedIn)
            #expect(keyStored == nil)
        }
        // anything that isn't the portal's answer (Android's fallback)
        struct NotAnApiError: Error {}
        api.stationKeyResult = { _ in throw NotAnApiError() }
        await tile.start()
        #expect(tile.error == "Couldn't start the time clock. Try again.")
        #expect(signedIn)
        // the next try clears the message; a key that arrives signs out
        api.stationKeyResult = { _ in "k3y" }
        await tile.start()
        #expect(tile.error == nil)
        #expect(keyStored == "k3y")
        #expect(!signedIn)
    }

    /// While the key is being issued the tile is disabled: a second tap starts nothing.
    @Test func theTileRunsOnceWhileTheKeyIsIssued() async {
        let hold = HoldGate()
        api.stationKeyResult = { _ in await hold.wait(); return "k3y" }
        let tile = makeTile()
        #expect(!tile.starting)
        let first = Task { await tile.start() }
        #expect(await waitUntil { issues == 1 })
        #expect(tile.starting)
        // a second tap while the first runs returns at once (were it to issue too, it would wait
        // on the held issue, and this would time out rather than hang)
        let secondDone = LockedFlag(false)
        let second = Task { await tile.start(); secondDone.value = true }
        #expect(await waitUntil { secondDone.value })
        #expect(issues == 1)
        #expect(signedIn)
        await hold.open()
        await first.value
        await second.value
        #expect(issues == 1)
        #expect(!tile.starting)
        #expect(keyStored == "k3y")
        #expect(!signedIn)
    }

    /// A sign-out (or someone else's sign-in) while the key is on its way: the key is kept, but
    /// nobody is signed out by a tap they didn't make.
    @Test func aSessionThatChangedMeanwhileIsNotSignedOut() async {
        let hold = HoldGate()
        api.stationKeyResult = { _ in await hold.wait(); return "k3y" }
        let tile = makeTile()
        let first = Task { await tile.start() }
        #expect(await waitUntil { issues == 1 })
        await auth.logout()
        await auth.completePair(fakeSession(personId: "p2"))
        await hold.open()
        await first.value
        #expect(keyStored == "k3y")
        guard case .authed(let s) = auth.state else { Issue.record("signed out by the earlier tap"); return }
        #expect(s.person.id == "p2")
        #expect(!tile.starting)
    }

    // MARK: the setup changes underneath the tile

    /// The red message belongs to this Time Clock station's setup: it shows only while the kiosk
    /// is one, and a re-setup or a Clear Setup clears it, so it never greets the next setup.
    @Test func theErrorGoesWithTheTimeClockSetup() async {
        api.stationKeyResult = { _ in throw ApiError.network() }
        let tile = makeTile()
        let text = "The station key hasn't arrived yet. Check the connection and try again in a minute."

        // set up again as a Regular kiosk: hidden at once, then cleared
        await tile.start()
        #expect(tile.shownError == text)
        prefs.setupSelection = testSelection(initiativeId: "i1")
        #expect(tile.shownError == nil)
        #expect(await waitUntil { tile.error == nil })
        // back to a Time Clock station: nothing stale comes back
        prefs.setupSelection = timeclockSelection()
        #expect(await waitUntil { tile.shownError == nil && tile.error == nil })

        // an administrator's Clear Setup
        await tile.start()
        #expect(tile.shownError == text)
        prefs.applySetupClear("clear-1")
        #expect(tile.shownError == nil)
        #expect(await waitUntil { tile.error == nil })
        prefs.setupSelection = timeclockSelection()
        prefs.setupState = .complete
        try? await Task.sleep(for: .milliseconds(20))
        #expect(tile.shownError == nil)

        // the same setup written again is no change: the message stays until the next tap
        await tile.start()
        prefs.setupSelection = timeclockSelection()
        try? await Task.sleep(for: .milliseconds(20))
        #expect(tile.shownError == text)
        #expect(signedIn)
    }

    /// A Clear Setup that lands while the key is on its way: the key belongs to a Time Clock
    /// station this kiosk no longer is, so it is dropped, and nobody is signed out.
    @Test func aClearSetupDuringTheIssueDropsTheKeyAndKeepsTheSession() async {
        let hold = HoldGate()
        api.stationKeyResult = { _ in await hold.wait(); return "k3y" }
        let tile = makeTile()
        let first = Task { await tile.start() }
        #expect(await waitUntil { issues == 1 })
        prefs.applySetupClear("clear-1")
        station.clearKey()                                   // what the container does as the clear lands
        await hold.open()
        await first.value
        #expect(keyStored == nil)
        #expect(!station.hasKey)
        #expect(signedIn)                                    // the person lands on Kiosk Setup, still signed in
        #expect(tile.error == nil)
        #expect(!tile.starting)
    }

    /// A failed issue under a setup that went meanwhile leaves no message behind for later.
    @Test func aFailureAfterAClearSetupLeavesNoMessage() async {
        let hold = HoldGate()
        api.stationKeyResult = { _ in await hold.wait(); throw ApiError.network() }
        let tile = makeTile()
        let first = Task { await tile.start() }
        #expect(await waitUntil { issues == 1 })
        prefs.applySetupClear("clear-1")
        await hold.open()
        await first.value
        #expect(tile.error == nil)
        prefs.setupSelection = timeclockSelection()          // set up as a Time Clock station again
        try? await Task.sleep(for: .milliseconds(20))
        #expect(tile.shownError == nil)
        #expect(signedIn)
    }
}
