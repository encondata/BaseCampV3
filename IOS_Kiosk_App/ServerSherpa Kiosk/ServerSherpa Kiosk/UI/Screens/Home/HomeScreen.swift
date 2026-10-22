import SwiftUI

// MARK: - What the launcher shows (pure, tested)

struct HomeTile: Equatable {
    let feature: KioskFeature
    let available: Bool
    /// The line under an unavailable tile.
    let lockedReason: String?
}

/// `isAdmin` (rank 60+) adds the Rolodex tile on a full kiosk Home.
func homeTiles(setupState: SetupState, devMode: Bool, stationType: String? = nil, isAdmin: Bool = false) -> [HomeTile] {
    homeFeatures(stationType: stationType, isAdmin: isAdmin).map { f in
        let available = featureAvailable(f, setupState: setupState, devMode: devMode)
        let reason = available ? nil : (setupState == .failed ? "Kiosk setup failed — open Kiosk Setup." : "Finish Kiosk Setup first.")
        return HomeTile(feature: f, available: available, lockedReason: reason)
    }
}

/// The banner above the tiles while setup is not complete.
func homeBanner(setupState: SetupState, devMode: Bool) -> (text: String, error: Bool)? {
    if setupState == .complete { return nil }
    if devMode { return ("Developer mode: all features are available while kiosk setup is \(setupState.rawValue).", false) }
    if setupState == .failed { return ("Kiosk setup failed. Open Kiosk Setup to try again.", true) }
    return ("Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.", false)
}

/// Three columns once the content is 1000 pt wide, else two.
func homeColumns(width: CGFloat) -> Int { width >= 1000 ? 3 : 2 }

// MARK: - The screen

/// kiosk/src/pages/Home.tsx: the launcher.
struct HomeScreen: View {
    @Binding var path: [Route]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ScrollView { HomeContent(path: $path) }
            .background(palette.paper2)
    }
}

/// The launcher's page body: header, setup banner, tiles.
struct HomeContent: View {
    @Binding var path: [Route]
    @Environment(KioskPrefs.self) private var prefs
    @Environment(KioskAuth.self) private var auth
    @Environment(\.kioskPalette) private var palette
    @State private var width: CGFloat = 0
    @State private var leaving = false

    private var isAdmin: Bool {
        if case .authed(let s) = auth.state { return s.isAdmin }
        return false
    }

    var body: some View {
        let banner = homeBanner(setupState: prefs.setupState, devMode: prefs.devMode)
        let tiles = homeTiles(setupState: prefs.setupState, devMode: prefs.devMode, stationType: prefs.setupSelection?.stationType,
                              isAdmin: isAdmin)
        let perRow = homeColumns(width: width)
        let rows = stride(from: 0, to: tiles.count, by: perRow).map { Array(tiles[$0..<min($0 + perRow, tiles.count)]) }
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(eyebrow: "Kiosk", title: "What would you like to do?")
            if let banner { KioskToast(text: banner.text, error: banner.error) }
            // A Grid, not a LazyVGrid: every tile in a row takes the row's height, so a tile
            // without the "Finish Kiosk Setup first." line is not shorter than its neighbor.
            Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r], id: \.feature.id) { tileView($0) }
                        ForEach(0..<(perRow - rows[r].count), id: \.self) { _ in Color.clear.gridCellUnsizedAxes([.horizontal, .vertical]) }
                    }
                }
            }
            .padding(.top, 12)
        }
        .padding(16)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func tileView(_ tile: HomeTile) -> some View {
        SetupCard(selected: false, enabled: tile.available && !leaving, action: { open(tile.feature) }) {
            FeatureIcon(id: tile.feature.id, tint: palette.accent)
            Text(tile.feature.title).font(KioskType.titleLarge).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
            Text(tile.feature.blurb).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            if let reason = tile.lockedReason {
                Text(reason).font(KioskType.labelSmall).foregroundStyle(palette.textMute)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 6)
            }
        }
        .accessibilityIdentifier(tile.feature == TIMECLOCK_STATION_FEATURE ? "tile-timeclock-station" : "tile-\(tile.feature.id.rawValue)")
    }

    /// A station's Time Clock tile signs out: the guard then rests the station on its Welcome.
    private func open(_ feature: KioskFeature) {
        if feature == TIMECLOCK_STATION_FEATURE {
            leaving = true
            Task { await auth.logout() }
        } else {
            path.append(Route.forFeature(feature.id))
        }
    }
}
