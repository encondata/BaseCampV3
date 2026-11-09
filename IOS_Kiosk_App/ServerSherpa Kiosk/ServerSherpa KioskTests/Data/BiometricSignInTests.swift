import CryptoKit
import Foundation
import LocalAuthentication
import Testing
@testable import ServerSherpa_Kiosk

/// The words the rig's device uses (Face ID is the fake key store's default biometric).
private let w = BiometricWords(bio: "Face ID", device: "iPad")

/// A list a `@Sendable` fake answer can append to.
private final class Recorded<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func append(_ item: T) { lock.withLock { items.append(item) } }
    var all: [T] { lock.withLock { items } }
}

/// A Keychain that can't answer this time (errSecInteractionNotAllowed).
private func keychainBusy() -> Error { NSError(domain: NSOSStatusErrorDomain, code: -25308) }

/// A 200 whose body didn't decode.
private func undecodable() -> Error {
    DecodingError.dataCorrupted(DecodingError.Context(codingPath: [], debugDescription: "bad body"))
}

/// The `/kiosk/biometric/challenge` answer for the rig's enrollment.
private func bioCard(keyId: String = "key-1", challenge: String = "chal.lenge.1", expired: Bool = false) -> BiometricChallengeOut {
    BiometricChallengeOut(keyId: keyId, challenge: challenge, displayName: "Ada Lovelace", photoUrl: "https://photos/p1.jpg", expired: expired)
}

/// Whether `signature` (base64 DER) is `key`'s ECDSA SHA-256 signature over `message`'s UTF-8 bytes.
private func verifies(_ signature: String?, _ message: String, _ key: P256.Signing.PublicKey?) -> Bool {
    guard let key, let signature, let der = Data(base64Encoded: signature),
          let parsed = try? P256.Signing.ECDSASignature(derRepresentation: der) else { return false }
    return key.isValidSignature(parsed, for: Data(message.utf8))
}

/// Android `BiometricSignInTest`, ported: who is offered, Turn on, the card, sign-in and Forget.
@MainActor @Suite(.timeLimit(.minutes(1)))
struct BiometricSignInTests {
    @MainActor private final class Rig {
        let api = FakeKioskApi()
        let keys = FakeBiometricKeys()
        let prefs = KioskPrefs(defaults: freshDefaults())
        let refresher = FakeRefresher()
        let prompt = FakeBiometricPrompter()
        let identity: Identity
        let auth: KioskAuth
        /// The container's shared-station rule: a Time Clock (or any) station type, or a station key.
        var shared = false
        /// What the default sign-in answer was sent.
        let signIns = Recorded<(keyId: String, challenge: String, signature: String)>()
        private(set) var bio: BiometricSignIn!
        private var mark = 0

        init() {
            identity = Identity(prefs: prefs, secrets: MemorySecretStore())
            auth = KioskAuth(api: api, refresher: refresher, identity: identity, prefs: prefs)
            api.loginResult = { fakeSession() }
            api.moveLoginResult = { _ in fakeSession(kioskMove: KioskMove(initiativeId: "m1", name: "Move")) }
            api.bioEnrollChallengeResult = { _ in "nonce-1" }
            api.bioEnrollResult = { _ in BiometricEnrollOut(keyId: "key-1", securityLevel: "secure_enclave", renewsAt: "2026-12-09T00:00:00Z") }
            let signIns = signIns
            api.bioSignInResult = { keyId, challenge, signature in
                signIns.append((keyId, challenge, signature))
                return fakeSession()
            }
            bio = BiometricSignIn(
                api: api, auth: auth, keys: keys, prefs: prefs, identity: identity,
                sharedStation: { [unowned self] in self.shared },
                words: { kind in
                    switch kind {
                    case .faceID: BiometricWords(bio: "Face ID", device: "iPad")
                    case .touchID: BiometricWords(bio: "Touch ID", device: "iPad")
                    case nil: BiometricWords(bio: "no biometric", device: "iPad")
                    }
                }
            )
        }

        var serial: String { identity.current.serial }

        /// The calls since `enrolledAndSignedOut()`.
        var calls: [String] { Array(api.calls.dropFirst(mark)) }

        /// A password sign-in and an enrollment, then signed out, as the next launch finds it.
        func enrolledAndSignedOut() async throws {
            try await auth.login(email: "tina@example.com", password: "pw")
            #expect(await bio.enroll(FakeBiometricPrompter()) == .enrolled)
            await auth.logout()
            // Sign-out tells the portal in the background: let those calls land first.
            #expect(await waitUntil { self.api.calls.contains("logout") })
            mark = api.calls.count
        }
    }

    // ── enroll ──────────────────────────────────────────────────────

