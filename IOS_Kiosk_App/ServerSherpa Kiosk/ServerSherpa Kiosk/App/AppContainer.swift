import Foundation
import SwiftData
import SwiftUI
import UIKit

/// Manual dependency wiring (Android `AppContainer.kt`): one instance, built by the app.
@MainActor
final class AppContainer {
    let prefs: KioskPrefs
    let config: KioskConfig
    let secrets: SecretStore
    let identity: Identity
    let sessionStore: SessionStore
    let api: KioskApi
    let auth: KioskAuth
    let heartbeat: Heartbeat
    let coordinator: SessionCoordinator
    let store: KioskStore
    let sync: Sync
    let outbox: Outbox
    /// The label generator, started on its first call (the first label build).
    let labelEngine: LabelEngine
    let labelSettings: LabelSettingsStore
    let labelBuilder: LabelBuilder
    let scanBus = ScanBus()
    let flash = FlashController()
    let sound: SoundPlayer
    let toast = ToastCenter()
    /// True when the on-disk store could not be used this launch and the kiosk
    /// runs in memory: nothing written (queued scans included) survives a relaunch.
    let storeIsTemporary: Bool

    private var active = false
    private var launched = false

    /// `fontsDir` holds downloaded label fonts; nil keeps font metadata only. `labelEngine` is
    /// the real generator unless a test passes another (nothing starts it until a build runs,
    /// and only `launch()` starts the builder).
    init(defaults: UserDefaults, secrets: SecretStore, modelContainer: ModelContainer, storeIsTemporary: Bool = false,
         backgroundTask: BackgroundTasking, fontsDir: URL? = nil, labelEngine: LabelEngine = JavaScriptLabelEngine()) {
        let prefs = KioskPrefs(defaults: defaults)
        let config = KioskConfig(prefs: prefs)
        let identity = Identity(prefs: prefs, secrets: secrets)
        let cookies = RefreshCookie(secrets: secrets)
        let apiUrl: @Sendable () async -> String = { await MainActor.run { config.apiUrl } }
        // One URLSession for both: it carries the cross-origin redirect guard.
        let session = URLSessionKioskApi.makeSession()
        let sessionStore = SessionStore(apiUrl: apiUrl, cookies: cookies, session: session)
        let api = URLSessionKioskApi(apiUrl: apiUrl, session: session, sessionStore: sessionStore, cookies: cookies)
        let auth = KioskAuth(api: api, refresher: sessionStore, identity: identity, prefs: prefs)
        let heartbeat = Heartbeat(api: api, identity: identity, version: config.kioskVersion)
        auth.onLogout = { heartbeat.stop() }
        let store = KioskStore(modelContainer: modelContainer)

        self.prefs = prefs
        self.config = config
        self.secrets = secrets
        self.identity = identity
        self.sessionStore = sessionStore
        self.api = api
        self.auth = auth
        self.heartbeat = heartbeat
        self.coordinator = SessionCoordinator(refresher: sessionStore, auth: auth, heartbeat: heartbeat)
        self.store = store
        self.storeIsTemporary = storeIsTemporary
        self.sync = Sync(api: api, store: store, fontsDir: fontsDir)
        self.outbox = Outbox(store: store, api: api, serial: { identity.current.serial }, backgroundTask: backgroundTask)
        let labelSettings = LabelSettingsStore(prefs: prefs)
        self.labelEngine = labelEngine
        self.labelSettings = labelSettings
        self.labelBuilder = LabelBuilder(store: store, engine: labelEngine, settings: labelSettings)
        self.sound = SoundPlayer(prefs: prefs)
    }

    /// Keychain, UserDefaults.standard and the on-disk store (see `openStore`).
    static func live() -> AppContainer {
        let opened = openStore()
        return AppContainer(defaults: .standard, secrets: KeychainSecretStore(), modelContainer: opened.container,
                            storeIsTemporary: opened.isTemporary, backgroundTask: UIKitBackgroundTasking(),
                            fontsDir: Sync.defaultFontsDir)
    }

