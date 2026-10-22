import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// Kiosk Setup's "What is this kiosk?" step and the Time Clock path (Android
/// KioskSetupViewModelTest's station cases): Move with No move → Site with No site →
/// save, issue the station key (one heartbeat and one retry on not_signed_in_here),
/// store it, sign out to the station's Welcome. A Regular re-setup drops the key.
@MainActor
struct KioskSetupTimeclockTests {
    private let api = FakeKioskApi()
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let secrets = MemorySecretStore()
    private let identity: Identity
    private let sync: Sync
    private let auth: KioskAuth
    private let heartbeat: Heartbeat
    private let station: TimeclockStation

    private static let options = SetupOptions(
        initiatives: [SetupOptionInitiative(id: "i1", name: "Move A", status: "in_progress", statusLabel: "In progress",
                                            sourceSite: SetupOptionSite(id: "s1", name: "Origin"), destinationSite: SetupOptionSite(id: "s2", name: "Dest"))],
        scanTypes: [SetupOptionScanType(key: "pre_stage", label: "Pre-stage", color: "#abc")],
        sites: [SetupOptionSite(id: "s1", name: "Origin"), SetupOptionSite(id: "s2", name: "Dest"), SetupOptionSite(id: "s3", name: "Yard")])

    init() async throws {
        identity = Identity(prefs: prefs, secrets: secrets)
        let store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        sync = Sync(api: api, store: store)
        auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
        heartbeat = Heartbeat(api: api, identity: identity, version: "1", rawInfo: { [:] })
        let identity = self.identity
        station = TimeclockStation(keys: StationKeyStore(secrets: secrets), serial: { identity.current.serial }, apiUrl: { TEST_API_URL })
        let options = Self.options
        api.setupOptionsResult = { options }
        api.loginResult = { fakeSession() }
        api.submitSetupResult = { body in
            KioskSetupResult(deviceId: "d", initiativeId: body.initiativeId, initiativeName: body.initiativeId == nil ? nil : "Move A",
                             siteId: body.siteId, siteName: body.siteId.map { ["s1": "Origin", "s2": "Dest", "s3": "Yard"][$0] ?? "?" },
                             siteRole: body.siteId == nil ? nil : (body.initiativeId == nil ? nil : "source"),
                             scanStatus: body.scanStatus, scanStatusLabel: body.scanStatus == nil ? nil : "Pre-stage")
        }
        api.stationKeyResult = { _ in "k3y" }
        try await auth.login(email: "a@b.c", password: "pw")
    }

    private func makeVM() -> KioskSetupViewModel {
        KioskSetupViewModel(api: api, identity: identity, prefs: prefs, sync: sync, auth: auth, heartbeat: heartbeat, station: station)
    }

    private var keyStored: String? { StationKeyStore(secrets: secrets).get() }