    @Test func enrollSendsTheIosBodyAndStoresTheKeyId() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.offerEnroll())
        #expect(await r.bio.enroll(r.prompt) == .enrolled)
        #expect(r.keys.created == ["nonce-1"])
        #expect(r.api.bioEnrollBodies.count == 1)
        let body = try #require(r.api.bioEnrollBodies.first)
        let proof = try #require(r.keys.proof)
        #expect(body.serial == r.serial)
        #expect(body.nonce == "nonce-1")
        #expect(body.platform == "ios")
        #expect(body.publicKey == proof.publicKey.base64EncodedString())
        #expect(body.appAttestKeyId == proof.appAttestKeyId)
        #expect(body.attestation == proof.attestation.base64EncodedString())
        #expect(proof.publicKey == r.keys.publicKey?.x963Representation)
        #expect(verifies(body.signature, "nonce-1", r.keys.publicKey))
        let enrolled = BiometricEnrollment(keyId: "key-1", personId: "p1", email: "tina@example.com")
        #expect(r.prefs.biometric == enrolled)
        #expect(r.bio.enrollment == enrolled)
        #expect(r.keys.hasKey)
    }

    @Test func enrollTakesAFreshNonceAndProvesTheKeyBehindThePrompt() async throws {
        let r = Rig()
        let asked = Recorded<String>()
        r.api.bioEnrollChallengeResult = { serial in
            asked.append(serial)
            return "nonce-\(asked.all.count)"
        }
        // At the prompt: the key is made and nothing is sent yet.
        let atPrompt = Recorded<String>()
        let (keys, api) = (r.keys, r.api)
        r.prompt.gate = { atPrompt.append("\(keys.created.count) key, \(api.bioEnrollBodies.count) sent") }
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.offerEnroll())
        #expect(await r.bio.enroll(r.prompt) == .enrolled)
        #expect(r.api.calls == ["login", "bioEnrollChallenge", "bioEnrollChallenge", "bioEnroll"])
        #expect(r.prompt.reasons == [BiometricCopy.enrollReason(w)])
        #expect(atPrompt.all == ["1 key, 0 sent"])
        // The key is attested to enroll's own nonce, not the offer's, and the proof signs that one.
        #expect(asked.all == [r.serial, r.serial])
        #expect(r.keys.created == ["nonce-2"])
        #expect(r.api.bioEnrollBodies.first?.nonce == "nonce-2")
        #expect(verifies(r.api.bioEnrollBodies.first?.signature, "nonce-2", r.keys.publicKey))
    }

    @Test func canceledEnrollPromptLeavesNoKey() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.prompt.answer = nil
        #expect(await r.bio.enroll(r.prompt) == .canceled)
        #expect(r.keys.deleted > 0)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        #expect(r.api.bioEnrollBodies.isEmpty)
    }

    @Test func attestationRefusedIsUnsupportedAndLeavesNoKey() async throws {
        for (status, code) in [(422, "attestation_failed"), (403, "not_personal_device")] {
            let r = Rig()
            try await r.auth.login(email: "tina@example.com", password: "pw")
            r.api.bioEnrollResult = { _ in throw ApiError(status: status, code: code) }
            #expect(await r.bio.enroll(r.prompt) == .unsupported, "\(code)")
            #expect(r.api.bioEnrollBodies.count == 1, "\(code)")
            #expect(r.keys.deleted > 0, "\(code)")
            #expect(!r.keys.hasKey, "\(code)")
            #expect(r.prefs.biometric == nil, "\(code)")
        }
        // Refused at the enroll-challenge, before any key is made.
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.api.bioEnrollChallengeResult = { _ in throw ApiError(status: 403, code: "not_personal_device") }
        #expect(await r.bio.enroll(r.prompt) == .unsupported)
        #expect(r.keys.created.isEmpty && r.prompt.reasons.isEmpty)
        #expect(r.prefs.biometric == nil)
    }

    @Test func enrollOtherFailuresAreFailedWithAMessage() async throws {
        let cases: [(Error, String)] = [
            (ApiError(status: 403, code: "enroll_window_closed"), BiometricCopy.enrollWindow(w)),
            // The nonce ran out (a prompt left open past 5 minutes) or was spent.
            (ApiError(status: 422, code: "bad_enroll_nonce"), BiometricCopy.enrollRetry(w)),
            (ApiError.network(), BiometricCopy.network(w)),
            (ApiError(status: 503, code: "read_only_mode"), BiometricCopy.enrollFailed(w)),
            (ApiError(status: 200, code: "unknown_error"), BiometricCopy.enrollFailed(w)),
            (undecodable(), BiometricCopy.enrollFailed(w)),
        ]
        for (error, message) in cases {
            let r = Rig()
            try await r.auth.login(email: "tina@example.com", password: "pw")
            r.api.bioEnrollResult = { _ in throw error }
            #expect(await r.bio.enroll(r.prompt) == .failed(message), "\(error)")
            #expect(!r.keys.hasKey, "\(error)")
            #expect(r.keys.deleted > 0, "\(error)")
            #expect(r.prefs.biometric == nil, "\(error)")
        }
        // The enroll-challenge's refusals read the same.
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.api.bioEnrollChallengeResult = { _ in throw ApiError(status: 403, code: "enroll_window_closed") }
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.enrollWindow(w)))
        r.api.bioEnrollChallengeResult = { _ in throw ApiError.network() }
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.network(w)))
        #expect(r.keys.created.isEmpty && r.prompt.reasons.isEmpty)
    }

    @Test func enrollWhereTheKeyStoreFailsIsUnsupported() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.keys.createError = keychainBusy()
        #expect(await r.bio.enroll(r.prompt) == .unsupported)
        #expect(r.prompt.reasons.isEmpty)
        #expect(r.api.bioEnrollBodies.isEmpty)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        // The Secure Enclave failing the proof signature behind the prompt: the same, and no key.
        r.keys.createError = nil
        r.keys.signError = keychainBusy()
        #expect(await r.bio.enroll(r.prompt) == .unsupported)
        #expect(r.prompt.reasons.count == 1)
        #expect(r.api.bioEnrollBodies.isEmpty)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    // ── who is offered ──────────────────────────────────────────────

    @Test func moveOrPairSignInNeverOffers() async throws {
        let r = Rig()
        try await r.auth.moveLogin(password: "orange-kayak-42")
        #expect(!(await r.bio.offerEnroll()))
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.enrollWindow(w)))
        // Even a session that came back move-locked from a password sign-in.
        r.api.loginResult = { fakeSession(kioskMove: KioskMove(initiativeId: "m1", name: "Move")) }
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(!(await r.bio.offerEnroll()))
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.enrollWindow(w)))
        // A link (pair) sign-in.
        await r.auth.completePair(fakeSession())
        #expect(!(await r.bio.offerEnroll()))
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.enrollWindow(w)))
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
        #expect(r.prompt.reasons.isEmpty)
        #expect(r.keys.created.isEmpty)
    }

    @Test func onlyAFreshPasswordSignInIsOffered() async throws {
        let r = Rig()
        await r.auth.completePair(fakeSession())
        #expect(!(await r.bio.offerEnroll()))
        r.refresher.refreshResult = { fakeSession() }
        await r.auth.restore()
        #expect(!(await r.bio.offerEnroll()))
        r.auth.signInWithBiometric(fakeSession())
        #expect(!(await r.bio.offerEnroll()))
        await r.auth.logout()
        #expect(!(await r.bio.offerEnroll()))
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.offerEnroll())
    }

    @Test func timeClockAndStationKeyDevicesNeverOfferOrShowTheCard() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.shared = true
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(!(await r.bio.offerEnroll()))
        #expect(await r.bio.enroll(r.prompt) == .unsupported)
        await r.auth.logout()
        #expect(await r.bio.card() == nil)
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .notAllowed(BiometricCopy.removed(w), .removed))
        #expect(r.prompt.reasons.isEmpty)
        #expect(!r.calls.contains { $0.hasPrefix("bio") })
        // The station rule hides the key; it doesn't forget it.
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        r.shared = false
        #expect(await r.bio.card() != nil)
    }

    @Test func offerNeedsABiometricReady() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        for no in [BiometricReadiness.noPasscode, .noneEnrolled, .unsupported] {
            r.keys.readinessValue = no
            #expect(!(await r.bio.offerEnroll()), "\(no)")
        }
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
        r.keys.readinessValue = .ready(.touchID)
        #expect(await r.bio.offerEnroll())
    }

    @Test func offerAsksTheServerWhetherThisDeviceIsPersonal() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.api.bioEnrollChallengeResult = { _ in throw ApiError(status: 403, code: "not_personal_device") }
        #expect(!(await r.bio.offerEnroll()))
        r.api.bioEnrollChallengeResult = { _ in throw ApiError(status: 403, code: "enroll_window_closed") }
        #expect(!(await r.bio.offerEnroll()))
        r.api.bioEnrollChallengeResult = { _ in throw ApiError.network() }
        #expect(!(await r.bio.offerEnroll()))
        r.api.bioEnrollChallengeResult = { _ in "nonce-2" }
        #expect(await r.bio.offerEnroll())
        #expect(r.api.calls.filter { $0 == "bioEnrollChallenge" }.count == 4)
        #expect(r.keys.created.isEmpty)   // asking makes no key
    }

    @Test func aLiveKeyIsNotOfferedAgainButADeadOneIs() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(!(await r.bio.offerEnroll()))   // the password sign-in renews it
        #expect(r.keys.hasKey)
        r.api.bioChallengeResult = { _ in throw ApiError.network() }   // offline: ask another time
        #expect(!(await r.bio.offerEnroll()))
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        #expect(!r.calls.contains("bioEnrollChallenge"))
        r.api.bioChallengeResult = { _ in throw ApiError(status: 404, code: "no_biometric") }   // revoked (a password reset)
        #expect(await r.bio.offerEnroll())
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        // The server holding another key for this device: this one is dead too.
        #expect(await r.bio.enroll(r.prompt) == .enrolled)
        r.api.bioChallengeResult = { _ in bioCard(keyId: "key-other") }
        #expect(await r.bio.offerEnroll())
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    @Test func anotherPersonsPasswordSignInLeavesTheOwnersKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.loginResult = {
            var s = fakeSession()
            s.person = PersonOut(id: "p2", firstName: "Sam", lastName: "S", displayName: "Sam S")
            return s
        }
        r.api.bioEnrollChallengeResult = { _ in throw ApiError(status: 403, code: "not_personal_device") }
        try await r.auth.login(email: "sam@example.com", password: "pw")
        #expect(!(await r.bio.offerEnroll()))
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric?.personId == "p1")
        #expect(!r.calls.contains("bioChallenge"))   // the owner's key is not looked at
    }

    @Test func noOfferWhileThePasswordMustChange() async throws {
        let r = Rig()
        r.api.loginResult = { fakeSession(mustChange: true) }
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(!(await r.bio.offerEnroll()))
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.enrollWindow(w)))
        #expect(!r.api.calls.contains("bioEnrollChallenge"))
        #expect(r.keys.created.isEmpty)
    }

    // ── the card ────────────────────────────────────────────────────

    @Test func cardNilWithoutLocalKey() async {
        let r = Rig()
        r.api.bioChallengeResult = { _ in bioCard() }
        #expect(await r.bio.card() == nil)
        #expect(r.api.calls.isEmpty)
    }

    @Test func cardCarriesTheServersNameAndTheLocalEmail() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard(expired: true) }
        #expect(await r.bio.card() == BiometricCard(
            keyId: "key-1", challenge: "chal.lenge.1", displayName: "Ada Lovelace",
            photoUrl: "https://photos/p1.jpg", expired: true, email: "tina@example.com"
        ))
        #expect(r.calls == ["bioChallenge"])
    }

    @Test func cardGoneOnTheServerForgetsTheLocalKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in throw ApiError(status: 404, code: "no_biometric") }
        #expect(await r.bio.card() == nil)
        #expect(r.keys.deleted > 0)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    @Test func cardForAnotherKeyForgetsTheLocalKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard(keyId: "key-other") }
        #expect(await r.bio.card() == nil)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    @Test func cardOfflineOrThrottledKeepsTheKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        let errors: [Error] = [ApiError.network(), ApiError(status: 429, code: "biometric_rate_limited"),
                               ApiError(status: 200, code: "unknown_error"), undecodable()]
        for error in errors {
            r.api.bioChallengeResult = { _ in throw error }
            #expect(await r.bio.card() == nil, "\(error)")
            #expect(r.keys.hasKey, "\(error)")
            #expect(r.prefs.biometric != nil, "\(error)")
        }
        #expect(r.calls == ["bioChallenge", "bioChallenge", "bioChallenge", "bioChallenge"])
    }

    @Test func invalidatedKeyHasNoCard() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.keys.invalidated = true
        #expect(await r.bio.card() == nil)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        #expect(!r.calls.contains("bioChallenge"))
    }

    // ── sign in ─────────────────────────────────────────────────────

    @Test func signInSignsTheChallengeBytes() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard(challenge: "chal.lenge.1") }
        let session = fakeSession(roles: ["worker", "x"])
        let signIns = r.signIns
        r.api.bioSignInResult = { keyId, challenge, signature in
            signIns.append((keyId, challenge, signature))
            return session
        }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .signedIn)
        #expect(signIns.all.count == 1)
        let sent = try #require(signIns.all.first)
        #expect(sent.keyId == "key-1")
        #expect(sent.challenge == "chal.lenge.1")
        #expect(verifies(sent.signature, "chal.lenge.1", r.keys.publicKey))
        #expect(r.auth.state == .authed(session))
        #expect(r.auth.currentSignIn == CurrentSignIn(method: .biometric, email: nil))
        #expect(r.auth.takePendingSignIn() == .biometric)
    }

    @Test func thePromptComesBeforeTheChallenge() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let hold = HoldGate()
        r.prompt.gate = { await hold.wait() }
        let signIn = Task { await r.bio.signIn(r.prompt, name: "Ada Lovelace") }
        #expect(await waitUntil { r.prompt.reasons.count == 1 })
        #expect(r.calls.isEmpty)   // the prompt is up and no challenge is spent
        await hold.open()
        #expect(await signIn.value == .signedIn)
        #expect(r.calls == ["bioChallenge", "bioSignIn"])
        #expect(r.prompt.reasons == ["Sign in as Ada Lovelace"])
    }

    @Test func eachSignInFetchesItsOwnChallenge() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        let served = Recorded<String>()
        r.api.bioChallengeResult = { serial in
            served.append(serial)
            return bioCard(challenge: "c\(served.all.count)")
        }
        let signIns = r.signIns
        r.api.bioSignInResult = { keyId, challenge, signature in
            signIns.append((keyId, challenge, signature))
            throw ApiError(status: 401, code: "bad_challenge")
        }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.tryAgain(w)))
        r.api.bioSignInResult = { keyId, challenge, signature in
            signIns.append((keyId, challenge, signature))
            return fakeSession()
        }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .signedIn)
        #expect(served.all == [r.serial, r.serial])
        #expect(signIns.all.map(\.challenge) == ["c1", "c2"])
        #expect(verifies(signIns.all.last?.signature, "c2", r.keys.publicKey))
    }

    @Test func expiredMapsToExpired() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        // Already past the 30 days: the card says so (the UI skips the prompt), and a sign-in
        // whose challenge says so ends Expired without sending anything.
        r.api.bioChallengeResult = { _ in bioCard(expired: true) }
        #expect(await r.bio.card()?.expired == true)
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .expired)
        #expect(!r.calls.contains("bioSignIn"))
        // Crossed the line while the card was up.
        r.api.bioChallengeResult = { _ in bioCard() }
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "biometric_expired") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .expired)
        #expect(r.keys.hasKey)   // the next password sign-in renews it
        #expect(r.prefs.biometric != nil)
        #expect(r.auth.state == .anon)
    }

    @Test func passwordChangeMapsToPasswordChange() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "password_change_required") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .passwordChange)
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
    }

    @Test func notAllowedMaps() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "kiosk_not_allowed") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .notAllowed(BiometricCopy.kioskNotAllowed(w), .kioskNotAllowed))
        #expect(r.keys.hasKey)   // access can come back
        #expect(r.prefs.biometric != nil)
    }

    @Test func aDisabledAccountForgetsLocallySoTheCardStopsComingBack() async throws {
        // An archived person's device otherwise looped: card, account_disabled, card.
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 403, code: "account_disabled") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .notAllowed(BiometricCopy.accountDisabled(w), .accountDisabled))
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        #expect(await r.bio.card() == nil)
    }

    @Test func reassignedOrRevokedForgetsLocallyAndFallsBack() async throws {
        for (status, code) in [(403, "not_personal_device"), (404, "no_biometric")] {
            let r = Rig()
            try await r.enrolledAndSignedOut()
            r.api.bioChallengeResult = { _ in bioCard() }
            r.api.bioSignInResult = { _, _, _ in throw ApiError(status: status, code: code) }
            #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .notAllowed(BiometricCopy.removed(w), .removed), "\(code)")
            #expect(!r.keys.hasKey, "\(code)")
            #expect(r.prefs.biometric == nil, "\(code)")
            #expect(await r.bio.card() == nil, "\(code)")
        }
        // Gone at the challenge: nothing is signed or sent.
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in throw ApiError(status: 404, code: "no_biometric") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .notAllowed(BiometricCopy.removed(w), .removed))
        #expect(!r.calls.contains("bioSignIn"))
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        // The challenge naming another key for this device.
        let other = Rig()
        try await other.enrolledAndSignedOut()
        other.api.bioChallengeResult = { _ in bioCard(keyId: "key-other") }
        #expect(await other.bio.signIn(other.prompt, name: "Ada Lovelace") == .notAllowed(BiometricCopy.removed(w), .removed))
        #expect(!other.calls.contains("bioSignIn"))
        #expect(!other.keys.hasKey)
        #expect(other.prefs.biometric == nil)
    }

    @Test func invalidatedKeyIsDeletedLocallyAndFallsBack() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.keys.invalidated = true   // Face ID was re-enrolled
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .invalidated)
        #expect(r.prompt.reasons.isEmpty)
        #expect(r.calls.isEmpty)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        // No loop: the card is gone, and a second try says the same.
        #expect(await r.bio.card() == nil)
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .invalidated)
        #expect(r.calls.isEmpty)
        // The next password sign-in offers enrollment again.
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.offerEnroll())
    }

    /// iOS checks the biometric set again when signing: a face or finger added while the prompt
    /// was up makes `sign` throw `.gone`, the same verdict as a `.gone` probe.
    @Test func aKeyInvalidatedBehindThePromptIsDeletedLocallyAndFallsBack() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let keys = r.keys
        r.prompt.gate = { keys.invalidated = true }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .invalidated)
        #expect(!r.calls.contains("bioSignIn"))
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
        #expect(await r.bio.card() == nil)
    }

    @Test func canceledPromptStaysOnCard() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.prompt.answer = nil
        #expect(await r.bio.signIn(r.prompt, name: nil) == .canceled)
        #expect(await r.bio.signIn(r.prompt, name: " \n") == .canceled)
        #expect(r.prompt.reasons == [BiometricCopy.signInReasonFallback(w), BiometricCopy.signInReasonFallback(w)])
        #expect(r.calls.isEmpty)   // a canceled prompt spends no challenge
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        #expect(await r.bio.card() != nil)
        r.prompt.answer = BiometricAuth(context: LAContext())
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .signedIn)
    }

    @Test func rateLimitedIsFailedWithAFriendlyMessage() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 429, code: "biometric_rate_limited") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.rateLimited(w)))
        r.api.bioChallengeResult = { _ in throw ApiError(status: 429, code: "biometric_rate_limited") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.rateLimited(w)))
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
    }

    @Test func aSpentChallengeOrBadSignatureIsFailedAndKeepsTheKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let cases: [(ApiError, String)] = [
            (ApiError(status: 401, code: "bad_challenge"), BiometricCopy.tryAgain(w)),
            (ApiError(status: 401, code: "bad_signature"), BiometricCopy.tryAgain(w)),
            (ApiError(status: 500, code: "unknown_error"), BiometricCopy.tryAgain(w)),
            (ApiError.network(), BiometricCopy.network(w)),
        ]
        for (error, message) in cases {
            r.api.bioSignInResult = { _, _, _ in throw error }
            #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(message), "\(error.code)")
        }
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        #expect(r.auth.state == .anon)
    }

    // ── forget ──────────────────────────────────────────────────────

    @Test func forgetSignedOutDeletesLocallyOnly() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        #expect(await r.bio.forget(signedIn: false))
        #expect(r.calls.isEmpty)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    @Test func forgetSignedInCallsServer() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.enroll(r.prompt) == .enrolled)
        let keys = r.keys
        let atServer = Recorded<(serial: String, hasKey: Bool)>()
        r.api.bioForgetResult = { serial in atServer.append((serial, keys.hasKey)) }
        #expect(await r.bio.forget(signedIn: true))
        #expect(r.api.calls.last == "bioForget")
        #expect(atServer.all.count == 1)
        #expect(atServer.all.first?.serial == r.serial)
        #expect(atServer.all.first?.hasKey == true)   // the server first, then the device
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    @Test func forgetSignedInOfflineStillForgetsOnTheDevice() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.enroll(r.prompt) == .enrolled)
        r.api.bioForgetResult = { _ in throw ApiError.network() }
        #expect(!(await r.bio.forget(signedIn: true)))
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    /// Forget waits for a running Turn on instead of deleting the key it is proving.
    @Test func forgetWaitsForARunningEnroll() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        let hold = HoldGate()
        r.prompt.gate = { await hold.wait() }
        let enroll = Task { await r.bio.enroll(r.prompt) }
        #expect(await waitUntil { r.prompt.reasons.count == 1 })
        let forget = Task { await r.bio.forget(signedIn: true) }
        // The forget task runs on the main actor ahead of the test's next turn.
        await Task.yield()
        await Task.yield()
        #expect(!r.api.calls.contains("bioForget"))
        #expect(r.keys.hasKey)
        await hold.open()
        #expect(await enroll.value == .enrolled)
        #expect(await forget.value)
        let calls = r.api.calls
        let enrolled = try #require(calls.firstIndex(of: "bioEnroll"))
        let forgot = try #require(calls.firstIndex(of: "bioForget"))
        #expect(enrolled < forgot)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    // ── a key store, prompt or task that fails ──────────────────────

    @Test func aThrowingKeyStoreIsUnusableThisTimeAndKeepsTheKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let deleted = r.keys.deleted
        r.keys.probeUnavailable = true
        #expect(await r.bio.card() == nil)
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.tryAgain(w)))
        #expect(r.prompt.reasons.isEmpty)
        #expect(r.calls.isEmpty)
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        // Signing that fails behind the prompt (the Keychain, not the key) is the same.
        r.keys.probeUnavailable = false
        r.keys.signError = keychainBusy()
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.tryAgain(w)))
        #expect(!r.calls.contains("bioSignIn"))
        #expect(r.keys.deleted == deleted)
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        // Next time it answers, the card and the sign-in are back.
        r.keys.signError = nil
        #expect(await r.bio.card() != nil)
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .signedIn)
    }

    @Test func aThrowingKeyStoreNeverOffers() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        try await r.auth.login(email: "tina@example.com", password: "pw")
        r.keys.probeUnavailable = true
        #expect(!(await r.bio.offerEnroll()))   // this person's key may still be live
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        #expect(!r.calls.contains { $0.hasPrefix("bio") })
    }

    @Test func aSecondEnrollWhileOneRunsIsCanceled() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        let hold = HoldGate()
        r.api.bioEnrollChallengeResult = { _ in
            await hold.wait()
            return "nonce-1"
        }
        let first = Task { await r.bio.enroll(r.prompt) }
        #expect(await waitUntil { r.api.calls.contains("bioEnrollChallenge") })
        let other = FakeBiometricPrompter()
        #expect(await r.bio.enroll(other) == .canceled)
        #expect(await r.bio.signIn(other, name: "Ada Lovelace") == .canceled)
        #expect(other.reasons.isEmpty)
        await hold.open()
        #expect(await first.value == .enrolled)
        #expect(r.api.calls.filter { $0 == "bioEnrollChallenge" }.count == 1)
        #expect(r.keys.created.count == 1)
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric?.keyId == "key-1")
        #expect(await r.bio.enroll(r.prompt) == .enrolled)   // free again once it ends
    }

    @Test func aSecondSignInWhileThePromptIsUpIsCanceled() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let hold = HoldGate()
        r.prompt.gate = { await hold.wait() }
        let first = Task { await r.bio.signIn(r.prompt, name: "Ada Lovelace") }
        #expect(await waitUntil { r.prompt.reasons.count == 1 })
        let other = FakeBiometricPrompter()
        #expect(await r.bio.signIn(other, name: "Ada Lovelace") == .canceled)
        #expect(await r.bio.enroll(other) == .canceled)
        #expect(other.reasons.isEmpty)
        await hold.open()
        #expect(await first.value == .signedIn)
        #expect(r.calls.filter { $0 == "bioSignIn" }.count == 1)
        #expect(r.keys.hasKey)
    }

    /// The sheet closing (a sign-out) while Turn on's prompt is up cancels it: even a prompt that
    /// then succeeds stores nothing and leaves no key.
    @Test func aCanceledTurnOnLeavesNoKey() async throws {
        let r = Rig()
        try await r.auth.login(email: "tina@example.com", password: "pw")
        let hold = HoldGate()
        r.prompt.gate = { await hold.wait() }
        let enroll = Task { await r.bio.enroll(r.prompt) }
        #expect(await waitUntil { r.prompt.reasons.count == 1 })
        enroll.cancel()
        await hold.open()
        #expect(await enroll.value == .canceled)
        #expect(r.api.bioEnrollBodies.isEmpty)
        #expect(!r.keys.hasKey)
        #expect(r.prefs.biometric == nil)
    }

    /// The login screen going away while the prompt is up: no challenge is spent, no session taken.
    @Test func aCanceledSignInSpendsNoChallenge() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let hold = HoldGate()
        r.prompt.gate = { await hold.wait() }
        let signIn = Task { await r.bio.signIn(r.prompt, name: "Ada Lovelace") }
        #expect(await waitUntil { r.prompt.reasons.count == 1 })
        signIn.cancel()
        await hold.open()
        #expect(await signIn.value == .canceled)
        #expect(r.calls.isEmpty)
        #expect(r.auth.state == .anon)
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
    }

    @Test func anUndecodableAnswerIsSomethingWentWrongNotTheNetwork() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        // What the transport throws for a 2xx body that didn't decode (a captive portal's HTML).
        r.api.bioSignInResult = { _, _, _ in throw ApiError(status: 200, code: "unknown_error") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.somethingWrong(w)))
        r.api.bioSignInResult = { _, _, _ in throw ApiError.network() }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.network(w)))
        r.api.bioChallengeResult = { _ in throw ApiError(status: 200, code: "unknown_error") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.somethingWrong(w)))
        // Any error that isn't the API's reads the same.
        r.api.bioChallengeResult = { _ in throw undecodable() }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.somethingWrong(w)))
        // A non-2xx unknown_error is the server's own refusal: try again.
        r.api.bioChallengeResult = { _ in throw ApiError(status: 500, code: "unknown_error") }
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.tryAgain(w)))
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
    }

    /// A card or offer `/challenge` answer that comes back after the person turned it on again
    /// is about the old key: it never forgets the new one.
    @Test func aLateChallengeAnswerNeverForgetsANewerKey() async throws {
        let renewed: @Sendable (BiometricIosEnrollIn) async throws -> BiometricEnrollOut = { _ in
            BiometricEnrollOut(keyId: "key-2", securityLevel: "secure_enclave", renewsAt: "2026-12-09T00:00:00Z")
        }
        // The card, signed out.
        let r = Rig()
        try await r.enrolledAndSignedOut()
        let hold = HoldGate()
        r.api.bioChallengeResult = { _ in
            await hold.wait()
            throw ApiError(status: 404, code: "no_biometric")
        }
        let card = Task { await r.bio.card() }
        #expect(await waitUntil { r.calls.contains("bioChallenge") })
        r.api.bioEnrollResult = renewed
        try await r.auth.login(email: "tina@example.com", password: "pw")
        #expect(await r.bio.enroll(r.prompt) == .enrolled)
        let deleted = r.keys.deleted
        await hold.open()
        #expect(await card.value == nil)
        #expect(r.prefs.biometric?.keyId == "key-2")
        #expect(r.keys.hasKey)
        #expect(r.keys.deleted == deleted)
        // The offer, after a password sign-in.
        let o = Rig()
        try await o.enrolledAndSignedOut()
        let held = HoldGate()
        o.api.bioChallengeResult = { _ in
            await held.wait()
            throw ApiError(status: 404, code: "no_biometric")
        }
        try await o.auth.login(email: "tina@example.com", password: "pw")
        let offer = Task { await o.bio.offerEnroll() }
        #expect(await waitUntil { o.calls.contains("bioChallenge") })
        o.api.bioEnrollResult = renewed
        #expect(await o.bio.enroll(o.prompt) == .enrolled)
        let dropped = o.keys.deleted
        await held.open()
        #expect(await offer.value == false)
        #expect(o.prefs.biometric?.keyId == "key-2")
        #expect(o.keys.hasKey)
        #expect(o.keys.deleted == dropped)
    }

    @Test func aThrowingPromptIsTryAgainAndKeepsTheKey() async throws {
        let r = Rig()
        try await r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { _ in bioCard() }
        let deleted = r.keys.deleted
        r.prompt.error = NSError(domain: "test.prompt", code: 1)
        #expect(await r.bio.signIn(r.prompt, name: "Ada Lovelace") == .failed(BiometricCopy.tryAgain(w)))
        #expect(r.calls.isEmpty)
        #expect(r.keys.deleted == deleted)
        #expect(r.keys.hasKey)
        #expect(r.prefs.biometric != nil)
        // During Turn on, a throwing prompt fails the enroll and leaves no key.
        let fresh = Rig()
        try await fresh.auth.login(email: "tina@example.com", password: "pw")
        fresh.prompt.error = NSError(domain: "test.prompt", code: 1)
        #expect(await fresh.bio.enroll(fresh.prompt) == .failed(BiometricCopy.enrollFailed(w)))
        #expect(fresh.api.bioEnrollBodies.isEmpty)
        #expect(fresh.keys.deleted > 0)
        #expect(!fresh.keys.hasKey)
        #expect(fresh.prefs.biometric == nil)
    }

    // ── the words ───────────────────────────────────────────────────

    @Test func theWordsFollowTheReadyBiometric() async {
        let r = Rig()
        #expect(r.bio.words == BiometricWords(bio: "Face ID", device: "iPad"))
        r.keys.readinessValue = .ready(.touchID)
        let touch = BiometricWords(bio: "Touch ID", device: "iPad")
        #expect(r.bio.words == touch)
        #expect(await r.bio.enroll(r.prompt) == .failed(BiometricCopy.enrollWindow(touch)))   // signed out
        r.keys.readinessValue = .noneEnrolled
        #expect(r.bio.words == BiometricWords(bio: "no biometric", device: "iPad"))
    }

    /// Locked out, a Touch ID iPad is not ready, but its words (and the card's symbol) stay
    /// Touch ID: the kind comes from the hardware, not a guess.
    @Test func aLockedOutDeviceKeepsItsBiometricsWords() {
        let r = Rig()
        r.keys.readinessValue = .unsupported   // biometryLockout
        r.keys.hardwareKind = .touchID
        #expect(r.bio.kind == .touchID)
        #expect(r.bio.words == BiometricWords(bio: "Touch ID", device: "iPad"))
        r.keys.hardwareKind = nil
        #expect(r.bio.kind == nil)
        #expect(r.bio.words == BiometricWords(bio: "no biometric", device: "iPad"))
    }
}
