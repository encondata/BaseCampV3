import SwiftUI

/// kiosk/src/timeclock/screens/ChooseAction.tsx: What would you like to do? Clock In
/// and Clock Out; only the one that fits the person's status can be tapped, the
/// other is dimmed. Clock In punches straight away. The tiles sit in one row.
struct TcActionView: View {
    let model: TimeclockFlowModel
    let status: KioskTimeclockStatus
    @Environment(\.tcMetrics) private var m

    var body: some View {
        VStack(spacing: m.gap) {
            TcTitle(text: "What would you like to do?")
            if let notice = model.state.notice { TcNotice(text: notice) }
            if let error = model.state.error { TcPunchErrorView(error: error, busy: model.busy) { model.retry() } }
            HStack(spacing: m.clamp(14, m.gap, 30)) {
                TcTile(icon: "clock.badge.checkmark", title: "Clock In", sub: "Start your work day", isIn: true,
                       disabled: model.busy || status.clockedIn) { model.chooseIn() }
                TcTile(icon: "clock.badge.xmark", title: "Clock Out", sub: "End your work day", isIn: false,
                       disabled: model.busy || !status.clockedIn) { model.chooseOut() }
            }
            .frame(maxWidth: m.landscape ? 1000 : 820)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("What would you like to do?")
        }
        .frame(maxWidth: m.landscape ? 1000 : 820)
    }
}

/// `.tcx-tile`: green Clock In, red Clock Out.
private struct TcTile: View {
    let icon: String
    let title: String
    let sub: String
    let isIn: Bool
    let disabled: Bool
    let action: () -> Void
    @Environment(\.tcMetrics) private var m

    var body: some View {
        let ink = isIn ? TcColors.inInk : TcColors.outInk
        Button(action: action) {
            VStack(spacing: m.clamp(6, m.tileHeight * 0.04, 14)) {
                Image(systemName: icon).font(.system(size: m.tileIcon * 0.75, weight: .regular))
                    .frame(height: m.tileIcon)
                Text(title).font(KioskType.sans(m.tileTitle, .bold))
                Text(sub).font(KioskType.sans(m.tileSub, .medium))
            }
            .foregroundStyle(ink)
            .multilineTextAlignment(.center)
            .padding(.vertical, 20).padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: m.tileHeight)
            .background(LinearGradient(colors: isIn ? [TcColors.inTop, TcColors.inBottom] : [TcColors.outTop, TcColors.outBottom],
                                       startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(isIn ? TcColors.inEdge : TcColors.outEdge, lineWidth: 2))
            .shadow(color: disabled ? .clear : TcColors.ink.opacity(0.06), radius: 9, y: 6)
            .contentShape(RoundedRectangle(cornerRadius: 22))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .saturation(disabled ? 0.3 : 1)
        .opacity(disabled ? 0.32 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityHint(sub)
    }
}
