import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Android SettingsScreenTest (the non-RFID cases), as model tests: which tabs show, the name save, the typed-URL switch.
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

    /// Typed URLs become the Custom environment to switch to, both normalized; either one that
    /// isn't an http(s) address gives nothing to switch to.
    @Test func typedUrlsBecomeANormalizedCustomTarget() {
        #expect(SettingsModel.customTarget(api: " https://api.example.com/ ", portal: "http://portal.example.com")
                == .custom(apiUrl: "https://api.example.com", portalUrl: "http://portal.example.com"))
        #expect(SettingsModel.customTarget(api: "ftp://x", portal: "https://p.example.com") == nil)
        #expect(SettingsModel.customTarget(api: "https://a.example.com", portal: "nope") == nil)
    }

    /// A switch that didn't happen says why, in the gates' copy; a done one says nothing here.
    @Test func switchResultsSayWhyNothingChanged() {
        #expect(SettingsModel.switchMessage(.done) == nil)
        #expect(SettingsModel.switchMessage(.pending(1)) == "1 unsent scan hasn't been sent yet.")
        #expect(SettingsModel.switchMessage(.pending(3)) == "3 unsent scans haven't been sent yet.")
        #expect(SettingsModel.switchMessage(.refused("custom_needs_super_admin"))
                == "Sign in as a developer, founder or super admin to use a custom URL.")
        #expect(SettingsModel.switchMessage(.refused("discard_needs_admin")) == "Sign in as an admin to discard unsent scans.")
        #expect(SettingsModel.switchMessage(.refused("access_check_offline")) == "Can't reach the server to check your access.")
        #expect(SettingsModel.switchFailedMessage(EnvironmentSwitchError.outboxUnreadable)
                == "Couldn't read this kiosk's unsent scans, so nothing was switched. Try again.")
        #expect(SettingsModel.switchFailedMessage(CocoaError(.fileWriteUnknown)) == "Couldn't switch environment. Try again.")
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
