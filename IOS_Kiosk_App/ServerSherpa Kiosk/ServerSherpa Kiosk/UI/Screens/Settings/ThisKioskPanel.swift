import SwiftUI
import UIKit

/// Settings › This Kiosk: name, serial, mode, API/portal URLs, version — usable signed out.
struct ThisKioskPanel: View {
    @Environment(KioskConfig.self) private var config
    @Environment(Identity.self) private var identity
    @Environment(Heartbeat.self) private var heartbeat
    @Environment(KioskAuth.self) private var auth
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette
    @State private var name = ""
    @State private var api = ""
    @State private var portal = ""
    @State private var nameError: String?
    @State private var urlError: String?
    @State private var saved: String?
    @State private var copied = false

    private var authed: Bool { if case .authed = auth.state { true } else { false } }

    private func field(_ placeholder: String, _ text: Binding<String>, url: Bool = false) -> some View {
        TextField(placeholder, text: text)
            .font(KioskType.bodyLarge)
            .textInputAutocapitalization(url ? .never : .sentences)
            .autocorrectionDisabled(url)
            .keyboardType(url ? .URL : .default)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsRow(title: "Kiosk name", detail: "What people see on their phone when they link with this kiosk. 1–\(NAME_MAX) characters.") {
                field("Kiosk name", $name).accessibilityIdentifier("kiosk-name")
                    .onChange(of: name) { nameError = nil }
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
            SettingsRow(title: "API URL", detail: "Where this kiosk talks to the portal. Must start with http:// or https://. Saving a new API address signs this kiosk out.") {
                field("https://api.serversherpa.com", $api, url: true).accessibilityIdentifier("api-url")
                    .onChange(of: api) { urlError = nil }
                Text("Portal URL").font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 8)
                field("https://portal.serversherpa.com", $portal, url: true).accessibilityIdentifier("portal-url")
                    .onChange(of: portal) { urlError = nil }
                KioskToast(text: urlError, error: true)
                SecondaryButton("Save URLs") {
                    Task {
                        if let error = await SettingsModel.saveUrls(api: api, portal: portal, config: config,
                                                                    session: container.sessionStore, auth: auth) {
                            urlError = error
                        } else {
                            urlError = nil
                            api = config.apiUrl
                            portal = config.portalUrl
                            saved = "URLs saved."
                        }
                    }
                }
                .padding(.top, 8)
            }
            SettingsRow(title: "Version") { Text(config.kioskVersion).font(KioskType.mono(13)).foregroundStyle(palette.text) }
            KioskToast(text: saved)
        }
        .onAppear {
            name = identity.current.name
            api = config.apiUrl
            portal = config.portalUrl
        }
    }
}
