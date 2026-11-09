import Foundation
import Observation

/// The "Sign in as …" card. `email` is the one saved on this device at enrollment (the server
/// never sends one), for the expired state's pre-filled password form.
struct BiometricCard: Equatable, Sendable {
    let keyId: String
    let challenge: String
    let displayName: String
    let photoUrl: String?
    let expired: Bool
    let email: String?
}

/// Why a biometric sign-in was refused. Only `removed` means the device is no longer this person's.
enum NotAllowedReason: Equatable, Sendable {
    case removed, kioskNotAllowed, accountDisabled
}

/// How a biometric sign-in ended.
enum BiometricOutcome: Equatable, Sendable {
    /// KioskAuth is authed with the new session.
    case signedIn
    /// Past the 30 days: the password form, pre-filled, with the expired line. The key stays.
    case expired
    /// "Your password needs changing in the portal." The key stays.
    case passwordChange
    /// The password form with the message, for the reason: the device is no longer this person's
    /// (reassigned, revoked, now a shared station; the key is already forgotten here unless it is
    /// a station), no kiosk access (the key stays), or a disabled account (forgotten here).
    case notAllowed(String, NotAllowedReason)
    /// iOS invalidated the key (a face or finger added, the passcode removed), or there is none:
    /// forgotten on the device; the password form, and the next password sign-in offers again.
    case invalidated
    /// The person canceled the prompt, another sign-in or Turn on is running, or the task was
    /// canceled: stay on the card.
    case canceled
    /// Nothing changed; stay on the card with the message (fetch a fresh card before retrying).
    case failed(String)
}

/// How Turn on ended. Every outcome but `enrolled` leaves no key from this Turn on behind; one
/// that got its nonce has also replaced (dropped) any old key.
enum EnrollOutcome: Equatable, Sendable {
    case enrolled
    case canceled
    /// `BiometricCopy.unsupported`: attestation refused, not this person's device, a shared
    /// station, or the Secure Enclave couldn't make or use the key.
    case unsupported
    case failed(String)
}

/// Biometric sign-in on a personal iPad or iPhone (Android `BiometricSignIn`): who is offered
/// enrollment, Turn on, the card, sign-in and Forget. The key is `keys`; the server's key id, the
/// person and the email are in `KioskPrefs.biometric`.
///
/// A key this device can no longer use (iOS invalidated it, or the server no longer has it for
/// this device) is forgotten on the device only: the server row is useless without the private
/// key. A Keychain or Secure Enclave call that fails is "unusable this time", never a reason to
/// forget a key: only a `.gone` probe or `BiometricKeyError.gone` from `sign` is.
///
/// Single flight: one `enroll` or `signIn` at a time (they share the one key). A second call
/// while one runs returns `.canceled` at once; `forget` waits for the running one.
@MainActor @Observable
final class BiometricSignIn {
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let auth: KioskAuth
    @ObservationIgnored private let keys: BiometricKeys
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let identity: Identity
    /// Whether this is a shared station: a Time Clock (or any) station type, or a station key.
    @ObservationIgnored private let sharedStation: @MainActor () -> Bool
    @ObservationIgnored private let wordsFor: @MainActor (BiometryKind?) -> BiometricWords
    @ObservationIgnored private var busy = false
    /// The `forget` calls waiting for the running enroll or sign-in, in order.
    @ObservationIgnored private var waiting: [CheckedContinuation<Void, Never>] = []

    init(api: KioskApi, auth: KioskAuth, keys: BiometricKeys, prefs: KioskPrefs, identity: Identity,
         sharedStation: @escaping @MainActor () -> Bool,
         words: @escaping @MainActor (BiometryKind?) -> BiometricWords = currentBiometricWords) {
        self.api = api
        self.auth = auth
        self.keys = keys
        self.prefs = prefs
        self.identity = identity
        self.sharedStation = sharedStation
        self.wordsFor = words
    }

    /// The device's enrollment (whose key, and its email), or nil: Settings › This Kiosk's row.
    var enrollment: BiometricEnrollment? { prefs.biometric }

