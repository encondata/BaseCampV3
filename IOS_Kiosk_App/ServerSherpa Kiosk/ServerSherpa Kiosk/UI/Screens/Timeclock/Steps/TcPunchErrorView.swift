import SwiftUI

/// kiosk/src/timeclock/screens/PunchError.tsx: a punch that failed, what happened,
/// and Try again (which re-reads the status before punching).
struct TcPunchErrorView: View {
    let error: String
    let busy: Bool
    let onRetry: () -> Void
    @Environment(\.tcMetrics) private var m

    var body: some View {
        HStack(spacing: 16) {
            Text(error)
                .font(KioskType.sans(m.notice))
                .foregroundStyle(TcColors.punchErrorText)
                .lineSpacing(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Try again", action: onRetry)
                .buttonStyle(TcButtonStyle(kind: .primary, small: true))
                .disabled(busy)
        }
        .padding(.vertical, 14).padding(.horizontal, 18)
        .frame(maxWidth: 720)
        .background(TcColors.punchErrorFill, in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10).fill(TcColors.punchErrorEdge).frame(width: 4)
        }
        .accessibilityElement(children: .contain)
    }
}
