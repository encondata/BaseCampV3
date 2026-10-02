import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// Android LoginViewModelTest.kt, plus the web kiosk's move-password form
/// (kiosk/src/pages/Login.tsx `MOVE_ERROR_MESSAGES`).
@MainActor
struct LoginViewModelTests {
    @MainActor private struct Harness {
        let api = FakeKioskApi()
        let auth: KioskAuth
        let vm: LoginViewModel
        init() {
            let prefs = KioskPrefs(defaults: freshDefaults())
            let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
            vm = LoginViewModel(auth: auth, api: api)
        }
    }

    private func isAuthed(_ auth: KioskAuth) -> Bool {
        if case .authed = auth.state { return true }
        return false
    }

    @Test func emptyFieldsAreRejectedLocally() async {
        let h = Harness()
        await h.vm.submit()
        #expect(h.vm.error == "Please enter both email and password")
        #expect(h.vm.emailInvalid && h.vm.passwordInvalid)
        #expect(!isAuthed(h.auth))
        #expect(h.api.calls.isEmpty)
    }

    @Test func onlyTheEmptyFieldIsFlagged() async {
        let h = Harness()
        h.vm.email = "a@b.c"
        await h.vm.submit()
        #expect(h.vm.error == "Please enter both email and password")
        #expect(!h.vm.emailInvalid)
        #expect(h.vm.passwordInvalid)
    }

    @Test func aWhitespaceOnlyPasswordIsNotEmpty() async {
        let h = Harness()
        h.api.loginResult = { fakeSession() }
        h.vm.email = "  a@b.c "; h.vm.password = "   "
        await h.vm.submit()
        #expect(h.vm.error == nil)
        #expect(!h.vm.passwordInvalid)
        #expect(isAuthed(h.auth))
    }

    @Test func aLiterallyEmptyPasswordIsRejected() async {
        let h = Harness()
        h.vm.email = "a@b.c"
        await h.vm.submit()
        #expect(h.vm.passwordInvalid && !h.vm.emailInvalid)
    }

    @Test func errorCodesMapToCopy() async {
        let h = Harness()
        h.api.loginResult = { throw ApiError(status: 403, code: "kiosk_not_allowed") }
        h.vm.email = "a@b.c"; h.vm.password = "pw"
        await h.vm.submit()
        #expect(h.vm.error == "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.")
        #expect(h.vm.password == "")   // cleared after a failure
        #expect(h.vm.emailInvalid && h.vm.passwordInvalid)
        #expect(!h.vm.busy)
        h.api.loginResult = { throw ApiError(status: 0, code: "network") }
        h.vm.password = "pw"
        await h.vm.submit()
        #expect(h.vm.error == "Can't reach the server. Check the kiosk's network connection.")
    }

    @Test func successSignsIn() async {
        let h = Harness()
        h.api.loginResult = { fakeSession() }
        h.vm.email = "a@b.c"; h.vm.password = "pw"
        await h.vm.submit()
        #expect(isAuthed(h.auth))
        #expect(h.vm.error == nil)
        #expect(!h.vm.busy)
        #expect(h.vm.password == "")   // cleared after a success too
    }

    @Test func typingClearsTheError() async {
        let h = Harness()
        await h.vm.submit()
        h.vm.email = "a"
        #expect(h.vm.error == nil)
        #expect(!h.vm.emailInvalid)
        #expect(h.vm.passwordInvalid)
    }

    @Test func passwordMessagesAreTheWebKiosks() {
        #expect(LoginViewModel.message(for: "invalid_credentials") == "Invalid email or password.")
        #expect(LoginViewModel.message(for: "account_locked") == "Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.")
        #expect(LoginViewModel.message(for: "account_disabled") == "This account is disabled. Contact your coordinator.")
        #expect(LoginViewModel.message(for: "totp_required") == "This account requires a verification code. 2FA sign-in is coming soon — contact support.")
        #expect(LoginViewModel.message(for: "kiosk_not_allowed") == "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.")
        #expect(LoginViewModel.message(for: "network") == "Can't reach the server. Check the kiosk's network connection.")
        #expect(LoginViewModel.message(for: "something_else") == "Login failed. Please try again.")
    }

    // MARK: move password

    @Test func emptyMovePasswordIsRejectedLocally() async {
        let h = Harness()
        h.vm.view = .move
        h.vm.movePassword = "   "
        await h.vm.submitMove()
        #expect(h.vm.moveError == "Enter the move password.")
        #expect(h.api.calls.isEmpty)
    }

    @Test(arguments: [
        ("invalid_move_password", "That move password isn't right."),
        ("move_not_active", "That move password isn't active."),
        ("move_login_rate_limited", "Too many tries. Wait a few minutes."),
        ("kiosk_not_allowed", "That move can't sign in to kiosks right now. Ask a coordinator."),
        ("network", "Can't reach the server. Check the kiosk's network connection."),
        ("teapot", "Login failed. Please try again."),
    ])
    func moveErrorCodesMapToCopy(code: String, copy: String) async {
        let h = Harness()
        h.api.moveLoginResult = { _ in throw ApiError(status: 400, code: code) }
        h.vm.view = .move
        h.vm.movePassword = "secret"
        await h.vm.submitMove()
        #expect(h.vm.moveError == copy)
        #expect(h.vm.movePassword == "")   // cleared after a failure
        #expect(!h.vm.busy)
        #expect(LoginViewModel.moveMessage(for: code) == copy)
    }

    @Test func movePasswordSignsIn() async {
        let h = Harness()
        h.api.moveLoginResult = { pw in
            #expect(pw == "secret")
            return fakeSession(kioskMove: KioskMove(initiativeId: "i1", name: "Move"))
        }
        h.vm.view = .move
        h.vm.movePassword = "secret"
        await h.vm.submitMove()
        #expect(isAuthed(h.auth))
        #expect(h.vm.moveError == nil)
        #expect(h.vm.movePassword == "")
    }

    @Test func loadStatusIsBestEffort() async {
        let h = Harness()
        h.api.systemStatusResult = { SystemStatus(readOnly: true, banner: "Hi") }
        await h.vm.loadStatus()
        #expect(h.vm.status == SystemStatus(readOnly: true, banner: "Hi"))
        h.api.systemStatusResult = { throw ApiError(status: 0, code: "network") }
        await h.vm.loadStatus()
        #expect(h.vm.status == SystemStatus(readOnly: true, banner: "Hi"))
    }
}
