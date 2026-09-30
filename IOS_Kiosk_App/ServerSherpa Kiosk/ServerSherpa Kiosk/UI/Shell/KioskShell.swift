import SwiftUI
import UIKit

// MARK: - What the shell shows (pure, tested)

enum FooterStatus: Equatable { case good, bad }

/// A footer entry. `value` renders as a labeled pair; `status` renders the
/// label alone in green or red, with `detail` behind a long press.
struct FooterItem: Equatable {
    let label: String
    var value: String? = nil
    var status: FooterStatus? = nil
    var detail: String? = nil
    var accent = false
}

/// kiosk/src/layout/KioskShell.tsx's footer: Mode · Version · Move · Site · Scan · Data Sync · Dev mode.
@MainActor func footerItems(selection: KioskSetupSelection?, sync: SyncStatus, devMode: Bool, version: String,
                 kioskMove: KioskMove? = nil) -> [FooterItem] {
    var items = [FooterItem(label: "Mode", value: "iOS"), FooterItem(label: "Version", value: version)]
    if let move = selection?.initiativeName ?? kioskMove?.name { items.append(FooterItem(label: "Move", value: move)) }
    if let selection {
        items.append(FooterItem(label: "Site", value: selection.siteName))
        items.append(FooterItem(label: "Scan", value: selection.scanLabel))
    }
    items.append(FooterItem(label: "Data Sync", status: sync.phase == .done ? .good : .bad, detail: syncDetail(sync)))
    if devMode { items.append(FooterItem(label: "Dev mode", value: "On", accent: true)) }
    return items
}

@MainActor private func syncDetail(_ sync: SyncStatus) -> String {
    if sync.phase == .running { return "Downloading move data…" }
    if sync.phase == .error { return "Last sync failed (\(sync.error ?? "unknown")) — re-sync from Kiosk Setup" }
    guard let assets = sync.assets else { return "No move data on this kiosk — sync it from Kiosk Setup" }
    var parts = ["\(assets) assets", "\(sync.people ?? 0) people", "\(sync.containers ?? 0) containers"]
    if let trucks = sync.trucks { parts.append("\(trucks) trucks") }
    let synced = sync.syncedAt.map { " · synced \(Sync.formatSyncedAt($0))" } ?? ""
    return parts.joined(separator: " · ") + synced
}

/// Who is on the kiosk: a move session names the move.
func personLabel(_ session: SessionData) -> String {
    session.kioskMove.map { "Kiosk · \($0.name)" } ?? session.person.displayName
}

func modeChipText(isPad: Bool) -> String { isPad ? "KIOSK · IPAD" : "KIOSK · IPHONE" }

func signOutMessage(waiting: Int) -> String {
    var text = "Whoever uses this kiosk next has to sign in again."
    if waiting == 1 {
        text += " One scan here hasn't reached the portal yet; it waits on this kiosk until someone signs in."
    } else if waiting > 1 {
        text += " \(waiting) scans here haven't reached the portal yet; they wait on this kiosk until someone signs in."
    }
    return text
}

private func registrationTone(_ state: RegistrationState) -> ChipTone {
    switch state {
    case .ok: .green
    case .soon: .amber
    case .expired: .red
    case .none: .slate
    }
}

private func sessionEndsText(_ iso: String) -> String? {
    let plain = ISO8601DateFormatter()
    let frac = ISO8601DateFormatter()
    frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = plain.date(from: iso) ?? frac.date(from: iso) else { return nil }
    return "Session ends \(date.formatted(date: .abbreviated, time: .shortened))"
}

// MARK: - The shell

/// kiosk/src/layout/KioskShell.tsx: ink top bar, the page, one-line mono footer.
struct KioskShell<Content: View>: View {
    @Binding var path: [Route]
    @ViewBuilder let content: () -> Content

    @Environment(KioskAuth.self) private var auth
    @Environment(Identity.self) private var identity
    @Environment(Heartbeat.self) private var heartbeat
    @Environment(KioskPrefs.self) private var prefs
    @Environment(KioskConfig.self) private var config
    @Environment(Sync.self) private var sync
    @Environment(Outbox.self) private var outbox
    @Environment(\.kioskPalette) private var palette
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var confirmSignOut = false

