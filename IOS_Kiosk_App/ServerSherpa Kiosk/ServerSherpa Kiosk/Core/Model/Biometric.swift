import Foundation

/// `POST /kiosk/biometric/enroll-challenge` body.
struct BiometricSerialIn: Codable, Equatable, Sendable {
    var serial: String

    enum CodingKeys: String, CodingKey {
        case serial
    }

    init(serial: String) {
        self.serial = serial
    }
}

struct BiometricEnrollChallengeOut: Codable, Equatable, Sendable {
    var nonce: String

    enum CodingKeys: String, CodingKey {
        case nonce
    }

    init(nonce: String) {
        self.nonce = nonce
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nonce = try c.decode(String.self, forKey: .nonce)
    }
}

/// `POST /kiosk/biometric/enroll` body for iOS. Every value is standard base64 except
/// `serial`, `nonce` and `platform`.
struct BiometricIosEnrollIn: Codable, Equatable, Sendable {
    var serial: String
    var nonce: String
    var platform: String
    var publicKey: String
    var appAttestKeyId: String
    var attestation: String
    var signature: String

    enum CodingKeys: String, CodingKey {
        case serial
        case nonce
        case platform
        case publicKey = "public_key"
        case appAttestKeyId = "app_attest_key_id"
        case attestation
        case signature
    }

    init(serial: String, nonce: String, platform: String = "ios", publicKey: String, appAttestKeyId: String, attestation: String, signature: String) {
        self.serial = serial
        self.nonce = nonce
        self.platform = platform
        self.publicKey = publicKey
        self.appAttestKeyId = appAttestKeyId
        self.attestation = attestation
        self.signature = signature
    }
}

struct BiometricEnrollOut: Codable, Equatable, Sendable {
    var keyId: String
    var securityLevel: String
    var renewsAt: String

    enum CodingKeys: String, CodingKey {
        case keyId = "key_id"
        case securityLevel = "security_level"
        case renewsAt = "renews_at"
    }

    init(keyId: String, securityLevel: String, renewsAt: String) {
        self.keyId = keyId
        self.securityLevel = securityLevel
        self.renewsAt = renewsAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keyId = try c.decode(String.self, forKey: .keyId)
        securityLevel = try c.decode(String.self, forKey: .securityLevel)
        renewsAt = try c.decode(String.self, forKey: .renewsAt)
    }
}

/// Whose card this phone shows, and the challenge to sign. A missing `expired` is false.
struct BiometricChallengeOut: Codable, Equatable, Sendable {
    var keyId: String
    var challenge: String
    var displayName: String
    var photoUrl: String?
    var expired: Bool

    enum CodingKeys: String, CodingKey {
        case keyId = "key_id"
        case challenge
        case displayName = "display_name"
        case photoUrl = "photo_url"
        case expired
    }

    init(keyId: String, challenge: String, displayName: String, photoUrl: String? = nil, expired: Bool = false) {
        self.keyId = keyId
        self.challenge = challenge
        self.displayName = displayName
        self.photoUrl = photoUrl
        self.expired = expired
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keyId = try c.decode(String.self, forKey: .keyId)
        challenge = try c.decode(String.self, forKey: .challenge)
        displayName = try c.decode(String.self, forKey: .displayName)
        photoUrl = try c.decodeIfPresent(String.self, forKey: .photoUrl)
        expired = try c.decodeIfPresent(Bool.self, forKey: .expired) ?? false
    }
}

/// `POST /kiosk/biometric/sign-in` body.
struct BiometricSignInIn: Codable, Equatable, Sendable {
    var keyId: String
    var challenge: String
    var signature: String

    enum CodingKeys: String, CodingKey {
        case keyId = "key_id"
        case challenge
        case signature
    }

    init(keyId: String, challenge: String, signature: String) {
        self.keyId = keyId
        self.challenge = challenge
        self.signature = signature
    }
}

/// What this kiosk keeps about its enrolled person (`ss.kiosk.biometric`).
struct BiometricEnrollment: Codable, Equatable, Sendable {
    var keyId: String
    var personId: String
    var email: String?

    enum CodingKeys: String, CodingKey {
        case keyId = "key_id"
        case personId = "person_id"
        case email
    }

    init(keyId: String, personId: String, email: String? = nil) {
        self.keyId = keyId
        self.personId = personId
        self.email = email
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keyId = try c.decode(String.self, forKey: .keyId)
        personId = try c.decode(String.self, forKey: .personId)
        email = try c.decodeIfPresent(String.self, forKey: .email)
    }
}
