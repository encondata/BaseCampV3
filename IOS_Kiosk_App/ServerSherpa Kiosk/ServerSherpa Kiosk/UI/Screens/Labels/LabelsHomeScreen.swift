import SwiftUI

/// The Label Printing tile (Android's LabelsHomeScreen): Print Labels and Printer Setup.
struct LabelsHomeScreen: View {
    @Binding var path: [Route]
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let printer = container.labelSettings.current().printer
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Label Printing", title: "Label Printing", subtitle: "Print asset labels.")
                SetupCard(selected: false, action: { path.append(.labelsPrint) }) {
                    Text("Print Labels").font(KioskType.titleMedium).foregroundStyle(palette.text)
                    Text("Scan an asset and its label prints.").font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 4)
                }
                .padding(.bottom, 10)
                SetupCard(selected: false, action: { path.append(.labelsPrinter) }) {
                    Text("Printer Setup").font(KioskType.titleMedium).foregroundStyle(palette.text)
                    Text(printer.map(printerSummary) ?? "No printer set up yet.")
                        .font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 4)
                }
                .padding(.bottom, 10)
            }
            .padding(16)
        }
        .background(palette.paper2)
    }
}
