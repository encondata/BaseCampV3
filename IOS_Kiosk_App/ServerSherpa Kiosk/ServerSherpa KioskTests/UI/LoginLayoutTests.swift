import Testing
import CoreGraphics
@testable import ServerSherpa_Kiosk

/// The web's login breakpoints (login-light.css), on the screen's width in points.
struct LoginLayoutTests {
    @Test(arguments: [
        (1366.0, LoginLayout.wide), (1194.0, .wide), (1180.0, .wide),
        (1024.0, .medium), (900.0, .medium),
        (899.0, .compact), (820.0, .compact), (430.0, .compact), (390.0, .compact),
    ])
    func forWidth(width: Double, expected: LoginLayout) {
        #expect(LoginLayout.forWidth(CGFloat(width)) == expected)
    }

    /// Android `LoginBrand(kioskName)`: the kiosk's own name under the wordmark, in every layout;
    /// nothing when the name is blank.
    @Test func theSignInPageShowsTheKioskName() {
        #expect(LoginLayout.kioskNameLine("Dock door 3") == "Dock door 3")
        #expect(LoginLayout.kioskNameLine("  Kiosk 7F2A \n") == "Kiosk 7F2A")
        #expect(LoginLayout.kioskNameLine("") == nil)
        #expect(LoginLayout.kioskNameLine(" \t\n") == nil)
    }

    /// What the screen passes: this kiosk's identity, with its default name before one is set.
    @MainActor @Test func theLineIsTheIdentitysName() {
        let prefs = KioskPrefs(defaults: freshDefaults())
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let line = LoginLayout.kioskNameLine(identity.current.name)
        #expect(line == defaultName(identity.current.serial))
        #expect(identity.setName("Receiving iPad"))
        #expect(LoginLayout.kioskNameLine(identity.current.name) == "Receiving iPad")
    }

    @Test func statesHideOnShortScreens() {
        #expect(LoginLayout.showsStates(height: 1024))
        #expect(LoginLayout.showsStates(height: 780))
        #expect(!LoginLayout.showsStates(height: 779))
    }
}
