import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct BuildConfigTests {
    @Test func debugDefaultsPointAtDev() {
        #expect(KioskBuildConfig.defaultApiUrl == "https://api.dev.serversherpa.com")
        #expect(KioskBuildConfig.defaultPortalUrl == "https://portal.dev.serversherpa.com")
        #expect(!KioskBuildConfig.kioskVersion.isEmpty)
    }

    /// iOS ends an app that starts Bluetooth without saying why it uses it (D15).
    @Test func theAppSaysWhyItUsesBluetooth() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") as? String
            == "Finds and prints to Zebra label printers over Bluetooth.")
    }
}