    /// This device's biometric: the ready one, else the hardware's own (locked out, nothing
    /// enrolled), else nil.
    var kind: BiometryKind? {
        if case .ready(let kind) = keys.readiness() { return kind }
        return keys.biometryKind()
    }

    /// The copy's words for this device: its biometric (`kind`), or the device's best guess when
    /// it has none.
    var words: BiometricWords { wordsFor(kind) }

    /// Whether to show the Turn on sheet now: right after a person's own password sign-in (never a
    /// restored, link, biometric or move-password session, a move-locked one, or one whose
    /// password must change), never on a shared station, with Face ID or Touch ID ready, no live
    /// key of theirs here already, and the server agreeing this is their personal device (the
    /// enroll-challenge answers, which it only does inside the 10-minute enroll window).
    /// Anything unexpected is "not now".
    func offerEnroll() async -> Bool {
        if sharedStation() { return false }
        guard let me = eligibleSession() else { return false }
        guard case .ready = keys.readiness() else { return false }
        let serial = identity.current.serial
        // Another person's key here is left alone: the server refuses them below anyway.
        if let local = prefs.biometric, local.personId == me.person.id {
            switch keys.probe() {
            case .unavailable: return false
            case .gone: dropLocal()
            case .ready:
                do {
                    let live = try await api.biometricChallenge(serial: serial).keyId == local.keyId
                    if live { return false }   // this password sign-in renews it
                } catch {
                    if code(error) != "no_biometric" { return false }   // offline, throttled: ask another time
                }
                guard prefs.biometric == local else { return false }   // changed while asking: not now
                dropLocal()
            }
        }
        do {
            _ = try await api.biometricEnrollChallenge(serial: serial)   // refused: not personal, window closed, offline
            return true
        } catch {
            return false
        }
    }

    /// Turn on: a fresh nonce, a new Secure Enclave key attested to it by App Attest, one prompt,
    /// then the key's signature over the nonce behind that prompt, all sent to the server. Any old
    /// key here is replaced. Canceled while another enroll or sign-in runs, or when the task is
    /// canceled (the sheet closed): then nothing is stored.
    func enroll(_ prompt: BiometricPrompter) async -> EnrollOutcome {
        guard begin() else { return .canceled }
        defer { end() }
        let w = words
        if sharedStation() { return .unsupported }
        guard let me = eligibleSession() else { return .failed(BiometricCopy.enrollWindow(w)) }
        let email = auth.currentSignIn?.email ?? me.person.email
        let serial = identity.current.serial
        let nonce: String
        do {
            nonce = try await api.biometricEnrollChallenge(serial: serial)
        } catch {
            return enrollFailure(error, w)
        }
        dropLocal()
        var enrolled = false
        defer { if !enrolled { dropLocal() } }
        let proof: BiometricEnrollProof
        do {
            proof = try await keys.create(nonce: nonce)
        } catch {
            return Task.isCancelled ? .canceled : .unsupported
        }
        if Task.isCancelled { return .canceled }
        let proven: BiometricAuth
        do {
            guard let answer = try await prompt.authenticate(reason: BiometricCopy.enrollReason(w)) else { return .canceled }
            proven = answer
        } catch {
            return .failed(BiometricCopy.enrollFailed(w))
        }
        if Task.isCancelled { return .canceled }
        let signature: Data
        do {
            signature = try keys.sign(Data(nonce.utf8), with: proven)
        } catch {
            return .unsupported
        }
        let out: BiometricEnrollOut
        do {
            out = try await api.biometricEnroll(BiometricIosEnrollIn(
                serial: serial, nonce: nonce,
                publicKey: proof.publicKey.base64EncodedString(),
                appAttestKeyId: proof.appAttestKeyId,
                attestation: proof.attestation.base64EncodedString(),
                signature: signature.base64EncodedString()
            ))
        } catch {
            return enrollFailure(error, w)
        }
        if Task.isCancelled { return .canceled }
        prefs.biometric = BiometricEnrollment(keyId: out.keyId, personId: me.person.id, email: email)
        enrolled = true
        return .enrolled
    }

