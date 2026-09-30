import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct KioskConfigTests {
    private func make() -> (KioskPrefs, KioskConfig) {
        let prefs = KioskPrefs(defaults: freshDefaults())
        return (prefs, KioskConfig(prefs: prefs, defaultApiUrl: "https://api.dev.serversherpa.com", defaultPortalUrl: "https://portal.dev.serversherpa.com", kioskVersion: "0.1.0"))
    }

    @Test func defaultsThenOverride() {
        let (prefs, config) = make()
        #expect(config.apiUrl == "https://api.dev.serversherpa.com")
        #expect(config.portalUrl == "https://portal.dev.serversherpa.com")
        prefs.apiUrl = "http://10.10.48.103:8000"
        #expect(config.apiUrl == "http://10.10.48.103:8000")
        #expect(config.kioskVersion == "0.1.0")
    }

    @Test func normalize() {
        #expect(KioskConfig.normalizeUrl("  https://x.example/// ") == "https://x.example")
        #expect(KioskConfig.normalizeUrl("x.example") == nil)
        #expect(KioskConfig.normalizeUrl("ftp://x") == nil)
        #expect(KioskConfig.normalizeUrl("") == nil)
        #expect(KioskConfig.normalizeUrl("https://") == nil)
    }

    @Test func normalizeRejectsEmptyHost() {
        // URLs with empty host must be rejected
        #expect(KioskConfig.normalizeUrl("https://?x") == nil)
        #expect(KioskConfig.normalizeUrl("https://:80") == nil)
        #expect(KioskConfig.normalizeUrl("http://") == nil)
        // Valid URLs with non-empty hosts are accepted
        #expect(KioskConfig.normalizeUrl("https://api.example.com/") == "https://api.example.com")
        #expect(KioskConfig.normalizeUrl("http://10.0.0.5:8000") == "http://10.0.0.5:8000")
    }

    @Test func setUrlStoresNormalizedOrRejects() {
        let (prefs, config) = make()
        #expect(config.setApiUrl(" http://h:8000/ "))
        #expect(prefs.apiUrl == "http://h:8000")
        #expect(config.apiUrl == "http://h:8000")
        #expect(!config.setApiUrl("nope"))
        #expect(prefs.apiUrl == "http://h:8000")
        #expect(config.setPortalUrl("https://p.example/"))
        #expect(config.portalUrl == "https://p.example")
        #expect(!config.setPortalUrl(""))
    }

    @Test func invalidStoredUrlFallsBackToDefault() {
        let (prefs, config) = make()
        prefs.apiUrl = "garbage"
        #expect(config.apiUrl == "https://api.dev.serversherpa.com")
    }
}
