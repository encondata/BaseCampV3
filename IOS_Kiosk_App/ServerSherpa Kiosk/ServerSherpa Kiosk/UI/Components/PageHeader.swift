import SwiftUI

/// `.eyebrow` + `.page-title` + `.page-hint`.
struct PageHeader: View {
    let eyebrow: String
    let title: String
    var subtitle: String? = nil
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(eyebrow.uppercased()).font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
            Text(title).font(KioskType.display).foregroundStyle(palette.text).padding(.top, 4)
            if let subtitle {
                Text(subtitle).font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 12)
    }
}
