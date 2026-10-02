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

    @Test func statesHideOnShortScreens() {
        #expect(LoginLayout.showsStates(height: 1024))
        #expect(LoginLayout.showsStates(height: 780))
        #expect(!LoginLayout.showsStates(height: 779))
    }
}
