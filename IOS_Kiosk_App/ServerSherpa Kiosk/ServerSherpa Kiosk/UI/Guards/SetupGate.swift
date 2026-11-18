import SwiftUI

/// Whether a route may show in this setup state (dev mode overrides).
func routeAllowed(_ route: Route, setupState: SetupState, devMode: Bool) -> Bool {
    featureAvailable(feature(route.featureId), setupState: setupState, devMode: devMode)
}

/// Clear Setup from the portal (Android `SetupClearedRedirect`): whoever is signed in goes to
/// Kiosk Setup, once for each clear the heartbeat applied (`Heartbeat.setupClearSignal`). The
/// path becomes `[.setup]`, so "‹ Home" lands on Home rather than going back through the gated
/// screen the person was on.
struct SetupClearedRedirect: Equatable {
    /// The last signal acted on, or let go.
    private(set) var seen = 0

    /// Where `path` goes for `signal`, or nil to leave it. A signal already seen leaves it; so
    /// does one that lands while nobody is signed in, which is spent so it can never move the
    /// next sign-in; and so does a kiosk already on Kiosk Setup.
    mutating func next(signal: Int, path: [Route], signedIn: Bool) -> [Route]? {
        guard signal != seen else { return nil }
        seen = signal
        guard signedIn, path.last != .setup else { return nil }
        return [.setup]
    }
}

/// Where SetupGate sends a route that is not allowed, or nil to leave the path: Home, or Kiosk
/// Setup while the Clear Setup notice is up. Nothing happens when the kiosk is already on Setup
/// (the clear's redirect got there first, and Home would pop Setup right off).
func gateRedirect(path: [Route], clearNotice: Bool) -> [Route]? {
    if path.last == .setup { return nil }
    return clearNotice ? [.setup] : []
}

/// Pops back to Home (or, after a Clear Setup, to Kiosk Setup) unless the route's feature is
/// usable in the kiosk's setup state.
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
            if !allowed, let next = gateRedirect(path: path, clearNotice: prefs.setupClear?.notice == true) { path = next }
        }
    }
}
