import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct IdentityTests {
    private func make(secrets: SecretStore = MemorySecretStore(), defaults: UserDefaults = freshDefaults()) -> Identity {
        Identity(prefs: KioskPrefs(defaults: defaults), secrets: secrets)
    }

    @Test func serialIsGeneratedOnceAndStable() {
        let secrets = MemorySecretStore()
        let defaults = freshDefaults()
        let a = make(secrets: secrets, defaults: defaults)
        let b = make(secrets: secrets, defaults: defaults)
        let first = a.current
        #expect(first.serial.hasPrefix("kiosk-ios-"))
        #expect(a.current.serial == first.serial)
        #expect(b.current.serial == first.serial)
        #expect(first.name == "Kiosk " + first.serial.suffix(4).uppercased())
        #expect(secrets.get("kiosk.serial") == first.serial)
    }

    @Test func nameValidation() {
        let identity = make()
        _ = identity.current
        #expect(!identity.setName("   "))
        #expect(!identity.setName(""))
        #expect(!identity.setName(String(repeating: "x", count: 81)))
        #expect(identity.setName(String(repeating: "x", count: 80)))
        #expect(identity.setName("  Dock 4 "))
        #expect(identity.current.name == "Dock 4")
    }

    @Test func helpers() {
        #expect(defaultName("kiosk-ios-0000-ab12") == "Kiosk AB12")
        #expect(newSerial().wholeMatch(of: /kiosk-ios-[0-9a-f-]{36}/) != nil)
    }
}
