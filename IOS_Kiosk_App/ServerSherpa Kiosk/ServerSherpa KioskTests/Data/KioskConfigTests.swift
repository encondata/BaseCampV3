import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct KioskConfigTests {
    private let dev = SavedEnvironment.named(id: "dev", name: "Dev", domain: "dev.serversherpa.com")

    private func make(_ defaults: UserDefaults = freshDefaults()) -> (EnvironmentStore, KioskConfig) {
        let store = EnvironmentStore(prefs: KioskPrefs(defaults: defaults))
        return (store, KioskConfig(store: store, defaultEnvironment: dev, kioskVersion: "0.1.0"))
    }

    @Test func theDefaultEnvironmentThenTheSavedOne() {
        let (store, config) = make()
        #expect(config.environment == dev)
        #expect(config.apiUrl == "https://api.dev.serversherpa.com")
        #expect(config.portalUrl == "https://portal.dev.serversherpa.com")
        #expect(config.kioskVersion == "0.1.0")
        store.save(.named(id: "uat", name: "UAT", domain: "uat.serversherpa.com"))
        #expect(config.apiUrl == "https://api.uat.serversherpa.com")
        #expect(config.portalUrl == "https://portal.uat.serversherpa.com")
        store.save(.custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "http://10.10.48.103:5173"))
        #expect(config.apiUrl == "http://10.10.48.103:8000")
        #expect(config.portalUrl == "http://10.10.48.103:5173")
    }

    /// The saved domain wins over a later list's entry for the same id (Review Focus 1).
    @Test func theSavedDomainWinsOverTheCachedList() {
        let (store, config) = make()
        store.save(.named(id: "rc1", name: "RC1", domain: "rc1.serversherpa.com"))
        store.cacheList([Env(id: "rc1", name: "RC1", domain: "rc1-new.serversherpa.com")])
        #expect(config.apiUrl == "https://api.rc1.serversherpa.com")
    }

    /// An upgraded kiosk reads its typed URLs until the migration has run (never the default).
    @Test func typedUrlsFromBeforeThePickerAreUsedUntilMigrated() {
        let defaults = freshDefaults()
        defaults.set("http://10.10.48.103:8000", forKey: "ss.kiosk.apiUrl")
        let (_, config) = make(defaults)
        #expect(config.apiUrl == "http://10.10.48.103:8000")
        #expect(config.portalUrl == "https://portal.dev.serversherpa.com")
    }

    @Test func aTamperedSavedEnvironmentFallsBackToTheDefault() {
        let defaults = freshDefaults()
        defaults.set(#"{"kind":"custom","api_url":"garbage","portal_url":"http://p"}"#, forKey: "ss.kiosk.environment")
        let (_, config) = make(defaults)
        #expect(config.apiUrl == "https://api.dev.serversherpa.com")
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

    /// Settings' typed URLs save a Custom pair, normalized; either one bad stores nothing.
    @Test func saveCustomStoresNormalizedOrRejects() {
        let (store, config) = make()
        #expect(config.saveCustom(apiUrl: " http://h:8000/ ", portalUrl: "https://p.example/"))
        #expect(store.saved == .custom(apiUrl: "http://h:8000", portalUrl: "https://p.example"))
        #expect(config.apiUrl == "http://h:8000")
        #expect(config.portalUrl == "https://p.example")
        #expect(!config.saveCustom(apiUrl: "nope", portalUrl: "https://p.example"))
        #expect(!config.saveCustom(apiUrl: "http://other:1", portalUrl: ""))
        #expect(config.apiUrl == "http://h:8000")
    }
}
