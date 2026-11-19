import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct FeaturesTests {
    @Test func orderMatchesTheWebKiosk() {
        #expect(FEATURES.map(\.route) == ["setup", "scan", "enroll", "containers", "trucks", "lookup", "labels", "timeclock", "settings"])
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
                == [.setup, .scan, .enroll, .containers, .trucks, .lookup, .labels, .timeclock, .rolodex, .settings])
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
        // the same sentence as the Android tile (ruling S16)
        #expect(rolodex.blurb == "Look up workers, edit their details, and take photos.")
        #expect(rolodex.alwaysAvailable && !rolodex.placeholder)
        #expect(featureAvailable(rolodex, setupState: .incomplete))
        #expect(featureForRoute("rolodex")?.id == .rolodex)
        #expect(routeAllowed(.rolodexWorker("p1"), setupState: .failed, devMode: false))
    }

    /// Asset Lookup (Android's Features.kt): the tile's words, a move tile (needs setup), its route
    /// resolves, and it sits on Home after Trucks. A Time Clock station's Home doesn't get it.
    @Test func lookupFeatureResolves() {
        let lookup = feature(.lookup)
        #expect(lookup == LOOKUP_FEATURE)
        #expect(lookup.title == "Asset Lookup" && lookup.route == "lookup")
        #expect(lookup.blurb == "Scan an asset to see what it is and where it goes.")
        #expect(!lookup.alwaysAvailable && !lookup.placeholder)
        #expect(!featureAvailable(lookup, setupState: .incomplete))
        #expect(featureAvailable(lookup, setupState: .complete))
        #expect(featureForRoute("lookup")?.id == .lookup)
        #expect(Route.forFeature(.lookup) == .lookup)
        #expect(!routeAllowed(.lookup, setupState: .incomplete, devMode: false))
        // Android's FeatureId order: after Trucks, before Label Printing
        let ids = FeatureId.allCases
        #expect(ids.firstIndex(of: .lookup) == ids.firstIndex(of: .trucks).map { $0 + 1 })
        let home = FEATURES.map(\.id)
        #expect(home.firstIndex(of: .lookup) == home.firstIndex(of: .trucks).map { $0 + 1 })
        #expect(home.filter { $0 == .lookup }.count == 1)
        #expect(!homeFeatures(stationType: "timeclock", isAdmin: true).map(\.id).contains(.lookup))
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
