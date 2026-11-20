import SwiftUI
import UIKit

/// Settings › This Kiosk: name, serial, mode, biometric sign-in, environment and server, version, app
/// updates — usable signed out. `onSwitched` runs after an environment switch (on to sign-in).
struct ThisKioskPanel: View {
    var onSwitched: () -> Void = {}
    @Environment(KioskConfig.self) private var config
    @Environment(Identity.self) private var identity
    @Environment(Heartbeat.self) private var heartbeat
    @Environment(KioskAuth.self) private var auth
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette
    @State private var name = ""
    @State private var nameError: String?
    @State private var saved: String?
    @State private var copied = false

    private var authed: Bool { if case .authed = auth.state { true } else { false } }

    private func field(_ placeholder: String, _ text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(KioskType.bodyLarge)
            .textInputAutocapitalization(.sentences)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
    }

    /// Typing here counts as activity on a Time Clock station's sign-in page (this panel is its
    /// gear's sheet), so the quiet minute back to Welcome restarts with each keystroke. A no-op
    /// anywhere else.
    private func typed() { container.station.noteLoginActivity() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsRow(title: "Kiosk name", detail: "What people see on their phone when they link with this kiosk. 1–\(NAME_MAX) characters.") {
                field("Kiosk name", $name).accessibilityIdentifier("kiosk-name")
                    .onChange(of: name) { nameError = nil; typed() }
                KioskToast(text: nameError, error: true)
                SecondaryButton("Save name") {
                    if let error = SettingsModel.saveName(name, identity: identity) {
                        nameError = error
                    } else {
                        nameError = nil
                        name = identity.current.name
                        saved = "Name saved."
                        if authed { Task { await heartbeat.now() } }
                    }
                }
                .padding(.top, 8)
            }
            SettingsRow(title: "Serial", detail: "Generated once for this install; the portal's Kiosk Devices page lists it.") {
                HStack {
                    Text(identity.current.serial).font(KioskType.mono(13)).foregroundStyle(palette.text).textSelection(.enabled)
                    Spacer(minLength: 8)
                    SecondaryButton(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = identity.current.serial
                        copied = true
                    }
                }
            }
            SettingsRow(title: "Mode") { Text("iOS").font(KioskType.mono(13)).foregroundStyle(palette.text) }
            SettingsRow(title: "Device model") { Text(DeviceInfo.rawInfo()["model"] ?? "—").font(KioskType.mono(13)).foregroundStyle(palette.text) }
            BiometricRow()
            EnvironmentRow(onSwitched: onSwitched)
            SettingsRow(title: "Version") { Text(config.kioskVersion).font(KioskType.mono(13)).foregroundStyle(palette.text) }
            AppUpdatesRow()
            KioskToast(text: saved)
        }
        .onAppear {
            name = identity.current.name
        }
    }
}
