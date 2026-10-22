import SwiftUI

/// kiosk/src/timeclock/screens/VerifyBadge.tsx: Verify Your Badge, a placeholder until
/// RFID badge reads land; no tag is read yet, so Continue moves on.
struct TcVerifyView: View {
    let model: TimeclockFlowModel
    @Environment(\.tcMetrics) private var m

    var body: some View {
        VStack(spacing: m.gap) {
            TcTitle(text: "Verify Your Badge")
            TcLead(text: "Place your badge against the reader to check it's working.")
            Image(systemName: "wave.3.right.circle")
                .font(.system(size: m.art * 0.6))
                .foregroundStyle(TcColors.ink)
                .frame(width: m.art, height: m.art * 0.8)
                .accessibilityHidden(true)
            Button("Continue") { model.verifyContinue() }
                .buttonStyle(TcButtonStyle(kind: .primary))
                .frame(maxWidth: 680)
                .padding(.top, m.clamp(8, m.gap * 0.8, 24))
        }
    }
}