    /// The card for the sign-in screen, or nil for the password form: no key here, a shared
    /// station, a key iOS invalidated or the server no longer has for this device (both forgotten
    /// here), the Keychain unavailable this time, or the server out of reach. Each call may fetch
    /// a new challenge.
    func card() async -> BiometricCard? {
        if sharedStation() { return nil }
        guard let local = prefs.biometric else { return nil }
        switch keys.probe() {
        case .gone:
            dropLocal()
            return nil
        case .unavailable:
            return nil
        case .ready:
            break
        }
        let c: BiometricChallengeOut
        do {
            c = try await api.biometricChallenge(serial: identity.current.serial)
        } catch {
            if code(error) == "no_biometric" { dropLocal(ifStill: local) }   // offline or throttled keeps it
            return nil
        }
        guard c.keyId == local.keyId else {
            dropLocal(ifStill: local)
            return nil
        }
        guard prefs.biometric == local else { return nil }   // changed while asking: a stale card
        return BiometricCard(keyId: c.keyId, challenge: c.challenge, displayName: c.displayName,
                             photoUrl: c.photoUrl, expired: c.expired, email: local.email)
    }

    /// Sign in with the key: the prompt first (its reason names `name`, the card's), then a fresh
    /// challenge (each attempt spends one), signed with the prompt's context, and the session
    /// adopted by KioskAuth (authed, method biometric). The UI skips the prompt for an expired
    /// card; a challenge that turns out expired here still ends `.expired` without a sign-in.
    /// Canceled while another enroll or sign-in runs.
    func signIn(_ prompt: BiometricPrompter, name: String?) async -> BiometricOutcome {
        guard begin() else { return .canceled }
        defer { end() }
        let w = words
        guard let local = prefs.biometric else { return .invalidated }
        if sharedStation() { return .notAllowed(BiometricCopy.removed(w), .removed) }
        switch keys.probe() {
        case .gone:
            dropLocal()
            return .invalidated
        case .unavailable:
            return .failed(BiometricCopy.tryAgain(w))
        case .ready:
            break
        }
        let named = name.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let reason = named.map { BiometricCopy.signInReason(w, name: $0) } ?? BiometricCopy.signInReasonFallback(w)
        let proven: BiometricAuth
        do {
            guard let answer = try await prompt.authenticate(reason: reason) else { return .canceled }
            proven = answer
        } catch {
            return .failed(BiometricCopy.tryAgain(w))
        }
        if Task.isCancelled { return .canceled }
        let c: BiometricChallengeOut
        do {
            c = try await api.biometricChallenge(serial: identity.current.serial)
        } catch {
            return signInFailure(error, w)
        }
        guard c.keyId == local.keyId else {
            dropLocal()
            return .notAllowed(BiometricCopy.removed(w), .removed)
        }
        if c.expired { return .expired }
        let signature: Data
        do {
            signature = try keys.sign(Data(c.challenge.utf8), with: proven)
        } catch BiometricKeyError.gone {
            dropLocal()
            return .invalidated
        } catch {
            return .failed(BiometricCopy.tryAgain(w))
        }
        let data: SessionData
        do {
            data = try await api.biometricSignIn(keyId: local.keyId, challenge: c.challenge, signature: signature.base64EncodedString())
        } catch {
            return signInFailure(error, w)
        }
        auth.signInWithBiometric(data)
        return .signedIn
    }

    /// Forget this device. Signed in: revoke on the server, then forget here. Signed out: here
    /// only. The device always forgets; false when the server call failed. Waits for a running
    /// enroll or sign-in.
    func forget(signedIn: Bool) async -> Bool {
        await acquire()
        defer { end() }
        var ok = true
        if signedIn {
            do {
                try await api.biometricForget(serial: identity.current.serial)
            } catch {
                ok = false
            }
        }
        dropLocal()
        return ok
    }

