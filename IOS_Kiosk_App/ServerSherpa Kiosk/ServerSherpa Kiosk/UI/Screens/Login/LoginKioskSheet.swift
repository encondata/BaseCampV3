import SwiftUI

/// Settings › This Kiosk, signed out, until Task 18's SettingsScreen replaces
/// it: the kiosk's name and serial (read-only) and the API URL.
struct LoginKioskSheet: View {
    @Environment(KioskConfig.self) private var config
    @Environment(Identity.self) private var identity
    @Environment(\.dismiss) private var dismiss
    @State private var apiUrl = ""
    @State private var urlError: String?
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                Section("This Kiosk") {
                    LabeledContent("Name", value: identity.current.name)
                    LabeledContent("Serial") {
                        Text(identity.current.serial).font(KioskType.mono(13)).textSelection(.enabled)
                    }
                }
                Section {
                    TextField("https://api.serversherpa.com", text: $apiUrl)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: apiUrl) { urlError = nil; saved = false }
                    if let urlError {
                        Text(urlError).foregroundStyle(LoginFormColors.error)
                    } else if saved {
                        Text("Saved.").foregroundStyle(LoginTokens.slate)
                    }
                    Button("Save", action: save)
                } header: {
                    Text("API URL")
                }
            }
            .navigationTitle("Kiosk settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .onAppear { apiUrl = config.apiUrl }
    }

    private func save() {
        if config.setApiUrl(apiUrl) {
            apiUrl = config.apiUrl
            saved = true
        } else {
            urlError = "Enter an http:// or https:// address."
        }
    }
}
