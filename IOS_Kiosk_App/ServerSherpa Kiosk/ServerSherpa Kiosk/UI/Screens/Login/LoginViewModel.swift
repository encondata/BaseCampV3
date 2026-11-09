import Foundation
import Observation

/// Which form the sign-in column shows. `biometric` is the "Sign in as …" card; "Other account"
/// is the password view with an empty email (iOS has no chooser: its links are on that view).
enum LoginView: Equatable { case password, pair, move, biometric }

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
    /// The longest "Checking…" waits for the card before the form shows anyway.
    static let cardPendingMax: Duration = .seconds(3)

    @ObservationIgnored private let auth: KioskAuth
    @ObservationIgnored private let api: KioskApi
    /// Nil where the screen has no biometric sign-in (unit tests of the password form).
    @ObservationIgnored private let biometric: BiometricSignIn?
    /// Told after each password sign-in; it decides on its own whether to offer Turn on.
    @ObservationIgnored private let enrollOffer: EnrollOffer?
    /// The "Checking…" cap's timer (tests hold it).
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

    // Once per screen: a new visit to the sign-in page makes a new view model.
    @ObservationIgnored private var cardLoaded = false
    @ObservationIgnored private var autoPrompted = false
    /// The person chose a form while the card was on its way: it never replaces that form.
    @ObservationIgnored private var cardDeclined = false

    // Typing ends "Checking…": the form the person started stays.
    var email = "" { didSet { emailInvalid = false; error = nil; cardPending = false } }
    var password = "" { didSet { passwordInvalid = false; error = nil; cardPending = false } }
    var movePassword = "" { didSet { moveError = nil } }
    var showPassword = false
    var showMovePassword = false
    private(set) var busy = false
    private(set) var error: String?
    private(set) var emailInvalid = false
    private(set) var passwordInvalid = false
    private(set) var moveError: String?
    /// Leaving the card (or "Checking…") for a form is the person's choice: a card still on its
    /// way never replaces it, and the lines from the card go with it.
    var view: LoginView = .password {
        didSet {
            error = nil
            moveError = nil
            guard view != .biometric else { return }
            cardDeclined = true
            cardPending = false
            notice = nil
            bioError = nil
        }
    }
    var ssoHint = false
    var supportOpen = false
    private(set) var status: SystemStatus?

    /// The device's card: shown while `view` is `.biometric`, and kept for Use password's email.
    private(set) var card: BiometricCard?
    /// This device has an enrollment and its card is still on its way: "Checking…" with Use
    /// password instead of a form the card would then replace (at most `cardPendingMax`).
    private(set) var cardPending = false
    /// A biometric sign-in is running (the prompt is up, or the server is answering).
    private(set) var bioBusy = false
    /// The card's line after a sign-in that left the person on it (lockout, network, …).
    private(set) var bioError: String?
    /// The line above the password form after the card sent the person there (expired, …).
    private(set) var notice: String?
    /// `notice` reads as an error (red) rather than a note.
    private(set) var noticeError = false
    /// The card's biometric and device words, for its button's words and symbol.
    private(set) var cardWords: BiometricWords?

    init(auth: KioskAuth, api: KioskApi, biometric: BiometricSignIn? = nil, enrollOffer: EnrollOffer? = nil,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.auth = auth
        self.api = api
        self.biometric = biometric
        self.enrollOffer = enrollOffer
        self.sleep = sleep
    }

    static func message(for code: String) -> String { ERROR_MESSAGES[code] ?? LOGIN_FAILED }
    static func moveMessage(for code: String) -> String { MOVE_ERROR_MESSAGES[code] ?? LOGIN_FAILED }

    func submit() async {
        guard !busy else { return }
        let blankEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let blankPassword = password.isEmpty   // the web: only a literally empty password
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
            password = ""
        } catch {
            password = ""   // before the flags: its didSet clears them
            emailInvalid = true
            passwordInvalid = true
            self.error = Self.message(for: Self.code(error))
            return
        }
        // The offer is decided in the background (the sign-in never waits for it), and only
        // after a password sign-in.
        enrollOffer?.afterPasswordSignIn()
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

    // MARK: Biometric sign-in

    /// Once per screen, signed out only: the device's card, if it has one. BiometricSignIn decides
    /// who never gets one (no key, a shared station, a key iOS or the server dropped). An expired
    /// card is the password form with its email and the expired line, never a prompt. The card
    /// arrives over the network, so it replaces the form only if the person hasn't started on it.
    /// While it is on its way on a device with an enrollment, the screen says "Checking…" (with
    /// Use password) for up to `cardPendingMax`; offline, that ends on the form.
    func loadCard() async {
        guard let bio = biometric, !cardLoaded else { return }
        cardLoaded = true
        if case .authed = auth.state { return }
        // The local record only decides whether to say "Checking…": nothing from it is shown,
        // since card() hasn't checked it yet (a shared station now, a key gone).
        var cap: Task<Void, Never>?
        if bio.enrollment != nil {
            if untouched { cardPending = true }
            let sleep = self.sleep
            cap = Task { [weak self] in
                do { try await sleep(Self.cardPendingMax) } catch { return }
                self?.cardPending = false
            }
        }
        let found = await bio.card()
        cap?.cancel()
        cardPending = false
        guard let found, untouched else { return }
        let w = bio.words
        cardWords = w
        if found.expired {
            card = found
            email = found.email ?? ""
            notice = BiometricCopy.expired(w)
            noticeError = false
        } else {
            view = .biometric
            card = found
            bioError = nil
        }
    }

    /// The prompt that starts on its own when the card appears: once per screen (never again on a
    /// re-render or a rotation), and never for an expired card.
    func autoPrompt(_ p: BiometricPrompter) async {
        guard !autoPrompted, view == .biometric, let card, !card.expired else { return }
        autoPrompted = true
        await signInWithBiometric(p)
    }

    /// The card's button (and the auto prompt): the system prompt, then the server. Signed in,
    /// `KioskAuth` swaps the screen out; otherwise the outcome picks the card's line or the
    /// password form. Only a device that is no longer this person's (`removed`) or a key iOS
    /// dropped clears the email.
    func signInWithBiometric(_ p: BiometricPrompter) async {
        guard let bio = biometric, !bioBusy, view == .biometric else { return }
        bioBusy = true
        bioError = nil
        let problems = BiometricPromptProblems()
        let outcome = await bio.signIn(problemAware(p) { problems.record($0) }, name: card?.displayName)
        let w = bio.words
        switch outcome {
        case .signedIn:
            bioBusy = false
        case .canceled:
            bioBusy = false
            bioError = Self.cardLine(problems.last, w)
        case .failed(let message):
            bioBusy = false
            bioError = message
        case .expired:
            toPassword(BiometricCopy.expired(w), error: false, keepEmail: true)
        case .passwordChange:
            toPassword(BiometricCopy.passwordChange(w), error: true, keepEmail: true)
        case .notAllowed(let message, let reason):
            toPassword(message, error: true, keepEmail: reason != .removed)
        case .invalidated:
            toPassword(nil, error: false, keepEmail: false)
        }
    }

    /// The card's Use password: this person's password form, with the email from the validated
    /// card. During "Checking…" there is no card yet, so the form opens empty.
    func usePassword() {
        let email = card?.email ?? ""
        view = .password
        self.email = email
        password = ""
    }

    /// The card's Other account: the password form for someone else, nothing filled in (its
    /// links still offer Pair with phone and Use a move password).
    func otherAccount() {
        view = .password
        email = ""
        password = ""
    }

    /// Whether the form is as the screen opened it: a card may still take its place.
    private var untouched: Bool {
        !cardDeclined && view == .password && email.isEmpty && password.isEmpty && !busy
    }

    private func toPassword(_ notice: String?, error: Bool, keepEmail: Bool) {
        let email = keepEmail ? (card?.email ?? "") : ""
        if !keepEmail { card = nil }
        view = .password   // first: it clears the card's lines
        bioBusy = false
        self.email = email
        password = ""
        self.notice = notice
        noticeError = error
    }

    private static func cardLine(_ problem: BiometricPromptProblem?, _ w: BiometricWords) -> String? {
        switch problem {
        case .lockedOut: BiometricCopy.lockoutCard(w)
        case .unavailable: BiometricCopy.unavailableCard(w)
        case nil: nil
        }
    }

    private static func code(_ error: Error) -> String { (error as? ApiError)?.code ?? "network" }
}
