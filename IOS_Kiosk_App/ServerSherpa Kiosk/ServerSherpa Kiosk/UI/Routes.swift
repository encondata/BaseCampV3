import Foundation

/// The NavigationStack's destinations. Home is the stack's root and login is
/// not a route (KioskGuard shows it whenever the kiosk is signed out).
enum Route: Hashable {
    case setup
    case settings(SettingsTabId?)
    case scan, enroll, timeclock, containers, trucks, labels
    /// Under the Label Printing tile: Print Labels and Printer Setup.
    case labelsPrint, labelsPrinter
    /// The Rolodex (admins): the list, with the worker page beside it on a wide screen.
    case rolodex
    /// A narrow screen's worker page, pushed over the list (its own "‹ Rolodex" goes back).
    case rolodexWorker(String)

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
        case .rolodex: .rolodex
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
        case .labels, .labelsPrint, .labelsPrinter: .labels
        case .rolodex, .rolodexWorker: .rolodex
        }
    }
}
