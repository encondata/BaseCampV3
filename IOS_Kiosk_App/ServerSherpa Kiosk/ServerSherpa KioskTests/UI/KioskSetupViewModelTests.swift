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
        let store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
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
        KioskSetupViewModel(api: api, identity: identity, prefs: prefs, sync: sync, auth: auth,
                            heartbeat: Heartbeat(api: api, identity: identity, version: "1", rawInfo: { [:] }),
                            station: TimeclockStation(keys: StationKeyStore(secrets: MemorySecretStore()), serial: { "SER" }))
    }

    private func saved(_ state: SetupState = .complete) {
        prefs.setupState = state
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i", initiativeName: "Move A", siteId: "s", siteName: "Dock 4", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
    }

    private func acceptSetup() {
        api.submitSetupResult = { KioskSetupResult(deviceId: "d", initiativeId: $0.initiativeId, initiativeName: "Move A", siteId: $0.siteId, siteName: "Dest", siteRole: "destination", scanStatus: $0.scanStatus, scanStatusLabel: "Pre-stage") }
    }

    @Test func wizardWalksFiveStepsAndSaves() async {
        acceptSetup()
        let vm = makeVM()
        await vm.load()
        #expect(vm.step == .type)
        vm.pickKind(.regular); #expect(vm.step == .move)
        vm.pickMove("i1"); #expect(vm.step == .site)
        #expect(vm.siteChoices.map(\.site.name) == ["Origin", "Dest"])
        #expect(vm.siteChoices.map(\.role) == ["source", "destination"])
        vm.pickSite("s2"); #expect(vm.step == .scanType)
        vm.pickScanType("pre_stage"); #expect(vm.step == .labels)
        #expect(vm.scanStatus == "pre_stage")
        #expect(!api.calls.contains("submitSetup"))         // the scan type only advances
        #expect(vm.labelKind == .top)                        // Top is preselected
        await vm.finish(.top)
        #expect(vm.step == .summary)
        #expect(!vm.saving)
        #expect(prefs.setupSelection?.siteName == "Dest")
        #expect(prefs.setupSelection?.labelKind == "top")
        #expect(prefs.setupState == .complete)
        await waitUntil { api.calls.contains("syncAssets") }
        #expect(api.calls.contains("syncAssets"))
    }

    @Test func finishingOnFrontSavesFrontAndTheStoreReportsIt() async {
        acceptSetup()
        let settings = LabelSettingsStore(prefs: prefs)
        let vm = makeVM()
        await vm.load()
        vm.pickMove("i1"); vm.pickSite("s2"); vm.pickScanType("pre_stage")
        #expect(settings.current().kind == .top)
        await vm.finish(.front)
        #expect(vm.labelKind == .front)
        #expect(prefs.setupSelection?.labelKind == "front")
        #expect(settings.current().kind == .front)
    }

    @Test func backFromStepFourGoesToStepThree() async {
        let vm = makeVM()
        await vm.load()
        vm.pickMove("i1"); vm.pickSite("s2"); vm.pickScanType("pre_stage")
        #expect(vm.step == .labels)
        vm.back(); #expect(vm.step == .scanType)
        #expect(vm.scanStatus == "pre_stage")
    }

    /// A re-run ("Change setup") preselects the saved kind; a fresh setup preselects Top.
    @Test func aRerunPreselectsTheSavedKind() async {
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move A", siteId: "s2", siteName: "Dest", siteRole: "destination",
                                                   scanStatus: "pre_stage", scanLabel: "Pre-stage", labelKind: "front")
        prefs.setupState = .complete
        let vm = makeVM()
        #expect(vm.step == .summary)
        vm.changeSetup()
        #expect(vm.labelKind == .front)
        await waitUntil { vm.options != nil }
        vm.pickMove("i1"); vm.pickSite("s2"); vm.pickScanType("pre_stage")
        #expect(vm.labelKind == .front)                      // still the saved kind on step 4

        prefs.setupSelection = nil
        vm.changeSetup()
        #expect(vm.labelKind == .top)
        #expect(makeVM().labelKind == .top)                  // a fresh setup starts at Top
    }

    /// A saved selection from before kinds existed (or an unknown kind) reads as Top.
    @Test func anUnknownSavedKindPreselectsTop() {
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move A", siteId: "s2", siteName: "Dest", siteRole: "destination",
                                                   scanStatus: "pre_stage", scanLabel: "Pre-stage", labelKind: "side")
        prefs.setupState = .complete
        let vm = makeVM()
        vm.changeSetup()
        #expect(vm.labelKind == .top)
    }

    /// Changing an existing setup through the wizard lands on its summary, with no second load.
    @Test func changingSetupThroughTheWizardDoesNotRestartIt() async {
        api.submitSetupResult = { KioskSetupResult(deviceId: "d", initiativeId: $0.initiativeId, initiativeName: "Move A", siteId: $0.siteId, siteName: "Origin", siteRole: "source", scanStatus: $0.scanStatus, scanStatusLabel: "Pre-stage") }
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move A", siteId: "s2", siteName: "Dest", siteRole: "destination", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        prefs.setupState = .complete
        let vm = makeVM()
        vm.changeSetup()
        await waitUntil { vm.options != nil }
        vm.pickMove("i1"); vm.pickSite("s1"); vm.pickScanType("pre_stage")
        await vm.finish(.top)
        #expect(vm.step == .summary)
        #expect(prefs.setupSelection?.siteName == "Origin")
        #expect(api.calls.filter { $0 == "setupOptions" }.count == 1)
    }

    @Test func stepHeaderCountsFiveSteps() async {
        let vm = makeVM()
        await vm.load()
        #expect(vm.stepNumber == 1); #expect(vm.stepHeader == "STEP 1 · TYPE")
        vm.pickKind(.regular); #expect(vm.stepNumber == 2); #expect(vm.stepHeader == "STEP 2 OF 5 · MOVE")
        vm.pickMove("i1"); #expect(vm.stepHeader == "STEP 3 OF 5 · SITE")
        vm.pickSite("s1"); #expect(vm.stepHeader == "STEP 4 OF 5 · SCAN TYPE")
        vm.pickScanType("pre_stage"); #expect(vm.stepNumber == 5); #expect(vm.stepHeader == "STEP 5 OF 5 · LABELS")
        acceptSetup()
        await vm.finish(.top)
        #expect(vm.stepNumber == nil); #expect(vm.stepHeader == nil)
    }

    @Test func labelKindCardsCopy() {
        #expect(KioskSetupViewModel.labelKindChoices.map(\.kind) == [.top, .front])
        #expect(KioskSetupViewModel.labelKindChoices.map(\.title) == ["Top", "Front"])
        #expect(KioskSetupViewModel.labelKindChoices.map(\.blurb) == ["Labels for the top of the device.", "Labels for the front of the device."])
        #expect(KioskSetupViewModel.labelsHeading == "What do labels print on?")
    }

    @Test func failureMarksFailedOnlyWhenNotAlreadyComplete() async {
        api.submitSetupResult = { _ in throw ApiError(status: 422, code: "bad_site") }
        let vm = makeVM()
        await vm.load(); vm.pickMove("i1"); vm.pickSite("s1"); vm.pickScanType("pre_stage")
        await vm.finish(.top)
        #expect(vm.saveError == "bad_site")
        #expect(vm.step == .labels)
        #expect(!vm.saving)
        #expect(prefs.setupState == .failed)
        #expect(prefs.setupSelection == nil)
    }

    @Test func failureKeepsAnAlreadyCompleteSetup() async {
        saved()
        api.submitSetupResult = { _ in throw ApiError(status: 422, code: "bad_site") }
        let vm = makeVM()
        vm.changeSetup()
        await waitUntil { vm.options != nil }
        vm.pickMove("i1"); vm.pickSite("s1"); vm.pickScanType("pre_stage")
        await vm.finish(.front)
        #expect(prefs.setupState == .complete)
        #expect(prefs.setupSelection?.labelKind == "top")   // the failed save keeps the saved kind
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
        #expect(makeVM().step == .type)
        saved(.failed)
        #expect(makeVM().step == .type)
    }

    @Test func changeSetupPreselectsAndRevalidatesCachedChoices() async {
        saved()   // initiative "i" is not offered, so the cached choices are dropped
        let vm = makeVM()
        vm.changeSetup()
        #expect(vm.step == .type)
        #expect(vm.kind == .regular)
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

    @Test func backStepsDownAndStopsAtType() async {
        let vm = makeVM()
        await vm.load(); vm.pickKind(.regular); vm.pickMove("i1"); vm.pickSite("s1"); vm.pickScanType("pre_stage")
        vm.back(); #expect(vm.step == .scanType)
        vm.back(); #expect(vm.step == .site)
        vm.back(); #expect(vm.step == .move)
        vm.back(); #expect(vm.step == .type)
        vm.back(); #expect(vm.step == .type)
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
