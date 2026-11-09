import Foundation
import LocalAuthentication
import Testing
@testable import ServerSherpa_Kiosk

/// The words the rig's device uses (Face ID is the fake key store's default biometric).
private let w = BiometricWords(bio: "Face ID", device: "iPad")

/// The `/kiosk/biometric/challenge` answer for the rig's enrollment.
private func challenge(expired: Bool = false, keyId: String = "key-1") -> BiometricChallengeOut {
    BiometricChallengeOut(keyId: keyId, challenge: "chal.lenge.1", displayName: "Tina T", photoUrl: nil, expired: expired)
}

/// Android `BiometricLoginTest`, ported to the view model: the "Sign in as …" card, "Checking…",
/// the fallbacks to the password form, and Settings › This Kiosk's row.
@MainActor @Suite(.timeLimit(.minutes(1)))
struct BiometricLoginTests {
    /// Tina's iPad, signed out: the next launch's sign-in screen. `sleeper` holds the
    /// "Checking…" cap until a test fires it.
    @MainActor private final class Rig {
        let api = FakeKioskApi()
        let keys = FakeBiometricKeys()
        let prefs = KioskPrefs(defaults: freshDefaults())
        let prompter = FakeBiometricPrompter()
        let sleeper = ManualSleeper()
        let identity: Identity
        let auth: KioskAuth
        let bio: BiometricSignIn
        let offer: EnrollOffer
        let vm: LoginViewModel

