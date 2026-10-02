import Testing
@testable import ServerSherpa_Kiosk

/// Android GuardsTest.kt, as model cases: the notice's copy and SetupGate's routing rule.
struct GuardsTests {
    @Test func mustChangePasswordShowsTheNotice() {
        let text = mustChangePasswordText(portalUrl: "https://portal.dev.serversherpa.com")
        #expect(text.hasPrefix("Your password needs to be changed before you can use a kiosk."))
        #expect(text == "Your password needs to be changed before you can use a kiosk. Sign in to the portal at https://portal.dev.serversherpa.com to change it.")
    }

    @Test func guardPicksTheScreenForEachAuthState() {
        #expect(guardScreen(for: .loading) == .spinner)
        #expect(guardScreen(for: .anon) == .login)
        #expect(guardScreen(for: .authed(fakeSession(mustChange: true))) == .mustChangePassword)
        #expect(guardScreen(for: .authed(fakeSession())) == .content)
    }

    @Test func setupGateShowsContentWhenCompleteOrDevMode() {
        #expect(routeAllowed(.scan, setupState: .complete, devMode: false))
        #expect(routeAllowed(.scan, setupState: .incomplete, devMode: true))
        #expect(!routeAllowed(.scan, setupState: .incomplete, devMode: false))
        #expect(!routeAllowed(.timeclock, setupState: .failed, devMode: false))
    }

    @Test func setupAndSettingsAreNeverGated() {
        #expect(routeAllowed(.setup, setupState: .incomplete, devMode: false))
        #expect(routeAllowed(.settings(.thisKiosk), setupState: .failed, devMode: false))
    }
}
