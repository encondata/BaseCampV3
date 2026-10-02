import Foundation

/// The NavigationStack's destinations. Home is the stack's root and login is
/// not a route (KioskGuard shows it whenever the kiosk is signed out).
enum Route: Hashable {
    case setup
    case settings(SettingsTabId?)
    case scan, enroll, timeclock, containers, trucks, labels

    static func forFeature(_ id: FeatureId) -> Route {
        switch id {
        case .setup: .setup
        case .scan: .scan
        case .enroll: .enroll
        case .containers: .containers
        case .trucks: .trucks
        case .labels: .labels
        case .timeclock: .timeclock
        case .settings: .settings(nil)
        }
    }

    var featureId: FeatureId {
        switch self {
        case .setup: .setup
        case .settings: .settings
        case .scan: .scan
        case .enroll: .enroll
        case .timeclock: .timeclock
        case .containers: .containers
        case .trucks: .trucks
        case .labels: .labels
        }
    }
}
