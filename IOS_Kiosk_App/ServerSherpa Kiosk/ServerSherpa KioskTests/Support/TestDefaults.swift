import Foundation

/// An isolated, empty UserDefaults suite.
func freshDefaults() -> UserDefaults {
    let name = "test-\(UUID())"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}
