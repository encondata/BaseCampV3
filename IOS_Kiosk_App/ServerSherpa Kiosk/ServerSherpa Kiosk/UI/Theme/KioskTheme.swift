import SwiftUI

private struct KioskPaletteKey: EnvironmentKey {
    static let defaultValue = KioskPalette.light
}

private struct KioskAccentKey: EnvironmentKey {
    static let defaultValue = Tokens.amber
}

extension EnvironmentValues {
    var kioskPalette: KioskPalette {
        get { self[KioskPaletteKey.self] }
        set { self[KioskPaletteKey.self] = newValue }
    }

    var kioskAccent: Color {
        get { self[KioskAccentKey.self] }
        set { self[KioskAccentKey.self] = newValue }
    }
}

/// The kiosk's theme: the signed-in person's `preferences.accent` (a named
/// accent or `#rrggbb`) and `preferences.theme` ("light" | "dark"; anything
/// else follows iOS), what the portal's applyPreferences() stamps on `.portal-shell`.
struct KioskTheme: ViewModifier {
    let accent: String
    let scheme: ColorScheme?
    @Environment(\.colorScheme) private var systemScheme

    func body(content: Content) -> some View {
        let dark = (scheme ?? systemScheme) == .dark
        let palette = (dark ? KioskPalette.dark : KioskPalette.light).with(accent: accent)
        content
            .environment(\.kioskPalette, palette)
            .environment(\.kioskAccent, palette.accent)
            .tint(palette.accent)
            .font(KioskType.bodyLarge)
            .preferredColorScheme(scheme)
    }

    static func scheme(forTheme theme: String) -> ColorScheme? {
        switch theme {
        case "dark": .dark
        case "light": .light
        default: nil
        }
    }
}

extension View {
    func kioskTheme(accent: String, scheme: ColorScheme?) -> some View {
        modifier(KioskTheme(accent: accent, scheme: scheme))
    }
}
