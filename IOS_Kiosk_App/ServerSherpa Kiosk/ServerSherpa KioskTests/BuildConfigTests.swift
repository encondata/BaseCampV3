import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct BuildConfigTests {
    /// Debug builds default to Dev (release builds to Prod), both addresses from the one environment.
    @Test func debugDefaultsPointAtDev() {
        #expect(KioskBuildConfig.defaultEnvironmentId == "dev")
        #expect(KioskBuildConfig.defaultEnvironment == .named(id: "dev", name: "Dev", domain: "dev.serversherpa.com"))
        #expect(KioskBuildConfig.defaultEnvironment.apiUrl == "https://api.dev.serversherpa.com")
        #expect(KioskBuildConfig.defaultEnvironment.portalUrl == "https://portal.dev.serversherpa.com")
        #expect(!KioskBuildConfig.kioskVersion.isEmpty)
    }

    /// iOS ends an app that starts Bluetooth without saying why it uses it (D15).
    @Test func theAppSaysWhyItUsesBluetooth() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") as? String
            == "Finds and prints to Zebra label printers over Bluetooth.")
    }
}
