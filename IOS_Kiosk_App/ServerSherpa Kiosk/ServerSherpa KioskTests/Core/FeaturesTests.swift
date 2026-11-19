import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct FeaturesTests {
    @Test func orderMatchesTheWebKiosk() {
        #expect(FEATURES.map(\.route) == ["setup", "scan", "enroll", "containers", "trucks", "labels", "timeclock", "troubleshooting", "settings"])
    }

    @Test func onlySetupTroubleshootingAndSettingsAreAlwaysAvailable() {
        #expect(Set(FEATURES.filter(\.alwaysAvailable).map(\.id)) == [.setup, .troubleshooting, .settings])
    }

    @Test func placeholdersAreContainersAndTrucks() {
        #expect(Set(FEATURES.filter(\.placeholder).map(\.id)) == [.containers, .trucks])
    }

    /// Asset labels only on this kiosk (Android's Features.kt).
    @Test func labelPrintingPrintsAssetLabels() {
        #expect(feature(.labels).title == "Label Printing")
        #expect(feature(.labels).blurb == "Print asset labels.")
        #expect(!feature(.labels).placeholder)
    }

    @Test func availabilityFollowsSetupStateUnlessDevMode() {
        let scan = feature(.scan)
        #expect(!featureAvailable(scan, setupState: .incomplete))
        #expect(!featureAvailable(scan, setupState: .failed))
        #expect(featureAvailable(scan, setupState: .complete))
        #expect(featureAvailable(scan, setupState: .incomplete, devMode: true))
        #expect(featureAvailable(feature(.settings), setupState: .incomplete))
    }

    @Test func featureForRouteStripsQueryAndChildren() {
        #expect(featureForRoute("settings?tab=admin")?.id == .settings)
        #expect(featureForRoute("labels/printers")?.id == .labels)
        #expect(featureForRoute("home") == nil)
        #expect(featureForRoute(nil) == nil)
    }

    /// The Rolodex (native apps only): a full kiosk Home shows it to admins, before Settings;
    /// never a station Home, never a non-admin. It needs no move, so it's always available.
    @Test func rolodexIsOnTheFullHomeForAdminsOnly() {
        #expect(homeFeatures(stationType: nil, isAdmin: true).map(\.id)
                == [.setup, .scan, .enroll, .containers, .trucks, .labels, .timeclock, .rolodex, .troubleshooting, .settings])
        #expect(!homeFeatures(stationType: nil, isAdmin: false).map(\.id).contains(.rolodex))
        #expect(!homeFeatures(stationType: nil).map(\.id).contains(.rolodex))
        #expect(homeFeatures(stationType: "timeclock", isAdmin: true).map(\.title) == ["Time Clock", "Kiosk Setup", "Troubleshooting", "Settings"])
        #expect(!homeFeatures(stationType: "label", isAdmin: true).map(\.id).contains(.rolodex))
        // the web kiosk's list stays as it is
        #expect(!FEATURES.map(\.id).contains(.rolodex))
    }

    @Test func rolodexFeatureResolves() {
        let rolodex = feature(.rolodex)
        #expect(rolodex == ROLODEX_FEATURE)
        #expect(rolodex.title == "Rolodex" && rolodex.route == "rolodex")
        // the same sentence as the Android tile (ruling S16)
        #expect(rolodex.blurb == "Look up workers, edit their details, and take photos.")
        #expect(rolodex.alwaysAvailable && !rolodex.placeholder)
        #expect(featureAvailable(rolodex, setupState: .incomplete))
        #expect(featureForRoute("rolodex")?.id == .rolodex)
        #expect(routeAllowed(.rolodexWorker("p1"), setupState: .failed, devMode: false))
    }

    /// The Troubleshooting tile (web/Android): always available, immediately before Settings on
    /// every Home list, and routed like Settings (no setup gate).
    @Test func troubleshootingSitsBeforeSettingsEverywhere() {
        let t = feature(.troubleshooting)
        #expect(t.title == "Troubleshooting")
        #expect(t.blurb == "Fix common problems with kiosk hardware.")
        #expect(t.route == "troubleshooting")
        #expect(t.alwaysAvailable && !t.placeholder)
        #expect(Array(homeFeatures(stationType: nil).map(\.id).suffix(2)) == [.troubleshooting, .settings])
        #expect(Array(homeFeatures(stationType: nil, isAdmin: true).map(\.id).suffix(3)) == [.rolodex, .troubleshooting, .settings])
        let station = homeFeatures(stationType: "timeclock")
        #expect(station.first == TIMECLOCK_STATION_FEATURE)
        #expect(station.dropFirst().map(\.id) == [.setup, .troubleshooting, .settings])
        #expect(homeTiles(setupState: .incomplete, devMode: false).map(\.feature.id).contains(.troubleshooting))
        #expect(featureForRoute("troubleshooting")?.id == .troubleshooting)
        #expect(featureForRoute("troubleshooting/zebra-ds22")?.id == .troubleshooting)
        #expect(Route.forFeature(.troubleshooting) == .troubleshooting)
        #expect(Route.troubleshootingTopic("zebra-ds22").featureId == .troubleshooting)
        #expect(routeAllowed(.troubleshooting, setupState: .incomplete, devMode: false))
        #expect(routeAllowed(.troubleshootingTopic("nope"), setupState: .failed, devMode: false))
    }

    @Test func setupStateWire() {
        #expect(SetupState.fromWire("complete") == .complete)
        #expect(SetupState.fromWire("failed") == .failed)
        #expect(SetupState.fromWire("bogus") == .incomplete)
        #expect(SetupState.fromWire(nil) == .incomplete)
        #expect(SetupState.complete.isComplete && !SetupState.failed.isComplete)
        #expect(SetupState.incomplete.label == "Incomplete")
    }
}
