import Foundation
import Security

/// Where the refresh cookie lives at rest. A nil value deletes the key.
protocol SecretStore: AnyObject, Sendable {
    func get(_ key: String) -> String?
    func set(_ key: String, _ value: String?)
}

final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var map: [String: String] = [:]

    func get(_ key: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return map[key]
    }

    func set(_ key: String, _ value: String?) {
        lock.lock(); defer { lock.unlock() }
        map[key] = value
    }
}

/// Generic-password Keychain items under one service; stateless, so safe from any thread.
final class KeychainSecretStore: SecretStore {
    static let service = "com.serversherpa.kiosk.session"

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: key,
        ]
    }

    func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ key: String, _ value: String?) {
        SecItemDelete(query(key) as CFDictionary)
        guard let value else { return }
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
