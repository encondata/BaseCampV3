import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// Android HomeScreenTest.kt, as model cases: what the launcher shows is `homeTiles` + `homeBanner`.
struct HomeModelTests {
    /// Jimmy 2026-11-17: before setup, Home hides every app but Kiosk Setup, the Rolodex (admins)
    /// and Settings, rather than showing them locked. Troubleshooting stays too (2026-11-19).
    @Test func incompleteSetupShowsOnlySetupTroubleshootingAndSettings() {
        let banner = homeBanner(setupState: .incomplete, devMode: false)
        #expect(banner?.text == "Kiosk setup is incomplete. Finish Kiosk Setup to see the other apps.")
        #expect(banner?.error == false)
        #expect(homeTiles(setupState: .incomplete, devMode: false).map(\.feature.id) == [.setup, .troubleshooting, .settings])
    }

    @Test func failedSetupSaysSo() {
        let banner = homeBanner(setupState: .failed, devMode: false)
        #expect(banner?.text == "Kiosk setup failed. Open Kiosk Setup to try again.")
        #expect(banner?.error == true)
        #expect(homeTiles(setupState: .failed, devMode: false).map(\.feature.id) == [.setup, .troubleshooting, .settings])
    }

    @Test func devModeShowsEveryAppWithBanner() {
        #expect(homeBanner(setupState: .failed, devMode: true)?.text == "Developer mode: all features are available while kiosk setup is failed.")
        #expect(homeTiles(setupState: .failed, devMode: true).map(\.feature.id) == FEATURES.map(\.id))
    }

    @Test func completeSetupHasNoBannerAndNoLocks() {
        #expect(homeBanner(setupState: .complete, devMode: false) == nil)
        #expect(homeBanner(setupState: .complete, devMode: true) == nil)
        #expect(homeTiles(setupState: .complete, devMode: false).map(\.feature.id) == FEATURES.map(\.id))
    }

    @Test func threeColumnsFromAThousandPoints() {
        #expect(homeColumns(width: 1000) == 3)
        #expect(homeColumns(width: 1366) == 3)
        #expect(homeColumns(width: 999) == 2)
        #expect(homeColumns(width: 390) == 2)
    }

    @Test func everyFeatureHasAnIconInsideItsViewport() {
        for id in FeatureId.allCases {
            let icon = FeatureIcons.icon(id)
            #expect(!icon.strokes.isEmpty || !icon.fills.isEmpty)
            let box = (icon.strokes + icon.fills).map { $0.boundingRect }.reduce(CGRect.null) { $0.union($1) }
            #expect(box.minX >= 0 && box.minY >= 0 && box.maxX <= 40 && box.maxY <= 40, "\(id) \(box)")
        }
    }

    @Test func svgArcsTraceACircle() {
        let p = SvgPath.parse("M15.5,20 a4.5,4.5 0 1,0 9,0 a4.5,4.5 0 1,0 -9,0")
        let box = p.boundingRect
        #expect(abs(box.minX - 15.5) < 0.05 && abs(box.maxX - 24.5) < 0.05)
        #expect(abs(box.minY - 15.5) < 0.05 && abs(box.maxY - 24.5) < 0.05)
    }

    /// An admin's Home has the Rolodex tile (before Settings), usable before Kiosk Setup.
    @Test func adminsSeeTheRolodexTile() {
        #expect(homeTiles(setupState: .incomplete, devMode: false, isAdmin: true).map(\.feature.id) == [.setup, .rolodex, .troubleshooting, .settings])
        #expect(homeTiles(setupState: .complete, devMode: false, isAdmin: true).map(\.feature.id)
                == [.setup, .scan, .enroll, .containers, .trucks, .lookup, .labels, .timeclock, .rolodex, .troubleshooting, .settings])
        #expect(homeTiles(setupState: .complete, devMode: false, isAdmin: false).map(\.feature.id) == FEATURES.map(\.id))
        #expect(homeTiles(setupState: .complete, devMode: false, stationType: "timeclock", isAdmin: true).count == 4)
    }

    /// Asset Lookup is a move tile: hidden until Kiosk Setup is done (iOS's Home rule), then after
    /// Trucks for everyone; developer mode shows it; a Time Clock station's Home never does.
    @Test func lookupTileShowsOnlyOnceSetupIsDone() {
        for admin in [false, true] {
            #expect(!homeTiles(setupState: .incomplete, devMode: false, isAdmin: admin).map(\.feature.id).contains(.lookup))
            #expect(!homeTiles(setupState: .failed, devMode: false, isAdmin: admin).map(\.feature.id).contains(.lookup))
            let done = homeTiles(setupState: .complete, devMode: false, isAdmin: admin).map(\.feature.id)
            #expect(done.firstIndex(of: .lookup) == done.firstIndex(of: .trucks).map { $0 + 1 })
        }
        #expect(homeTiles(setupState: .incomplete, devMode: true).map(\.feature.id).contains(.lookup))
        #expect(!homeTiles(setupState: .complete, devMode: false, stationType: "timeclock", isAdmin: true)
            .map(\.feature.id).contains(.lookup))
        #expect(Route.forFeature(.lookup) == .lookup)
    }

    @Test func routesMapFromFeatures() {
        #expect(Route.forFeature(.settings) == .settings(nil))
        #expect(Route.forFeature(.labels) == .labels)
        for id in FeatureId.allCases { #expect(Route.forFeature(id).featureId == id) }
        // Print Labels and Printer Setup live under the Label Printing tile.
        #expect(Route.labelsPrint.featureId == .labels)
        #expect(Route.labelsPrinter.featureId == .labels)
        // a phone's worker page lives under the Rolodex
        #expect(Route.forFeature(.rolodex) == .rolodex)
        #expect(Route.rolodexWorker("p1").featureId == .rolodex)
    }
}
