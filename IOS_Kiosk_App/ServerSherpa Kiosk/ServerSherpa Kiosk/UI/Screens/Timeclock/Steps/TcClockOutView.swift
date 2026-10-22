import SwiftUI

/// kiosk/src/timeclock/screens/ClockOutSummary.tsx: today so far (the big total and
/// the day's punches), then Confirm Clock Out. In landscape the total sits left of
/// the table. A span that began before today shows its day ("yesterday 10:00 PM").
struct TcClockOutView: View {
    let model: TimeclockFlowModel
    let status: KioskTimeclockStatus
    @Environment(\.tcMetrics) private var m

    private var worked: String { formatWorked(Double(status.todayMinutes)) }

    var body: some View {
        Group {
            if m.landscape {
                HStack(alignment: .center, spacing: m.clamp(24, m.size.width * 0.05, 72)) {
                    total(alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
                    side.frame(maxWidth: .infinity)
                }
                .frame(maxWidth: 1100)
            } else {
                VStack(spacing: m.gap) {
                    total(alignment: .center)
                    side.frame(maxWidth: 680)
                }
                .frame(maxWidth: 820)
            }
        }
    }

    private func total(alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 4) {
            HStack(spacing: m.title * 0.35) {
                Image(systemName: "clock.badge.xmark").foregroundStyle(TcColors.amber)
                Text("Clock Out")
            }
            .font(KioskType.sans(m.title, .heavy))
            .foregroundStyle(TcColors.ink)
            .padding(.bottom, m.clamp(8, m.gap * 0.8, 24))
            .accessibilityAddTraits(.isHeader)
            TcLead(text: "You've been working for")
            Text(worked)
                .font(KioskType.sans(m.big, .heavy))
                .tracking(-0.03 * m.big)
                .foregroundStyle(TcColors.ink)
            TcLead(text: "today")
        }
    }

    private var side: some View {
        VStack(spacing: 16) {
            VStack(spacing: 0) {
                ForEach(Array(status.todayEntries.enumerated()), id: \.offset) { _, entry in
                    row(icon: "clock.badge.checkmark", label: "Clock In", value: formatPunch(entry.clockInAt))
                    row(icon: "clock.badge.xmark", label: "Clock Out", value: entry.clockOutAt.map { formatPunch($0) } ?? "now")
                }
                Rectangle().fill(TcColors.keyShadow).frame(height: 1)
                row(icon: nil, label: "Total", value: worked, total: true)
            }
            .background(TcColors.tableFill.opacity(0.92), in: RoundedRectangle(cornerRadius: 16))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            if let error = model.state.error { TcPunchErrorView(error: error, busy: model.busy) { model.retry() } }
            Button { model.confirmClockOut() } label: {
                HStack(spacing: 12) { Text("Confirm Clock Out"); Image(systemName: "arrow.right") }
            }
            .buttonStyle(TcButtonStyle(kind: .primary))
            .disabled(model.busy)
        }
    }

    private func row(icon: String?, label: String, value: String, total: Bool = false) -> some View {
        HStack(spacing: 14) {
            if let icon { Image(systemName: icon).foregroundStyle(TcColors.ink) }
            Text(label)
                .font(KioskType.sans(m.table, total ? .bold : .medium))
                .foregroundStyle(total ? TcColors.ink : TcColors.muted)
            Spacer(minLength: 8)
            Text(value)
                .font(KioskType.sans(m.table, total ? .bold : .semibold))
                .foregroundStyle(TcColors.ink)
                .lineLimit(1)
        }
        .font(KioskType.sans(m.table))
        .padding(.vertical, m.clamp(8, m.table * 0.5, 14))
        .padding(.horizontal, m.clamp(14, m.table, 28))
        .accessibilityElement(children: .combine)
    }
}
