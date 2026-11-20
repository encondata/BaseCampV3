import Foundation

let rootDomain = "serversherpa.com"
let customLabel = "Custom"

/// One named environment of the published list: its addresses follow from `domain`.
struct Env: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let domain: String

    var apiUrl: String { "https://api.\(domain)" }
    var portalUrl: String { "https://portal.\(domain)" }
}

/// What the kiosk saved: a named environment (always connected to by its saved domain, whatever a
/// later list says) or a typed Custom pair. Saved as `{"kind":"named","id","name","domain"}` or
/// `{"kind":"custom","api_url","portal_url"}`.
enum SavedEnvironment: Codable, Equatable {
    case named(id: String, name: String, domain: String)
    case custom(apiUrl: String, portalUrl: String)

    private enum CodingKeys: String, CodingKey {
        case kind, id, name, domain
        case apiUrl = "api_url"
        case portalUrl = "portal_url"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "named":
            self = .named(id: try c.decode(String.self, forKey: .id),
                          name: try c.decode(String.self, forKey: .name),
                          domain: try c.decode(String.self, forKey: .domain))
        case "custom":
            self = .custom(apiUrl: try c.decode(String.self, forKey: .apiUrl),
                           portalUrl: try c.decode(String.self, forKey: .portalUrl))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown kind \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .named(id, name, domain):
            try c.encode("named", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
            try c.encode(domain, forKey: .domain)
        case let .custom(apiUrl, portalUrl):
            try c.encode("custom", forKey: .kind)
            try c.encode(apiUrl, forKey: .apiUrl)
            try c.encode(portalUrl, forKey: .portalUrl)
        }
    }

    var apiUrl: String {
        switch self {
        case let .named(_, _, domain): "https://api.\(domain)"
        case let .custom(apiUrl, _): apiUrl
        }
    }

    var portalUrl: String {
        switch self {
        case let .named(_, _, domain): "https://portal.\(domain)"
        case let .custom(_, portalUrl): portalUrl
        }
    }

    var isProd: Bool {
        if case let .named(_, _, domain) = self { return domain == rootDomain }
        return false
    }

    var label: String {
        switch self {
        case let .named(_, name, _): name
        case .custom: customLabel
        }
    }
}

extension Env {
    /// `self` as the environment a kiosk saves when it is picked.
    var asSaved: SavedEnvironment { .named(id: id, name: name, domain: domain) }
}

/// The environments a kiosk can pick: the built-in list, the rules for the published list at
/// status.serversherpa.com, and the migration of URLs typed before the picker existed. Mirrors
/// the Android and laptop-edge implementations.
enum Environments {
    static let statusListURL = "https://status.serversherpa.com/environments.json"
    static let password = "cumulus"
    static let maxBody = 64 * 1024

    static let builtIn: [Env] = [
        Env(id: "prod", name: "Prod", domain: rootDomain),
        Env(id: "rc1", name: "RC1", domain: "rc1.\(rootDomain)"),
        Env(id: "uat", name: "UAT", domain: "uat.\(rootDomain)"),
        Env(id: "beta", name: "Beta", domain: "beta.\(rootDomain)"),
        Env(id: "alpha", name: "Alpha", domain: "alpha.\(rootDomain)"),
        Env(id: "dev", name: "Dev", domain: "dev.\(rootDomain)"),
    ]

    static func byId(_ id: String) -> Env? { builtIn.first { $0.id == id } }

    /// The valid entries of a downloaded list in file order, or nil when the file is unusable
    /// (too big, not JSON, wrong version, no valid entry).
    static func parseList(_ data: Data) -> [Env]? {
        if data.count > maxBody { return nil }
        guard let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard let version = doc["version"] as? NSNumber, isWholeOne(version) else { return nil }
        guard let entries = doc["environments"] as? [Any] else { return nil }
        var seen = Set<String>()
        var out: [Env] = []
        for item in entries {
            guard let env = toEnv(item), seen.insert(env.id).inserted else { continue }
            out.append(env)
        }
        return out.isEmpty ? nil : out
    }

