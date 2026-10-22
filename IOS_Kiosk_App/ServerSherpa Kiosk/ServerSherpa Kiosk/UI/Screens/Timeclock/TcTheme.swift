import SwiftUI

/// The time clock's own colors (kiosk/src/styles/timeclock.css `.tcx` tokens, from the
/// portal's light sign-in page). Always light, whatever the kiosk's theme.
enum TcColors {
    static let ink = LoginTokens.ink              // #0F172A
    static let amber = LoginTokens.orange         // #FF6A00
    static let amberTop = Color(hex: 0xFF7A1A)
    static let paper = LoginTokens.canvas         // #FFF9F2
    static let slate = LoginTokens.slate          // #64748B
    static let muted = Color(hex: 0x4A5D7E)
    static let line = Color(hex: 0xDDE3EA)
    static let motto = Color(hex: 0x334155)
    static let blue = Color(hex: 0x1677F2)
    static let blueTop = Color(hex: 0x2A86F7)
    static let green = Color(hex: 0x16A34A)
    static let errorText = Color(hex: 0xB42318)
    static let noticeFill = Color(hex: 0xFFF1E3)
    static let punchErrorFill = Color(hex: 0xFEF2F2)
    static let punchErrorEdge = Color(hex: 0xE5372B)
    static let punchErrorText = Color(hex: 0x991B1B)
    static let ghostFill = Color(hex: 0xEEF1F5)
    static let keyMod = Color(hex: 0xE2E8F0)
    static let keyShadow = Color(hex: 0xCBD5E1)
    static let searchShadow = Color(hex: 0xC2410C)
    static let tableFill = Color(hex: 0xF1F5F9)
    static let inInk = Color(hex: 0x15803D)
    static let inEdge = Color(hex: 0x86D3A3)
    static let inTop = Color(hex: 0xF3FCF6)
    static let inBottom = Color(hex: 0xE4F7EB)
    static let outInk = Color(hex: 0xDC2626)
    static let outEdge = Color(hex: 0xF5A9A3)
    static let outTop = Color(hex: 0xFFF6F5)
    static let outBottom = Color(hex: 0xFFE9E7)
}

/// Layout A when the screen is wider than it is tall (spec §5): the greeting on
/// top, the photo left of the name, the tiles in one row, the total left of the
/// punches table, the results beside the keyboard.
func tcIsLandscape(_ size: CGSize) -> Bool { size.width > size.height }

/// The stylesheet's `clamp(lo, n vmin/vh, hi)` sizes for one screen size.
struct TcMetrics: Equatable {
    let size: CGSize

    var landscape: Bool { tcIsLandscape(size) }
    private var vmin: CGFloat { min(size.width, size.height) / 100 }
    private var vh: CGFloat { size.height / 100 }
    /// Portrait uses vmin, landscape vh (the stylesheet's landscape block).
    private var unit: CGFloat { landscape ? vh : vmin }
    /// A short screen (a phone on its side) gets smaller floors so the keys fit.
    private var short: Bool { size.height < 500 }

    func clamp(_ lo: CGFloat, _ v: CGFloat, _ hi: CGFloat) -> CGFloat { min(max(v, lo), hi) }

    var pad: CGFloat { landscape ? clamp(14, 2.4 * vh, 32) : clamp(16, 3 * vmin, 40) }
    var footHeight: CGFloat { size.height * (landscape ? 0.36 : 0.30) }
    var mainTop: CGFloat { landscape ? clamp(8, 4 * vh, 64) : clamp(16, 5 * vh, 96) }
    var mainBottom: CGFloat { footHeight * (landscape ? 0.45 : 0.55) }
    var gap: CGFloat { landscape ? clamp(10, 2.2 * vh, 26) : clamp(12, 2.4 * vmin, 30) }

