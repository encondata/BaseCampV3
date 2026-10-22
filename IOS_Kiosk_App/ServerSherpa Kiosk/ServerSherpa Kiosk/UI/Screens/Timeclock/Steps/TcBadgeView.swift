import SwiftUI

/// kiosk/src/timeclock/screens/BadgeQuestion.tsx: after a Clock In (the punch is
/// already recorded), a new badge or not.
struct TcBadgeView: View {
    let model: TimeclockFlowModel
    @Environment(\.tcMetrics) private var m

    var body: some View {
        VStack(spacing: m.gap) {
            TcTitle(text: "Do you need a new badge?")
            let print = Button("Print a new badge") { model.badgeNew() }.buttonStyle(TcButtonStyle(kind: .primary))
            let works = Button("My badge works") { model.badgeExisting() }.buttonStyle(TcButtonStyle(kind: .ghost))
            Group {
                if m.landscape {
                    HStack(spacing: 14) { print; works }.frame(maxWidth: 900)
                } else {
                    VStack(spacing: 14) { print; works }.frame(maxWidth: 680)
                }
            }
            .padding(.top, m.clamp(10, m.gap, 40))
        }
    }
}
