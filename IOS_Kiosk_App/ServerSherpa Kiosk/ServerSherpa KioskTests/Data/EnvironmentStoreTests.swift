import Foundation
import Testing
@testable import ServerSherpa_Kiosk

@MainActor
struct EnvironmentStoreTests {
    private let defaults = freshDefaults()
    private let defaultPortal = "https://portal.dev.serversherpa.com"
    private let uat = SavedEnvironment.named(id: "uat", name: "UAT", domain: "uat.serversherpa.com")

    private func make() -> EnvironmentStore { EnvironmentStore(prefs: KioskPrefs(defaults: defaults)) }

    /// The stored JSON as an object, so key order doesn't matter.
    private func stored(_ key: String) -> [String: String]? {
        guard let s = defaults.string(forKey: key), let data = s.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: String]
    }

    @Test func nothingSavedAtFirst() {
        let store = make()
        #expect(store.saved == nil)
        #expect(!store.everRegistered)
        #expect(store.cachedList == nil)
    }

    @Test func savesNamedAndCustomInTheSharedShape() {
        let store = make()
        #expect(store.save(uat))
        #expect(store.saved == uat)
        #expect(make().saved == uat)                                   // kept across launches
        #expect(stored("ss.kiosk.environment") == ["kind": "named", "id": "uat", "name": "UAT", "domain": "uat.serversherpa.com"])
        let custom = SavedEnvironment.custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "http://10.10.48.103:5173")
        #expect(store.save(custom))
        #expect(store.saved == custom)
        #expect(stored("ss.kiosk.environment") == ["kind": "custom", "api_url": "http://10.10.48.103:8000", "portal_url": "http://10.10.48.103:5173"])
    }

    /// A Custom pair is saved normalized; an invalid environment is refused and nothing changes.
    @Test func saveNormalizesCustomAndRefusesAnInvalidEnvironment() {
        let store = make()
        #expect(store.save(.custom(apiUrl: " http://h:8000/ ", portalUrl: "https://p.example/")))
        #expect(store.saved == .custom(apiUrl: "http://h:8000", portalUrl: "https://p.example"))
        #expect(!store.save(.custom(apiUrl: "ftp://x", portalUrl: "https://p.example")))
        #expect(!store.save(.named(id: "uat", name: "UAT", domain: "evil.example.com")))
        #expect(store.saved == .custom(apiUrl: "http://h:8000", portalUrl: "https://p.example"))
    }

    /// A saved Named entry is checked with the list's rules when read back: a tampered one (a
    /// foreign domain, a bad id, a blank name) counts as nothing saved, as on the edge.
    @Test func aTamperedSavedEnvironmentCountsAsNothingSaved() {
        for bad in [
            #"{"kind":"named","id":"uat","name":"UAT","domain":"evil.example.com"}"#,
            #"{"kind":"named","id":"uat","name":"UAT","domain":"uat.serversherpa.com:8443"}"#,
            #"{"kind":"named","id":"UAT!","name":"UAT","domain":"uat.serversherpa.com"}"#,
            #"{"kind":"named","id":"uat","name":"  ","domain":"uat.serversherpa.com"}"#,
            #"{"kind":"custom","api_url":"ftp://x","portal_url":"http://p"}"#,
            #"{"kind":"custom","api_url":"http://a:1","portal_url":""}"#,
            #"{"kind":"other"}"#,
            "not json",
        ] {
            defaults.set(bad, forKey: "ss.kiosk.environment")
            #expect(make().saved == nil, "\(bad)")
        }
    }

    @Test func theRegisteredFlagIsSetOnceAndStays() {
        let store = make()
        store.markRegistered()
        #expect(store.everRegistered)
        store.markRegistered()
        store.save(uat)
        #expect(store.everRegistered)
        #expect(make().everRegistered)                                 // kept across launches
        #expect(defaults.bool(forKey: "ss.kiosk.everRegistered"))
    }

    @Test func theLastGoodListRoundTripsInTheFilesShapeAndIsCheckedWhenRead() throws {
        let store = make()
        let list = [Env(id: "rc2", name: "RC2", domain: "rc2.serversherpa.com"), Env(id: "dev", name: "Dev", domain: "dev.serversherpa.com")]
        store.cacheList(list)
        #expect(store.cachedList == list)
        #expect(make().cachedList == list)
        let raw = try #require(defaults.string(forKey: "ss.kiosk.environmentList"))
        #expect(Environments.parseList(Data(raw.utf8)) == list)           // the published file's shape
        defaults.set(#"{"version":1,"environments":[{"id":"x1","name":"X","domain":"evil.example.com"}]}"#, forKey: "ss.kiosk.environmentList")
        #expect(make().cachedList == nil)
        defaults.set("garbage", forKey: "ss.kiosk.environmentList")
        #expect(make().cachedList == nil)
    }

    // MARK: Migration of the URLs typed before the picker (Review Focus 4)

    @Test func aBuiltInApiUrlBecomesThatEnvironmentAndTheOldKeysGo() {
        defaults.set("https://api.uat.serversherpa.com", forKey: "ss.kiosk.apiUrl")
        defaults.set("https://portal.uat.serversherpa.com", forKey: "ss.kiosk.portalUrl")
        let store = make()
        store.migrateIfNeeded(defaultPortal: defaultPortal)
        #expect(store.saved == uat)
        #expect(defaults.object(forKey: "ss.kiosk.apiUrl") == nil)
        #expect(defaults.object(forKey: "ss.kiosk.portalUrl") == nil)
    }

    @Test func anyOtherApiUrlBecomesCustomWithItsPortalOrTheDefault() {
        defaults.set("http://10.10.48.103:8000", forKey: "ss.kiosk.apiUrl")
        defaults.set("http://10.10.48.103:5173", forKey: "ss.kiosk.portalUrl")
        make().migrateIfNeeded(defaultPortal: defaultPortal)
        #expect(make().saved == .custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "http://10.10.48.103:5173"))

        defaults.removeObject(forKey: "ss.kiosk.environment")
        defaults.set("http://10.10.48.103:8000", forKey: "ss.kiosk.apiUrl")
        make().migrateIfNeeded(defaultPortal: defaultPortal)
        #expect(make().saved == .custom(apiUrl: "http://10.10.48.103:8000", portalUrl: defaultPortal))
    }

    @Test func nothingIsMigratedWhenNothingWasSaved() {
        let store = make()
        store.migrateIfNeeded(defaultPortal: defaultPortal)
        #expect(store.saved == nil)
        #expect(defaults.object(forKey: "ss.kiosk.environment") == nil)
    }

    /// Once: the old keys are gone after the first run, so a later run changes nothing, and a saved
    /// environment is never replaced by old URLs.
    @Test func migrationRunsOnceAndNeverReplacesASavedEnvironment() throws {
        defaults.set("https://api.uat.serversherpa.com", forKey: "ss.kiosk.apiUrl")
        let store = make()
        store.migrateIfNeeded(defaultPortal: defaultPortal)
        let dev = try #require(Environments.byId("dev")).asSaved
        store.save(dev)
        store.migrateIfNeeded(defaultPortal: defaultPortal)
        #expect(store.saved == dev)

        defaults.set("http://10.0.2.2:8000", forKey: "ss.kiosk.apiUrl")   // old keys beside a saved environment
        let relaunched = make()
        relaunched.migrateIfNeeded(defaultPortal: defaultPortal)
        #expect(relaunched.saved == dev)
        #expect(defaults.object(forKey: "ss.kiosk.apiUrl") == nil)
    }

    /// Before the migration has run, what the kiosk connects to is already what the migration
    /// will save, so nothing ever goes to the build default meanwhile.
    @Test func theOldUrlsAreUsedUntilTheMigrationLands() {
        let fallback = SavedEnvironment.named(id: "dev", name: "Dev", domain: "dev.serversherpa.com")
        #expect(make().current(fallback) == fallback)
        defaults.set("http://10.10.48.103:8000", forKey: "ss.kiosk.apiUrl")
        let store = make()
        #expect(store.current(fallback) == .custom(apiUrl: "http://10.10.48.103:8000", portalUrl: fallback.portalUrl))
        store.migrateIfNeeded(defaultPortal: fallback.portalUrl)
        #expect(store.current(fallback) == .custom(apiUrl: "http://10.10.48.103:8000", portalUrl: fallback.portalUrl))
        defaults.set(#"{"kind":"named","id":"uat","name":"UAT","domain":"evil.example.com"}"#, forKey: "ss.kiosk.environment")
        #expect(make().current(fallback) == fallback)                  // tampered: the build default, as on the edge
    }
}
