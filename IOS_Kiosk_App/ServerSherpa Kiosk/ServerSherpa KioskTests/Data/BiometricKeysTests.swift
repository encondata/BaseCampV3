import CryptoKit
import Foundation
import LocalAuthentication
import Security
import Testing
import UIKit
@testable import ServerSherpa_Kiosk

/// The biometric key's pure pieces, the software fake the rules are tested with, and what the
/// real Secure Enclave key does on the Simulator (no Secure Enclave, no App Attest).
@Suite(.serialized, .timeLimit(.minutes(1)))
struct BiometricKeysTests {
    @Test func clientDataHashMatchesTheServerVector() {
        let hash = biometricClientDataHash(nonce: "enroll-nonce", publicKey: Data([4] + (1...64)))
        #expect(hash.map { String(format: "%02x", $0) }.joined() == "e66ae6444b04ccdff839a7a0d5041d2bf2b1797a3ffdcddfd7e59fd5828df43a")
    }

    @Test func lockoutIsLockedOut() {
        #expect(biometricPromptProblem(for: .biometryLockout) == .lockedOut)
    }

    @Test func unusableSensorIsUnavailable() {
        #expect(biometricPromptProblem(for: .biometryNotAvailable) == .unavailable)
        #expect(biometricPromptProblem(for: .biometryNotEnrolled) == .unavailable)
    }

    @Test func cancelAndFallbackAreNotProblems() {
        for code: LAError.Code in [.userCancel, .appCancel, .systemCancel, .userFallback, .authenticationFailed] {
            #expect(biometricPromptProblem(for: code) == nil, "\(code)")
        }
    }

    @Test func fakeSignatureVerifies() async throws {
        let keys = FakeBiometricKeys()
        let proof = try await keys.create(nonce: "n1")
        let der = try keys.sign(Data("abc".utf8), with: BiometricAuth(context: LAContext()))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
        let publicKey = try P256.Signing.PublicKey(x963Representation: proof.publicKey)
        #expect(publicKey.isValidSignature(signature, for: Data("abc".utf8)))
        #expect(!publicKey.isValidSignature(signature, for: Data("abd".utf8)))
        #expect(keys.created == ["n1"])
    }

    @Test func fakeProbeAndSignFollowTheKnobs() async throws {
        let keys = FakeBiometricKeys()
        let auth = BiometricAuth(context: LAContext())
        #expect(keys.probe() == .gone)
        #expect(throws: BiometricKeyError.gone) { try keys.sign(Data("abc".utf8), with: auth) }
        _ = try await keys.create(nonce: "n1")
        #expect(keys.probe() == .ready)
        keys.probeUnavailable = true
        #expect(keys.probe() == .unavailable)
        keys.probeUnavailable = false
        keys.invalidated = true
        #expect(keys.probe() == .gone)
        #expect(throws: BiometricKeyError.gone) { try keys.sign(Data("abc".utf8), with: auth) }
        keys.delete()
        #expect(keys.deleted == 1)
        #expect(keys.probe() == .gone)
    }

    @MainActor @Test func wordsForKinds() {
        #expect(currentBiometricWords(.touchID).bio == "Touch ID")
        #expect(currentBiometricWords(.faceID).bio == "Face ID")
        let device = currentBiometricWords(.faceID).device
        if UIDevice.current.userInterfaceIdiom == .pad {
            #expect(device == "iPad")
        } else {
            #expect(device == "iPhone")
        }
    }

    /// The real key on the Simulator: never ready, never prompts, and a create that fails
    /// (no Secure Enclave, no App Attest) leaves no key behind.
    @Test func secureEnclaveKeysOnTheSimulatorAreUnsupportedAndLeaveNoKey() async {
        let keys = SecureEnclaveBiometricKeys()
        #expect(keys.readiness() == .unsupported)
        keys.delete()
        #expect(keys.probe() == .gone)
        await #expect(throws: (any Error).self) { try await keys.create(nonce: "n1") }
        #expect(keys.probe() == .gone)
        #expect(throws: BiometricKeyError.gone) { try keys.sign(Data("abc".utf8), with: BiometricAuth(context: LAContext())) }
    }

    // The probe's verdict. A Secure Enclave key can still be found after Face ID is re-enrolled
    // or a finger is added (the Secure Enclave checks `.biometryCurrentSet` only when signing),
    // so the biometric state saved at create is compared with the current one.

    @Test func probeVerdictFollowsTheKeyLookup() {
        let s = Data([1])
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: nil, storedStateReadFailed: false, currentState: nil) == .ready)
        #expect(biometricProbeVerdict(lookup: errSecInteractionNotAllowed, storedState: nil, storedStateReadFailed: false, currentState: nil) == .ready)
        #expect(biometricProbeVerdict(lookup: errSecItemNotFound, storedState: s, storedStateReadFailed: false, currentState: s) == .gone)
        #expect(biometricProbeVerdict(lookup: errSecNotAvailable, storedState: s, storedStateReadFailed: false, currentState: s) == .unavailable)
        #expect(biometricProbeVerdict(lookup: errSecInternalComponent, storedState: nil, storedStateReadFailed: false, currentState: nil) == .unavailable)
    }

    @Test func probeVerdictWithTheSameBiometricsIsReady() {
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: Data([1, 2]), storedStateReadFailed: false, currentState: Data([1, 2])) == .ready)
        #expect(biometricProbeVerdict(lookup: errSecInteractionNotAllowed, storedState: Data([1, 2]), storedStateReadFailed: false, currentState: Data([1, 2])) == .ready)
    }

    @Test func probeVerdictWithChangedBiometricsIsGone() {
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: Data([1]), storedStateReadFailed: false, currentState: Data([2])) == .gone)
        #expect(biometricProbeVerdict(lookup: errSecInteractionNotAllowed, storedState: Data([1]), storedStateReadFailed: false, currentState: Data([2])) == .gone)
    }

    @Test func probeVerdictWithAnUnreadableOrMissingStateKeepsTheLookupVerdict() {
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: Data([1]), storedStateReadFailed: false, currentState: nil) == .ready)
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: nil, storedStateReadFailed: false, currentState: Data([2])) == .ready)
        #expect(biometricProbeVerdict(lookup: errSecItemNotFound, storedState: Data([1]), storedStateReadFailed: false, currentState: nil) == .gone)
    }

    @Test func probeVerdictWhenTheStoredStateCannotBeReadIsUnavailableNeverGone() {
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: nil, storedStateReadFailed: true, currentState: Data([2])) == .unavailable)
        #expect(biometricProbeVerdict(lookup: errSecSuccess, storedState: nil, storedStateReadFailed: true, currentState: nil) == .unavailable)
        #expect(biometricProbeVerdict(lookup: errSecInteractionNotAllowed, storedState: nil, storedStateReadFailed: true, currentState: Data([2])) == .unavailable)
        // A key the Keychain says is not there is gone whatever the state item says.
        #expect(biometricProbeVerdict(lookup: errSecItemNotFound, storedState: nil, storedStateReadFailed: true, currentState: nil) == .gone)
    }
}
