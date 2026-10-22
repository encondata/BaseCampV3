import Foundation

/// The Time Clock station's key (Android `StationKeyStore`). `POST /kiosk/station-key`
/// shows it once; it lives only in the secret store (the Keychain in the app,
/// this-device-only, after first unlock), never in UserDefaults and never in a log.
/// It survives a relaunch, so an armed station comes back ready.
final class StationKeyStore: Sendable {
    static let account = "station_key"
    /// The API origin (scheme://host:port) the key was issued by; the key is only ever sent there.
    static let originAccount = "station_key_origin"

    private let secrets: SecretStore

    init(secrets: SecretStore) {
        self.secrets = secrets
    }

    /// The stored key; nil when there is none (a blank value counts as none).
    func get() -> String? {
        guard let key = secrets.get(Self.account), !key.isEmpty else { return nil }
        return key
    }

    /// Stores the key, with the API origin it was issued by (nil leaves no origin, which no
    /// station call accepts).
    func put(_ key: String, origin: String? = nil) {
        secrets.set(Self.account, key)
        secrets.set(Self.originAccount, origin)
    }

    /// The API origin the stored key belongs to.
    func origin() -> String? {
        guard let origin = secrets.get(Self.originAccount), !origin.isEmpty else { return nil }
        return origin
    }

    func clear() {
        secrets.set(Self.account, nil)
        secrets.set(Self.originAccount, nil)
    }
}
