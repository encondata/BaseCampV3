import SwiftUI

/// `.kiosk-placeholder`: a card with one line and one action.
struct PlaceholderCard: View {
    let text: String
    let actionText: String
    let onAction: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text).font(KioskType.bodyLarge).foregroundStyle(palette.textMute)
            LinkButton(actionText, action: onAction)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.paperLine, lineWidth: 1))
    }
}
