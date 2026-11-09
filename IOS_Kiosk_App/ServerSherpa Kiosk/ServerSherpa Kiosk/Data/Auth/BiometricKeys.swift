import CryptoKit
import DeviceCheck
import Foundation
import LocalAuthentication
import Security

enum BiometryKind: Equatable, Sendable {
    case faceID, touchID
}

/// The one switch for App Attest at enroll. App Attest needs the paid Apple Developer Program
/// membership, which the team doesn't have right now, so it is off: enroll sends the Secure
/// Enclave key and its proof without Apple's statement, and the server stores the key as
/// `unattested`. Harbor Master SS-521 turns it back on: flip this, add the
/// `com.apple.developer.devicecheck.appattest-environment` entitlement back, and set
/// `SS_KIOSK_IOS_REQUIRE_APP_ATTEST` on the server.
enum BiometricAppAttest {
    static let isEnabled = false
}

/// Whether this device can hold a biometric sign-in key right now. `unsupported` covers no
/// biometric hardware, no App Attest (checked only while `BiometricAppAttest.isEnabled`), and
/// the Simulator.
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
/// Both are nil, together, while `BiometricAppAttest.isEnabled` is false.
struct BiometricEnrollProof: Equatable, Sendable {
    let publicKey: Data
    let appAttestKeyId: String?
    let attestation: Data?
}

/// What `sign` throws when the key is missing or iOS invalidated it: the same verdict as a
/// `.gone` probe, so the caller forgets the key and falls back to the password form.
enum BiometricKeyError: Error, Equatable, Sendable {
    case gone
}

/// A Face ID / Touch ID prompt that succeeded. Signing with its context does not prompt again.
struct BiometricAuth: @unchecked Sendable {
    let context: LAContext
}

/// The device's one biometric sign-in key. `BiometricSignIn` holds the rules; this is only the key.
protocol BiometricKeys: Sendable {
    func readiness() -> BiometricReadiness

    /// The device's biometric hardware, whether or not it can be used right now (locked out,
    /// nothing enrolled); nil without any. For the copy's words and the card's symbol only: the
    /// offer goes by `readiness()`.
    func biometryKind() -> BiometryKind?

    /// Replaces any old key with a new Secure Enclave key, attested by App Attest for `nonce`
    /// while `BiometricAppAttest.isEnabled`. Throws when either can't be made, and then leaves no
    /// key behind.
    func create(nonce: String) async throws -> BiometricEnrollProof

    /// Never prompts.
    func probe() -> KeyProbe

    /// A DER ECDSA SHA-256 signature over `message`. Throws `BiometricKeyError.gone` when the key
    /// is missing or invalidated, and any other error when the Keychain fails this time.
    func sign(_ message: Data, with auth: BiometricAuth) throws -> Data

    func delete()
}

/// `LAContext.biometryType` as a kind; nil for none (or a type the app doesn't name, Optic ID).
func biometryKind(of type: LABiometryType) -> BiometryKind? {
    switch type {
    case .faceID: return .faceID
    case .touchID: return .touchID
    default: return nil
    }
}

/// The App Attest clientDataHash the server checks: SHA-256 of the nonce's UTF-8 bytes followed
/// by the X9.63 public key, which binds the Secure Enclave key to this app's attestation.
func biometricClientDataHash(nonce: String, publicKey: Data) -> Data {
    Data(SHA256.hash(data: Data(nonce.utf8) + publicKey))
}

/// The probe's verdict. `lookup` is the no-prompt Keychain lookup of the key. A Secure Enclave key
/// is still found after Face ID is re-enrolled or a finger is added (`.biometryCurrentSet` is
/// checked only when signing), so the biometric state saved at create is compared with the
/// current one: a change means the key is dead. A missing or unreadable state never means gone;
/// a stored state the Keychain can't read means unavailable. A key the lookup can't find is gone.
func biometricProbeVerdict(lookup: OSStatus, storedState: Data?, storedStateReadFailed: Bool, currentState: Data?) -> KeyProbe {
    switch lookup {
    case errSecSuccess, errSecInteractionNotAllowed: break
    case errSecItemNotFound: return .gone
    default: return .unavailable
    }
    if storedStateReadFailed { return .unavailable }
    guard let storedState, let currentState else { return .ready }
    return storedState == currentState ? .ready : .gone
}

