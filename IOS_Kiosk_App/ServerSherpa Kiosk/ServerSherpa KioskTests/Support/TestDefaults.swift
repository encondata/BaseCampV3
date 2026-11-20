import Foundation
@testable import ServerSherpa_Kiosk

/// An isolated, empty UserDefaults suite.
func freshDefaults() -> UserDefaults {
    let name = "test-\(UUID())"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}

extension KioskPrefs {
    /// Saves a Custom environment on `api` (with `portal`), as a kiosk pointed at a typed
    /// server has.
    func useApi(_ api: String, portal: String = "https://portal.example") {
        let saved = EnvironmentStore(prefs: self).save(.custom(apiUrl: api, portalUrl: portal))
        precondition(saved, "not a usable Custom pair: \(api) \(portal)")
    }
}
