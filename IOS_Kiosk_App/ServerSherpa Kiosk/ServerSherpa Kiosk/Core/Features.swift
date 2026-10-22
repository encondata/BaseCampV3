import Foundation

enum FeatureId: String, CaseIterable, Sendable {
    case setup, scan, enroll, containers, trucks, labels, timeclock, settings
}

/// One launcher tile / route. `placeholder` features open the generic
/// "not available yet" page; `alwaysAvailable` ones ignore setup state.
struct KioskFeature: Equatable, Identifiable, Sendable {
    let id: FeatureId
    let route: String
    let title: String
    let blurb: String
    var placeholder: Bool = false
    var alwaysAvailable: Bool = false
}

/// Same order and copy as kiosk/src/lib/features.ts, except Label Printing: asset labels only here.
let FEATURES: [KioskFeature] = [
    KioskFeature(id: .setup, route: "setup", title: "Kiosk Setup", blurb: "Set up this kiosk for a move.", alwaysAvailable: true),
    KioskFeature(id: .scan, route: "scan", title: "Scanning", blurb: "Scan assets, containers, and badges."),
    KioskFeature(id: .enroll, route: "enroll", title: "RFID Enroll", blurb: "Scan an asset, then scan its RFID tag."),
    KioskFeature(id: .containers, route: "containers", title: "Containers", blurb: "Pack and unpack containers by scanning.", placeholder: true),
    KioskFeature(id: .trucks, route: "trucks", title: "Trucks", blurb: "Load and unload trucks by scanning.", placeholder: true),
    KioskFeature(id: .labels, route: "labels", title: "Label Printing", blurb: "Print asset labels."),
    KioskFeature(id: .timeclock, route: "timeclock", title: "Timeclock", blurb: "Clock in and out of a move."),
    KioskFeature(id: .settings, route: "settings", title: "Settings", blurb: "Appearance, sound, devices, and more.", alwaysAvailable: true),
]

/// The Time Clock station's Home tile (web `TIMECLOCK_STATION_FEATURE`): signs the person out,
/// which lands the station on its Welcome screen. Not in FEATURES: only a Time Clock station's
/// Home shows it, first. It shares the Timeclock icon.
let TIMECLOCK_STATION_FEATURE = KioskFeature(id: .timeclock, route: "timeclock/station", title: "Time Clock",
                                             blurb: "Start the time clock for workers.")

/// What Home shows (web `homeFeatures`): a Time Clock station only Time Clock, Kiosk Setup and
/// Settings (web `STATION_TILES.timeclock`; Jimmy owns these lists); any other kiosk every feature.
func homeFeatures(stationType: String?) -> [KioskFeature] {
    guard stationType == "timeclock" else { return FEATURES }
    return [TIMECLOCK_STATION_FEATURE, feature(.setup), feature(.settings)]
}

func feature(_ id: FeatureId) -> KioskFeature {
    FEATURES.first { $0.id == id }!
}

/// The feature whose route the nav destination is (route may carry `?tab=`).
func featureForRoute(_ route: String?) -> KioskFeature? {
    guard let route else { return nil }
    let base = route.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first
        .map { $0.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? "" } ?? ""
    return FEATURES.first { $0.route == base }
}

/// Always for alwaysAvailable features or in dev mode; otherwise only once setup is complete.
func featureAvailable(_ f: KioskFeature, setupState: SetupState, devMode: Bool = false) -> Bool {
    devMode || f.alwaysAvailable || setupState.isComplete
}