    @Test func theFirstStepAsksWhatThisKioskIs() async {
        let vm = makeVM()
        #expect(vm.step == .type)
        #expect(KioskSetupViewModel.typeHeading == "What is this kiosk?")
        #expect(KioskSetupViewModel.kindChoices.map(\.kind) == [.regular, .timeclock])
        #expect(KioskSetupViewModel.kindChoices.map(\.title) == ["Regular kiosk", "Time Clock"])
        #expect(KioskSetupViewModel.kindChoices.map(\.blurb) == ["Scan, enroll and print with a signed-in crew.",
                                                                  "Crews clock in and out here; it stays ready on its own."])
        #expect(vm.stepHeader == "STEP 1 · TYPE")
        await vm.load()
        vm.pickKind(.timeclock)
        #expect(vm.step == .move)
        #expect(vm.stepHeader == "STEP 2 OF 3 · MOVE")
        vm.back()
        #expect(vm.step == .type)
        #expect(vm.stepHeader == "STEP 1 OF 3 · TYPE")
        vm.pickKind(.regular)
        #expect(vm.stepHeader == "STEP 2 OF 5 · MOVE")
        #expect(!vm.offersNoMove)                            // a regular kiosk always has a move
    }

    @Test func noMoveListsEverySiteAndNoSite() async {
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock)
        #expect(vm.offersNoMove)
        #expect(KioskSetupViewModel.noMoveBlurb == "Punches are filed under no move and sorted out later in the portal.")
        vm.pickNoMove()
        #expect(vm.step == .site)
        #expect(vm.noMove)
        #expect(vm.offersNoSite)
        #expect(vm.stepHeader == "STEP 3 OF 3 · SITE")
        #expect(vm.siteChoices.map(\.site.name) == ["Origin", "Dest", "Yard"])
        #expect(vm.siteChoices.allSatisfy { $0.role.isEmpty })   // no source/destination without a move
    }

    @Test func aMovesStationOffersTheMovesSitesAndNoNoSite() async {
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock)
        vm.pickMove("i1")
        #expect(!vm.noMove)
        #expect(!vm.offersNoSite)
        #expect(vm.siteChoices.map(\.site.name) == ["Origin", "Dest"])
        #expect(vm.siteChoices.map(\.role) == ["source", "destination"])
    }

    @Test func aMoveSessionGetsNoNoMoveCard() async throws {
        api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "i1", name: "Move A")) }
        try await auth.moveLogin(password: "pw")
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock)
        #expect(!vm.offersNoMove)
    }

    @Test func noMoveNoSiteSavesIssuesTheKeyAndSignsOut() async {
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock)
        vm.pickNoMove()
        await vm.finishTimeclock(siteId: nil)
        let body = api.submitSetupBodies.last
        #expect(body?.initiativeId == nil)
        #expect(body?.siteId == nil)
        #expect(body?.scanStatus == nil)                     // a Time Clock path has no scan type
        #expect(body?.stationType == "timeclock")
        #expect(api.calls.filter { $0 == "issueStationKey" }.count == 1)
        #expect(keyStored == "k3y")
        #expect(station.hasKey)
        let sel = prefs.setupSelection
        #expect(sel?.isTimeclockStation == true)
        #expect(sel?.initiativeName == "No move")
        #expect(sel?.siteName == "No site")
        #expect(sel?.siteRole == "none")
        #expect(sel?.moveId == nil); #expect(sel?.siteIdOrNil == nil)
        #expect(prefs.setupState == .complete)
        #expect(auth.state == .anon)                         // signed out: the station rests on Welcome
        #expect(guardScreen(for: auth.state, stationResting: stationRests(selection: sel, loginRequested: station.loginRequested)) == .stationResting)
        #expect(!api.calls.contains("syncAssets"))           // a Time Clock station downloads no move data
    }

    @Test func noMoveWithASiteSavesTheSiteAsOther() async {
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock)
        vm.pickNoMove()
        await vm.finishTimeclock(siteId: "s3")
        #expect(api.submitSetupBodies.last?.siteId == "s3")
        #expect(prefs.setupSelection?.siteName == "Yard")
        #expect(prefs.setupSelection?.siteRole == "other")
        #expect(prefs.setupSelection?.initiativeName == "No move")
    }

    @Test func aMovesStationSendsTheMoveAndSite() async {
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock)
        vm.pickMove("i1")
        await vm.finishTimeclock(siteId: "s1")
        #expect(api.submitSetupBodies.last?.initiativeId == "i1")
        #expect(api.submitSetupBodies.last?.siteId == "s1")
        #expect(prefs.setupSelection?.initiativeName == "Move A")
        #expect(prefs.setupSelection?.siteRole == "source")
        #expect(keyStored == "k3y")
    }

    @Test func notSignedInHereSendsOneSignInHeartbeatAndRetriesOnce() async {
        let tries = LockedCounter()
        api.stationKeyResult = { _ in
            if tries.next() == 1 { throw ApiError(status: 403, code: "not_signed_in_here") }
            return "k3y"
        }
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock); vm.pickNoMove()
        await vm.finishTimeclock(siteId: nil)
        #expect(api.calls.filter { $0 == "issueStationKey" }.count == 2)
        #expect(api.heartbeats.count == 1)
        #expect(api.heartbeats.first?.signIn == true)
        #expect(api.heartbeats.first?.loginMethod == "password")
        #expect(keyStored == "k3y")
        #expect(auth.state == .anon)
    }

    @Test func aSecondNotSignedInHereIsAnErrorAndStaysSignedIn() async {
        api.stationKeyResult = { _ in throw ApiError(status: 403, code: "not_signed_in_here") }
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock); vm.pickNoMove()
        await vm.finishTimeclock(siteId: nil)
        #expect(api.calls.filter { $0 == "issueStationKey" }.count == 2)   // one retry, no loop
        #expect(api.heartbeats.count == 1)
        #expect(vm.keyError == "not_signed_in_here")
        #expect(vm.step == .site)
        #expect(!vm.saving)
        #expect(keyStored == nil)
        #expect(prefs.setupSelection?.isTimeclockStation == true)        // the setup itself saved
        if case .authed = auth.state {} else { Issue.record("signed out on a failed key") }
    }

    @Test func aFailedSetupSaveIssuesNoKey() async {
        api.submitSetupResult = { _ in throw ApiError(status: 422, code: "bad_site") }
        let vm = makeVM()
        await vm.load()
        vm.pickKind(.timeclock); vm.pickNoMove()
        await vm.finishTimeclock(siteId: nil)
        #expect(vm.saveError == "bad_site")
        #expect(!api.calls.contains("issueStationKey"))
        #expect(prefs.setupSelection == nil)
        #expect(prefs.setupState == .failed)
    }

    @Test func aRegularResetupDropsTheKey() async {
        StationKeyStore(secrets: secrets).put("old", origin: apiOrigin(TEST_API_URL))
        let station = TimeclockStation(keys: StationKeyStore(secrets: secrets), serial: { "SER" }, apiUrl: { TEST_API_URL })
        #expect(station.hasKey)
        prefs.setupSelection = timeclockSelection()
        prefs.setupState = .complete
        let vm = KioskSetupViewModel(api: api, identity: identity, prefs: prefs, sync: sync, auth: auth, heartbeat: heartbeat, station: station)
        #expect(vm.step == .summary)
        vm.changeSetup()
        #expect(vm.step == .type)
        #expect(vm.kind == .timeclock)                        // the saved kind is preselected
        #expect(vm.noMove)
        await waitUntil { vm.options != nil }
        vm.pickKind(.regular)
        #expect(!vm.noMove)
        vm.pickMove("i1"); vm.pickSite("s1"); vm.pickScanType("pre_stage")
        await vm.finish(.top)
        #expect(vm.step == .summary)
        #expect(prefs.setupSelection?.isTimeclockStation == false)
        #expect(StationKeyStore(secrets: secrets).get() == nil)
        #expect(!station.hasKey)
        #expect(api.submitSetupBodies.last?.stationType == nil)
    }

    @Test func cancelOnTheTypeStepReturnsToTheSummary() async {
        prefs.setupSelection = timeclockSelection()
        prefs.setupState = .complete
        let vm = makeVM()
        vm.changeSetup()
        #expect(vm.canCancel)
        vm.cancelChange()
        #expect(vm.step == .summary)
    }

    @Test func theSummaryNamesNoMoveAndNoSite() {
        #expect(setupSummaryText(timeclockSelection()) == "This kiosk is a Time Clock station for no move at no site.")
        #expect(setupSummaryText(timeclockSelection(initiativeId: "i1", siteId: "s1")) == "This kiosk is a Time Clock station for Move A at Dock 4.")
        #expect(setupSummaryText(testSelection(initiativeId: "i1")) == "This kiosk is set up for Move at HQ (source) · scan type Pre-stage")
    }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int { lock.withLock { n += 1; return n } }
}
