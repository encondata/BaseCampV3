import SwiftUI

/// Whether a route may show in this setup state (dev mode overrides).
func routeAllowed(_ route: Route, setupState: SetupState, devMode: Bool) -> Bool {
    featureAvailable(feature(route.featureId), setupState: setupState, devMode: devMode)
}

/// Pops back to Home unless the route's feature is usable in the kiosk's setup state.
struct SetupGate<Content: View>: View {
    let route: Route
    @Binding var path: [Route]
    @ViewBuilder let content: () -> Content
    @Environment(KioskPrefs.self) private var prefs

    var body: some View {
        let allowed = routeAllowed(route, setupState: prefs.setupState, devMode: prefs.devMode)
        Group {
            if allowed { content() } else { Color.clear }
        }
        .task(id: allowed) {
            if !allowed { path.removeAll() }
        }
    }
}