    var hero: CGFloat { landscape ? clamp(short ? 30 : 40, 9 * vh, 96) : clamp(44, 10 * vmin, 112) }
    var heroDone: CGFloat { clamp(short ? 28 : 36, 8 * unit, 92) }
    var title: CGFloat { landscape ? clamp(short ? 22 : 28, 6 * vh, 60) : clamp(30, 6 * vmin, 64) }
    var lead: CGFloat { landscape ? clamp(short ? 14 : 16, 3.2 * vh, 32) : clamp(18, 3.6 * vmin, 38) }
    var hint: CGFloat { clamp(15, 2.2 * unit, 20) }
    var notice: CGFloat { clamp(16, 2.4 * unit, 22) }
    var errorText: CGFloat { clamp(17, 2.6 * unit, 24) }

    // header
    var logo: CGFloat { clamp(44, 7.5 * vmin, 92) }
    var wordmark: CGFloat { clamp(22, 3.8 * vmin, 44) }
    var tagline: CGFloat { clamp(8.5, 1.25 * vmin, 13) }
    var date: CGFloat { clamp(11, 1.6 * vmin, 17) }
    var time: CGFloat { clamp(20, 3.6 * vmin, 40) }
    var motto: CGFloat { clamp(10, 1.5 * vmin, 15) }

    // buttons
    var button: CGFloat { clamp(19, 3 * unit, 30) }
    var buttonHeight: CGFloat { short ? 52 : 64 }
    var back: CGFloat { clamp(17, 2.4 * unit, 24) }
    var backBottom: CGFloat { pad + clamp(28, 4 * vh, 44) }

    // Welcome
    var cardHeight: CGFloat { landscape ? clamp(short ? 76 : 90, 16 * vh, 170) : clamp(96, 15 * vmin, 190) }
    var cardIcon: CGFloat { clamp(short ? 40 : 52, 9 * unit, 104) }
    var cardTitle: CGFloat { clamp(22, 4 * unit, 44) }
    var cardSub: CGFloat { clamp(14, 2.2 * unit, 24) }

    // Enter Your Name
    var searchText: CGFloat { clamp(20, 3 * unit, 30) }
    var resultName: CGFloat { clamp(18, 2.8 * unit, 26) }
    var resultSub: CGFloat { clamp(13, 1.9 * unit, 18) }
    var keyHeight: CGFloat { landscape ? clamp(short ? 38 : 56, 8 * vh, 80) : clamp(56, 8 * vmin, 84) }
    var keyText: CGFloat { clamp(short ? 16 : 20, 3.4 * unit, 32) }
    var keyGap: CGFloat { clamp(5, 1 * unit, 10) }

    // Is this you?
    var avatar: CGFloat { landscape ? clamp(short ? 110 : 140, 34 * vh, 360) : clamp(150, 32 * vmin, 380) }
    var ask: CGFloat { clamp(short ? 22 : 26, 5 * unit, 54) }
    var personName: CGFloat { landscape ? clamp(short ? 28 : 34, 8 * vh, 84) : clamp(38, 8.4 * vmin, 92) }
    var personMeta: CGFloat { clamp(17, 3 * unit, 32) }

    // What would you like to do?
    var tileHeight: CGFloat { landscape ? clamp(short ? 130 : 170, 32 * vh, 360) : clamp(200, 30 * vmin, 400) }
    var tileIcon: CGFloat { clamp(short ? 48 : 64, 13 * unit, 150) }
    var tileTitle: CGFloat { clamp(24, 5 * unit, 52) }
    var tileSub: CGFloat { clamp(14, 2.4 * unit, 24) }

    // Clock Out
    var big: CGFloat { landscape ? clamp(short ? 44 : 56, 14 * vh, 150) : clamp(64, 15 * vmin, 168) }
    var table: CGFloat { clamp(16, 2.6 * unit, 26) }

    // badge, printing, verify, done
    var art: CGFloat { landscape ? clamp(short ? 80 : 120, 26 * vh, 280) : clamp(140, 30 * vmin, 320) }
    var check: CGFloat { landscape ? clamp(short ? 72 : 100, 20 * vh, 220) : clamp(120, 24 * vmin, 260) }

