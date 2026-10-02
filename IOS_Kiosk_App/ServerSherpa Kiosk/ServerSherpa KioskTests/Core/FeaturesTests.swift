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

    @Test func placeholdersAreContainersTrucksLabels() {
        #expect(Set(FEATURES.filter(\.placeholder).map(\.id)) == [.containers, .trucks, .labels])
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

    @Test func setupStateWire() {
        #expect(SetupState.fromWire("complete") == .complete)
        #expect(SetupState.fromWire("failed") == .failed)
        #expect(SetupState.fromWire("bogus") == .incomplete)
        #expect(SetupState.fromWire(nil) == .incomplete)
        #expect(SetupState.complete.isComplete && !SetupState.failed.isComplete)
        #expect(SetupState.incomplete.label == "Incomplete")
    }
}
