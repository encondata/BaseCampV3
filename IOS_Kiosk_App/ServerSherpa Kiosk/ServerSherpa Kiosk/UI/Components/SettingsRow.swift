import SwiftUI

/// `.settings-row`: title, detail, then the control below (stacked for portrait).
struct SettingsRow<Content: View>: View {
    let title: String
    var detail: String? = nil
    @ViewBuilder let content: () -> Content
    @Environment(\.kioskPalette) private var palette

    init(title: String, detail: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.detail = detail
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(KioskType.titleMedium).foregroundStyle(palette.text)
                if let detail {
                    Text(detail).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 2).padding(.bottom, 8)
                }
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
            Rectangle().fill(palette.paperLine).frame(height: 1)
        }
    }
}
