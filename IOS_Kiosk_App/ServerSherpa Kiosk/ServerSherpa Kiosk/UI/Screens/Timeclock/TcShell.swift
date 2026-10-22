import SwiftUI

/// kiosk/src/timeclock/TcShell.tsx: the time clock's full-screen frame. Faint
/// contour lines on the light paper, the logo and wordmark with the live date and
/// time on top, the mountain scene with "TRACK | MONITOR | VERIFY | COMPLETE" along
/// the bottom, and Back pinned bottom-left. No kiosk top bar or footer: the flow
/// owns the whole screen in both modes. Always light.
struct TcShell<Content: View>: View {
    let metrics: TcMetrics
    /// Back, bottom-left; nil on steps with no way back.
    var back: (() -> Void)?
    var backDisabled = false
    /// The small gear in the header (station Welcome only).
    var onSettings: (() -> Void)?
    @ViewBuilder let content: () -> Content

    var body: some View {
        let m = metrics
        ZStack(alignment: .bottomLeading) {
            TcBackdrop(metrics: m)
            VStack(spacing: 0) {
                TcHeader(onSettings: onSettings)
                    .padding(.horizontal, m.pad).padding(.top, m.pad)
                ScrollView {
                    content()
                        .frame(maxWidth: .infinity)
                        .padding(.top, m.mainTop)
                        .padding(.horizontal, 16)
                        .padding(.bottom, m.mainBottom + (back == nil ? 0 : 56))
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            if let back {
                Button(action: back) {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.left").font(.system(size: m.back, weight: .semibold))
                        Text("Back")
                    }
                    .font(KioskType.sans(m.back, .semibold))
                    .foregroundStyle(TcColors.ink)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 56)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(TcColors.line, lineWidth: 1))
                    .shadow(color: TcColors.ink.opacity(0.12), radius: 8, y: 6)
                    .contentShape(RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .disabled(backDisabled)
                .opacity(backDisabled ? 0.55 : 1)
                .padding(.leading, m.pad)
                .padding(.bottom, m.backBottom)
            }
        }
        .environment(\.tcMetrics, m)
        .environment(\.colorScheme, .light)
        .background(TcColors.paper.ignoresSafeArea())
    }
}

/// The paper, the contour lines and the mountains with the motto.
private struct TcBackdrop: View {
    let metrics: TcMetrics

    var body: some View {
        ZStack(alignment: .bottom) {
            TcColors.paper
            LoginContours()
            ZStack(alignment: .bottom) {
                // object-fit: cover at object-position center 72 % (the art is 1022×611)
                let w = metrics.size.width, h = metrics.footHeight
                let scale = max(w / 1022, h / 611)
                Image("LoginMountains")
                    .resizable()
                    .frame(width: 1022 * scale, height: 611 * scale)
                    .offset(x: (w - 1022 * scale) / 2, y: (h - 611 * scale) * 0.72)
                    .frame(width: w, height: h, alignment: .topLeading)
                    .clipped()
                    .mask {
                        LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.42)],
                                       startPoint: .top, endPoint: .bottom)
                    }
                Text("TRACK | MONITOR | VERIFY | COMPLETE")
                    .font(KioskType.mono(metrics.motto))
                    .tracking(0.24 * metrics.motto)
                    .foregroundStyle(TcColors.motto)
                    .shadow(color: .white.opacity(0.9), radius: 3)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.horizontal, 12)
                    .padding(.bottom, metrics.clamp(8, metrics.size.height * 0.016, 20))
            }
            .frame(height: metrics.footHeight)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The logo and wordmark, "DATACENTER RELOCATION TOOLS", and the live date and time.
private struct TcHeader: View {
    var onSettings: (() -> Void)?
    @Environment(\.tcMetrics) private var m

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            HStack(spacing: m.clamp(10, m.logo * 0.22, 20)) {
                Image("Logo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: m.logo, height: m.logo)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: m.wordmark * 0.3) {
                    (Text("Server").foregroundColor(TcColors.ink) + Text("Sherpa").foregroundColor(TcColors.amber))
                        .font(KioskType.sans(m.wordmark, .heavy))
                        .tracking(-0.01 * m.wordmark)
                    Text("DATACENTER RELOCATION TOOLS")
                        .font(KioskType.mono(m.tagline))
                        .tracking(0.22 * m.tagline)
                        .foregroundStyle(TcColors.slate)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 8)
            TimelineView(.everyMinute) { context in
                VStack(alignment: .trailing, spacing: 2) {
                    Text(formatHeaderDate(context.date))
                        .font(KioskType.sans(m.date))
                        .foregroundStyle(TcColors.slate)
                    Text(formatClock(context.date))
                        .font(KioskType.sans(m.time, .bold))
                        .foregroundStyle(TcColors.ink)
                }
                .lineLimit(1)
                .fixedSize()
            }
            if let onSettings {
                Button(action: onSettings) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 26))
                        .foregroundStyle(TcColors.slate)
                        .frame(width: 56, height: 56)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
            }
        }
    }
}
