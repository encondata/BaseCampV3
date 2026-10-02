import Foundation
import Observation

/// Runtime configuration: the stored URL wins, else the build default.
/// Computed from prefs on every read, so Observation tracks it and nothing is cached.
@MainActor @Observable
final class KioskConfig {
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let defaultApiUrl: String
    @ObservationIgnored private let defaultPortalUrl: String
    let kioskVersion: String

    init(
        prefs: KioskPrefs,
        defaultApiUrl: String = KioskBuildConfig.defaultApiUrl,
        defaultPortalUrl: String = KioskBuildConfig.defaultPortalUrl,
        kioskVersion: String = KioskBuildConfig.kioskVersion
    ) {
        self.prefs = prefs
        self.defaultApiUrl = defaultApiUrl
        self.defaultPortalUrl = defaultPortalUrl
        self.kioskVersion = kioskVersion
    }

    var apiUrl: String { Self.normalizeUrl(prefs.apiUrl ?? "") ?? defaultApiUrl }
    var portalUrl: String { Self.normalizeUrl(prefs.portalUrl ?? "") ?? defaultPortalUrl }

    /// Trimmed, trailing slashes removed; only http(s) origins with a non-empty host are accepted.
    nonisolated static func normalizeUrl(_ raw: String) -> String? {
        var v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while v.hasSuffix("/") { v.removeLast() }
        guard v.hasPrefix("http://") || v.hasPrefix("https://") else { return nil }
        guard let r = v.range(of: "://"), !v[r.upperBound...].isEmpty else { return nil }
        // Validate that the URL has a non-empty host
        guard let components = URLComponents(string: v), let host = components.host, !host.isEmpty else { return nil }
        return v
    }

    /// Stores the normalized URL; false (and nothing stored) when invalid.
    func setApiUrl(_ raw: String) -> Bool {
        guard let v = Self.normalizeUrl(raw) else { return false }
        prefs.apiUrl = v
        return true
    }

    func setPortalUrl(_ raw: String) -> Bool {
        guard let v = Self.normalizeUrl(raw) else { return false }
        prefs.portalUrl = v
        return true
    }
}
