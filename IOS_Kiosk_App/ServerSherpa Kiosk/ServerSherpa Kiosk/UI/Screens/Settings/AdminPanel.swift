import SwiftUI

/// Settings › Admin: the RFID Enroll checkpoint (what every enrollment on this kiosk records).
struct AdminPanel: View {
    @Environment(KioskPrefs.self) private var prefs
    @Environment(\.container) private var container
    @State private var scanTypes: [SetupOptionScanType]?
    @State private var loadFailed = false

    var body: some View {
        let offered = scanTypes?.map(\.key) ?? []
        let effective = effectiveCheckpoint(.enroll, stored: prefs.checkpoint(.enroll), offered: offered)
        let options = scanTypes?.map { ($0.key, $0.label) } ?? [(effective, effective)]
        VStack(alignment: .leading, spacing: 0) {
            if loadFailed { KioskToast(text: "Couldn't load the checkpoint list. The stored choice still applies.", error: true) }
            SettingsRow(title: CheckpointId.enroll.label, detail: "The asset status an enrollment scan records. Default pre_stage.") {
                Segmented(options: options, selection: Binding(get: { effective }, set: { prefs.setCheckpoint(.enroll, $0) }))
            }
        }
        .task {
            do { scanTypes = try await container.api.setupOptions().scanTypes } catch { loadFailed = true }
        }
    }
}
