import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct FeaturesTests {
    @Test func orderMatchesTheWebKiosk() {
        #expect(FEATURES.map(\.route) == ["setup", "scan", "enroll", "containers", "trucks", "labels", "timeclock", "settings"])
    }

    @Test func onlySetupAndSettingsAreAlwaysAvailable() {
        #expect(Set(FEATURES.filter(\.alwaysAvailable).map(\.id)) == [.setup, .settings])
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
                == [.setup, .scan, .enroll, .containers, .trucks, .labels, .timeclock, .rolodex, .settings])
        #expect(!homeFeatures(stationType: nil, isAdmin: false).map(\.id).contains(.rolodex))
        #expect(!homeFeatures(stationType: nil).map(\.id).contains(.rolodex))
        #expect(homeFeatures(stationType: "timeclock", isAdmin: true).map(\.title) == ["Time Clock", "Kiosk Setup", "Settings"])
        #expect(!homeFeatures(stationType: "label", isAdmin: true).map(\.id).contains(.rolodex))
        // the web kiosk's list stays as it is
        #expect(!FEATURES.map(\.id).contains(.rolodex))
    }

    @Test func rolodexFeatureResolves() {
        let rolodex = feature(.rolodex)
        #expect(rolodex == ROLODEX_FEATURE)
        #expect(rolodex.title == "Rolodex" && rolodex.route == "rolodex")
        #expect(rolodex.alwaysAvailable && !rolodex.placeholder)
        #expect(featureAvailable(rolodex, setupState: .incomplete))
        #expect(featureForRoute("rolodex")?.id == .rolodex)
        #expect(routeAllowed(.rolodexWorker("p1"), setupState: .failed, devMode: false))
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
