import SwiftUI

/// Android `PairPanel.kt`: a code to approve from a phone, as a QR of the link
/// and in large type, counting down; polls until approved, denied or expired.
struct PairPanel: View {
    /// Owned by the login screen, so a relayout (rotation) keeps the same code.
    let vm: PairViewModel
    @Environment(KioskConfig.self) private var config
    /// Built once per code, not on every countdown tick.
    @State private var qr: UIImage?
    let f: CGFloat

    var body: some View {
        VStack(spacing: 10 * f) {
            switch vm.phase {
            case .requesting:
                Text("Getting a code…")
                    .font(KioskType.sans(17 * f))
                    .foregroundStyle(LoginTokens.slate)
                    .padding(.vertical, 24 * f)
            case .error:
                failure("Couldn't get a code (\(vm.error)). Try again.", button: "Try again")
            case .denied:
                failure("Sign-in was declined on the phone.", button: "Get a new code")
            case .expired:
                failure("This code expired.", button: "Get a new code")
            case .showing:
                if let pair = vm.pair { showing(pair) }
            }
        }
        .frame(maxWidth: .infinity)
        .task(id: vm.pair?.code) { qr = vm.pair.flatMap { Qr.image(for: $0.linkUrl, scale: 8) } }
    }

    @ViewBuilder private func showing(_ pair: PairCreated) -> some View {
        if let qr {
            Image(uiImage: qr)
                .interpolation(.none)
                .resizable()
                .frame(width: 220 * f, height: 220 * f)
                .padding(10 * f)
                .background(.white, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(LoginTokens.line, lineWidth: 1))
                .accessibilityLabel("QR code to link this kiosk")
        }
        Text(formatPairCode(pair.code))
            .font(KioskType.mono(40 * f))
            .foregroundStyle(LoginTokens.ink)
            .padding(.top, 4 * f)
        Text("Scan the code, or open \(portalHost(config.portalUrl))/link on your phone and enter it.")
            .font(KioskType.sans(16 * f))
            .foregroundStyle(LoginTokens.slate)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        Text("Expires in \(formatRemaining(vm.remainingSec))")
            .font(KioskType.mono(14 * f))
            .foregroundStyle(LoginFormColors.label)
        LoginUnderlinedLink(title: "Get a new code", size: 16 * f) { Task { await vm.begin() } }
    }

    private func failure(_ message: String, button: String) -> some View {
        VStack(spacing: 14 * f) {
            LoginErrorText(text: message, f: f)
            Button { Task { await vm.begin() } } label: {
                Text(button)
                    .font(KioskType.sans(20 * f, .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: max(44, 56 * f))
                    .background(LoginTokens.ink, in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}
