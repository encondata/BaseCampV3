import Testing
import Foundation
@testable import ServerSherpa_Kiosk

struct SecretStoreTests {
    @Test func memoryStoreRoundTrip() {
        let s = MemorySecretStore()
        #expect(s.get("k") == nil)
        s.set("k", "v")
        #expect(s.get("k") == "v")
        s.set("k", nil)
        #expect(s.get("k") == nil)
    }

    @Test func keychainStoreRoundTrip() {
        let s = KeychainSecretStore()
        let key = "test-\(UUID().uuidString)"
        defer { s.set(key, nil) }
        #expect(s.get(key) == nil)
        s.set(key, "one")
        #expect(s.get(key) == "one")
        s.set(key, "two")
        #expect(s.get(key) == "two")
        s.set(key, nil)
        #expect(s.get(key) == nil)
    }
}