    /// The page column's width: the stylesheet's `max-width` for the step, inside 16 pt gutters.
    func column(_ maxWidth: CGFloat) -> CGFloat { max(0, min(size.width - 32, maxWidth)) }
}

private struct TcMetricsKey: EnvironmentKey {
    static let defaultValue = TcMetrics(size: CGSize(width: 820, height: 1180))
}

extension EnvironmentValues {
    var tcMetrics: TcMetrics {
        get { self[TcMetricsKey.self] }
        set { self[TcMetricsKey.self] = newValue }
    }
}

/// `.tcx-btn`: primary (amber), ghost, blue; 64 pt tall, rounded 14.
struct TcButtonStyle: ButtonStyle {
    enum Kind { case primary, ghost, blue }
    let kind: Kind
    var small = false
    @Environment(\.tcMetrics) private var m
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let size = small ? m.clamp(16, m.button * 0.72, 20) : m.button
        configuration.label
            .font(KioskType.sans(size, .bold))
            .foregroundStyle(kind == .ghost ? TcColors.ink : Color.white)
            .padding(.horizontal, small ? 22 : 28)
            .frame(minHeight: small ? 56 : m.buttonHeight)
            .frame(maxWidth: small ? nil : .infinity)
            .background(fill, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(kind == .ghost ? TcColors.line : .clear, lineWidth: 1))
            .shadow(color: enabled ? shadow : .clear, radius: 8, y: 6)
            .opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.55)
            .contentShape(RoundedRectangle(cornerRadius: 14))
    }

    private var fill: AnyShapeStyle {
        switch kind {
        case .primary: AnyShapeStyle(LinearGradient(colors: [TcColors.amberTop, TcColors.amber], startPoint: .top, endPoint: .bottom))
        case .blue: AnyShapeStyle(LinearGradient(colors: [TcColors.blueTop, TcColors.blue], startPoint: .top, endPoint: .bottom))
        case .ghost: AnyShapeStyle(TcColors.ghostFill)
        }
    }

    private var shadow: Color {
        switch kind {
        case .primary: TcColors.amber.opacity(0.3)
        case .blue: TcColors.blue.opacity(0.28)
        case .ghost: .clear
        }
    }
}

/// A step's big heading ("Enter Your Name", "What would you like to do?").
struct TcTitle: View {
    let text: String
    @Environment(\.tcMetrics) private var m

    var body: some View {
        Text(text)
            .font(KioskType.sans(m.title, .heavy))
            .tracking(-0.015 * m.title)
            .foregroundStyle(TcColors.ink)
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A step's lead line under the heading.
struct TcLead: View {
    let text: String
    @Environment(\.tcMetrics) private var m

    var body: some View {
        Text(text)
            .font(KioskType.sans(m.lead))
            .foregroundStyle(TcColors.muted)
            .multilineTextAlignment(.center)
    }
}

/// `.tcx-notice`: an amber-edged note ("Your status changed…", a paused station).
struct TcNotice: View {
    let text: String
    @Environment(\.tcMetrics) private var m

    var body: some View {
        Text(text)
            .font(KioskType.sans(m.notice))
            .foregroundStyle(TcColors.ink)
            .lineSpacing(3)
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.vertical, 14).padding(.horizontal, 18)
            .background(TcColors.noticeFill, in: RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .leading) {
                UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10).fill(TcColors.amber).frame(width: 4)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.updatesFrequently)
    }
}

/// `.tcx-error-text`: "We couldn't find that code." and the like.
struct TcErrorText: View {
    let text: String
    @Environment(\.tcMetrics) private var m

    var body: some View {
        Text(text)
            .font(KioskType.sans(m.errorText, .semibold))
            .foregroundStyle(TcColors.errorText)
            .multilineTextAlignment(.center)
    }
}
