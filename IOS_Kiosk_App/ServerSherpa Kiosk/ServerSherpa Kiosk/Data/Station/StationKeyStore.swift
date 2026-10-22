import Foundation

/// The Time Clock station's key (Android `StationKeyStore`). `POST /kiosk/station-key`
/// shows it once; it lives only in the secret store (the Keychain in the app,
/// this-device-only, after first unlock), never in UserDefaults and never in a log.
/// It survives a relaunch, so an armed station comes back ready.
final class StationKeyStore: Sendable {
    static let account = "station_key"

    private let secrets: SecretStore

    init(secrets: SecretStore) {
        self.secrets = secrets
    }

    /// The stored key; nil when there is none (a blank value counts as none).
    func get() -> String? {
        guard let key = secrets.get(Self.account), !key.isEmpty else { return nil }
        return key
    }

    func put(_ key: String) { secrets.set(Self.account, key) }

    func clear() { secrets.set(Self.account, nil) }
}
