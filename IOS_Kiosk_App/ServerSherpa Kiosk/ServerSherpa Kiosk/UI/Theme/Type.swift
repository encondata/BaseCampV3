import SwiftUI

/// `--font-display` (Geologica, variable) and `--font-mono` (Fragment Mono),
/// registered from the bundle by `KioskFonts`. An unregistered name falls
/// back to the system font.
enum KioskType {
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        Font.custom("Geologica", size: size).weight(weight)
    }

    static func mono(_ size: CGFloat, italic: Bool = false) -> Font {
        Font.custom(italic ? "FragmentMono-Italic" : "FragmentMono-Regular", size: size)
    }

    // Android `KioskTypography`, by Material role.
    static let display = sans(28, .semibold)
    static let headline = sans(22, .semibold)
    static let titleLarge = sans(18, .semibold)
    static let titleMedium = sans(16, .semibold)
    static let bodyLarge = sans(16)
    static let bodyMedium = sans(14)
    static let bodySmall = sans(12)
    static let labelLarge = sans(14, .medium)
    static let labelMedium = mono(12)
    static let labelSmall = mono(11)
}
