import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// A list download held until the test hands it its answer.
@MainActor
private final class HeldList {
    private var waiting: CheckedContinuation<[Env], Never>?
    private(set) var asked = 0

    func fetch() async -> [Env] {
        asked += 1
        return await withCheckedContinuation { waiting = $0 }
    }

    func answer(_ list: [Env]) {
        waiting?.resume(returning: list)
        waiting = nil
    }

    var isWaiting: Bool { waiting != nil }
}

/// A switch held until the test hands it its answer; records every call.
@MainActor
private final class HeldSwitch {
    private var waiting: CheckedContinuation<SwitchResult, Error>?
    private(set) var calls: [(target: SavedEnvironment, discard: Bool)] = []

    func run(_ target: SavedEnvironment, _ discard: Bool) async throws -> SwitchResult {
        calls.append((target, discard))
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }

    func answer(_ result: SwitchResult) {
        waiting?.resume(returning: result)
        waiting = nil
    }

    func fail(_ error: Error) {
        waiting?.resume(throwing: error)
        waiting = nil
    }

    var isWaiting: Bool { waiting != nil }
}

/// Settings › This Kiosk's environment chooser (Android EnvironmentChooserTest), at model level:
/// its steps, its copy for every answer, its busy state, and the badge and row text. Nothing here
/// reaches the network or the Keychain: the switches are fakes or a whole container with a fake
/// server and a stubbed environment-list session.
@MainActor
struct EnvironmentChooserTests {
    private let uat = Environments.byId("uat")!
    private let rc1 = Environments.byId("rc1")!
    private let prod = Environments.byId("prod")!
    private let customEnv = SavedEnvironment.custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "http://10.10.48.103:5173")
    private let cached = [Env(id: "rc2", name: "RC2", domain: "rc2.serversherpa.com")]
    private let fresh = [Env(id: "rc3", name: "RC3", domain: "rc3.serversherpa.com"),
                         Env(id: "dev", name: "Dev", domain: "dev.serversherpa.com")]

    /// A model on `current` whose switch answers `answer` at once (recording its calls in `log`).
    private func model(_ current: SavedEnvironment? = nil, cachedList: [Env]? = nil, freshList: [Env]? = nil,
                       answer: @escaping @MainActor (SavedEnvironment, Bool) async throws -> SwitchResult = { _, _ in .done },
                       activity: @escaping @MainActor () -> Void = {},
                       sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) })
        -> EnvironmentChooserModel {
        let builtIn = Environments.builtIn
        return EnvironmentChooserModel(current: current ?? uat.asSaved, cachedList: { cachedList },
                                       freshList: { freshList ?? builtIn }, switchTo: answer,
                                       activity: activity, sleep: sleep)
    }

    private func unlocked(_ m: EnvironmentChooserModel) -> EnvironmentChooserModel {
        m.typePassword(Environments.password)
        m.unlock()
        return m
    }

    // MARK: password

    @Test func aWrongPasswordShowsItsCopyAndStaysOnThePasswordStep() {
        var typed = 0
        let m = model(activity: { typed += 1 })
        #expect(m.step == .password)
        #expect(!m.canContinue)
        m.unlock()                                    // nothing typed: Continue does nothing
        #expect(m.step == .password && m.error == nil)

        m.typePassword("nimbus")
        #expect(m.canContinue)
        #expect(typed == 1, "typing counts as activity on a Time Clock station's sign-in page")
        m.unlock()
        #expect(m.step == .password)
        #expect(m.error == "That password isn't right.")

        m.typePassword("cumulu")                      // typing again clears the line
        #expect(m.error == nil)
        #expect(typed == 2)
    }

    @Test func theEnvironmentPasswordOpensTheList() {
        let m = unlocked(model())
        #expect(m.step == .list)
        #expect(m.error == nil)
    }

    @Test func thePasswordHasNoLengthLimit() {
        let m = model()
        let long = String(repeating: "x", count: 500)
        m.typePassword(long)
        #expect(m.password == long)
    }

    // MARK: the list

    @Test func theSavedListShowsAtOnceAndTheDownloadReplacesItInPlace() async {
        let held = HeldList()
        let m = EnvironmentChooserModel(current: uat.asSaved, cachedList: { [cached] in cached }, freshList: { await held.fetch() },
                                        switchTo: { _, _ in .done })
        #expect(m.list == nil)
        #expect(EnvironmentChooserModel.loadingText == "Loading environments…")
        let load = Task { await m.loadList() }
        #expect(await waitUntil { held.isWaiting })
        #expect(m.list == cached, "the last good download shows while the fresh one is on its way")
        held.answer(fresh)
        await load.value
        #expect(m.list == fresh)
    }

    @Test func withNothingSavedTheBuiltInListShowsFirst() async {
        let held = HeldList()
        let m = EnvironmentChooserModel(current: uat.asSaved, cachedList: { nil }, freshList: { await held.fetch() },
                                        switchTo: { _, _ in .done })
        let load = Task { await m.loadList() }
        #expect(await waitUntil { held.isWaiting })
        #expect(m.list == Environments.builtIn)
        held.answer(Environments.builtIn)
        await load.value
    }

    @Test func theCurrentEnvironmentIsMarkedByItsIdAndDomainAndCantBePicked() {
        let m = unlocked(model(uat.asSaved))
        #expect(m.isCurrent(uat))
        #expect(!m.isCurrent(rc1))
        #expect(!m.customIsCurrent)
        m.choose(uat)
        #expect(m.step == .list, "the current one can't be picked")
        #expect(EnvironmentChooserModel.customRowText == "Custom URL…")
    }

    /// Review Focus 1: the list's entry for the saved id now has another domain. It is a normal
    /// choice, and picking it is a full switch to the new domain.
    @Test func theSavedIdUnderAnotherDomainIsANormalChoice() async {
        let moved = Env(id: "uat", name: "UAT", domain: "uat2.serversherpa.com")
        var asked: [SavedEnvironment] = []
        let m = unlocked(model(uat.asSaved, answer: { target, _ in asked.append(target); return .done }))
        #expect(!m.isCurrent(moved))
        m.choose(moved)
        #expect(m.step == .confirm)
        #expect(await m.switchNow(discard: false))
        #expect(asked == [moved.asSaved])
    }

    @Test func aCustomKioskMarksCustomButCanStillEditIt() {
        let m = unlocked(model(customEnv))
        #expect(m.customIsCurrent)
        #expect(!m.isCurrent(uat))
        m.chooseCustom()
        #expect(m.step == .custom)
        #expect(m.customApi == "http://10.10.48.103:8000")
        #expect(m.customPortal == "http://10.10.48.103:5173")
    }

    // MARK: confirm

    @Test func confirmSaysWhatASwitchClearsAndCancelGoesBackToTheList() {
        let m = unlocked(model())
        m.choose(rc1)
        #expect(m.step == .confirm)
        #expect(m.confirmText == "Switching to RC1 signs this kiosk out and clears its setup and saved move data.")
        m.backToList()
        #expect(m.step == .list)

        m.chooseCustom()
        #expect(m.confirmText == "Switching to Custom signs this kiosk out and clears its setup and saved move data.")
        m.backToList()
        #expect(m.step == .list)
    }

    @Test func aSwitchThatIsDoneSaysSo() async {
        var asked: [(SavedEnvironment, Bool)] = []
        let m = unlocked(model(answer: { asked.append(($0, $1)); return .done }))
        m.choose(rc1)
        #expect(await m.switchNow(discard: false))
        #expect(asked.count == 1 && asked[0].0 == rc1.asSaved && asked[0].1 == false)
        #expect(!m.busy && m.error == nil)
    }

    // MARK: unsent scans

    @Test func unsentScansAreCountedAndNeverAsZero() async {
        for (n, text) in [(3, "3 unsent scans haven't been sent yet."), (1, "1 unsent scan hasn't been sent yet."),
                          (0, "Unsent scans haven't been sent yet.")] {
            var asked: [Bool] = []
            let m = unlocked(model(answer: { _, discard in asked.append(discard); return discard ? .done : .pending(n) }))
            m.choose(rc1)
            #expect(await !m.switchNow(discard: false))
            #expect(m.pending == n)
            #expect(m.pendingText == text)
            #expect(m.step == .confirm)
            #expect(!m.pendingText!.contains("0 unsent"))
            // Discard and switch asks again, discarding.
            #expect(await m.switchNow(discard: true))
            #expect(asked == [false, true])
        }
    }

    @Test func goingBackToTheListForgetsTheCount() async {
        let m = unlocked(model(answer: { _, _ in .pending(2) }))
        m.choose(rc1)
        _ = await m.switchNow(discard: false)
        #expect(m.pending == 2)
        m.backToList()
        #expect(m.pending == nil)
    }

    // MARK: refusals and failures

    @Test func everyRefusalHasItsCopyAndLeavesTheChooserOnItsStep() async {
        let copy: [(String, String)] = [
            ("custom_needs_super_admin", "Sign in as a developer, founder or super admin to use a custom URL."),
            ("discard_needs_admin", "Sign in as an admin to discard unsent scans."),
            ("access_check_offline", "Can't reach the server to check your access."),
            ("something_new", "Couldn't switch environment (something_new)."),
        ]
        for (code, text) in copy {
            let m = unlocked(model(answer: { _, _ in .refused(code) }))
            m.choose(rc1)
            #expect(await !m.switchNow(discard: false))
            #expect(m.error == text)
            #expect(m.step == .confirm)
            #expect(!m.busy)
        }
    }

    @Test func aSwitchThatThrowsShowsAnErrorAndStaysOpen() async {
        let cases: [(Error, String)] = [
            (EnvironmentSwitchError.outboxUnreadable, "Couldn't read this kiosk's unsent scans, so nothing was switched. Try again."),
            (EnvironmentSwitchError.invalidEnvironment, "Couldn't switch environment. Try again."),
            (CocoaError(.fileWriteUnknown), "Couldn't switch environment. Try again."),
        ]
        for (thrown, text) in cases {
            let m = unlocked(model(answer: { _, _ in throw thrown }))
            m.choose(rc1)
            #expect(await !m.switchNow(discard: false))
            #expect(m.error == text)
            #expect(m.step == .confirm)
            #expect(!m.busy)
        }
    }

    // MARK: custom URL

    @Test func aCustomUrlThatIsntHttpIsRefusedBeforeAnySwitch() async {
        var asked = 0
        let m = unlocked(model(answer: { _, _ in asked += 1; return .done }))
        m.chooseCustom()
        #expect(m.customApi == "https://api.uat.serversherpa.com")      // prefilled with today's addresses
        #expect(m.customPortal == "https://portal.uat.serversherpa.com")
        m.typeApi("ftp://10.0.0.1")
        #expect(await !m.switchNow(discard: false))
        #expect(m.error == "Enter an http or https address for both URLs.")
        #expect(asked == 0)
        m.typeApi("http://10.0.0.1:8000")                                 // typing clears the line
        #expect(m.error == nil)
    }

    @Test func switchWaitsForBothUrls() {
        let m = unlocked(model())
        m.chooseCustom()
        m.typePortal("  ")
        #expect(!m.canSwitch)
        m.typePortal("http://10.0.0.1:5173")
        #expect(m.canSwitch)
    }

    @Test func aCustomSwitchSendsTheNormalizedUrls() async {
        var asked: [SavedEnvironment] = []
        let m = unlocked(model(answer: { target, _ in asked.append(target); return .done }))
        m.chooseCustom()
        m.typeApi(" http://10.0.0.1:8000/ ")
        m.typePortal("http://10.0.0.1:5173/")
        #expect(await m.switchNow(discard: false))
        #expect(asked == [.custom(apiUrl: "http://10.0.0.1:8000", portalUrl: "http://10.0.0.1:5173")])
    }

    // MARK: busy

    /// A switch away from a dead server can take a while: until it answers, nothing else can be
    /// pressed or typed, and it counts as activity every 15 s, so a signed-out Time Clock station
    /// doesn't go back to Welcome under it.
    @Test func whileASwitchRunsEverythingWaitsAndItCountsAsActivity() async throws {
        let held = HeldSwitch()
        let sleeper = ManualSleeper()
        var activity = 0
        let m = unlocked(model(answer: { try await held.run($0, $1) }, activity: { activity += 1 },
                               sleep: { try await sleeper.sleep($0) }))
        m.chooseCustom()
        let before = activity
        let running = Task { await m.switchNow(discard: false) }
        #expect(await waitUntil { held.isWaiting })
        #expect(m.busy)
        #expect(!m.canSwitch)
        #expect(m.fieldsLocked)
        #expect(await waitUntil { activity == before + 1 && sleeper.pending(EnvironmentChooserModel.activityEvery) == 1 })
        sleeper.fire(EnvironmentChooserModel.activityEvery)
        #expect(await waitUntil { activity == before + 2 })

        m.typeApi("http://elsewhere")                 // read-only while busy
        #expect(m.customApi == "https://api.uat.serversherpa.com")
        m.backToList()                                // Cancel waits too
        #expect(m.step == .custom)
        #expect(await !m.switchNow(discard: true), "a second press while busy does nothing")
        #expect(held.calls.count == 1)

        held.answer(.refused("access_check_offline"))
        #expect(await !running.value)
        #expect(!m.busy)
        #expect(!m.fieldsLocked)
        #expect(await waitUntil { sleeper.pending(EnvironmentChooserModel.activityEvery) == 0 }, "the ticks stop with the switch")
        #expect(m.error == "Can't reach the server to check your access.")
    }

    @Test func pendingLocksTheCustomFields() async {
        let m = unlocked(model(answer: { _, _ in .pending(2) }))
        m.chooseCustom()
        _ = await m.switchNow(discard: false)
        #expect(m.fieldsLocked)
        m.typeApi("http://elsewhere")
        #expect(m.customApi == "https://api.uat.serversherpa.com")
    }

    // MARK: row and badge

    @Test func theRowNamesTheEnvironmentAndItsServer() {
        #expect(environmentServerLabel(uat.asSaved) == "api.uat.serversherpa.com")
        #expect(environmentServerLabel(prod.asSaved) == "api.serversherpa.com")
        #expect(environmentServerLabel(customEnv) == "http://10.10.48.103:8000")
        #expect(uat.asSaved.label == "UAT")
        #expect(customEnv.label == "Custom")
    }

    @Test func theBadgeNamesEveryEnvironmentButProd() {
        #expect(environmentBadgeText(prod.asSaved) == nil)
        #expect(environmentBadgeText(uat.asSaved) == "UAT")
        #expect(environmentBadgeText(customEnv) == "Custom")
        // Prod is its domain, not its id or name.
        #expect(environmentBadgeText(.named(id: "prod", name: "Prod", domain: "prod.serversherpa.com")) == "Prod")
    }

    // MARK: Time Clock station

    /// The sign-in page's Settings sheet closes when a Time Clock station's sign-in request ends,
    /// but never while a switch runs inside it.
    @Test func theLoginSettingsSheetStaysUpWhileASwitchRuns() {
        let sel = timeclockSelection()
        #expect(!loginSettingsSheetShown(true, selection: sel, loginRequested: false, switching: false))
        #expect(loginSettingsSheetShown(true, selection: sel, loginRequested: false, switching: true))
        #expect(!loginSettingsSheetShown(false, selection: sel, loginRequested: false, switching: true))
    }
}

