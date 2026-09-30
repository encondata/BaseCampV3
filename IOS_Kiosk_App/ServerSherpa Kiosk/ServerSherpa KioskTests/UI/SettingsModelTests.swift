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

    @Test func urlSaveStoresBothNormalized() {
        let config = KioskConfig(prefs: prefs)
        #expect(SettingsModel.saveUrls(api: " https://api.example.com/ ", portal: "http://portal.example.com", config: config) == nil)
        #expect(config.apiUrl == "https://api.example.com")
        #expect(config.portalUrl == "http://portal.example.com")
    }

    @Test func urlValidationMessageAndNothingStoredWhenEitherIsBad() {
        let config = KioskConfig(prefs: prefs)
        let api = config.apiUrl, portal = config.portalUrl
        #expect(SettingsModel.saveUrls(api: "ftp://x", portal: "https://p.example.com", config: config) == "Enter an http:// or https:// address.")
        #expect(SettingsModel.saveUrls(api: "https://a.example.com", portal: "nope", config: config) == "Enter an http:// or https:// address.")
        #expect(config.apiUrl == api && config.portalUrl == portal)
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