/// `BiometricKeys` on the Secure Enclave, and App Attest while `BiometricAppAttest.isEnabled`.
/// Thin on purpose: the device pass covers it.
struct SecureEnclaveBiometricKeys: BiometricKeys {
    static let tag = Data("com.serversherpa.kiosk.biometric".utf8)
    /// The generic-password item holding the biometric state the key was made under.
    static let stateService = "com.serversherpa.kiosk.biometric"
    static let stateAccount = "biometry_state"

    func readiness() -> BiometricReadiness {
        #if targetEnvironment(simulator)
        return .unsupported
        #else
        if BiometricAppAttest.isEnabled, !DCAppAttestService.shared.isSupported { return .unsupported }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return Self.code(error) == .passcodeNotSet ? .noPasscode : .unsupported
        }
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return Self.code(error) == .biometryNotEnrolled ? .noneEnrolled : .unsupported
        }
        guard let kind = ServerSherpa_Kiosk.biometryKind(of: context.biometryType) else { return .unsupported }
        return .ready(kind)
        #endif
    }

    func biometryKind() -> BiometryKind? {
        let context = LAContext()
        var error: NSError?
        // biometryType is set by this call whatever it returns (locked out, none enrolled).
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        return ServerSherpa_Kiosk.biometryKind(of: context.biometryType)
    }

    func create(nonce: String) async throws -> BiometricEnrollProof {
        do {
            // A key left behind here would leave two under one tag, and signing could pick the old one.
            let deleted = SecItemDelete(Self.query as CFDictionary)
            guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw Self.osError(deleted) }
            SecItemDelete(Self.stateQuery as CFDictionary)
            let publicKey = try makeKey()
            // The biometrics the key is bound to, for the probe. An unreadable state saves nothing,
            // and the probe then goes by the key lookup alone.
            if let state = Self.biometryState(LAContext()) { try Self.storeState(state) }
            guard BiometricAppAttest.isEnabled else {
                return BiometricEnrollProof(publicKey: publicKey, appAttestKeyId: nil, attestation: nil)
            }
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
        let lookup = copyKey(context).status
        let stored = Self.storedState()
        return biometricProbeVerdict(lookup: lookup, storedState: stored.state, storedStateReadFailed: stored.failed, currentState: Self.biometryState(LAContext()))
    }

    func sign(_ message: Data, with auth: BiometricAuth) throws -> Data {
        let found = copyKey(auth.context)
        let stored = Self.storedState()
        // The prompt's own context carries the biometric state it was just evaluated under.
        let current = auth.context.domainState.biometry.stateHash ?? Self.biometryState(LAContext())
        switch biometricProbeVerdict(lookup: found.status, storedState: stored.state, storedStateReadFailed: stored.failed, currentState: current) {
        case .gone: throw BiometricKeyError.gone
        case .unavailable: throw Self.osError(stored.failed ? errSecInternalComponent : found.status)
        case .ready: break
        }
        // Ready without a key ref is a locked Keychain (errSecInteractionNotAllowed).
        guard let key = found.key else { throw Self.osError(found.status) }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) else {
            throw Self.failure(error)
        }
        return signature as Data
    }

    func delete() {
        SecItemDelete(Self.query as CFDictionary)
        SecItemDelete(Self.stateQuery as CFDictionary)
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

    /// The enrolled biometrics' state hash; nil when nothing is enrolled or it can't be read.
    /// It changes when a face or finger is added or removed. Never prompts.
    private static func biometryState(_ context: LAContext) -> Data? {
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        return context.domainState.biometry.stateHash
    }

    private static func storeState(_ state: Data) throws {
        var item = stateQuery
        item[kSecValueData as String] = state
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw osError(status) }
    }

    /// The saved state; `failed` when the Keychain could not answer.
    private static func storedState() -> (state: Data?, failed: Bool) {
        var query = stateQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &item) {
        case errSecSuccess:
            guard let data = item as? Data else { return (nil, true) }
            return (data, false)
        case errSecItemNotFound: return (nil, false)
        default: return (nil, true)
        }
    }

    private static var stateQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stateService,
            kSecAttrAccount as String: stateAccount,
        ]
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