    /// For SwiftUI previews: nothing touches the Keychain, the real defaults or the disk.
    static func preview() -> AppContainer {
        let suite = "preview-\(UUID())"
        return AppContainer(defaults: UserDefaults(suiteName: suite) ?? .standard, secrets: MemorySecretStore(),
                            modelContainer: inMemoryStore(), backgroundTask: NoBackgroundTasking())
    }

    /// The on-disk store in `directory`, migrated when older. A store file is
    /// never deleted: only a corrupt one is moved aside (its queued scans are
    /// salvaged); any other failure runs in memory this launch (`KioskStoreOpener`).
    static func openStore(directory: URL = .applicationSupportDirectory, now: Date = Date()) -> OpenedStore {
        KioskStoreOpener.open(directory: directory, now: now,
                              protectedDataAvailable: { UIApplication.shared.isProtectedDataAvailable }, inMemory: inMemoryStore)
    }

    private static func inMemoryStore() -> ModelContainer {
        do { return try KioskSchema.inMemoryContainer() } catch {
            fatalError("An in-memory SwiftData store could not be created: \(error)")
        }
    }

    /// Once per launch: the session listener, then the cookie restore, the
    /// roster hydrate (then the label builder following the sync) and the
    /// outbox read side by side (the footer's sync line must not wait on
    /// auth's network call).
    func launch() async {
        guard !launched else { return }
        launched = true
        coordinator.start()
        async let restored: Void = restoreSession()
        async let hydrated: Void = hydrateAndBuildLabels()
        async let loaded: Void = outbox.load()
        _ = await (restored, hydrated, loaded)
        authChanged()
    }

    /// The restored sync reads `done`, so the builder's first look at it builds (Android starts
    /// the builder beside `sync.hydrate()`).
    private func hydrateAndBuildLabels() async {
        await sync.hydrate()
        await labelBuilder.start(syncStatus: sync.statusUpdates())
    }

    private func restoreSession() async {
        #if DEBUG
        // UI tests pass this to see the login screen whatever session the simulator kept.
        if ProcessInfo.processInfo.arguments.contains("-uiTestSignedOut") { auth.endSession(); return }
        #endif
        await auth.restore()
    }

    func onActive() {
        active = true
        refreshRunState()
    }

    func onBackground() {
        active = false
        refreshRunState()
    }

    /// Call on every auth-state change.
    func authChanged() { refreshRunState() }

    /// Heartbeat while active and signed in (not must-change-password); the
    /// outbox flushes and the screen stays awake only while active and signed in
    /// (a signed-out kiosk has no token to send scans with).
    private func refreshRunState() {
        coordinator.evaluate(foreground: active)
        var authed = false
        if case .authed = auth.state { authed = true }
        if active && authed { outbox.start() } else { outbox.stop() }
        UIApplication.shared.isIdleTimerDisabled = active && authed
    }
}

private struct AppContainerKey: EnvironmentKey {
    // Exists for SwiftUI previews only; the app injects the real container.
    static let defaultValue: AppContainer = MainActor.assumeIsolated { AppContainer.preview() }
}

extension EnvironmentValues {
    var container: AppContainer {
        get { self[AppContainerKey.self] }
        set { self[AppContainerKey.self] = newValue }
    }
}

extension View {
    /// The container plus each @Observable it owns, for `@Environment(Type.self)` lookup.
    func appContainer(_ c: AppContainer) -> some View {
        environment(\.container, c)
            .environment(c.prefs)
            .environment(c.config)
            .environment(c.identity)
            .environment(c.auth)
            .environment(c.heartbeat)
            .environment(c.sync)
            .environment(c.labelBuilder.monitor)
            .environment(c.outbox)
            .environment(c.flash)
            .environment(c.toast)
    }
}
