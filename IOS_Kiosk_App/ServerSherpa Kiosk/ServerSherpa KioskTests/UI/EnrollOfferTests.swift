import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// The words the rig's device uses (Face ID is the fake key store's default biometric).
private let w = BiometricWords(bio: "Face ID", device: "iPad")

/// Another person's session (`fakeSession` is Tina, p1).
private func session(person id: String) -> SessionData {
    var s = fakeSession()
    s.person.id = id
    s.person.displayName = "Sam S"
    return s
}

/// Android `EnrollOfferSheetTest`, ported to the controller: the Turn on offer after a password
/// sign-in, its outcomes, and signing out under it.
@MainActor @Suite(.timeLimit(.minutes(1)))
struct EnrollOfferTests {
    /// Tina's own iPad, signed out, with Face ID set up: the server will let her enroll.
    @MainActor private final class Rig {
        let api = FakeKioskApi()
        let keys: FakeBiometricKeys
        let prefs = KioskPrefs(defaults: freshDefaults())
        let prompter = FakeBiometricPrompter()
        let identity: Identity
        let auth: KioskAuth
        let bio: BiometricSignIn
        let offer: EnrollOffer
        let vm: LoginViewModel

        init(readiness: BiometricReadiness = .ready(.faceID)) {
            keys = FakeBiometricKeys(readiness: readiness)
            identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            auth = KioskAuth(api: api, refresher: FakeRefresher(), identity: identity, prefs: prefs)
            api.loginResult = { fakeSession() }
            api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "m1", name: "Dallas Move")) }
            api.bioEnrollChallengeResult = { _ in "nonce-1" }
            api.bioEnrollResult = { _ in BiometricEnrollOut(keyId: "key-1", securityLevel: "secure_enclave", renewsAt: "2026-12-09T00:00:00Z") }
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
            vm = LoginViewModel(auth: auth, api: api, biometric: bio, enrollOffer: offer)
        }

        var isAuthed: Bool { if case .authed = auth.state { true } else { false } }

        /// Tina's email and password through the sign-in screen.
        func signInWithPassword() async {
            vm.email = "tina@example.com"
            vm.password = "pw"
            await vm.submit()
            #expect(isAuthed)
        }

        /// Signed in with the sheet up.
        func offered() async {
            await signInWithPassword()
            #expect(await waitUntil { self.offer.sheet != nil })
        }

        /// Signed out, with the portal told in the background (let those calls land).
        func signOut() async {
            await auth.logout()
            #expect(await waitUntil { self.api.calls.contains("logout") })
        }

        /// The offer decided (or stopped) after a sign-in that may not show it.
        func decided() async {
            await offer.deciding?.value
        }
    }

    // ── the offer ───────────────────────────────────────────────────

    @Test func offerAfterPasswordSignInOnPersonalDevice() async {
        let r = Rig()
        await r.offered()
        #expect(r.offer.sheet == EnrollOfferUI())
        await r.offer.turnOn(r.prompter)
        #expect(r.offer.sheet == nil)
        #expect(r.prefs.biometric == BiometricEnrollment(keyId: "key-1", personId: "p1", email: "tina@example.com"))
        #expect(r.keys.hasKey)
        #expect(r.prompter.reasons == [BiometricCopy.enrollReason(w)])
    }

    @Test func notNowAsksAgainNextPasswordSignIn() async {
        let r = Rig()
        await r.offered()
        r.offer.notNow()
        #expect(r.offer.sheet == nil)
        #expect(r.prefs.biometric == nil)
        #expect(r.prompter.reasons.isEmpty)
        #expect(!r.keys.hasKey)

        await r.signOut()
        await r.offered()
        #expect(r.offer.sheet == EnrollOfferUI())
    }

    @Test func noOfferWhenSignedOutBeforeTheAnswer() async throws {
        let r = Rig()
        let hold = HoldGate()
        r.api.bioEnrollChallengeResult = { _ in await hold.wait(); return "nonce-1" }   // the offer's call stays open
        await r.signInWithPassword()
        #expect(await waitUntil { r.api.calls.contains("bioEnrollChallenge") })
        let deciding = try #require(r.offer.deciding)   // captured before the sign-out forgets it
        await r.signOut()
        await hold.open()   // then answers yes
        await deciding.value
        #expect(r.offer.sheet == nil)
    }

    @Test func noOfferWhenSomeoneElseIsSignedInByTheAnswer() async throws {
        let r = Rig()
        let hold = HoldGate()
        r.api.bioEnrollChallengeResult = { _ in await hold.wait(); return "nonce-1" }
        await r.signInWithPassword()
        #expect(await waitUntil { r.api.calls.contains("bioEnrollChallenge") })
        let deciding = try #require(r.offer.deciding)
        await r.auth.completePair(session(person: "p2"))   // straight to another person, never signed out
        await hold.open()
        await deciding.value
        #expect(r.offer.sheet == nil)
        #expect(r.isAuthed)
    }

    @Test func signingOutClosesTheSheet() async {
        let r = Rig()
        await r.offered()
        await r.signOut()
        #expect(await waitUntil { r.offer.sheet == nil })
        // And it stays closed: nothing decides again after the sign-out.
        #expect(r.offer.deciding == nil)
        #expect(r.api.calls.filter { $0 == "bioEnrollChallenge" }.count == 1)
    }

    @Test func noOfferWithoutABiometricInIOS() async {
        let r = Rig(readiness: .noneEnrolled)
        await r.signInWithPassword()
        await r.decided()
        #expect(r.offer.sheet == nil)
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
    }

    @Test func noOfferAfterAMovePasswordOrOnATimeClockStation() async {
        let r = Rig()
        r.vm.view = .move
        r.vm.movePassword = "orange-kayak-42"
        await r.vm.submitMove()
        #expect(r.isAuthed)
        await r.decided()
        #expect(r.offer.sheet == nil)
        #expect(!r.api.calls.contains("bioEnrollChallenge"))

        // A Time Clock station: a person's password sign-in there is never offered it.
        await r.signOut()
        r.prefs.setupSelection = .timeclock(initiativeId: nil, initiativeName: nil, siteId: nil, siteName: nil, siteRole: nil)
        await r.signInWithPassword()
        await r.decided()
        #expect(r.offer.sheet == nil)
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
    }

    @Test func noOfferWhileThePasswordMustChange() async {
        let r = Rig()
        r.api.loginResult = { fakeSession(mustChange: true) }
        await r.signInWithPassword()
        await r.decided()
        #expect(r.offer.sheet == nil)
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
    }

    // ── Turn on's outcomes ──────────────────────────────────────────

    @Test func attestationRefusedSaysThisDeviceCantUseIt() async {
        let r = Rig()
        r.api.bioEnrollResult = { _ in throw ApiError(status: 422, code: "attestation_failed") }
        await r.offered()
        await r.offer.turnOn(r.prompter)
        #expect(r.offer.sheet?.message == BiometricCopy.unsupported(w))
        #expect(r.offer.sheet?.busy == false)
        #expect(r.prefs.biometric == nil)
        #expect(!r.keys.hasKey)
    }

    @Test func aCanceledPromptKeepsTheSheetWithNoMessage() async {
        let r = Rig()
        r.prompter.answer = nil
        await r.offered()
        await r.offer.turnOn(r.prompter)
        #expect(r.prompter.reasons.count == 1)
        #expect(r.offer.sheet == EnrollOfferUI())   // up, not busy, no line
        #expect(r.prefs.biometric == nil)
    }

    @Test func lockoutDuringTurnOnHasItsOwnMessage() async {
        let r = Rig()
        r.prompter.error = BiometricPromptProblem.lockedOut
        await r.offered()
        await r.offer.turnOn(r.prompter)
        #expect(r.offer.sheet == EnrollOfferUI(message: BiometricCopy.lockoutSheet(w)))
        #expect(r.prefs.biometric == nil)
    }

    @Test func anUnavailableSensorDuringTurnOnSaysSo() async {
        let r = Rig()
        r.prompter.error = BiometricPromptProblem.unavailable
        await r.offered()
        await r.offer.turnOn(r.prompter)
        #expect(r.offer.sheet == EnrollOfferUI(message: BiometricCopy.unavailableSheet(w)))
        #expect(r.prefs.biometric == nil)
    }

    @Test func signingOutDuringTurnOnStopsItAndTheSheetStaysClosed() async {
        let r = Rig()
        let hold = HoldGate()
        r.prompter.gate = { await hold.wait() }
        await r.offered()
        let turning = Task { await r.offer.turnOn(r.prompter) }
        #expect(await waitUntil { r.prompter.reasons.count == 1 })   // Face ID is up
        #expect(r.offer.sheet == EnrollOfferUI(busy: true))
        await r.signOut()
        #expect(await waitUntil { r.offer.sheet == nil })
        await hold.open()   // the prompt answers after the sign-out
        await turning.value
        #expect(r.offer.sheet == nil)
        #expect(r.prefs.biometric == nil)
        #expect(!r.api.calls.contains("bioEnroll"))   // stopped, not finished behind the sign-in screen
        #expect(!r.keys.hasKey)
    }
}
