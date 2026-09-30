import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Android SettingsScreenTest (the non-RFID cases), as model tests: which tabs show, the name save, the URL save.
@MainActor
struct SettingsModelTests {
    private let prefs = KioskPrefs(defaults: freshDefaults())

    private func tabs(admin: Bool = false, developer: Bool = false, signedIn: Bool) -> [SettingsTab] {
        visibleTabs(isAdmin: admin, isDeveloper: developer, signedIn: signedIn)
    }

    // signedOutShowsOnlyThisKioskAndSavesName
    @Test func signedOutShowsOnlyThisKioskAndNoTabStrip() {
        let t = tabs(admin: true, developer: true, signedIn: false)
        #expect(t.map(\.id) == [.thisKiosk])
        #expect(!SettingsModel.showsTabStrip(t))
        #expect(SettingsModel.selectedTab(requested: .appearance, tabs: t) == .thisKiosk)
    }

    @Test func signedOutNameSaveStoresTheTrimmedName() {
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        #expect(SettingsModel.saveName("  Dock 4 ", identity: identity) == nil)
        #expect(identity.current.name == "Dock 4")
        #expect(prefs.kioskName == "Dock 4")
    }

    @Test func nameValidationMessageAndNothingStored() {
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let before = identity.current.name
        #expect(SettingsModel.saveName("   ", identity: identity) == "Enter a name between 1 and 80 characters.")
        #expect(SettingsModel.saveName(String(repeating: "x", count: 81), identity: identity) == "Enter a name between 1 and 80 characters.")
        #expect(identity.current.name == before)
        #expect(SettingsModel.saveName(String(repeating: "x", count: 80), identity: identity) == nil)
    }

    // adminSeesAdminTabDeveloperSeesDeveloper
    @Test func adminSeesAdminTabDeveloperSeesDeveloper() {
        let dev = tabs(admin: true, developer: true, signedIn: true)
        #expect(dev.map(\.id).contains(.admin))
        #expect(dev.map(\.id).contains(.developer))
        #expect(dev.first { $0.id == .developer }?.label == "Developer")
        #expect(SettingsModel.showsTabStrip(dev))
        #expect(SettingsModel.selectedTab(requested: .developer, tabs: dev) == .developer)
    }

    @Test func staffSeesNeitherAdminNorDeveloper() {
        let ids = tabs(signedIn: true).map(\.id)
        #expect(!ids.contains(.admin) && !ids.contains(.developer))
    }

    @Test func requestedTabThatIsHiddenFallsBack() {
        let staff = tabs(signedIn: true)
        #expect(SettingsModel.selectedTab(requested: .admin, tabs: staff) == .appearance)
        #expect(SettingsModel.selectedTab(requested: nil, tabs: staff) == .appearance)
        #expect(SettingsModel.selectedTab(requested: .thisKiosk, tabs: staff) == .thisKiosk)
    }

    private func signedOut() -> (FakeRefresher, KioskAuth) {
        let refresher = FakeRefresher()
        let auth = KioskAuth(api: FakeKioskApi(), refresher: refresher, identity: Identity(prefs: prefs, secrets: MemorySecretStore()), prefs: prefs)
        auth.endSession()
        return (refresher, auth)
    }

    @Test func urlSaveStoresBothNormalized() async {
        let config = KioskConfig(prefs: prefs)
        let (refresher, auth) = signedOut()
        #expect(await SettingsModel.saveUrls(api: " https://api.example.com/ ", portal: "http://portal.example.com", config: config, session: refresher, auth: auth) == nil)
        #expect(config.apiUrl == "https://api.example.com")
        #expect(config.portalUrl == "http://portal.example.com")
        #expect(refresher.cleared == 0)                  // signed out: nothing to sign out of
    }

    @Test func urlValidationMessageAndNothingStoredWhenEitherIsBad() async {
        let config = KioskConfig(prefs: prefs)
        let (refresher, auth) = signedOut()
        let api = config.apiUrl, portal = config.portalUrl
        #expect(await SettingsModel.saveUrls(api: "ftp://x", portal: "https://p.example.com", config: config, session: refresher, auth: auth) == "Enter an http:// or https:// address.")
        #expect(await SettingsModel.saveUrls(api: "https://a.example.com", portal: "nope", config: config, session: refresher, auth: auth) == "Enter an http:// or https:// address.")
        #expect(config.apiUrl == api && config.portalUrl == portal)
    }

    /// The live token must never go to a new API host: saving a new API origin
    /// while signed in clears the session and returns to the login screen.
    @Test func aNewApiOriginWhileSignedInSignsOut() async {
        let config = KioskConfig(prefs: prefs)
        _ = config.setApiUrl("https://api.old.example.com")
        let refresher = FakeRefresher()
        let auth = KioskAuth(api: FakeKioskApi(), refresher: refresher, identity: Identity(prefs: prefs, secrets: MemorySecretStore()), prefs: prefs)
        await auth.completePair(fakeSession())
        #expect(await SettingsModel.saveUrls(api: "https://api.new.example.com", portal: config.portalUrl, config: config, session: refresher, auth: auth) == nil)
        #expect(refresher.cleared == 1)
        #expect(refresher.stored == nil)
        #expect(auth.state == .anon)
        #expect(config.apiUrl == "https://api.new.example.com")
    }

    /// The same origin (default port spelled out, a trailing slash) keeps the session.
    @Test func theSameApiOriginWhileSignedInKeepsTheSession() async {
        let config = KioskConfig(prefs: prefs)
        _ = config.setApiUrl("https://api.example.com")
        let refresher = FakeRefresher()
        let auth = KioskAuth(api: FakeKioskApi(), refresher: refresher, identity: Identity(prefs: prefs, secrets: MemorySecretStore()), prefs: prefs)
        await auth.completePair(fakeSession())
        #expect(await SettingsModel.saveUrls(api: "https://API.example.com:443/", portal: "https://portal.example.com", config: config, session: refresher, auth: auth) == nil)
        #expect(refresher.cleared == 0)
        if case .authed = auth.state {} else { Issue.record("expected still signed in") }
        #expect(config.portalUrl == "https://portal.example.com")
    }

    @Test func localDataLineSaysNothingDownloadedUntilDone() {
        #expect(SettingsModel.localDataLine(SyncStatus()) == "Nothing downloaded yet.")
        var done = SyncStatus()
        done.phase = .done; done.assets = 12; done.people = 3; done.containers = 2; done.trucks = 1
        #expect(SettingsModel.localDataLine(done) == "12 assets · 3 people · 2 containers · 1 trucks")
    }

    @Test func inspectorFilterMatchesCaseInsensitivelyAndCaps() {
        let rows = (0..<250).map { KioskAssetRow(id: "\($0)", assetId: "A-\($0)", name: "Rack \($0)", serialNumber: "SN\($0)") }
        #expect(SettingsModel.shownAssets(rows, filter: "").count == 200)
        #expect(SettingsModel.shownAssets(rows, filter: " sn7 ").map(\.assetId).prefix(2) == ["A-7", "A-70"])
        let people = [KioskPersonRow(id: "p", displayName: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", rfidTag: nil, isWorker: true, hasAccount: false)]
        #expect(SettingsModel.shownPeople(people, filter: "LOVE").count == 1)
        #expect(SettingsModel.shownPeople(people, filter: "zzz").isEmpty)
    }
}
