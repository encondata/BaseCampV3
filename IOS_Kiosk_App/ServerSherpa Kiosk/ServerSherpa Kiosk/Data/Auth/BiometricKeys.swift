import CryptoKit
import DeviceCheck
import Foundation
import LocalAuthentication
import Security

enum BiometryKind: Equatable, Sendable {
    case faceID, touchID
}

/// Whether this device can hold a biometric sign-in key right now. `unsupported` covers no
/// biometric hardware, no App Attest, and the Simulator.
enum BiometricReadiness: Equatable, Sendable {
    case ready(BiometryKind)
    case noPasscode
    case noneEnrolled
    case unsupported
}

/// The stored key, looked at without a prompt. `gone` means it is missing or iOS invalidated it
/// (Face ID re-enrolled, a finger added). `unavailable` means the Keychain could not answer this
/// time; the key may be fine, so callers never forget it for that.
enum KeyProbe: Equatable, Sendable {
    case ready, gone, unavailable
}

/// What enroll sends the server about a new key. `publicKey` is the 65-byte X9.63 point;
/// `appAttestKeyId` is the base64 key id `DCAppAttestService` returns; `attestation` is its
/// attestation object, whose clientDataHash is `biometricClientDataHash(nonce:publicKey:)`.
struct BiometricEnrollProof: Equatable, Sendable {
    let publicKey: Data
    let appAttestKeyId: String
    let attestation: Data
}

/// A Face ID / Touch ID prompt that succeeded. Signing with its context does not prompt again.
struct BiometricAuth: @unchecked Sendable {
    let context: LAContext
}

/// The device's one biometric sign-in key. `BiometricSignIn` holds the rules; this is only the key.
protocol BiometricKeys: Sendable {
    func readiness() -> BiometricReadiness

    /// Replaces any old key with a new Secure Enclave key, attested by App Attest for `nonce`.
    /// Throws when either can't be made, and then leaves no key behind.
    func create(nonce: String) async throws -> BiometricEnrollProof

    /// Never prompts.
    func probe() -> KeyProbe

    /// A DER ECDSA SHA-256 signature over `message`. Throws when there is no usable key.
    func sign(_ message: Data, with auth: BiometricAuth) throws -> Data

    func delete()
}

/// The App Attest clientDataHash the server checks: SHA-256 of the nonce's UTF-8 bytes followed
/// by the X9.63 public key, which binds the Secure Enclave key to this app's attestation.
func biometricClientDataHash(nonce: String, publicKey: Data) -> Data {
    Data(SHA256.hash(data: Data(nonce.utf8) + publicKey))
}

/// `BiometricKeys` on the Secure Enclave and App Attest. Thin on purpose: the device pass covers it.
struct SecureEnclaveBiometricKeys: BiometricKeys {
    static let tag = Data("com.serversherpa.kiosk.biometric".utf8)

    func readiness() -> BiometricReadiness {
        #if targetEnvironment(simulator)
        return .unsupported
        #else
        guard DCAppAttestService.shared.isSupported else { return .unsupported }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return Self.code(error) == .passcodeNotSet ? .noPasscode : .unsupported
        }
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return Self.code(error) == .biometryNotEnrolled ? .noneEnrolled : .unsupported
        }
        switch context.biometryType {
        case .faceID: return .ready(.faceID)
        case .touchID: return .ready(.touchID)
        default: return .unsupported
        }
        #endif
    }

    func create(nonce: String) async throws -> BiometricEnrollProof {
        delete()
        do {
            let publicKey = try makeKey()
            let service = DCAppAttestService.shared
            let keyId = try await service.generateKey()
            let attestation = try await service.attestKey(keyId, clientDataHash: biometricClientDataHash(nonce: nonce, publicKey: publicKey))
            return BiometricEnrollProof(publicKey: publicKey, appAttestKeyId: keyId, attestation: attestation)
        } catch {
            delete()
            throw error
        }
    }

    func probe() -> KeyProbe {
        let context = LAContext()
        context.interactionNotAllowed = true
        switch copyKey(context).status {
        case errSecSuccess, errSecInteractionNotAllowed: return .ready
        case errSecItemNotFound: return .gone
        default: return .unavailable
        }
    }

    func sign(_ message: Data, with auth: BiometricAuth) throws -> Data {
        let found = copyKey(auth.context)
        guard found.status == errSecSuccess, let key = found.key else { throw Self.osError(found.status) }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) else {
            throw Self.failure(error)
        }
        return signature as Data
    }

    func delete() {
        SecItemDelete(Self.query as CFDictionary)
    }

    /// Makes the permanent Secure Enclave key, usable only after Face ID / Touch ID with the
    /// biometrics enrolled now and only while a passcode is set, and returns its X9.63 public key.
    private func makeKey() throws -> Data {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error
        ) else { throw Self.failure(error) }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: Self.tag,
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw Self.failure(error) }
        guard let publicKey = SecKeyCopyPublicKey(key) else { throw Self.osError(errSecInternalComponent) }
        guard let x963 = SecKeyCopyExternalRepresentation(publicKey, &error) else { throw Self.failure(error) }
        return x963 as Data
    }

    /// Looks up the private key with `context` attached, so signing uses that context's prompt.
    private func copyKey(_ context: LAContext) -> (status: OSStatus, key: SecKey?) {
        var query = Self.query
        query[kSecAttrKeyClass as String] = kSecAttrKeyClassPrivate
        query[kSecReturnRef as String] = true
        query[kSecUseAuthenticationContext as String] = context
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return (status, nil) }
        guard let item, CFGetTypeID(item) == SecKeyGetTypeID() else { return (errSecInternalComponent, nil) }
        return (status, (item as! SecKey))
    }

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: tag,
        ]
    }

    private static func code(_ error: NSError?) -> LAError.Code? {
        guard let error, error.domain == LAErrorDomain else { return nil }
        return LAError.Code(rawValue: error.code)
    }

    private static func osError(_ status: OSStatus) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }

    private static func failure(_ error: Unmanaged<CFError>?) -> Error {
        error.map { $0.takeRetainedValue() as Error } ?? osError(errSecInternalComponent)
    }
}
