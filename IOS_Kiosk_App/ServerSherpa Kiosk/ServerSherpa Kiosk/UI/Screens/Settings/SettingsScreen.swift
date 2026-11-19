import SwiftUI

/// kiosk/src/pages/Settings.tsx: a tab strip and one panel. Signed out there is
/// only This Kiosk, so no strip. As a sheet (the login gear) it shows a Done button and has no
/// `path` (no stack to push onto); as a route, `path` is the app's stack (Troubleshooting's
/// Printer Setup button pushes onto it).
struct SettingsScreen: View {
    var initialTab: SettingsTabId? = nil
    var onDone: (() -> Void)? = nil
    var path: Binding<[Route]>? = nil
    @Environment(KioskAuth.self) private var auth
    @Environment(KioskPrefs.self) private var prefs
    @Environment(\.kioskPalette) private var palette
    @State private var picked: SettingsTabId?

    init(initialTab: SettingsTabId? = nil, onDone: (() -> Void)? = nil, path: Binding<[Route]>? = nil) {
        self.initialTab = initialTab
        self.onDone = onDone
        self.path = path
    }

    private var tabs: [SettingsTab] {
        if case .authed(let s) = auth.state { return visibleTabs(isAdmin: s.isAdmin, isDeveloper: s.isDeveloper, signedIn: true) }
        return visibleTabs(isAdmin: false, isDeveloper: false, signedIn: false)
    }

    var body: some View {
        // A pick that stops being visible (signing out) falls back rather than showing a hidden panel.
        let active = tabs.first { $0.id == SettingsModel.selectedTab(requested: picked ?? initialTab, tabs: tabs) } ?? tabs[0]
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    PageHeader(eyebrow: "Kiosk · Settings", title: "Settings")
                    if let onDone { LinkButton("Done", action: onDone) }
                }
                if SettingsModel.showsTabStrip(tabs) {
                    Segmented(options: tabs.map { ($0.id, $0.label) }, selection: Binding(get: { active.id }, set: { picked = $0 }))
                }
                Text(active.label).font(KioskType.headline).foregroundStyle(palette.text).padding(.top, 16)
                Text(active.blurb).font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.bottom, 8)
                panel(active.id)
            }
            .padding(16)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(palette.paper2)
    }

    @ViewBuilder private func panel(_ id: SettingsTabId) -> some View {
        switch id {
        case .thisKiosk: ThisKioskPanel()
        case .appearance: AppearancePanel()
        case .sound: SoundPanel()
        case .devices: DevicesPanel()
        case .troubleshooting:
            TroubleshootingPanel(openPrinterSetup: printerSetupOpener(path: path, setupState: prefs.setupState, devMode: prefs.devMode))
        case .admin: AdminPanel()
        case .developer: DeveloperPanel()
        }
    }
}

/// Troubleshooting's Printer Setup button (no printer saved): pushes Printer Setup onto Settings'
/// stack, so Back returns to the tab. Nil, and no button (the note still says where to go), in the
/// login gear's sheet, which has no stack (and shows Troubleshooting to nobody: it is for signed-in
/// people), and while Label Printing waits for Kiosk Setup: SetupGate would send Printer Setup
/// straight back to Home.
func printerSetupOpener(path: Binding<[Route]>?, setupState: SetupState, devMode: Bool) -> (() -> Void)? {
    guard let path, routeAllowed(.labelsPrinter, setupState: setupState, devMode: devMode) else { return nil }
    return { path.wrappedValue.append(.labelsPrinter) }
}
