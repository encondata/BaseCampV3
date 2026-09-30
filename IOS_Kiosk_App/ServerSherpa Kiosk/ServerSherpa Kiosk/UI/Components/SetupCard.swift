import SwiftUI

/// `.setup-card` / `.kiosk-tile`: paper card, accent border when selected, big tap target.
struct SetupCard<Content: View>: View {
    let selected: Bool
    var enabled: Bool = true
    let action: () -> Void
    @ViewBuilder let content: () -> Content
    @Environment(\.kioskPalette) private var palette

    init(selected: Bool, enabled: Bool = true, action: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.selected = selected
        self.enabled = enabled
        self.action = action
        self.content = content
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0, content: content)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .frame(minHeight: 96)
                .padding(16)
                .background(palette.paper, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? palette.accent : palette.paperLine, lineWidth: selected ? 2 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
