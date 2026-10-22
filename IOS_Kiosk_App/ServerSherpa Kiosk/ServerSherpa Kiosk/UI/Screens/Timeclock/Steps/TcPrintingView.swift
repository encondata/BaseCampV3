import SwiftUI

/// kiosk/src/timeclock/screens/PrintingBadge.tsx: Printing Your Badge, a placeholder
/// until real badge printing lands; the flow moves on to Verify after 3 s.
struct TcPrintingView: View {
    @Environment(\.tcMetrics) private var m

    var body: some View {
        VStack(spacing: m.gap) {
            TcTitle(text: "Printing Your Badge")
            TcLead(text: "Please wait while we print your badge…")
            Image(systemName: "printer.fill")
                .font(.system(size: m.art * 0.6))
                .foregroundStyle(TcColors.ink)
                .frame(width: m.art, height: m.art * 0.8)
                .accessibilityHidden(true)
            ProgressView()
                .controlSize(.large)
                .tint(TcColors.blue)
                .accessibilityLabel("Printing")
        }
    }
}
