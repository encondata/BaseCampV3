import Foundation
import Observation

/// Which form the sign-in column shows.
enum LoginView: Equatable { case password, pair, move }

/// The web kiosk's `ERROR_MESSAGES` (kiosk/src/pages/Login.tsx), verbatim.
private let ERROR_MESSAGES: [String: String] = [
    "invalid_credentials": "Invalid email or password.",
    "account_locked": "Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.",
    "account_disabled": "This account is disabled. Contact your coordinator.",
    "totp_required": "This account requires a verification code. 2FA sign-in is coming soon — contact support.",
    "kiosk_not_allowed": "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.",
    "invalid_move_password": "That move password isn't right.",
    "move_not_active": "That move password isn't active.",
    "move_login_rate_limited": "Too many tries. Wait a few minutes.",
    "network": "Can't reach the server. Check the kiosk's network connection.",
]

/// The move form's own wording where a code means something else there:
/// kiosk_not_allowed on a move sign-in is the move's kiosk identity.
private let MOVE_ERROR_MESSAGES: [String: String] = ERROR_MESSAGES.merging([
    "kiosk_not_allowed": "That move can't sign in to kiosks right now. Ask a coordinator.",
]) { _, move in move }

private let LOGIN_FAILED = "Login failed. Please try again."

/// Android `LoginViewModel.kt` + the web kiosk's move-password form. A
/// successful sign-in flips `KioskAuth.state`, which swaps the login screen out.
@MainActor @Observable
final class LoginViewModel {
    @ObservationIgnored private let auth: KioskAuth
    @ObservationIgnored private let api: KioskApi

    var email = "" { didSet { emailInvalid = false; error = nil } }
    var password = "" { didSet { passwordInvalid = false; error = nil } }
    var movePassword = "" { didSet { moveError = nil } }
    var showPassword = false
    var showMovePassword = false
    private(set) var busy = false
    private(set) var error: String?
    private(set) var emailInvalid = false
    private(set) var passwordInvalid = false
    private(set) var moveError: String?
    var view: LoginView = .password { didSet { error = nil; moveError = nil } }
    var ssoHint = false
    var supportOpen = false
    private(set) var status: SystemStatus?

    init(auth: KioskAuth, api: KioskApi) {
        self.auth = auth
        self.api = api
    }

    static func message(for code: String) -> String { ERROR_MESSAGES[code] ?? LOGIN_FAILED }
    static func moveMessage(for code: String) -> String { MOVE_ERROR_MESSAGES[code] ?? LOGIN_FAILED }

    func submit() async {
        guard !busy else { return }
        let blankEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let blankPassword = password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if blankEmail || blankPassword {
            emailInvalid = blankEmail
            passwordInvalid = blankPassword
            error = "Please enter both email and password"
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await auth.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
        } catch {
            password = ""   // before the flags: its didSet clears them
            emailInvalid = true
            passwordInvalid = true
            self.error = Self.message(for: Self.code(error))
        }
    }

    func submitMove() async {
        guard !busy else { return }
        guard !movePassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            moveError = "Enter the move password."
            return
        }
        busy = true
        moveError = nil
        defer { busy = false }
        do {
            try await auth.moveLogin(password: movePassword)
            movePassword = ""
        } catch {
            movePassword = ""   // before the message: its didSet clears it
            moveError = Self.moveMessage(for: Self.code(error))
        }
    }

    /// Read-only / broadcast banners; best effort.
    func loadStatus() async {
        if let s = try? await api.systemStatus() { status = s }
    }

    private static func code(_ error: Error) -> String { (error as? ApiError)?.code ?? "network" }
}
