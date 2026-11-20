import Foundation
import Observation

/// The environment this kiosk saved, the last good download of the environment list, and whether
/// any server has ever registered this kiosk (all in `KioskPrefs`; Android `EnvironmentStore`).
/// A saved environment is checked again whenever it is read: a named one by the list's entry
/// rules, a Custom one by the typed-URL rule. One that fails counts as nothing saved, as on the
/// laptop edge. Computed from prefs on every read, so Observation tracks it.
@MainActor @Observable
final class EnvironmentStore {
    @ObservationIgnored private let prefs: KioskPrefs

    init(prefs: KioskPrefs) {
        self.prefs = prefs
    }

    /// The saved environment, or nil when nothing (or nothing valid) is saved.
    var saved: SavedEnvironment? { Self.decode(prefs.environment) }

    /// What the kiosk connects to: the saved environment, else `fallback`. Until
    /// `migrateIfNeeded` has run, URLs typed before the picker resolve the way it will save them,
    /// so nothing reaches `fallback` meanwhile.
    func current(_ fallback: SavedEnvironment) -> SavedEnvironment {
        if prefs.environment != nil { return saved ?? fallback }
        return Environments.migrate(savedApi: prefs.legacyApiUrl, savedPortal: prefs.legacyPortalUrl,
                                    defaultPortal: fallback.portalUrl) ?? fallback
    }

    /// Saves `env` as checked on read (a Custom pair normalized). False, and nothing saved, when
    /// it would not pass that check.
    @discardableResult
    func save(_ env: SavedEnvironment) -> Bool {
        guard let checked = Self.checked(env), let json = Self.encode(checked) else { return false }
        prefs.environment = json
        return true
    }

    var everRegistered: Bool { prefs.everRegistered }

    func markRegistered() { prefs.markEverRegistered() }

    /// The last good download, checked again by the list's rules; nil when none is usable.
    var cachedList: [Env]? { prefs.environmentList.flatMap { Environments.parseList(Data($0.utf8)) } }

    /// Saved in the published file's own shape, so `cachedList` reads it with the same checks.
    func cacheList(_ list: [Env]) {
        guard let data = try? KioskJSON.encoder.encode(ListFile(version: 1, environments: list)) else { return }
        prefs.environmentList = String(decoding: data, as: UTF8.self)
    }

    /// The URLs typed before the picker become the saved environment (a built-in one when the API
    /// URL is its address, else Custom with `defaultPortal` when no portal URL was saved), once;
    /// the old keys are removed. A saved environment is never replaced.
    func migrateIfNeeded(defaultPortal: String) {
        prefs.migrateLegacyUrls { api, portal in
            Environments.migrate(savedApi: api, savedPortal: portal, defaultPortal: defaultPortal).flatMap(Self.encode)
        }
    }

    private struct ListFile: Encodable {
        let version: Int
        let environments: [Env]
    }

    private static func encode(_ env: SavedEnvironment) -> String? {
        (try? KioskJSON.encoder.encode(env)).map { String(decoding: $0, as: UTF8.self) }
    }

    private static func decode(_ raw: String?) -> SavedEnvironment? {
        guard let raw, let env = try? KioskJSON.decoder.decode(SavedEnvironment.self, from: Data(raw.utf8)) else { return nil }
        return checked(env)
    }

    /// `env` when it passes the read-back rules (a Custom pair normalized), else nil.
    private static func checked(_ env: SavedEnvironment) -> SavedEnvironment? {
        switch env {
        case let .named(id, name, domain):
            return Environments.isValid(Env(id: id, name: name, domain: domain)) ? env : nil
        case let .custom(apiUrl, portalUrl):
            guard let api = KioskConfig.normalizeUrl(apiUrl), let portal = KioskConfig.normalizeUrl(portalUrl) else { return nil }
            return .custom(apiUrl: api, portalUrl: portal)
        }
    }
}
