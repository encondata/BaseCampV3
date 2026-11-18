import SwiftUI

/// Home's update card, above the setup banner, while the last check offers one (and Later hasn't
/// hidden it): Update and Later for a build this iPhone can install, or the register-first message
/// and Later. Update checks again first (the install link expires 30 minutes after its answer) and
/// opens only the link that fresh answer carries; a check that fails says why on the card.
struct UpdateBanner: View {
    @Environment(UpdateChecker.self) private var updates
    @Environment(\.kioskPalette) private var palette
    @Environment(\.openURL) private var openURL
    /// Update was tapped: a failure since then shows on the card.
    @State private var updateTapped = false

    private var checking: Bool { updates.state == .checking }

    var body: some View {
        if let offer = updates.homeOffer {
            card(offer)
        }
    }

    @ViewBuilder private func card(_ offer: UpdateOffer) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch offer {
            case .available(let version, _, _, _, _):
                title("Update available — \(version)")
                if updateTapped, case .failed = updates.state {
                    KioskToast(text: updateStatusLine(updates.state, installed: updates.installed), error: true)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { update; later }
                    VStack(alignment: .leading, spacing: 8) { update; later }
                }
            case .registerFirst(let message):
                title("Update available")
                Text(message).font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                    .fixedSize(horizontal: false, vertical: true)
                later
            case .upToDate, .waiting:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-banner")
    }

    private func title(_ text: String) -> some View {
        Text(text).font(KioskType.titleMedium).foregroundStyle(palette.text)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var update: some View {
        PrimaryButton("Update", enabled: !checking) {
            updateTapped = true
            Task { if let url = await updates.freshInstallUrl() { openURL(url) } }
        }
        .accessibilityIdentifier("update-banner-update")
    }

    private var later: some View {
        SecondaryButton("Later") { updates.later() }.accessibilityIdentifier("update-banner-later")
    }
}
