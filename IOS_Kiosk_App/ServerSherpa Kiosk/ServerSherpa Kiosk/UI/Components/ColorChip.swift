import SwiftUI

/// `#rrggbb` (the server's status and level colors); nil for anything else.
func hexColor(_ hex: String?) -> Color? {
    guard var text = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, text.allSatisfy(\.isHexDigit), let value = UInt32(text, radix: 16) else { return nil }
    return Color(hex: value)
}

/// A pill in a status's own color (statuses can be customized in the portal); slate without one.
/// Shared by the Rolodex and Asset Lookup (Android `ui/components/ColorChip.kt`).
struct ColorChip: View {
    let text: String
    let color: Color?
    var dot = false
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let tint = color ?? ChipTone.slate.text
        HStack(spacing: 6) {
            if dot { Circle().fill(tint).frame(width: 6, height: 6) }
            Text(text)
                .font(KioskType.sans(12, .semibold))
                .foregroundStyle(palette.isDark ? palette.text : tint)
                .lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 3)
        .background(tint.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 1))
        .fixedSize()
    }
}
