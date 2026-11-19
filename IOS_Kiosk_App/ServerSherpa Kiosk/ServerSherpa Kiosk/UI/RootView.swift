import SwiftUI

/// KioskGuard { KioskShell { NavigationStack { Home + routes behind SetupGate } } },
/// the flash overlay over everything, the biometric Turn on sheet over the signed-in app, the
/// Clear Setup redirect, and the scene-phase hooks.
struct RootView: View {
    @Environment(\.container) private var container
    @Environment(KioskAuth.self) private var auth
    @Environment(Heartbeat.self) private var heartbeat
    @Environment(EnrollOffer.self) private var enrollOffer
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var path: [Route] = []
    @State private var setupClearedRedirect = SetupClearedRedirect()

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
        // Inside the theme: the sheet follows the app's light or dark look.
        .sheet(item: offerSheet) { shown in
            EnrollOfferSheet(ui: enrollOffer.sheet ?? shown, words: enrollOffer.words,
                             onTurnOn: { Task { await enrollOffer.turnOn(SystemBiometricPrompter()) } },
                             onNotNow: { enrollOffer.notNow() }, compactWidth: sizeClass == .compact)
        }
        .environment(\.goHome, GoHomeAction { [path = $path] in path.wrappedValue.removeAll() })
        .kioskTheme(accent: preferences?.accent ?? "amber",
                    scheme: KioskTheme.scheme(forTheme: preferences?.theme ?? "light"))
        .task { await container.launch() }
        .onChange(of: auth.state) { _, state in
            if state == .anon { path.removeAll() }
            container.authChanged()
        }
        // Clear Setup from the portal: whoever is signed in lands on Kiosk Setup, from any screen,
        // once. Outside every route, so no screen's gate can drop it before it acts.
        .onChange(of: heartbeat.setupClearSignal) { _, signal in
            var signedIn = false
            if case .authed = auth.state { signedIn = true }
            if let next = setupClearedRedirect.next(signal: signal, path: path, signedIn: signedIn) { path = next }
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

    /// The Turn on sheet; a swipe down is Not now (never while Turn on runs).
    private var offerSheet: Binding<EnrollOfferUI?> {
        Binding(get: { enrollOffer.sheet }, set: { if $0 == nil { enrollOffer.notNow() } })
    }

    /// Screens not built yet show the placeholder until their task replaces the destination.
    @ViewBuilder private func destination(_ route: Route) -> some View {
        switch route {
        case .setup: KioskSetupScreen(path: $path)
        case .settings(let tab): SettingsScreen(initialTab: tab, path: $path)
        case .scan: ScanScreen()
        case .enroll: EnrollScreen()
        case .timeclock: TimeclockScreen()
        case .labels: LabelsHomeScreen(path: $path)
        case .labelsPrint: PrintLabelsScreen(path: $path)
        case .labelsPrinter: PrinterSetupScreen(path: $path)
        case .rolodex: RolodexView(path: $path)
        case .rolodexWorker(let id): RolodexWorkerScreen(personId: id, path: $path)
        case .lookup: AssetLookupScreen()
        case .troubleshooting: TroubleshootingView(path: $path)
        case .troubleshootingTopic(let id): TroubleshootingTopicView(topicId: id, path: $path)
        default: FeaturePlaceholderScreen(feature: feature(route.featureId), path: $path)
        }
    }
}

/// Back to Home: the navigation stack cleared (Settings › Developer › Reset app).
struct GoHomeAction: Sendable {
    let run: @MainActor @Sendable () -> Void

    @MainActor func callAsFunction() { run() }
}

private struct GoHomeKey: EnvironmentKey {
    // Outside RootView (a sheet's own stack, previews) there is nothing to clear.
    static let defaultValue = GoHomeAction(run: {})
}

extension EnvironmentValues {
    var goHome: GoHomeAction {
        get { self[GoHomeKey.self] }
        set { self[GoHomeKey.self] = newValue }
    }
}
