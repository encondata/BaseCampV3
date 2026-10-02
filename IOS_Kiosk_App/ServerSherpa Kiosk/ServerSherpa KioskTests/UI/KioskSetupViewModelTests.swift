import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct KioskSetupViewModelTests {
    private let api = FakeKioskApi()
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let identity: Identity
    private let sync: Sync
    private let auth: KioskAuth

    private static let options = SetupOptions(
        initiatives: [SetupOptionInitiative(id: "i1", name: "Move A", status: "in_progress", statusLabel: "In progress", clientName: "Acme", scheduledStart: "2026-09-20T00:00:00Z", scheduledEnd: "2026-09-22T00:00:00Z", sourceSite: SetupOptionSite(id: "s1", name: "Origin"), destinationSite: SetupOptionSite(id: "s2", name: "Dest"))],
        scanTypes: [SetupOptionScanType(key: "pre_stage", label: "Pre-stage", color: "#abc")])

    init() throws {
        identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let store = KioskStore(modelContainer: try KioskSchema.container(inMemory: true))
        sync = Sync(api: api, store: store)
        auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
        let options = Self.options
        api.setupOptionsResult = { options }
        api.assets = { KioskAssetsSync(initiativeId: "i1", initiativeName: "Move A", generatedAt: "now") }
        api.people = { KioskPeopleSync(generatedAt: "now") }
        api.containers = { KioskContainersSync(initiativeId: "i1", generatedAt: "now") }
        api.trucks = { KioskTrucksSync(initiativeId: "i1", generatedAt: "now") }
    }

    private func makeVM() -> KioskSetupViewModel {
        KioskSetupViewModel(api: api, identity: identity, prefs: prefs, sync: sync, auth: auth)
    }

    private func saved(_ state: SetupState = .complete) {
        prefs.setupState = state
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i", initiativeName: "Move A", siteId: "s", siteName: "Dock 4", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
    }

    @Test func wizardWalksThreeStepsAndSaves() async {
        api.submitSetupResult = { KioskSetupResult(deviceId: "d", initiativeId: $0.initiativeId, initiativeName: "Move A", siteId: $0.siteId, siteName: "Dest", siteRole: "destination", scanStatus: $0.scanStatus, scanStatusLabel: "Pre-stage") }
        let vm = makeVM()
        await vm.load()
        #expect(vm.step == .move)
        vm.pickMove("i1"); #expect(vm.step == .site)
        #expect(vm.siteChoices.map(\.site.name) == ["Origin", "Dest"])
        #expect(vm.siteChoices.map(\.role) == ["source", "destination"])
        vm.pickSite("s2"); #expect(vm.step == .scanType)
        await vm.pickScanType("pre_stage")
        #expect(vm.step == .summary)
        #expect(!vm.saving)
        #expect(prefs.setupSelection?.siteName == "Dest")
        #expect(prefs.setupState == .complete)
        await waitUntil { api.calls.contains("syncAssets") }
        #expect(api.calls.contains("syncAssets"))
    }

    @Test func failureMarksFailedOnlyWhenNotAlreadyComplete() async {
        api.submitSetupResult = { _ in throw ApiError(status: 422, code: "bad_site") }
        let vm = makeVM()
        await vm.load(); vm.pickMove("i1"); vm.pickSite("s1")
        await vm.pickScanType("pre_stage")
        #expect(vm.saveError == "bad_site")
        #expect(vm.step == .scanType)
        #expect(prefs.setupState == .failed)
        #expect(prefs.setupSelection == nil)
    }

    @Test func failureKeepsAnAlreadyCompleteSetup() async {
        saved()
        api.submitSetupResult = { _ in throw ApiError(status: 422, code: "bad_site") }
        let vm = makeVM()
        vm.changeSetup()
        await waitUntil { vm.options != nil }
        vm.pickMove("i1"); vm.pickSite("s1")
        await vm.pickScanType("pre_stage")
        #expect(prefs.setupState == .complete)
        #expect(prefs.setupSelection?.siteName == "Dock 4")
    }

    @Test func dates() {
        let i = Self.options.initiatives[0]
        #expect(formatMoveDates(i) == "Sep 20 – Sep 22")
        var startOnly = i; startOnly.scheduledEnd = nil
        #expect(formatMoveDates(startOnly) == "Starts Sep 20")
        var endOnly = i; endOnly.scheduledStart = nil
        #expect(formatMoveDates(endOnly) == "Ends Sep 22")
        var none = i; none.scheduledStart = nil; none.scheduledEnd = nil
        #expect(formatMoveDates(none) == nil)
    }

    @Test func datesAreUtcDaysWithFractionsAndFallBack() {
        var i = Self.options.initiatives[0]
        i.scheduledStart = "2026-09-03T23:30:00.123Z"; i.scheduledEnd = "2026-09-05T00:00:00Z"
        #expect(formatMoveDates(i) == "Sep 3 – Sep 5")
        i.scheduledStart = "2026-09-03"; i.scheduledEnd = nil
        #expect(formatMoveDates(i) == "Starts 2026-09-03")
    }

    @Test func cssColors() {
        #expect(parseCssHex("#abc") == 0xAABBCC)
        #expect(parseCssHex("#12ab9f") == 0x12AB9F)
        #expect(parseCssHex("red") == 0x8A97AA)
        #expect(parseCssHex("#zzz") == 0x8A97AA)
    }

    // Android KioskSetupScreenTest.summaryWhenSetUp
    @Test func summaryWhenSetUp() async {
        saved()
        let vm = makeVM()
        #expect(vm.step == .summary)
        #expect(vm.selection?.initiativeName == "Move A")
        #expect(vm.selection?.siteName == "Dock 4")
        #expect(sync.status.phase == .idle)   // "No move data on this kiosk yet."
        #expect(!api.calls.contains("setupOptions"))
    }

    @Test func incompleteSetupOpensTheWizard() {
        #expect(makeVM().step == .move)
        saved(.failed)
        #expect(makeVM().step == .move)
    }

    @Test func changeSetupPreselectsAndRevalidatesCachedChoices() async {
        saved()   // initiative "i" is not offered, so the cached choices are dropped
        let vm = makeVM()
        vm.changeSetup()
        #expect(vm.step == .move)
        #expect(vm.initiativeId == "i")
        await waitUntil { vm.options != nil }
        #expect(vm.initiativeId == ""); #expect(vm.siteId == ""); #expect(vm.scanStatus == "")
        #expect(vm.canCancel)
        vm.cancelChange()
        #expect(vm.step == .summary)
    }

    @Test func cachedChoicesSurviveWhenStillOffered() async {
        prefs.setupState = .complete
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move A", siteId: "s9", siteName: "Gone", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        let vm = makeVM()
        vm.changeSetup()
        await waitUntil { vm.options != nil }
        #expect(vm.initiativeId == "i1")
        #expect(vm.siteId == "")            // site no longer on the move
        #expect(vm.scanStatus == "pre_stage")
    }

    @Test func loadErrorThenRetry() async {
        api.setupOptionsResult = { throw ApiError(status: 500, code: "boom") }
        let vm = makeVM()
        await vm.load()
        #expect(vm.loadError == "Couldn't load setup options.")
        #expect(vm.options == nil)
        let options = Self.options
        api.setupOptionsResult = { options }
        await vm.load()
        #expect(vm.loadError == nil); #expect(vm.options != nil)
    }

    @Test func backStepsDownAndStopsAtMove() async {
        let vm = makeVM()
        await vm.load(); vm.pickMove("i1"); vm.pickSite("s1")
        vm.back(); #expect(vm.step == .site)
        vm.back(); #expect(vm.step == .move)
        vm.back(); #expect(vm.step == .move)
    }

    @Test func pickingADifferentMoveClearsTheSite() async {
        let vm = makeVM()
        await vm.load(); vm.pickMove("i1"); vm.pickSite("s1")
        vm.pickMove("i1"); #expect(vm.siteId == "s1")
        vm.pickMove("other"); #expect(vm.siteId == "")
    }

    @Test func aMoveSessionSeesOnlyItsMove() async throws {
        var opts = Self.options
        opts.initiatives.append(SetupOptionInitiative(id: "i2", name: "Move B", status: "planned", statusLabel: "Planned"))
        let offered = opts
        api.setupOptionsResult = { offered }
        api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "i2", name: "Move B")) }
        try await auth.moveLogin(password: "pw")
        let vm = makeVM()
        await vm.load()
        #expect(vm.options?.initiatives.map(\.id) == ["i2"])
    }

    @Test func aNormalSessionSeesEveryMove() async throws {
        var opts = Self.options
        opts.initiatives.append(SetupOptionInitiative(id: "i2", name: "Move B", status: "planned", statusLabel: "Planned"))
        let offered = opts
        api.setupOptionsResult = { offered }
        api.loginResult = { fakeSession() }
        try await auth.login(email: "a@b.c", password: "pw")
        let vm = makeVM()
        await vm.load()
        #expect(vm.options?.initiatives.map(\.id) == ["i1", "i2"])
    }

    @Test func syncAgainRunsForTheSavedSelection() async {
        saved()
        let vm = makeVM()
        vm.syncAgain()
        await waitUntil { sync.status.phase == .done }
        #expect(api.calls.contains("syncPeople"))
    }
}
