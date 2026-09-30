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
    let scanBus = ScanBus()
    let flash = FlashController()
    let sound: SoundPlayer
    let toast = ToastCenter()

    private var active = false
    private var launched = false

    init(defaults: UserDefaults, secrets: SecretStore, modelContainer: ModelContainer, backgroundTask: BackgroundTasking) {
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
        self.sync = Sync(api: api, store: store)
        self.outbox = Outbox(store: store, api: api, serial: { identity.current.serial }, backgroundTask: backgroundTask)
        self.sound = SoundPlayer(prefs: prefs)
    }

    /// Keychain, UserDefaults.standard and the on-disk store. A store that will
    /// not open is deleted and opened once more; failing that, the kiosk runs in memory.
    static func live() -> AppContainer {
        AppContainer(defaults: .standard, secrets: KeychainSecretStore(), modelContainer: openStore(),
                     backgroundTask: UIKitBackgroundTasking())
    }

    /// For SwiftUI previews: nothing touches the Keychain, the real defaults or the disk.
    static func preview() -> AppContainer {
        let suite = "preview-\(UUID())"
        return AppContainer(defaults: UserDefaults(suiteName: suite) ?? .standard, secrets: MemorySecretStore(),
                            modelContainer: inMemoryStore(), backgroundTask: NoBackgroundTasking())
    }

    private static func openStore() -> ModelContainer {
        if let container = try? KioskSchema.container(inMemory: false) { return container }
        let base = URL.applicationSupportDirectory.appending(path: "serversherpa-kiosk.store")
        for suffix in ["", "-shm", "-wal"] {
            try? FileManager.default.removeItem(at: URL(filePath: base.path() + suffix))
        }
        if let container = try? KioskSchema.container(inMemory: false) { return container }
        return inMemoryStore()
    }

    private static func inMemoryStore() -> ModelContainer {
        do { return try KioskSchema.container(inMemory: true) } catch {
            fatalError("An in-memory SwiftData store could not be created: \(error)")
        }
    }

    /// Once per launch: the session listener, then the cookie restore, the
    /// roster hydrate and the outbox read side by side (the footer's sync line
    /// must not wait on auth's network call).
    func launch() async {
        guard !launched else { return }
        launched = true
        coordinator.start()
        async let restored: Void = auth.restore()
        async let hydrated: Void = sync.hydrate()
        async let loaded: Void = outbox.load()
        _ = await (restored, hydrated, loaded)
        authChanged()
    }

    func onActive() {
        active = true
        outbox.start()
        refreshRunState()
    }

    func onBackground() {
        active = false
        outbox.stop()
        refreshRunState()
    }

    /// Call on every auth-state change.
    func authChanged() { refreshRunState() }

    /// Heartbeat while active and signed in (not must-change-password); the
    /// screen stays awake only while active and signed in.
    private func refreshRunState() {
        coordinator.evaluate(foreground: active)
        var authed = false
        if case .authed = auth.state { authed = true }
        UIApplication.shared.isIdleTimerDisabled = active && authed
    }
}

private struct AppContainerKey: EnvironmentKey {
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
            .environment(c.outbox)
            .environment(c.flash)
            .environment(c.toast)
    }
}
