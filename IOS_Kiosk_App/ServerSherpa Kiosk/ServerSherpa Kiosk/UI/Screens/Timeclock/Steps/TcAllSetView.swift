import SwiftUI

/// kiosk/src/timeclock/screens/AllSet.tsx: You're All Set! The flow returns to its
/// start on its own after 8 s.
struct TcAllSetView: View {
    let model: TimeclockFlowModel
    @Environment(\.tcMetrics) private var m

    var body: some View {
        VStack(spacing: m.gap) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: m.check))
                .foregroundStyle(.white, TcColors.green)
                .shadow(color: TcColors.green.opacity(0.3), radius: 11, y: 10)
                .accessibilityHidden(true)
            Text("You're All Set!")
                .font(KioskType.sans(m.heroDone, .heavy))
                .tracking(-0.02 * m.heroDone)
                .foregroundStyle(TcColors.ink)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: m.lead * 0.2) {
                Text("Have a great day,").font(KioskType.sans(m.lead)).foregroundStyle(TcColors.muted)
                Text("\(model.firstName)!").font(KioskType.sans(m.lead * 1.9, .heavy)).foregroundStyle(TcColors.ink)
            }
            .multilineTextAlignment(.center)
            .accessibilityElement(children: .combine)
            Button("Done") { model.done() }
                .buttonStyle(TcButtonStyle(kind: .blue))
                .frame(maxWidth: 680)
                .padding(.top, m.clamp(8, m.gap * 0.8, 24))
        }
    }
}
