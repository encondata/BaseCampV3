import SwiftUI

/// Settings › Developer: dev mode, setup-state override, clear local data, and the local-data inspector.
struct DeveloperPanel: View {
    @Environment(KioskPrefs.self) private var prefs
    @Environment(Sync.self) private var sync
    @Environment(\.kioskPalette) private var palette
    @State private var clearError = false
    @State private var confirmClear = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsRow(title: "Developer mode", detail: "Shows diagnostics and developer tools on this kiosk. Stored on this kiosk only.") {
                Toggle("Developer mode", isOn: Binding(get: { prefs.devMode }, set: { prefs.devMode = $0 }))
                    .labelsHidden()
                    .frame(minHeight: 48)
            }
            if prefs.devMode {
                SettingsRow(title: "Kiosk setup state", detail: "Testing aid until real setup logic sets this. Stored on this kiosk only.") {
                    let states: [SetupState] = [.incomplete, .complete, .failed]
                    Segmented(options: states.map { ($0, $0.label) }, selection: Binding(get: { prefs.setupState }, set: { prefs.setupState = $0 }))
                }
                SettingsRow(title: "Local data", detail: SettingsModel.localDataLine(sync.status)) {
                    KioskToast(text: clearError ? "Couldn't clear local data." : nil, error: true)
                    SecondaryButton("Clear local data") { confirmClear = true }
                }
                LocalDataInspector()
            }
        }
        .confirmationDialog("Clear local data?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear local data", role: .destructive) {
                Task {
                    do { try await sync.clearLocalData(); clearError = false } catch { clearError = true }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the assets, people, containers and trucks downloaded to this kiosk. Scans waiting to upload are kept. Sync again from Kiosk Setup to download them.")
        }
    }
}

/// Assets and people, filterable, capped at 200 rows each.
private struct LocalDataInspector: View {
    @Environment(\.container) private var container
    @Environment(Sync.self) private var sync
    @Environment(\.kioskPalette) private var palette
    @State private var filter = ""
    @State private var assets: [KioskAssetRow] = []
    @State private var people: [KioskPersonRow] = []

    var body: some View {
        let shownAssets = SettingsModel.shownAssets(assets, filter: filter)
        let shownPeople = SettingsModel.shownPeople(people, filter: filter)
        VStack(alignment: .leading, spacing: 4) {
            TextField("Filter local data", text: $filter)
                .font(KioskType.bodyLarge)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
                .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
                .padding(.top, 12)
            Text("Assets (\(shownAssets.count) of \(assets.count))").font(KioskType.mono(13)).padding(.top, 12)
            ForEach(shownAssets, id: \.id) { a in
                Text("\(a.assetId) · \(a.name ?? "—") · \(a.serialNumber ?? "—") · \(displayRfid(a.rfid))").font(KioskType.mono(12))
            }
            Text("People (\(shownPeople.count) of \(people.count))").font(KioskType.mono(13)).padding(.top, 12)
            ForEach(shownPeople, id: \.id) { p in
                Text("\(p.displayName) · \(displayRfid(p.rfidTag))").font(KioskType.mono(12))
            }
        }
        .foregroundStyle(palette.text)
        .task(id: "\(sync.status.phase)-\(sync.rosterVersion)-\(sync.status.syncedAt ?? "")") {
            if let rows = try? await container.store.inspect(limit: 1_000_000) {
                assets = rows.assets
                people = rows.people
            }
        }
    }
}
