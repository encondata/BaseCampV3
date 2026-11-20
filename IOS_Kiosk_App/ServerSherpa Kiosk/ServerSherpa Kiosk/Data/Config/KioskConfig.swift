import Foundation
import Observation

/// Runtime configuration: the saved environment's addresses, else the build's default
/// environment's (`EnvironmentStore.current`). Computed from prefs on every read, so Observation
/// tracks it and nothing is cached.
@MainActor @Observable
final class KioskConfig {
    @ObservationIgnored private let store: EnvironmentStore
    @ObservationIgnored let defaultEnvironment: SavedEnvironment
    let kioskVersion: String

    init(
        store: EnvironmentStore,
        defaultEnvironment: SavedEnvironment = KioskBuildConfig.defaultEnvironment,
        kioskVersion: String = KioskBuildConfig.kioskVersion
    ) {
        self.store = store
        self.defaultEnvironment = defaultEnvironment
        self.kioskVersion = kioskVersion
    }

    /// The environment the kiosk connects to.
    var environment: SavedEnvironment { store.current(defaultEnvironment) }
    var apiUrl: String { environment.apiUrl }
    var portalUrl: String { environment.portalUrl }

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

    /// Saves typed URLs as a Custom environment, both normalized; false (and nothing saved) when
    /// either is invalid.
    func saveCustom(apiUrl: String, portalUrl: String) -> Bool {
        store.save(.custom(apiUrl: apiUrl, portalUrl: portalUrl))
    }
}
