import CoreGraphics
import Foundation

/// Which version of the sign-in page fits, from the web's breakpoints
/// (login-light.css `max-width: 1279px` / `899px`, `max-height: 780px`)
/// measured on the screen in points.
enum LoginLayout: Equatable {
    /// The full mockup: scene left, form right.
    case wide
    /// Map scaled down without its small details, headline kept, form right.
    case medium
    /// Logo, form and status line in one scrolling column; no map, no headline.
    case compact

    static func forWidth(_ w: CGFloat) -> LoginLayout {
        if w >= 1180 { return .wide }
        if w >= 900 { return .medium }
        return .compact
    }

    /// The state names collide with the logo on short screens.
    static func showsStates(height: CGFloat) -> Bool { height >= 780 }

    /// The kiosk's own name, shown under the wordmark in every layout (Android
    /// `LoginBrand(kioskName)`), so someone pairing a phone can see which kiosk this is.
    /// Nil, and no line at all, when the name is blank.
    static func kioskNameLine(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// What VoiceOver reads for the wide and medium layouts' art, which is one element: the
    /// wordmark and the kiosk's name under it. Nil (nothing read) without a name.
    static func sceneAccessibilityLabel(kioskName: String?) -> String? {
        kioskName.map { "ServerSherpa, \($0)" }
    }
}