    /// Exactly the JSON number 1: not true, not 1.0, not a string.
    private static func isWholeOne(_ n: NSNumber) -> Bool {
        CFGetTypeID(n) == CFNumberGetTypeID() && !CFNumberIsFloatType(n) && n.int64Value == 1
    }

    private static func toEnv(_ item: Any) -> Env? {
        guard let obj = item as? [String: Any],
              let id = obj["id"] as? String,
              let name = obj["name"] as? String,
              let domain = obj["domain"] as? String
        else { return nil }
        let env = Env(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), domain: domain)
        return isValid(env) ? env : nil
    }

    /// Whether `env` passes the list's entry rules (id, non-blank name, a serversherpa.com domain).
    /// A saved named environment is checked with these too when it is read back.
    static func isValid(_ env: Env) -> Bool {
        isValidId(env.id)
            && !env.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && isValidDomain(env.domain)
    }

    /// `^[a-z][a-z0-9-]{1,31}$`, not ending in `-`. Checked by hand: ICU's `$` would also accept a
    /// trailing newline.
    private static func isValidId(_ id: String) -> Bool {
        let b = Array(id.utf8)
        guard (2...32).contains(b.count), isLower(b[0]), b.last != dash else { return false }
        return b.dropFirst().allSatisfy { isLower($0) || isDigit($0) || $0 == dash }
    }

    /// Exactly `serversherpa.com` or a lower-case subdomain of it: labels of 1-63 letters, digits
    /// and inner hyphens, no scheme, port, path or user info.
    private static func isValidDomain(_ domain: String) -> Bool {
        if domain == rootDomain { return true }
        let suffix = "." + rootDomain
        guard domain.hasSuffix(suffix) else { return false }
        let labels = domain.dropLast(suffix.count).split(separator: ".", omittingEmptySubsequences: false)
        return !labels.isEmpty && labels.allSatisfy { label in
            let b = Array(label.utf8)
            guard (1...63).contains(b.count) else { return false }
            let alnum: (UInt8) -> Bool = { isLower($0) || isDigit($0) }
            return alnum(b[0]) && alnum(b[b.count - 1]) && b.allSatisfy { alnum($0) || $0 == dash }
        }
    }

    private static let dash = UInt8(ascii: "-")
    private static func isLower(_ c: UInt8) -> Bool { c >= UInt8(ascii: "a") && c <= UInt8(ascii: "z") }
    private static func isDigit(_ c: UInt8) -> Bool { c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") }

    /// The kiosk's saved typed URLs as an environment: a built-in one when the API URL is exactly its
    /// `https://api.<domain>` (scheme and host in any case, default port and a trailing slash
    /// ignored; no path, query or user info), else Custom. `defaultPortal` stands in when no portal
    /// URL was saved. Nil when nothing usable was saved, so nothing is migrated.
    static func migrate(savedApi: String?, savedPortal: String?, defaultPortal: String) -> SavedEnvironment? {
        guard let api = cleanUrl(savedApi) else { return nil }
        let portal = cleanUrl(savedPortal) ?? defaultPortal
        if let origin = bareOrigin(api) {
            for env in builtIn where origin == bareOrigin(env.apiUrl) {
                return .named(id: env.id, name: env.name, domain: env.domain)
            }
        }
        return .custom(apiUrl: api, portalUrl: portal)
    }

    /// Trimmed, trailing `/` removed, http(s) with a host; nil otherwise.
    private static func cleanUrl(_ raw: String?) -> String? {
        guard var v = raw?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        while v.hasSuffix("/") { v.removeLast() }
        guard let parts = URLComponents(string: v),
              let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host, !host.isEmpty
        else { return nil }
        return v
    }

    /// `scheme://host:port` (lower case, default port filled in) of a URL that is only an origin:
    /// nil when it has a path, query, fragment or user info.
    private static func bareOrigin(_ url: String) -> String? {
        guard let parts = URLComponents(string: url),
              parts.path.isEmpty, parts.query == nil, parts.fragment == nil,
              parts.user == nil, parts.password == nil,
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased()
        else { return nil }
        let port: Int
        if let p = parts.port { port = p }
        else if scheme == "https" { port = 443 }
        else if scheme == "http" { port = 80 }
        else { return nil }
        return "\(scheme)://\(host):\(port)"
    }
}
