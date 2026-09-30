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

    /// Both URLs are checked before either is stored. nil when saved.
    @MainActor static func saveUrls(api: String, portal: String, config: KioskConfig) -> String? {
        guard KioskConfig.normalizeUrl(api) != nil, KioskConfig.normalizeUrl(portal) != nil else { return urlError }
        _ = config.setApiUrl(api)
        _ = config.setPortalUrl(portal)
        return nil
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
