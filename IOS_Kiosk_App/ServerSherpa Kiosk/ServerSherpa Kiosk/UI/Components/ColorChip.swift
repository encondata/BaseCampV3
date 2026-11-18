import SwiftUI

/// `#rrggbb` (the server's status and level colors); nil for anything else.
func hexColor(_ hex: String?) -> Color? {
    guard var text = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, text.allSatisfy(\.isHexDigit), let value = UInt32(text, radix: 16) else { return nil }
    return Color(hex: value)
}

/// A pill in a status's own color (statuses can be customized in the portal); slate without one.
/// Shared by the Rolodex and Asset Lookup (Android `ui/components/ColorChip.kt`): at most 160 pt
/// wide, a longer label ending in "…".
struct ColorChip: View {
    let text: String
    let color: Color?
    var dot = false
    @Environment(\.kioskPalette) private var palette

    /// Android's `widthIn(max = 160.dp)`.
    static let maxWidth: CGFloat = 160

    /// The words' color. The status colors are bright: on light paper the words take the color
    /// darkened 40% to stay legible (Android's `lerp(base, Color.Black, 0.4f)`); on dark paper they
    /// take the page's text color.
    static func ink(_ tint: Color, dark: Bool, text: Color) -> Color {
        dark ? text : tint.mix(with: .black, by: 0.4)
    }

    var body: some View {
        let tint = color ?? ChipTone.slate.text
        CappedWidth(max: Self.maxWidth) {
            HStack(spacing: 6) {
                if dot { Circle().fill(tint).frame(width: 6, height: 6) }
                Text(text)
                    .font(KioskType.sans(12, .semibold))
                    .foregroundStyle(Self.ink(tint, dark: palette.isDark, text: palette.text))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 1))
        }
        .fixedSize()
    }
}

/// Its one child at its own width, but never wider than `max` (a `frame(maxWidth:)` would stretch
/// a short chip to the cap).
private struct CappedWidth: Layout {
    let max: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        return child.sizeThatFits(ProposedViewSize(width: Swift.min(proposal.width ?? max, max), height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}
