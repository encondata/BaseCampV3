import Foundation

/// The pure rules behind the Settings screen (Android SettingsScreen / ThisKioskPanel / DeveloperPanel).
enum SettingsModel {
    static let nameError = "Enter a name between 1 and \(NAME_MAX) characters."
    static let urlError = "Enter an http:// or https:// address."
    static let inspectCap = 200

    /// A single tab needs no strip (the signed-out sheet).
    static func showsTabStrip(_ tabs: [SettingsTab]) -> Bool { tabs.count > 1 }

    /// The requested tab when it is visible, else the default tab, else the first one visible.
    static func selectedTab(requested: SettingsTabId?, tabs: [SettingsTab]) -> SettingsTabId {
        if let requested, tabs.contains(where: { $0.id == requested }) { return requested }
        return tabs.first { $0.id == DEFAULT_TAB }?.id ?? tabs.first?.id ?? DEFAULT_TAB
    }

    /// nil when saved; otherwise the inline message.
    @MainActor static func saveName(_ name: String, identity: Identity) -> String? {
        identity.setName(name) ? nil : nameError
    }

    /// The typed URLs as the Custom environment to switch to, both normalized; nil when either
    /// isn't an http:// or https:// address.
    static func customTarget(api: String, portal: String) -> SavedEnvironment? {
        guard let api = KioskConfig.normalizeUrl(api), let portal = KioskConfig.normalizeUrl(portal) else { return nil }
        return .custom(apiUrl: api, portalUrl: portal)
    }

    /// How many scans a switch would leave unsent (never "0").
    static func unsentScansText(_ n: Int) -> String {
        switch n {
        case 1: "1 unsent scan hasn't been sent yet."
        case 2...: "\(n) unsent scans haven't been sent yet."
        default: "Unsent scans haven't been sent yet."
        }
    }

    /// What a switch that didn't happen says; nil when it was done.
    static func switchMessage(_ result: SwitchResult) -> String? {
        switch result {
        case .done: nil
        case .pending(let n): unsentScansText(n)
        case .refused(SwitchResult.customNeedsSuperAdmin): "Sign in as a developer, founder or super admin to use a custom URL."
        case .refused(SwitchResult.discardNeedsAdmin): "Sign in as an admin to discard unsent scans."
        case .refused(SwitchResult.accessCheckOffline): "Can't reach the server to check your access."
        case .refused(let code): "Couldn't switch environment (\(code))."
        }
    }

    /// What a switch that threw says (nothing was saved).
    static func switchFailedMessage(_ error: Error) -> String {
        error as? EnvironmentSwitchError == .outboxUnreadable
            ? "Couldn't read this kiosk's unsent scans, so nothing was switched. Try again."
            : "Couldn't switch environment. Try again."
    }

    @MainActor static func localDataLine(_ status: SyncStatus) -> String {
        guard status.phase == .done else { return "Nothing downloaded yet." }
        var line = "\(status.assets ?? 0) assets · \(status.people ?? 0) people · \(status.containers ?? 0) containers · \(status.trucks ?? 0) trucks"
        if let at = status.syncedAt { line += " · synced \(Sync.formatSyncedAt(at))" }
        return line
    }

    private static func matches(_ filter: String, _ values: [String?]) -> Bool {
        let q = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return q.isEmpty || values.contains { $0?.lowercased().contains(q) == true }
    }

    static func shownAssets(_ rows: [KioskAssetRow], filter: String) -> [KioskAssetRow] {
        Array(rows.filter { matches(filter, [$0.assetId, $0.name, $0.serialNumber, $0.rfid]) }.prefix(inspectCap))
    }

    static func shownPeople(_ rows: [KioskPersonRow], filter: String) -> [KioskPersonRow] {
        Array(rows.filter { matches(filter, [$0.displayName, $0.rfidTag]) }.prefix(inspectCap))
    }
}
