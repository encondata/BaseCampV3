import SwiftUI

/// The launcher tiles' icons, traced from Android `ui/screens/home/FeatureIcons.kt`
/// (40 × 40 viewport, 2.5 stroke, round caps and joins).
enum FeatureIcons {
    private static func icon(strokes: [String] = [], fills: [String] = []) -> VectorIcon {
        VectorIcon(viewport: 40, lineWidth: 2.5, strokes: strokes, fills: fills)
    }

    private static let setup = icon(strokes: [
        svgCircle(20, 20, 4.5),
        "M32.3 23.3a2.8 2.8 0 0 0 .6 3.1l.2.2a3.3 3.3 0 1 1-4.7 4.7l-.2-.2a2.8 2.8 0 0 0-3.1-.6 2.8 2.8 0 0 0-1.7 2.6V34a3.3 3.3 0 1 1-6.6 0v-.3a2.8 2.8 0 0 0-1.8-2.6 2.8 2.8 0 0 0-3.1.6l-.2.2a3.3 3.3 0 1 1-4.7-4.7l.2-.2a2.8 2.8 0 0 0 .6-3.1 2.8 2.8 0 0 0-2.6-1.7H4.7a3.3 3.3 0 1 1 0-6.6H5a2.8 2.8 0 0 0 2.6-1.8 2.8 2.8 0 0 0-.6-3.1l-.2-.2a3.3 3.3 0 1 1 4.7-4.7l.2.2a2.8 2.8 0 0 0 3.1.6H15a2.8 2.8 0 0 0 1.7-2.6V4.7a3.3 3.3 0 1 1 6.6 0V5a2.8 2.8 0 0 0 1.7 2.6 2.8 2.8 0 0 0 3.1-.6l.2-.2a3.3 3.3 0 1 1 4.7 4.7l-.2.2a2.8 2.8 0 0 0-.6 3.1V15a2.8 2.8 0 0 0 2.6 1.7h.3a3.3 3.3 0 1 1 0 6.6h-.3a2.8 2.8 0 0 0-2.6 1.7Z",
    ])
    private static let scan = icon(fills: ["M5 8h3v24H5z", "M11 8h1.5v24H11z", "M15 8h4v24h-4z", "M22 8h1.5v24H22z", "M26 8h3v24h-3z", "M32 8h3v24h-3z"])
    private static let enroll = icon(strokes: ["M4 9h11l9 11-9 11H4V9z", "M29 14a8 8 0 0 1 0 12M33.5 10a13.5 13.5 0 0 1 0 20"], fills: [svgCircle(10.5, 15.5, 2)])
    private static let containers = icon(strokes: [
        "M6 11h28a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2z", "M4 17h32", "M14 17v17M26 17v17",
        "M13 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3",
    ])
    private static let trucks = icon(strokes: [
        "M2 10h19v17H2V10z", "M21 16h7l5 6v5h-12v-11z", svgCircle(12, 30, 3.5), svgCircle(28, 30, 3.5), "M2 27h6.5M15.5 27h9M31.5 27H38",
    ])
    private static let labels = icon(strokes: ["M6 6h15l13 13-15 15L6 21V6z"], fills: [svgCircle(14, 14, 2.5)])
    private static let timeclock = icon(strokes: [svgCircle(20, 20, 15), "M20 11v9l7 4"])
    private static let settings = icon(strokes: ["M6 12h20M31 12h3", svgCircle(26, 12, 3.5), "M6 28h9M20 28h14", svgCircle(15, 28, 3.5)])

    static func icon(_ id: FeatureId) -> VectorIcon {
        switch id {
        case .setup: setup
        case .scan: scan
        case .enroll: enroll
        case .containers: containers
        case .trucks: trucks
        case .labels: labels
        case .timeclock: timeclock
        case .settings: settings
        }
    }
}

struct FeatureIcon: View {
    let id: FeatureId
    let tint: Color
    var size: CGFloat = 40

    var body: some View {
        VectorIconView(icon: FeatureIcons.icon(id), tint: tint, size: size)
    }
}
