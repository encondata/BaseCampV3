import CryptoKit
import Foundation
@testable import ServerSherpa_Kiosk

/// A software P-256 key standing in for the Secure Enclave one (Android `FakeBiometricKeys`):
/// real DER signatures, so a test can verify what was signed. `invalidated` plays iOS dropping
/// the key (Face ID re-enrolled, a finger added); `probeUnavailable` plays a Keychain that throws.
final class FakeBiometricKeys: BiometricKeys, @unchecked Sendable {
    private struct State {
        var readinessValue: BiometricReadiness = .ready(.faceID)
        var hardwareKind: BiometryKind?
        var invalidated = false
        var probeUnavailable = false
        var createError: Error?
        var signError: Error?
        var created: [String] = []
        var deleted = 0
        var key: P256.Signing.PrivateKey?
        var proof: BiometricEnrollProof?
    }

    private let lock = NSLock()
    private var state = State()

    private func locked<T>(_ body: (inout State) throws -> T) rethrows -> T { try lock.withLock { try body(&state) } }

    init(readiness: BiometricReadiness = .ready(.faceID)) {
        state.readinessValue = readiness
    }

    var readinessValue: BiometricReadiness {
        get { locked { $0.readinessValue } }
        set { locked { $0.readinessValue = newValue } }
    }
    /// What `biometryKind()` reports: the hardware, also when it isn't ready (a lockout).
    var hardwareKind: BiometryKind? {
        get { locked { $0.hardwareKind } }
        set { locked { $0.hardwareKind = newValue } }
    }
    /// The key is still stored but no longer usable: probe gives `.gone`, sign throws `BiometricKeyError.gone`.
    var invalidated: Bool {
        get { locked { $0.invalidated } }
        set { locked { $0.invalidated = newValue } }
    }
    /// Probe gives `.unavailable`: the Keychain could not answer this time.
    var probeUnavailable: Bool {
        get { locked { $0.probeUnavailable } }
        set { locked { $0.probeUnavailable = newValue } }
    }
    /// Thrown by `create`, which (like the real one) then leaves no key behind.
    var createError: Error? {
        get { locked { $0.createError } }
        set { locked { $0.createError = newValue } }
    }
    var signError: Error? {
        get { locked { $0.signError } }
        set { locked { $0.signError = newValue } }
    }
    /// The nonces of the keys `create` made.
    var created: [String] { locked { $0.created } }
    /// How many times `delete()` was called. A create's own replacement of the old key does
    /// not count, so a test can tell the rules deleted the key.
    var deleted: Int { locked { $0.deleted } }
    var hasKey: Bool { locked { $0.key != nil } }
    /// The public key of the key that is stored now.
    var publicKey: P256.Signing.PublicKey? { locked { $0.key?.publicKey } }
    /// What the last successful `create` returned.
    var proof: BiometricEnrollProof? { locked { $0.proof } }

    func readiness() -> BiometricReadiness { readinessValue }

    func biometryKind() -> BiometryKind? { hardwareKind }

    func create(nonce: String) async throws -> BiometricEnrollProof {
        let error = locked { s -> Error? in
            s.key = nil
            s.invalidated = false
            return s.createError
        }
        if let error { throw error }
        let key = P256.Signing.PrivateKey()
        let publicKey = key.publicKey.x963Representation
        let proof = BiometricEnrollProof(
            publicKey: publicKey,
            appAttestKeyId: Data(SHA256.hash(data: publicKey)).base64EncodedString(),
            attestation: Data("fake-attestation-\(nonce)".utf8)
        )
        locked { s in
            s.key = key
            s.proof = proof
            s.created.append(nonce)
        }
        return proof
    }

    func probe() -> KeyProbe {
        locked { s in
            if s.probeUnavailable { return .unavailable }
            return s.key == nil || s.invalidated ? .gone : .ready
        }
    }

    func sign(_ message: Data, with auth: BiometricAuth) throws -> Data {
        try locked { s in
            if let error = s.signError { throw error }
            guard let key = s.key, !s.invalidated else { throw BiometricKeyError.gone }
            return try key.signature(for: message).derRepresentation
        }
    }

    func delete() {
        locked { s in
            s.deleted += 1
            s.key = nil
            s.invalidated = false
        }
    }
}
