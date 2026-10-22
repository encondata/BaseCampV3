import SwiftUI

/// Printer Setup: a placeholder until its screen is built (find printers, checks, fonts, test
/// labels, offsets, peel).
struct PrinterSetupScreen: View {
    @Binding var path: [Route]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Label Printing", title: "Printer Setup", subtitle: "Coming soon.")
                PlaceholderCard(text: "Printer Setup is not available yet.", actionText: "Back") {
                    if !path.isEmpty { path.removeLast() }
                }
            }
            .padding(16)
        }
        .background(palette.paper2)
    }
}
