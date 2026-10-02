import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct SettingsTabsTests {
    private func ids(isAdmin: Bool, isDeveloper: Bool, signedIn: Bool) -> [SettingsTabId] {
        visibleTabs(isAdmin: isAdmin, isDeveloper: isDeveloper, signedIn: signedIn).map(\.id)
    }

    @Test func signedOutSeesOnlyThisKiosk() {
        #expect(ids(isAdmin: true, isDeveloper: true, signedIn: false) == [.thisKiosk])
    }

    @Test func workerSeesTheFourOpenTabs() {
        #expect(ids(isAdmin: false, isDeveloper: false, signedIn: true) == [.appearance, .sound, .devices, .thisKiosk])
    }

    @Test func adminGetsAdminDeveloperGetsDeveloper() {
        #expect(ids(isAdmin: true, isDeveloper: false, signedIn: true).contains(.admin))
        #expect(!ids(isAdmin: true, isDeveloper: false, signedIn: true).contains(.developer))
        #expect(ids(isAdmin: false, isDeveloper: true, signedIn: true).contains(.developer))
    }

    @Test func wireRoundTrip() {
        #expect(SettingsTabId(rawValue: "this-kiosk") == .thisKiosk)
        #expect(SettingsTabId(rawValue: "nope") == nil)
        #expect(SettingsTabId(rawValue: "rfid") == nil)
    }

    @Test func devicesBlurbIsIosCopy() {
        #expect(SETTINGS_TABS.first { $0.id == .devices }?.blurb == "Cameras and keyboards this kiosk can scan with.")
        #expect(DEFAULT_TAB == .appearance)
    }
}
