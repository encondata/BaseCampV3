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

    // MARK: Clear Setup (Android SetupClearedRedirectTest + GuardsTest)

    /// The heartbeat's signal moves whoever is signed in to Kiosk Setup (Home beneath it, so
    /// "‹ Home" doesn't go back through the gated screen), once per signal. A signal that lands
    /// while nobody is signed in is spent: it never moves the next sign-in.
    @Test func theRedirectFiresOnceAndOnlyWhileSignedIn() {
        var redirect = SetupClearedRedirect()
        #expect(redirect.next(signal: 0, path: [.scan], signedIn: true) == nil)            // nothing applied yet
        #expect(redirect.next(signal: 1, path: [.scan, .settings(nil)], signedIn: true) == [.setup])
        #expect(redirect.next(signal: 1, path: [.rolodex], signedIn: true) == nil)         // the same clear: once
        #expect(redirect.next(signal: 2, path: [], signedIn: true) == [.setup])            // from Home too
        #expect(redirect.next(signal: 3, path: [.setup], signedIn: true) == nil)           // already there: no second Setup
        #expect(redirect.next(signal: 4, path: [.scan], signedIn: false) == nil)           // signed out
        #expect(redirect.next(signal: 4, path: [.scan], signedIn: true) == nil)            // ...and spent for the next sign-in
    }

    @Test func setupGateLeavesAKioskThatIsAlreadyOnSetupThere() {
        #expect(gateRedirect(path: [.setup], clearNotice: false) == nil)
        #expect(gateRedirect(path: [.setup], clearNotice: true) == nil)
    }

    @Test func setupGateSendsAnUnsetKioskHome() {
        #expect(gateRedirect(path: [.scan], clearNotice: false) == [])
    }

    /// The notice is up: a gated screen left by the clear goes to Kiosk Setup, not Home (Home
    /// would pop the redirect's Setup right off).
    @Test func setupGateSendsAClearedKioskToSetupNotHome() {
        #expect(gateRedirect(path: [.scan], clearNotice: true) == [.setup])
    }
}
