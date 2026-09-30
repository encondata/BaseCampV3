import Foundation

enum SettingsTabId: String, Sendable {
    case appearance, sound, devices
    case thisKiosk = "this-kiosk"
    case admin, developer
}

enum TabRequirement: Sendable { case admin, developer }

struct SettingsTab: Sendable {
    let id: SettingsTabId
    let label: String
    let blurb: String
    var requires: TabRequirement? = nil
    /// Visible signed out.
    var anon: Bool = false
}

let SETTINGS_TABS: [SettingsTab] = [
    SettingsTab(id: .appearance, label: "Appearance", blurb: "Theme, accent, and text size for this kiosk."),
    SettingsTab(id: .sound, label: "Sound", blurb: "Scan and alert sounds."),
    SettingsTab(id: .devices, label: "Devices", blurb: "Cameras and keyboards this kiosk can scan with."),
    SettingsTab(id: .thisKiosk, label: "This Kiosk", blurb: "This kiosk's name, identity, and connection.", anon: true),
    SettingsTab(id: .admin, label: "Admin", blurb: "Kiosk administration.", requires: .admin),
    SettingsTab(id: .developer, label: "Developer", blurb: "Diagnostics and developer tools.", requires: .developer),
]

let DEFAULT_TAB = SettingsTabId.appearance

func visibleTabs(isAdmin: Bool, isDeveloper: Bool, signedIn: Bool, tabs: [SettingsTab] = SETTINGS_TABS) -> [SettingsTab] {
    if !signedIn { return tabs.filter { $0.anon } }
    return tabs.filter {
        switch $0.requires {
        case .admin: isAdmin
        case .developer: isDeveloper
        case nil: true
        }
    }
}
