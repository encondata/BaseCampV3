import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct KioskAuthTests {
    @MainActor private struct Harness {
        let api = FakeKioskApi()
        let refresher = FakeRefresher()
        let prefs = KioskPrefs(defaults: freshDefaults())
        let identity: Identity
        let auth: KioskAuth
        init() {
            identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            auth = KioskAuth(api: api, refresher: refresher, identity: identity, prefs: prefs)
        }
    }

    @Test func restoreFromCookieOrAnon() async {
        let h = Harness()
        h.refresher.refreshResult = { fakeSession() }
        #expect(h.auth.state == .loading)
        await h.auth.restore()
        if case .authed = h.auth.state {} else { Issue.record("expected authed") }
        #expect(h.auth.takePendingSignIn() == nil)   // a cookie restore is not a sign-in
        h.refresher.refreshResult = { nil }
        await h.auth.restore()
        #expect(h.auth.state == .anon)
    }

    @Test func loginMarksPendingPasswordSignIn() async throws {
        let h = Harness()
        h.api.loginResult = { fakeSession(roles: ["developer"], maxRank: 100) }
        try await h.auth.login(email: "a@b.c", password: "pw")
        guard case .authed(let s) = h.auth.state else { Issue.record("expected authed"); return }
        #expect(s.isAdmin); #expect(s.isDeveloper)
        #expect(h.auth.takePendingSignIn() == .password)
        #expect(h.auth.takePendingSignIn() == nil)
        #expect(h.auth.can("kiosk", "view")); #expect(!h.auth.can("labels", "view"))
    }

    @Test func loginFailurePropagatesAndStaysPut() async {
        let h = Harness()
        do { try await h.auth.login(email: "a@b.c", password: "bad"); Issue.record("should throw") }
        catch let e as ApiError { #expect(e.code == "invalid_credentials") }
        catch { Issue.record("wrong error") }
        #expect(h.auth.state == .loading)   // restore() not called in this test
    }

    @Test func completePairAndLogout() async {
        let h = Harness()
        var stopped = 0
        h.auth.onLogout = { stopped += 1 }
        await h.auth.completePair(fakeSession())
        #expect(h.auth.takePendingSignIn() == .link)
        await h.auth.logout()
        #expect(h.api.calls == ["signOut", "logout"])
        #expect(h.auth.state == .anon)
        #expect(h.refresher.cleared == 1)
        #expect(stopped == 1)
    }

    @Test func completePairKeepsTheSessionAndItsCookie() async {
        let h = Harness()
        let cookie = PairCookie(host: "api.example.com", value: "p1")
        await h.auth.completePair(fakeSession(), cookie: cookie)
        #expect(h.refresher.stored == fakeSession())
        #expect(h.refresher.adoptedCookie == cookie)
    }

    @Test func endSessionFlipsToAnon() async {
        let h = Harness()
        await h.auth.completePair(fakeSession())
        h.auth.endSession()
        #expect(h.auth.state == .anon)
    }

    @Test func moveLoginMarksPendingPasswordSignIn() async throws {
        let h = Harness()
        h.api.moveLoginResult = { pw in
            #expect(pw == "move-pass")
            return fakeSession(kioskMove: KioskMove(initiativeId: "i1", name: "Move"))
        }
        try await h.auth.moveLogin(password: "move-pass")
        if case .authed = h.auth.state {} else { Issue.record("expected authed") }
        #expect(h.auth.takePendingSignIn() == .password)
        #expect(h.api.calls == ["moveLogin"])
    }

    @Test func moveSessionForAnotherInitiativeClearsSavedSelection() async throws {
        let h = Harness()
        h.prefs.setupSelection = testSelection(initiativeId: "i1")
        h.prefs.setupState = .complete
        h.api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "i2", name: "Other")) }
        try await h.auth.moveLogin(password: "pw")
        #expect(h.prefs.setupSelection == nil)
        #expect(h.prefs.setupState == .incomplete)
    }

    @Test func moveSessionForTheSameInitiativeLeavesSelection() async throws {
        let h = Harness()
        h.prefs.setupSelection = testSelection(initiativeId: "i1")
        h.prefs.setupState = .complete
        h.api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "i1", name: "Move")) }
        try await h.auth.moveLogin(password: "pw")
        #expect(h.prefs.setupSelection == testSelection(initiativeId: "i1"))
        #expect(h.prefs.setupState == .complete)
    }

    @Test func moveRuleAlsoAppliesToRestoreAndPair() async {
        let h = Harness()
        h.prefs.setupSelection = testSelection(initiativeId: "i1")
        h.prefs.setupState = .complete
        h.refresher.refreshResult = { fakeSession(kioskMove: KioskMove(initiativeId: "i2", name: "Other")) }
        await h.auth.restore()
        #expect(h.prefs.setupSelection == nil)
        #expect(h.prefs.setupState == .incomplete)

        h.prefs.setupSelection = testSelection(initiativeId: "i1")
        h.prefs.setupState = .complete
        await h.auth.completePair(fakeSession(kioskMove: KioskMove(initiativeId: "i2", name: "Other")))
        #expect(h.prefs.setupSelection == nil)
    }

    @Test func nonMoveSessionLeavesSelection() async throws {
        let h = Harness()
        h.prefs.setupSelection = testSelection(initiativeId: "i1")
        h.api.loginResult = { fakeSession() }
        try await h.auth.login(email: "a@b.c", password: "pw")
        #expect(h.prefs.setupSelection != nil)
    }
}
