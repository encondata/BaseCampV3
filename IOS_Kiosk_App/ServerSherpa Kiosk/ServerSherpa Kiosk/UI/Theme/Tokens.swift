import SwiftUI

extension Color {
    /// `0xRRGGBB` in sRGB.
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: alpha)
    }

    /// An opaque color from the kiosk's stored HSL (flash colors).
    init(hsl: Hsl) {
        let c = hslToRGB(hsl)
        self.init(.sRGB, red: c.r, green: c.g, blue: c.b, opacity: 1)
    }
}

/// The portal's CSS tokens (portal/src/styles/portal-theme.css), restated by
/// name as Android `ui/theme/Tokens.kt` does, so a SwiftUI screen and a web
/// screen read the same color.
enum Tokens {
    static let ink = Color(hex: 0x0C1117)
    static let ink2 = Color(hex: 0x121925)
    static let inkLine = Color(hex: 0x243140)
    static let snow = Color(hex: 0xE8EDF4)
    static let ok = Color(hex: 0x3ECF8E)

    static let lightPaper = Color(hex: 0xFBFCFD)
    static let lightPaper2 = Color(hex: 0xF1F4F7)
    static let lightPaperLine = Color(hex: 0xE4E8EE)
    static let lightText = Color(hex: 0x1B2129)
    static let lightTextMute = Color(hex: 0x667085)

    static let darkPaper = Color(hex: 0x10151F)
    static let darkPaper2 = Color(hex: 0x0B0F17)
    static let darkPaperLine = Color(hex: 0xFFFFFF, alpha: Double(0x17) / 255)
    static let darkText = Color(hex: 0xE8EDF4)
    static let darkTextMute = Color(hex: 0x8A97AA)

    static let amber = Color(hex: 0xFFA12E)
    static let amberSoft = Color(hex: 0xFFC06B)
    static let aqua = Color(hex: 0x35E0C8)
    static let aquaSoft = Color(hex: 0x6AF0DD)
    static let blue = Color(hex: 0x4DD0FF)
    static let blueSoft = Color(hex: 0x86E0FF)
    static let violet = Color(hex: 0xA78BFA)
    static let violetSoft = Color(hex: 0xC4B5FD)
    static let pink = Color(hex: 0xFF6FAE)
    static let pinkSoft = Color(hex: 0xFF9EC9)
    static let green = Color(hex: 0x3DDC84)
    static let greenSoft = Color(hex: 0x74E8A8)
}

/// `.portal-shell[data-accent=…]`: the six named accents.
enum Accent: String, CaseIterable, Sendable {
    case amber, aqua, blue, violet, pink, green

    var color: Color {
        switch self {
        case .amber: Tokens.amber
        case .aqua: Tokens.aqua
        case .blue: Tokens.blue
        case .violet: Tokens.violet
        case .pink: Tokens.pink
        case .green: Tokens.green
        }
    }

    var soft: Color {
        switch self {
        case .amber: Tokens.amberSoft
        case .aqua: Tokens.aquaSoft
        case .blue: Tokens.blueSoft
        case .violet: Tokens.violetSoft
        case .pink: Tokens.pinkSoft
        case .green: Tokens.greenSoft
        }
    }

    /// A named accent (any case, trimmed); anything else is amber.
    static func from(_ s: String) -> Accent {
        Accent(rawValue: s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? .amber
    }
}

/// Android `accentFor`: a named accent, or a custom `#rrggbb` (whose soft
/// variant is the color lightened 30 % toward white); anything else is amber.
func accentFor(_ name: String) -> (accent: Color, soft: Color) {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if let named = Accent(rawValue: trimmed) { return (named.color, named.soft) }
    guard let hex = parseHexColor(trimmed) else { return (Accent.amber.color, Accent.amber.soft) }
    func lighten(_ c: UInt32) -> Double { let v = Double(c) / 255; return v + (1 - v) * 0.3 }
    let soft = Color(.sRGB, red: lighten((hex >> 16) & 0xFF), green: lighten((hex >> 8) & 0xFF), blue: lighten(hex & 0xFF), opacity: 1)
    return (Color(hex: hex), soft)
}

private func parseHexColor(_ value: String) -> UInt32? {
    let v = value.hasPrefix("#") ? String(value.dropFirst()) : value
    guard v.count == 6, v.allSatisfy(\.isHexDigit) else { return nil }
    return UInt32(v, radix: 16)
}

/// The paper set a screen paints with (Android `KioskColors`), accent included.
struct KioskPalette: Equatable {
    var ink = Tokens.ink
    var ink2 = Tokens.ink2
    var inkLine = Tokens.inkLine
    var snow = Tokens.snow
    var paper: Color
    var paper2: Color
    var paperLine: Color
    var text: Color
    var textMute: Color
    var ok = Tokens.ok
    var accent = Tokens.amber
    var accentSoft = Tokens.amberSoft
    var isDark: Bool

    static let light = KioskPalette(paper: Tokens.lightPaper, paper2: Tokens.lightPaper2, paperLine: Tokens.lightPaperLine,
                                    text: Tokens.lightText, textMute: Tokens.lightTextMute, isDark: false)
    static let dark = KioskPalette(paper: Tokens.darkPaper, paper2: Tokens.darkPaper2, paperLine: Tokens.darkPaperLine,
                                   text: Tokens.darkText, textMute: Tokens.darkTextMute, isDark: true)

    func with(accent name: String) -> KioskPalette {
        var p = self
        (p.accent, p.accentSoft) = accentFor(name)
        return p
    }
}

/// The portal's `.chip.c-*` tones: text color, background, border.
enum ChipTone: CaseIterable, Sendable {
    case green, amber, red, blue, violet, aqua, slate

    private var hex: UInt32 {
        switch self {
        case .green: 0x3DDC84
        case .amber: 0xFFB84D
        case .red: 0xFF5D6C
        case .blue: 0x4DD0FF
        case .violet: 0xA78BFA
        case .aqua: 0x35E0C8
        case .slate: 0x8A97AA
        }
    }

    var text: Color { Color(hex: hex) }
    var bg: Color { Color(hex: hex, alpha: Double(0x1F) / 255) }
    var border: Color { Color(hex: hex, alpha: Double(0x40) / 255) }
}