        init() {
            identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
            api.loginResult = { fakeSession() }
            api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "m1", name: "Dallas Move")) }
            api.bioChallengeResult = { _ in challenge() }
            api.bioSignInResult = { _, _, _ in fakeSession() }
            // The container's rule, less the station key (AppContainerTests checks both halves).
            bio = BiometricSignIn(
                api: api, auth: auth, keys: keys, prefs: prefs, identity: identity,
                sharedStation: { [prefs] in prefs.setupSelection?.stationType != nil },
                words: { kind in
                    switch kind {
                    case .faceID: BiometricWords(bio: "Face ID", device: "iPad")
                    case .touchID: BiometricWords(bio: "Touch ID", device: "iPad")
                    case nil: BiometricWords(bio: "no biometric", device: "iPad")
                    }
                }
            )
            offer = EnrollOffer(biometric: bio, auth: auth)
            let sleeper = sleeper
            vm = LoginViewModel(auth: auth, api: api, biometric: bio, enrollOffer: offer, sleep: { try await sleeper.sleep($0) })
        }

        /// Tina enrolled on this iPad earlier: the key and the saved enrollment.
        func enrolled() async throws {
            _ = try await keys.create(nonce: "nonce-0")
            prefs.biometric = BiometricEnrollment(keyId: "key-1", personId: "p1", email: "tina@example.com")
        }

        var bioCalls: [String] { api.calls.filter { $0.hasPrefix("bio") } }

        /// The next visit to the sign-in screen: a new view model on the same app.
        func nextScreen() -> LoginViewModel {
            let sleeper = sleeper
            return LoginViewModel(auth: auth, api: api, biometric: bio, enrollOffer: offer, sleep: { try await sleeper.sleep($0) })
        }

        var isAuthed: Bool { if case .authed = auth.state { true } else { false } }

        /// The card on screen and the prompt that started on its own.
        func cardThenAutoPrompt() async {
            await vm.loadCard()
            await vm.autoPrompt(prompter)
        }
    }

    // ── the card ────────────────────────────────────────────────────

    @Test func cardShowsNameAndOtherAccount() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil   // the person cancels the prompt
        await r.vm.loadCard()
        #expect(r.vm.view == .biometric)
        #expect(r.vm.card?.displayName == "Tina T")
        #expect(r.vm.card?.email == "tina@example.com")
        // The prompt starts on its own, once, naming the card's person; a cancel stays on the card.
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons == [BiometricCopy.signInReason(w, name: "Tina T")])
        #expect(r.vm.view == .biometric)
        #expect(r.vm.bioError == nil)
        #expect(!r.vm.bioBusy)
        #expect(r.vm.email == "")   // no form behind the card
        // Other account is the way to the form for someone else.
        r.vm.otherAccount()
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "")
    }

    @Test func faceIDSignsInAndGoesHome() async throws {
        let r = Rig()
        try await r.enrolled()
        await r.cardThenAutoPrompt()
        #expect(r.isAuthed)
        #expect(r.auth.currentSignIn == CurrentSignIn(method: .biometric, email: nil))
        #expect(r.bioCalls == ["bioChallenge", "bioChallenge", "bioSignIn"])   // the card's, then the sign-in's own
        #expect(!r.vm.bioBusy)
        #expect(r.vm.bioError == nil)
    }

    @Test func theAutoPromptRunsOnce() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil
        await r.vm.loadCard()
        await r.vm.autoPrompt(r.prompter)
        await r.vm.autoPrompt(r.prompter)   // the view's task again (a re-render, a rotation)
        #expect(r.prompter.reasons.count == 1)
        // A retry is the person's own tap: one more prompt.
        await r.vm.signInWithBiometric(r.prompter)
        #expect(r.prompter.reasons.count == 2)
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.count == 2)
    }

    @Test func lockoutHasItsOwnMessageAndStaysOnTheCard() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.error = BiometricPromptProblem.lockedOut
        await r.cardThenAutoPrompt()
        #expect(r.vm.bioError == BiometricCopy.lockoutCard(w))
        #expect(r.vm.view == .biometric)
        #expect(r.vm.card?.displayName == "Tina T")
        #expect(!r.vm.bioBusy)
        #expect(r.bioCalls == ["bioChallenge"])   // the card's only
        #expect(r.prefs.biometric != nil)
    }

    @Test func anUnavailableSensorSaysSoAndStaysOnTheCard() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.error = BiometricPromptProblem.unavailable
        await r.cardThenAutoPrompt()
        #expect(r.vm.bioError == BiometricCopy.unavailableCard(w))
        #expect(r.vm.view == .biometric)
        #expect(r.bioCalls == ["bioChallenge"])
        #expect(r.prefs.biometric != nil)
    }

    @Test func usePasswordShowsThePasswordFormWithTheEmail() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .biometric)   // the validated card, not "Checking…"
        r.vm.usePassword()
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "tina@example.com")
        #expect(r.vm.password == "")
        #expect(r.vm.notice == nil)
        #expect(!r.vm.cardPending)
    }

    @Test func otherAccountShowsTheEmptyPasswordForm() async throws {
        let r = Rig()
        try await r.enrolled()
        await r.vm.loadCard()
        #expect(r.vm.view == .biometric)
        r.vm.otherAccount()
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "")
        #expect(r.vm.password == "")
        #expect(r.vm.notice == nil)
        #expect(r.vm.bioError == nil)
        // The form for someone else: no prompt starts behind it.
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
        #expect(!r.isAuthed)
    }

    // ── when the prompt starts on its own ───────────────────────────

    @Test func noAutoPromptRightAfterSignOut() async throws {
        let r = Rig()
        try await r.enrolled()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        await r.auth.logout()
        // The screen after Sign out shows the card, but Face ID would sign the person straight
        // back in: the prompt waits for a tap.
        let screen = r.nextScreen()
        await screen.loadCard()
        #expect(screen.view == .biometric)
        await screen.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
        #expect(!r.isAuthed)
        await screen.signInWithBiometric(r.prompter)   // the person's own tap
        #expect(r.prompter.reasons.count == 1)
        #expect(r.isAuthed)
    }

    @Test func aLaunchOrASessionEndStillAutoPrompts() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil
        // A launch whose restore finds no session.
        await r.auth.restore()
        await r.cardThenAutoPrompt()
        #expect(r.prompter.reasons.count == 1)
        // A session that ended underneath the kiosk.
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.auth.endSession()
        let afterEnd = r.nextScreen()
        await afterEnd.loadCard()
        await afterEnd.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.count == 2)
        // A sign-out that no screen saw is forgotten by the next sign-in.
        try await r.auth.login(email: "tina@example.com", password: "pw")
        await r.auth.logout()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.auth.endSession()
        let afterLaterEnd = r.nextScreen()
        await afterLaterEnd.loadCard()
        await afterLaterEnd.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.count == 3)
        // A sign-out holds only the screen that follows it.
        try await r.auth.login(email: "tina@example.com", password: "pw")
        await r.auth.logout()
        let afterOut = r.nextScreen()
        await afterOut.loadCard()
        await afterOut.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.count == 3)
        let later = r.nextScreen()
        await later.loadCard()
        await later.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.count == 4)
    }

    @Test func noAutoPromptWhileSettingsOrSupportCoversTheCard() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil
        await r.vm.loadCard()
        #expect(r.vm.view == .biometric)
        r.vm.settingsOpen = true   // the gear's Settings sheet: a sign-in would tear it down
        #expect(r.vm.covered)
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
        r.vm.settingsOpen = false
        r.vm.supportOpen = true
        #expect(r.vm.covered)
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
        // Closed, the card still untouched and not yet prompted: the prompt starts.
        r.vm.supportOpen = false
        #expect(!r.vm.covered)
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.count == 1)
    }

    // ── while a sign-in runs ────────────────────────────────────────

    @Test func theCardsLinksWaitForARunningSignIn() async throws {
        let r = Rig()
        try await r.enrolled()
        let hold = HoldGate()
        r.api.bioSignInResult = { _, _, _ in await hold.wait(); return fakeSession() }
        await r.vm.loadCard()
        let signing = Task { await r.vm.signInWithBiometric(r.prompter) }
        #expect(await waitUntil { r.api.calls.contains("bioSignIn") })
        #expect(r.vm.bioBusy)
        // Other account and Use password do nothing while the server answers: its yes would
        // sign the card's person in over the form chosen.
        r.vm.otherAccount()
        r.vm.usePassword()
        #expect(r.vm.view == .biometric)
        #expect(r.vm.email == "")
        await hold.open()
        await signing.value
        #expect(r.isAuthed)
    }

    @Test func aLateAnswerNeverReplacesAFormChosenMeanwhile() async throws {
        let r = Rig()
        try await r.enrolled()
        let hold = HoldGate()
        r.api.bioSignInResult = { _, _, _ in await hold.wait(); throw ApiError(status: 403, code: "kiosk_not_allowed") }
        await r.vm.loadCard()
        let signing = Task { await r.vm.signInWithBiometric(r.prompter) }
        #expect(await waitUntil { r.api.calls.contains("bioSignIn") })
        r.vm.view = .move   // the screen moved on while the server answered
        await hold.open()
        await signing.value
        #expect(r.vm.view == .move)
        #expect(r.vm.notice == nil)
        #expect(r.vm.email == "")
        #expect(r.vm.bioError == nil)
        #expect(!r.vm.bioBusy)
    }

    // ── the enrollment going away under the card ────────────────────

    @Test func aForgottenEnrollmentDropsTheCardToThePlainForm() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .biometric)
        // Settings › This Kiosk › Forget, from the sign-in screen's gear.
        #expect(await r.bio.forget(signedIn: false))
        #expect(await waitUntil { r.vm.view == .password })
        #expect(r.vm.card == nil)
        #expect(r.vm.email == "")
        #expect(r.vm.notice == nil)
        #expect(!r.vm.noticeError)
    }

    @Test func theCardsSymbolIsTheDevicesBiometric() async throws {
        #expect(biometricSymbol(.faceID) == "faceid")
        #expect(biometricSymbol(.touchID) == "touchid")
        #expect(biometricSymbol(nil) == nil)
        // Locked out on a Touch ID iPad: not ready, but still Touch ID, not a guess.
        let r = Rig()
        try await r.enrolled()
        r.keys.readinessValue = .unsupported
        r.keys.hardwareKind = .touchID
        await r.vm.loadCard()
        #expect(r.vm.view == .biometric)
        #expect(r.vm.cardKind == .touchID)
        #expect(r.vm.cardWords == BiometricWords(bio: "Touch ID", device: "iPad"))
    }

    // ── the fallbacks to the password form ──────────────────────────

    @Test func expiredShowsPrefilledEmailAndLine() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioChallengeResult = { _ in challenge(expired: true) }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "tina@example.com")
        #expect(r.vm.notice == BiometricCopy.expired(w))
        #expect(!r.vm.noticeError)
        #expect(r.prompter.reasons.isEmpty)   // never prompted
        #expect(!r.bioCalls.contains("bioSignIn"))
        #expect(r.prefs.biometric != nil)     // a password sign-in renews it
    }

    @Test func passwordChangeShowsPortalMessage() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "password_change_required") }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .password)
        #expect(r.vm.notice == BiometricCopy.passwordChange(w))
        #expect(r.vm.noticeError)
        #expect(r.vm.email == "tina@example.com")
        #expect(!r.vm.bioBusy)
        #expect(!r.isAuthed)
    }

    @Test func reassignedFallsBackToPasswordWithMessageAndNoEmail() async throws {
        let r = Rig()
        try await r.enrolled()
        // The card was showing; then the portal gave the iPad to someone else.
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "not_personal_device") }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .password)
        #expect(r.vm.notice == BiometricCopy.removed(w))
        #expect(r.vm.noticeError)
        // The iPad is no longer Tina's: none of her email is left on the form.
        #expect(r.vm.email == "")
        #expect(r.vm.card == nil)
        #expect(r.prefs.biometric == nil)
        #expect(!r.keys.hasKey)
        #expect(!r.isAuthed)
    }

    @Test func kioskAccessRemovedKeepsTheEmail() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "kiosk_not_allowed") }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .password)
        #expect(r.vm.notice == BiometricCopy.kioskNotAllowed(w))
        #expect(r.vm.noticeError)
        #expect(r.vm.email == "tina@example.com")
        #expect(r.prefs.biometric != nil)   // still her iPad
    }

    @Test func aDisabledAccountFallsBackToPasswordWithMessage() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "account_disabled") }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .password)
        #expect(r.vm.notice == BiometricCopy.accountDisabled(w))
        #expect(r.vm.noticeError)
        #expect(r.vm.email == "tina@example.com")
        // The iPad forgets the key, so the card doesn't come back next time.
        #expect(r.prefs.biometric == nil)
        #expect(!r.keys.hasKey)
    }

    @Test func rateLimitedStaysOnTheCardWithItsMessage() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 429, code: "biometric_rate_limited") }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .biometric)
        #expect(r.vm.bioError == BiometricCopy.rateLimited(w))
        #expect(r.vm.notice == nil)
        #expect(!r.vm.bioBusy)
    }

    @Test func aNetworkFailureStaysOnTheCardWithItsMessage() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 0, code: "network") }
        await r.cardThenAutoPrompt()
        #expect(r.vm.view == .biometric)
        #expect(r.vm.bioError == BiometricCopy.network(w))
        #expect(r.prefs.biometric != nil)
    }

    @Test func aKeyDroppedAfterTheCardShowedIsThePlainForm() async throws {
        let r = Rig()
        try await r.enrolled()
        r.prompter.answer = nil
        await r.cardThenAutoPrompt()
        #expect(r.prompter.reasons.count == 1)
        // A face added in Settings while the card was up: iOS invalidated the key.
        r.keys.invalidated = true
        r.prompter.answer = BiometricAuth(context: LAContext())
        await r.vm.signInWithBiometric(r.prompter)
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "")
        #expect(r.vm.notice == nil)
        #expect(!r.vm.noticeError)
        #expect(r.vm.card == nil)
        #expect(r.prefs.biometric == nil)
        #expect(r.prompter.reasons.count == 1)   // never prompted for a key that can't sign
        #expect(!r.bioCalls.contains("bioSignIn"))
    }

    // ── while the card is on its way ────────────────────────────────

    @Test func checkingShowsWhileTheCardIsOnItsWayThenTheCard() async throws {
        let r = Rig()
        try await r.enrolled()
        let hold = HoldGate()
        r.api.bioChallengeResult = { _ in await hold.wait(); return challenge() }
        let load = Task { await r.vm.loadCard() }
        #expect(await waitUntil { r.vm.cardPending })
        #expect(r.vm.view == .password)   // "Checking…", no form to flash away
        #expect(r.vm.email == "")         // and no email from the unchecked local record
        #expect(r.vm.card == nil)
        await hold.open()
        await load.value
        #expect(!r.vm.cardPending)
        #expect(r.vm.view == .biometric)
        #expect(r.vm.card?.displayName == "Tina T")
        #expect(r.sleeper.pending(LoginViewModel.cardPendingMax) == 0)   // the cap stopped with it
    }

    @Test func offlineEndsOnTheForm() async throws {
        let r = Rig()
        try await r.enrolled()
        r.api.bioChallengeResult = { _ in throw ApiError(status: 0, code: "network") }
        await r.vm.loadCard()
        #expect(!r.vm.cardPending)
        #expect(r.vm.view == .password)
        #expect(r.vm.card == nil)
        #expect(r.vm.email == "")             // no card, no email
        #expect(r.prefs.biometric != nil)     // offline keeps the key
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
    }

    @Test func aKeyGoneBeforeTheCardNeverPrefills() async throws {
        let r = Rig()
        try await r.enrolled()
        r.keys.invalidated = true   // card() finds the key unusable: no card
        await r.vm.loadCard()
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "")
        #expect(!r.vm.cardPending)
        #expect(!r.api.calls.contains("bioChallenge"))
        #expect(r.prefs.biometric == nil)
    }

    @Test func checkingGivesUpAfterThreeSeconds() async throws {
        #expect(LoginViewModel.cardPendingMax == .seconds(3))
        let r = Rig()
        try await r.enrolled()
        let hold = HoldGate()
        r.api.bioChallengeResult = { _ in await hold.wait(); return challenge() }
        let load = Task { await r.vm.loadCard() }
        #expect(await waitUntil { r.vm.cardPending })
        #expect(await waitUntil { r.sleeper.pending(LoginViewModel.cardPendingMax) == 1 })
        r.sleeper.fire(LoginViewModel.cardPendingMax)
        #expect(await waitUntil { !r.vm.cardPending })
        // The form shows while the card is still on its way.
        #expect(r.vm.view == .password)
        #expect(r.vm.card == nil)
        // Nobody started on it, so the card may still take its place when it lands.
        await hold.open()
        await load.value
        #expect(r.vm.view == .biometric)
        #expect(!r.vm.cardPending)
    }

    @Test func aLateCardNeverReplacesAStartedForm() async throws {
        let r = Rig()
        try await r.enrolled()
        let hold = HoldGate()
        r.api.bioChallengeResult = { _ in await hold.wait(); return challenge() }
        let load = Task { await r.vm.loadCard() }
        #expect(await waitUntil { r.vm.cardPending })
        r.vm.email = "sam@example.com"   // typing ends "Checking…" at once
        #expect(!r.vm.cardPending)
        await hold.open()
        await load.value
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "sam@example.com")
        #expect(r.vm.card == nil)
        #expect(r.vm.notice == nil)
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
    }

    @Test func usePasswordWhileCheckingOpensAnEmptyFormThatALateCardNeverReplaces() async throws {
        let r = Rig()
        try await r.enrolled()
        let hold = HoldGate()
        r.api.bioChallengeResult = { _ in await hold.wait(); return challenge() }
        let load = Task { await r.vm.loadCard() }
        #expect(await waitUntil { r.vm.cardPending })
        r.vm.usePassword()
        // Nothing is validated yet, so the saved email stays off the form.
        #expect(r.vm.view == .password)
        #expect(r.vm.email == "")
        #expect(!r.vm.cardPending)
        await hold.open()
        await load.value
        #expect(r.vm.view == .password)
        #expect(r.vm.card == nil)
        #expect(r.vm.email == "")
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
    }

    @Test func noKeyOnTheDeviceIsThePlainPasswordForm() async {
        let r = Rig()
        await r.vm.loadCard()
        #expect(r.vm.view == .password)
        #expect(!r.vm.cardPending)
        #expect(r.sleeper.started(LoginViewModel.cardPendingMax) == 0)   // never "Checking…"
        #expect(r.vm.card == nil)
        #expect(r.api.calls.isEmpty)
        await r.vm.autoPrompt(r.prompter)
        #expect(r.prompter.reasons.isEmpty)
    }

    @Test func noCardForATimeClockStationOrWhileSignedIn() async throws {
        // A Time Clock station with a key left on it: the sign-in page never shows the card.
        let station = Rig()
        try await station.enrolled()
        station.prefs.setupSelection = .timeclock(initiativeId: nil, initiativeName: nil, siteId: nil, siteName: nil, siteRole: nil)
        await station.vm.loadCard()
        await station.vm.autoPrompt(station.prompter)
        #expect(station.vm.view == .password)
        #expect(station.vm.card == nil)
        #expect(station.vm.email == "")   // the leftover enrollment's email never shows
        #expect(station.prompter.reasons.isEmpty)
        #expect(!station.api.calls.contains("bioChallenge"))

        // Signed in already (a move-locked session): no card is looked up.
        let signedIn = Rig()
        try await signedIn.enrolled()
        try await signedIn.auth.moveLogin(password: "orange-kayak-42")
        await signedIn.vm.loadCard()
        await signedIn.vm.autoPrompt(signedIn.prompter)
        #expect(signedIn.vm.card == nil)
        #expect(signedIn.vm.view == .password)
        #expect(signedIn.prompter.reasons.isEmpty)
        #expect(!signedIn.api.calls.contains("bioChallenge"))
    }

    // ── the offer after a password sign-in ──────────────────────────

    @Test func passwordSignInStartsTheOfferInTheBackground() async {
        let r = Rig()
        let hold = HoldGate()
        r.api.bioEnrollChallengeResult = { _ in await hold.wait(); return "nonce-1" }
        r.vm.email = "tina@example.com"
        r.vm.password = "pw"
        await r.vm.submit()
        // Signed in while the offer is still being decided.
        #expect(r.isAuthed)
        #expect(r.offer.sheet == nil)
        #expect(await waitUntil { r.api.calls.contains("bioEnrollChallenge") })
        #expect(r.offer.sheet == nil)
        await hold.open()
        #expect(await waitUntil { r.offer.sheet != nil })
        #expect(r.offer.sheet == EnrollOfferUI())
    }

    // ── the prompt's problems ───────────────────────────────────────

    @Test func problemAwareTurnsAProblemIntoACancelAndSaysWhich() async throws {
        let prompter = FakeBiometricPrompter()
        let seen = BiometricPromptProblems()
        let aware = problemAware(prompter) { seen.record($0) }
        prompter.error = BiometricPromptProblem.lockedOut
        #expect(try await aware.authenticate(reason: "r") == nil)
        #expect(seen.last == .lockedOut)
        prompter.error = BiometricPromptProblem.unavailable
        #expect(try await aware.authenticate(reason: "r") == nil)
        #expect(seen.last == .unavailable)
        // Anything else still throws: the rules call that a failure, not a cancel.
        prompter.error = CancellationError()
        await #expect(throws: CancellationError.self) { try await aware.authenticate(reason: "r") }
        prompter.error = nil
        #expect(try await aware.authenticate(reason: "r") != nil)
    }

    // ── Settings › This Kiosk ───────────────────────────────────────

    @Test func rowIsOffWithoutEnrollment() {
        #expect(biometricRowState(enrollment: nil, signedInPersonId: nil) == .off)
        #expect(biometricRowState(enrollment: nil, signedInPersonId: "p1") == .off)
    }

    @Test func rowIsNotYoursForSomeoneElseSignedIn() {
        let tina = BiometricEnrollment(keyId: "key-1", personId: "p1", email: "tina@example.com")
        #expect(biometricRowState(enrollment: tina, signedInPersonId: "p2") == .notYours)
    }

    @Test func rowIsOnForTheOwnerOrSignedOut() {
        let tina = BiometricEnrollment(keyId: "key-1", personId: "p1", email: "tina@example.com")
        #expect(biometricRowState(enrollment: tina, signedInPersonId: "p1") == .on)
        #expect(biometricRowState(enrollment: tina, signedInPersonId: nil) == .on)
    }

    @Test func forgetSaysWhatHappened() {
        #expect(biometricForgetMessage(serverReached: true, stillEnrolled: false, w) == BiometricCopy.forgotten(w))
        #expect(biometricForgetMessage(serverReached: false, stillEnrolled: false, w) == BiometricCopy.forgottenHereOnly(w))
        #expect(biometricForgetMessage(serverReached: true, stillEnrolled: true, w) == BiometricCopy.forgetFailed(w))
        #expect(biometricForgetMessage(serverReached: false, stillEnrolled: true, w) == BiometricCopy.forgetFailed(w))
    }
}
