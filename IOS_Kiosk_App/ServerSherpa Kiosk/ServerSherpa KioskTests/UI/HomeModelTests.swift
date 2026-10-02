import SwiftUI
import Testing
@testable import ServerSherpa_Kiosk

/// Android HomeScreenTest.kt, as model cases: what the launcher shows is `homeTiles` + `homeBanner`.
struct HomeModelTests {
    @Test func incompleteSetupLocksFeatureTiles() {
        let banner = homeBanner(setupState: .incomplete, devMode: false)
        #expect(banner?.text == "Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.")
        #expect(banner?.error == false)
        let tiles = homeTiles(setupState: .incomplete, devMode: false)
        #expect(tiles.map(\.feature.id) == FEATURES.map(\.id))
        #expect(tiles.filter { $0.lockedReason == "Finish Kiosk Setup first." }.count == 6)
        #expect(tiles.filter(\.available).map(\.feature.id) == [.setup, .settings])
    }

    @Test func failedSetupSaysSo() {
        let banner = homeBanner(setupState: .failed, devMode: false)
        #expect(banner?.text == "Kiosk setup failed. Open Kiosk Setup to try again.")
        #expect(banner?.error == true)
        #expect(homeTiles(setupState: .failed, devMode: false).filter { $0.lockedReason == "Kiosk setup failed — open Kiosk Setup." }.count == 6)
    }

    @Test func devModeUnlocksWithBanner() {
        #expect(homeBanner(setupState: .failed, devMode: true)?.text == "Developer mode: all features are available while kiosk setup is failed.")
        let tiles = homeTiles(setupState: .failed, devMode: true)
        #expect(tiles.allSatisfy { $0.available })
        #expect(tiles.allSatisfy { $0.lockedReason == nil })
    }

    @Test func completeSetupHasNoBannerAndNoLocks() {
        #expect(homeBanner(setupState: .complete, devMode: false) == nil)
        #expect(homeBanner(setupState: .complete, devMode: true) == nil)
        #expect(homeTiles(setupState: .complete, devMode: false).allSatisfy { $0.available })
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

    @Test func routesMapFromFeatures() {
        #expect(Route.forFeature(.settings) == .settings(nil))
        #expect(Route.forFeature(.labels) == .labels)
        for id in FeatureId.allCases { #expect(Route.forFeature(id).featureId == id) }
    }
}
