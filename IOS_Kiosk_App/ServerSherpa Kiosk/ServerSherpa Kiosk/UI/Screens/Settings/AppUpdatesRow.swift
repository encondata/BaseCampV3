import SwiftUI

// MARK: - Copy (pure, tested)

/// Settings › App updates' first line: where the last check left things.
func updateStatusLine(_ state: UpdateCheckState, installed: InstalledApp) -> String {
    switch state {
    case .idle: return "Not checked yet."
    case .checking: return "Checking…"
    case .failed(let message): return "Couldn't check for updates. \(message)"
    case .done(let offer):
        switch offer {
        case .upToDate: return "Up to date — \(installed.versionName) (\(installed.build))."
        case .available(let version, _, _, _, _): return "Update available — \(version)"
        case .registerFirst: return "Update available"
        case .waiting: return "Update not ready"
        }
    }
}

/// `Last checked HH:mm`, 24-hour in `timeZone`; nil before the first check.
func lastCheckedLine(_ date: Date?, timeZone: TimeZone = .current) -> String? {
    guard let date else { return nil }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = "HH:mm"
    return "Last checked \(formatter.string(from: date))"
}

/// The download size as Files shows it (`48.2 MB`); nil when the Devices site didn't say.
func sizeLine(_ bytes: Int?) -> String? {
    guard let bytes else { return nil }
    return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}

// MARK: - The row

/// Settings › This Kiosk › App updates: the last check's answer, Update when one can be installed,
/// and Check for updates (the visible control for the automatic checks). Signed out it explains
/// that a check needs a sign-in.
struct AppUpdatesRow: View {
    @Environment(UpdateChecker.self) private var updates
    @Environment(KioskAuth.self) private var auth
    @Environment(\.kioskPalette) private var palette
    @Environment(\.openURL) private var openURL

    private var authed: Bool { if case .authed = auth.state { true } else { false } }
    private var checking: Bool { updates.state == .checking }

    var body: some View {
        SettingsRow(title: "App updates",
                    detail: "Updates come from the Devices site. The kiosk checks after sign-in and every 6 hours.") {
            VStack(alignment: .leading, spacing: 8) {
                status
                offerDetail
                if !authed {
                    Text("Sign in to check for updates.").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                        .fixedSize(horizontal: false, vertical: true)
                }
                SecondaryButton("Check for updates", enabled: authed && !checking) {
                    Task { await updates.checkNow() }
                }
                .accessibilityIdentifier("check-for-updates")
                if let last = lastCheckedLine(updates.lastChecked) {
                    Text(last).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                }
            }
        }
    }

    @ViewBuilder private var status: some View {
        let line = updateStatusLine(updates.state, installed: updates.installed)
        if case .failed = updates.state {
            KioskToast(text: line, error: true)
        } else {
            Text(line).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var offerDetail: some View {
        if case .done(let offer) = updates.state {
            switch offer {
            case .available(_, _, let notes, let size, let installUrl):
                if let notes, !notes.isEmpty {
                    Text(notes).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let size = sizeLine(size) {
                    Text(size).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                }
                PrimaryButton("Update") { openURL(installUrl) }
                    .accessibilityIdentifier("update-now")
            case .registerFirst(let message), .waiting(let message):
                Text(message).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                    .fixedSize(horizontal: false, vertical: true)
            case .upToDate:
                EmptyView()
            }
        }
    }
}