    // MARK: Rules

    /// The signed-in session when it may enroll: a person's own password sign-in on this launch,
    /// not locked to a move, and not one whose password must change. (Each caller checks the
    /// shared-station rule.)
    private func eligibleSession() -> SessionData? {
        guard case .authed(let session) = auth.state,
              session.kioskMove == nil,
              auth.currentSignIn?.method == .password,
              !session.mustChangePassword else { return nil }
        return session
    }

    /// Challenge and sign-in refusals. A key the server no longer has for this device is done here
    /// too: revoked, reassigned, or no longer a personal device. A disabled account (or an archived
    /// person) is forgotten here as well, so the card doesn't come back after the message; a
    /// re-enabled person turns it on again after a password sign-in.
    private func signInFailure(_ error: Error, _ w: BiometricWords) -> BiometricOutcome {
        if Task.isCancelled || error is CancellationError { return .canceled }
        switch code(error) {
        case "no_biometric", "not_personal_device":
            dropLocal()
            return .notAllowed(BiometricCopy.removed(w), .removed)
        case "biometric_expired": return .expired
        case "password_change_required": return .passwordChange
        case "kiosk_not_allowed": return .notAllowed(BiometricCopy.kioskNotAllowed(w), .kioskNotAllowed)
        case "account_disabled":
            dropLocal()
            return .notAllowed(BiometricCopy.accountDisabled(w), .accountDisabled)
        case "biometric_rate_limited": return .failed(BiometricCopy.rateLimited(w))
        case "network": return .failed(BiometricCopy.network(w))
        case Self.unexpected: return .failed(BiometricCopy.somethingWrong(w))
        default: return .failed(BiometricCopy.tryAgain(w))   // bad_challenge, bad_signature, …
        }
    }

    private func enrollFailure(_ error: Error, _ w: BiometricWords) -> EnrollOutcome {
        if Task.isCancelled || error is CancellationError { return .canceled }
        switch code(error) {
        case "attestation_failed", "not_personal_device": return .unsupported
        case "enroll_window_closed": return .failed(BiometricCopy.enrollWindow(w))
        // The nonce ran out (a prompt left open past 5 minutes) or was spent: start over.
        case "bad_enroll_nonce": return .failed(BiometricCopy.enrollRetry(w))
        case "network": return .failed(BiometricCopy.network(w))
        default: return .failed(BiometricCopy.enrollFailed(w))
        }
    }

    // MARK: Plumbing

    /// Forgets the key on the device: the Secure Enclave key and the saved enrollment.
    private func dropLocal() {
        keys.delete()
        prefs.biometric = nil
    }

    /// `dropLocal()` for an answer about `local` that came back after an await: only while
    /// `local` is still the enrollment, so a late answer never forgets a newer key (or one a
    /// running Turn on is making).
    private func dropLocal(ifStill local: BiometricEnrollment) {
        guard prefs.biometric == local else { return }
        dropLocal()
    }

    /// The API's code. A 2xx whose body didn't decode (the transport's `unknown_error` with that
    /// status, a captive portal's HTML, say) or any other error is `unexpected`, not the network:
    /// the transport already turns every I/O failure into `ApiError.network()`.
    private func code(_ error: Error) -> String {
        guard let api = error as? ApiError, !(200..<300).contains(api.status) else { return Self.unexpected }
        return api.code
    }

    private static let unexpected = "unexpected"

    /// Takes the one turn if it is free.
    private func begin() -> Bool {
        if busy { return false }
        busy = true
        return true
    }

    /// Takes the one turn, waiting for the running enroll or sign-in (or an earlier forget).
    private func acquire() async {
        if !busy {
            busy = true
            return
        }
        await withCheckedContinuation { waiting.append($0) }   // `end()` hands the turn over
    }

    /// Hands the turn straight to the next waiting forget, or frees it.
    private func end() {
        if waiting.isEmpty {
            busy = false
        } else {
            waiting.removeFirst().resume()
        }
    }
}
