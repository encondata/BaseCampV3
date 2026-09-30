import Foundation

/// The web kiosk lets the browser hold `ss_refresh`; here the Keychain-backed
/// `SecretStore` holds its value, keyed by the API host. URLSession's own
/// cookie storage is off, so no other cookie is kept at all.
final class RefreshCookie: Sendable {
    static let name = "ss_refresh"

    private let secrets: SecretStore

    init(secrets: SecretStore) {
        self.secrets = secrets
    }

    private func key(_ host: String) -> String { "refresh.\(host)" }

    func value(forHost host: String) -> String? {
        secrets.get(key(host))
    }

    /// Saves a `Set-Cookie: ss_refresh=…` from `response`; an empty value or an
    /// expiry in the past (e.g. `Max-Age=0`) deletes it. No such cookie: no change.
    func capture(from response: HTTPURLResponse, url: URL) {
        guard let parsed = Self.parse(from: response, url: url) else { return }
        secrets.set(key(parsed.host), parsed.value)
    }

    /// The `ss_refresh` a response sets, without keeping it: nil when it sets
    /// none; a nil value when it deletes it (empty, or already expired).
    static func parse(from response: HTTPURLResponse, url: URL) -> (host: String, value: String?)? {
        guard let host = url.host else { return nil }
        var fields: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            guard let name = name as? String, let value = value as? String else { continue }
            fields[name.caseInsensitiveCompare("Set-Cookie") == .orderedSame ? "Set-Cookie" : name] = value
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
        guard let cookie = cookies.last(where: { $0.name == Self.name }) else { return nil }
        let emptied = cookie.value.isEmpty || cookie.value == "\"\""
        let expired = cookie.expiresDate.map { $0 <= Date() } ?? false
        return (host, emptied || expired ? nil : cookie.value)
    }

    func set(host: String, value: String) {
        secrets.set(key(host), value)
    }

    func clear(host: String) {
        secrets.set(key(host), nil)
    }
}
