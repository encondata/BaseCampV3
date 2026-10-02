import SwiftUI

/// `.btn-solid` — the one primary action on a screen.
struct PrimaryButton: View {
    let title: String
    var enabled: Bool = true
    let action: () -> Void
    @Environment(\.kioskPalette) private var palette

    init(_ title: String, enabled: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.enabled = enabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(KioskType.labelLarge)
                .foregroundStyle(palette.ink)
                .padding(.horizontal, 20)
                .frame(minHeight: 48)
                .background(palette.accent, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

/// `.mini-btn` — a secondary, outlined action. `borderColor` overrides the outline.
struct SecondaryButton: View {
    let title: String
    var enabled: Bool = true
    var borderColor: Color? = nil
    var foreground: Color? = nil
    let action: () -> Void
    @Environment(\.kioskPalette) private var palette

    init(_ title: String, enabled: Bool = true, borderColor: Color? = nil, foreground: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.enabled = enabled
        self.borderColor = borderColor
        self.foreground = foreground
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(KioskType.labelLarge)
                .foregroundStyle(foreground ?? palette.text)
                .padding(.horizontal, 16)
                .frame(minHeight: 48)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(borderColor ?? palette.paperLine, lineWidth: borderColor == nil ? 1 : 2))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

/// `.link` — an inline text action.
struct LinkButton: View {
    let title: String
    let action: () -> Void
    @Environment(\.kioskPalette) private var palette

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title).font(KioskType.labelLarge).foregroundStyle(palette.accent).frame(minHeight: 48)
        }
        .buttonStyle(.plain)
    }
}