    private var session: SessionData? {
        if case .authed(let s) = auth.state { return s }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottom) { ToastHost().padding(.bottom, 12) }
            footer
        }
        .background(palette.paper2)
        .alert("Sign out of this kiosk?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { Task { await auth.logout() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(signOutMessage(waiting: outbox.snapshot.counts.queued + outbox.snapshot.counts.failed))
        }
    }

    // MARK: top bar

    private var topBar: some View {
        Group {
            if sizeClass == .compact {
                VStack(alignment: .leading, spacing: 8) {
                    brand
                    HStack(spacing: 10) { kioskName; Spacer(minLength: 0); userItems }
                }
            } else {
                HStack(spacing: 12) {
                    brand
                    Spacer(minLength: 8)
                    kioskName
                    userItems
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.ink.ignoresSafeArea(edges: .top))
    }

    private var brand: some View {
        HStack(spacing: 8) {
            Image("Logo").resizable().scaledToFit().frame(width: 26, height: 26).accessibilityHidden(true)
            (Text("Server").foregroundStyle(palette.snow) + Text("Sherpa").foregroundStyle(palette.accent))
                .font(KioskType.sans(17, .semibold))
                .lineLimit(1)
            Text(modeChipText(isPad: UIDevice.current.userInterfaceIdiom == .pad))
                .font(KioskType.mono(10)).tracking(1)
                .foregroundStyle(palette.snow.opacity(0.7))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .overlay(Capsule().stroke(palette.inkLine, lineWidth: 1))
                .lineLimit(1)
                .fixedSize()
            if let route = path.last {
                Text(feature(route.featureId).title)
                    .font(KioskType.sans(15, .medium))
                    .foregroundStyle(palette.snow)
                    .lineLimit(1)
            }
        }
    }

    private var kioskName: some View {
        Button { path.append(.settings(.thisKiosk)) } label: {
            Text(identity.current.name)
                .font(KioskType.mono(13))
                .foregroundStyle(palette.snow)
                .lineLimit(1)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityHint("This kiosk")
    }

    @ViewBuilder private var userItems: some View {
        if let session {
            HStack(spacing: 10) {
                if let registration = heartbeat.registration {
                    KioskChip(text: registration.label, tone: registrationTone(registration)).fixedSize()
                }
                Text(personLabel(session))
                    .font(KioskType.bodySmall)
                    .foregroundStyle(Tokens.darkTextMute)
                    .lineLimit(1)
                    .contextMenu {
                        if let ends = sessionEndsText(session.sessionExpiresAt) { Text(ends) }
                    }
                SecondaryButton("Sign out", borderColor: palette.inkLine, foreground: palette.snow) { confirmSignOut = true }
                    .fixedSize()
            }
        }
    }

    // MARK: footer

    private var footer: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            ShellFooterLine(items: footerItems(selection: prefs.setupSelection, sync: sync.status, devMode: prefs.devMode,
                                               version: config.kioskVersion, kioskMove: session?.kioskMove))
        }
        .background(palette.paper.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(palette.paperLine).frame(height: 1) }
    }
}

/// The footer's one mono line.
struct ShellFooterLine: View {
    let items: [FooterItem]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if index > 0 { Text("·").foregroundStyle(palette.textMute).accessibilityHidden(true) }
                footItem(item)
            }
        }
        .font(KioskType.mono(11))
        .padding(.horizontal, 14).padding(.vertical, 6)
    }

    @ViewBuilder private func footItem(_ item: FooterItem) -> some View {
        if let status = item.status {
            Text(item.label.uppercased())
                .foregroundStyle(status == .good ? ChipTone.green.text : ChipTone.red.text)
                .contextMenu { if let detail = item.detail { Text(detail) } }
                .accessibilityValue(item.detail ?? "")
        } else {
            HStack(spacing: 4) {
                Text(item.label.uppercased()).foregroundStyle(palette.textMute)
                Text(item.value ?? "").foregroundStyle(item.accent ? palette.accent : palette.text)
            }
        }
    }
}
