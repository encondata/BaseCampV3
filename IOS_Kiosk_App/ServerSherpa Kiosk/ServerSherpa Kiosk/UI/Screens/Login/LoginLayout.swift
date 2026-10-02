import CoreGraphics

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
}
