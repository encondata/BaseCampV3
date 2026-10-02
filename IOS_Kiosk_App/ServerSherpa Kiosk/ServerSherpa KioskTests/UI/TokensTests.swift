import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// Android TokensTest.kt.
struct TokensTests {
    @Test func namedAccents() {
        #expect(accentFor("aqua").accent == Color(hex: 0x35E0C8))
        #expect(accentFor("aqua").soft == Color(hex: 0x6AF0DD))
        #expect(accentFor("GREEN").accent == Color(hex: 0x3DDC84))
    }

    @Test func customHexAccent() {
        #expect(accentFor("#123456").accent == Color(hex: 0x123456))
    }

    @Test func unknownFallsBackToAmber() {
        #expect(accentFor("mauve").accent == Color(hex: 0xFFA12E))
        #expect(accentFor("#12").accent == Color(hex: 0xFFA12E))
    }

    @Test func accentEnumParsesNamesAndFallsBackToAmber() {
        #expect(Accent.from(" Violet ") == .violet)
        #expect(Accent.from("pink").color == Color(hex: 0xFF6FAE))
        #expect(Accent.from("#123456") == .amber)
    }

    @Test func themeFollowsThePreference() {
        #expect(KioskTheme.scheme(forTheme: "dark") == .dark)
        #expect(KioskTheme.scheme(forTheme: "light") == .light)
        #expect(KioskTheme.scheme(forTheme: "system") == nil)
    }
}
