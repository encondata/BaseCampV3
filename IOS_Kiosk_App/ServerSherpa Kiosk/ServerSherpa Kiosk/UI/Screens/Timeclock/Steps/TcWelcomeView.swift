import SwiftUI

let TC_PAUSED_TEXT = "This time clock is paused. Ask an administrator to sign in here or renew this kiosk on Kiosk Devices."
let TC_KEY_MISSING_TEXT = "This time clock is waiting for its station key. Check the connection, or ask an administrator to sign in here."

/// kiosk/src/timeclock/screens/Welcome.tsx (station only): the greeting and the two
/// ways in. A badge reader scans at any time into the flow's key capture; on iOS the
/// Scan card opens the camera.
struct TcWelcomeView: View {
    let model: TimeclockFlowModel
    let onScan: (() -> Void)?
    @Environment(\.tcMetrics) private var m

    var body: some View {
        VStack(spacing: m.gap) {
            Text("Welcome!")
                .font(KioskType.sans(m.hero, .heavy))
                .tracking(-0.02 * m.hero)
                .foregroundStyle(TcColors.ink)
                .accessibilityAddTraits(.isHeader)
            TcLead(text: "Please identify yourself to continue.")
            if model.paused { TcNotice(text: model.keyMissing ? TC_KEY_MISSING_TEXT : TC_PAUSED_TEXT) }
            if let message = model.shownMessage { TcErrorText(text: message) }
            let cards = Group {
                TcWelcomeCard(icon: "qrcode.viewfinder", title: "Scan Your QR Code", sub: "Scan your code with the reader",
                              disabled: model.paused) { onScan?() }
                TcWelcomeCard(icon: "keyboard", title: "Enter Your Name", sub: "Type your name on screen",
                              disabled: model.paused) { model.enterName() }
            }
            if m.landscape {
                HStack(spacing: m.clamp(14, m.gap, 28)) { cards }.frame(maxWidth: 1000)
            } else {
                VStack(spacing: m.clamp(14, m.gap, 28)) { cards }.frame(maxWidth: 760)
            }
        }
        .frame(maxWidth: m.landscape ? 1100 : 820)
    }
}

/// `.tcx-card`: icon, title and line, chevron.
private struct TcWelcomeCard: View {
    let icon: String
    let title: String
    let sub: String
    let disabled: Bool
    let action: () -> Void
    @Environment(\.tcMetrics) private var m

    var body: some View {
        Button(action: action) {
            HStack(spacing: m.clamp(16, m.cardIcon * 0.35, 36)) {
                Image(systemName: icon)
                    .font(.system(size: m.cardIcon * 0.7, weight: .regular))
                    .foregroundStyle(TcColors.amber)
                    .frame(width: m.cardIcon, height: m.cardIcon)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(KioskType.sans(m.cardTitle, .bold)).foregroundStyle(TcColors.ink)
                    Text(sub).font(KioskType.sans(m.cardSub)).foregroundStyle(TcColors.muted)
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 24, weight: .semibold)).foregroundStyle(TcColors.slate)
            }
            .padding(.vertical, m.clamp(16, m.cardHeight * 0.17, 32))
            .padding(.horizontal, m.clamp(18, m.cardHeight * 0.2, 40))
            .frame(maxWidth: .infinity, minHeight: m.cardHeight)
            .background(Color.white.opacity(0.92), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(TcColors.line, lineWidth: 1))
            .shadow(color: TcColors.ink.opacity(0.07), radius: 9, y: 6)
            .contentShape(RoundedRectangle(cornerRadius: 20))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityHint(sub)
    }
}
