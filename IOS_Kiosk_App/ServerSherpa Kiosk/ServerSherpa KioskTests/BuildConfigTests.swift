import Testing
@testable import ServerSherpa_Kiosk

struct BuildConfigTests {
    @Test func debugDefaultsPointAtDev() {
        #expect(KioskBuildConfig.defaultApiUrl == "https://api.dev.serversherpa.com")
        #expect(KioskBuildConfig.defaultPortalUrl == "https://portal.dev.serversherpa.com")
        #expect(!KioskBuildConfig.kioskVersion.isEmpty)
    }
}
