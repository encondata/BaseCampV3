import SwiftUI

/// KioskGuard { KioskShell { NavigationStack { Home + routes behind SetupGate } } },
/// the flash overlay over everything, and the scene-phase hooks.
struct RootView: View {
    @Environment(\.container) private var container
    @Environment(KioskAuth.self) private var auth
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [Route] = []

    private var preferences: UiPreferences? {
        if case .authed(let s) = auth.state { return s.preferences }
        return nil
    }

    var body: some View {
        ZStack {
            KioskGuard {
                KioskShell(path: $path) {
                    NavigationStack(path: $path) {
                        HomeScreen(path: $path)
                            .toolbar(.hidden, for: .navigationBar)
                            .navigationDestination(for: Route.self) { route in
                                SetupGate(route: route, path: $path) { destination(route) }
                                    .toolbar(.hidden, for: .navigationBar)
                            }
                    }
                }
            }
            ScanFlash()
        }
        .kioskTheme(accent: preferences?.accent ?? "amber",
                    scheme: KioskTheme.scheme(forTheme: preferences?.theme ?? "light"))
        .task { await container.launch() }
        .onChange(of: auth.state) { _, state in
            if state == .anon { path.removeAll() }
            container.authChanged()
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            // Only .background stops things and only .active starts them; .inactive (Control Center,
            // the app switcher, a permission prompt) changes nothing.
            switch phase {
            case .active: container.onActive()
            case .background: container.onBackground()
            default: break
            }
        }
    }

    /// Screens not built yet show the placeholder until their task replaces the destination.
    @ViewBuilder private func destination(_ route: Route) -> some View {
        switch route {
        case .setup: KioskSetupScreen(path: $path)
        case .settings(let tab): SettingsScreen(initialTab: tab)
        case .scan: ScanScreen()
        case .enroll: EnrollScreen()
        case .timeclock: TimeclockScreen()
        default: FeaturePlaceholderScreen(feature: feature(route.featureId), path: $path)
        }
    }
}
