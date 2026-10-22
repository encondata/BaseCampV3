import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The station key lives only in the secret store, under its own account,
/// beside (never instead of) the session's secrets. A fake store: never the
/// real Keychain.
struct StationKeyStoreTests {
    @Test func putGetClear() {
        let secrets = MemorySecretStore()
        let keys = StationKeyStore(secrets: secrets)
        #expect(keys.get() == nil)
        keys.put("k3y")
        #expect(keys.get() == "k3y")
        #expect(secrets.get("station_key") == "k3y")
        keys.put("n3w")
        #expect(keys.get() == "n3w")
        keys.clear()
        #expect(keys.get() == nil)
        #expect(secrets.get("station_key") == nil)
    }

    @Test func survivesANewInstanceOverTheSameStore() {
        let secrets = MemorySecretStore()
        StationKeyStore(secrets: secrets).put("k3y")
        #expect(StationKeyStore(secrets: secrets).get() == "k3y")
    }

    @Test func clearingLeavesOtherSecretsAlone() {
        let secrets = MemorySecretStore()
        secrets.set("ss_refresh", "cookie")
        let keys = StationKeyStore(secrets: secrets)
        keys.put("k3y")
        keys.clear()
        #expect(secrets.get("ss_refresh") == "cookie")
    }

    @Test func aBlankKeyReadsAsNone() {
        let secrets = MemorySecretStore()
        secrets.set("station_key", "")
        #expect(StationKeyStore(secrets: secrets).get() == nil)
    }

    @Test func theKeysOriginIsStoredBesideItAndClearedWithIt() {
        let secrets = MemorySecretStore()
        let keys = StationKeyStore(secrets: secrets)
        keys.put("k3y", origin: "https://api.test:443")
        #expect(keys.origin() == "https://api.test:443")
        keys.clear()
        #expect(keys.origin() == nil)
        #expect(secrets.get("station_key_origin") == nil)
    }

    @Test func apiOriginsSpellOutTheDefaultPort() {
        #expect(apiOrigin("https://API.example.com/") == "https://api.example.com:443")
        #expect(apiOrigin("http://localhost:8000") == "http://localhost:8000")
        #expect(apiOrigin("http://x.example") == "http://x.example:80")
        #expect(apiOrigin("ftp://x") == nil)
    }

    @MainActor @Test func theAppContainerKeepsTheKeyInItsSecretStore() throws {
        let secrets = MemorySecretStore()
        let container = AppContainer(defaults: freshDefaults(), secrets: secrets, modelContainer: try KioskSchema.inMemoryContainer(),
                                     backgroundTask: NoBackgroundTasking())
        container.stationKeys.put("k3y")
        #expect(secrets.get("station_key") == "k3y")
    }
}