/// The chooser against a whole container: the real switcher, store and outbox, a fake server, and
/// a stubbed environment-list session (nothing reaches status.serversherpa.com or the Keychain).
@MainActor
struct EnvironmentChooserContainerTests {
    private let api = FakeKioskApi()
    private let c: AppContainer

    init() throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).useApi("http://127.0.0.1:9")
        c = AppContainer(defaults: defaults, secrets: MemorySecretStore(), modelContainer: try KioskSchema.inMemoryContainer(),
                         backgroundTask: NoBackgroundTasking(), labelEngine: FakeLabelEngine(), biometricKeys: FakeBiometricKeys(),
                         devicesApi: FakeDevicesApi(), api: api,
                         environmentListSession: .makeEnvironmentListSession(protocolClasses: [StubURLProtocol.self]))
    }

    @Test func aNamedSwitchSavesTheEnvironment() async {
        let m = EnvironmentChooserModel(container: c)
        #expect(m.current == .custom(apiUrl: "http://127.0.0.1:9", portalUrl: c.config.portalUrl))
        await m.loadList()
        #expect(m.list == Environments.builtIn, "the stubbed download fails: the built-in list")
        m.typePassword("cumulus")
        m.unlock()
        m.choose(Environments.byId("uat")!)
        #expect(await m.switchNow(discard: false))
        #expect(c.environments.saved == Environments.byId("uat")!.asSaved)
        #expect(c.config.apiUrl == "https://api.uat.serversherpa.com")
    }

    /// Review Focus 3: a registered kiosk, nobody signed in, asks for Custom: refused with its copy.
    @Test func customOnARegisteredKioskNeedsASuperAdmin() async {
        c.environments.markRegistered()
        let m = EnvironmentChooserModel(container: c)
        m.typePassword("cumulus")
        m.unlock()
        m.chooseCustom()
        m.typeApi("http://10.0.0.1:8000")
        m.typePortal("http://10.0.0.1:5173")
        #expect(await !m.switchNow(discard: false))
        #expect(m.error == "Sign in as a developer, founder or super admin to use a custom URL.")
        #expect(c.config.apiUrl == "http://127.0.0.1:9")
    }

    /// A switch started from the chooser signs out first: the outbox stops right there (at
    /// sign-out itself, not when a screen next reacts to it), before the old server's data is
    /// cleared and the new environment saved.
    @Test func signingOutStopsTheOutboxAtOnce() async throws {
        await c.auth.completePair(fakeSession())
        c.outbox.start()
        #expect(c.outbox.isRunning)
        await c.auth.logout()
        #expect(!c.outbox.isRunning)

        await c.auth.completePair(fakeSession())
        c.outbox.start()
        #expect(try await c.environmentSwitcher.switchTo(Environments.byId("uat")!.asSaved, discard: false) == .done)
        #expect(!c.outbox.isRunning)
    }

    /// The switcher says when a switch is running (the sign-in page's Settings sheet keeps it up).
    @Test func theSwitcherSaysWhileASwitchRuns() async throws {
        c.environments.markRegistered()
        await c.auth.completePair(fakeSession(maxRank: 100))
        let gate = AsyncStream<Void>.makeStream()
        api.meResult = {
            for await _ in gate.stream { break }
            return MeInfo(roles: ["developer"], maxRank: 100, isGlobal: true)
        }
        #expect(!c.environmentSwitcher.isSwitching)
        let running = Task { try await c.environmentSwitcher.switchTo(.custom(apiUrl: "http://10.0.0.1:8000", portalUrl: "http://10.0.0.1:5173"), discard: false) }
        #expect(await waitUntil { api.calls.contains("me") })
        #expect(c.environmentSwitcher.isSwitching)
        gate.continuation.yield()
        #expect(try await running.value == .done)
        #expect(!c.environmentSwitcher.isSwitching)
    }
}
