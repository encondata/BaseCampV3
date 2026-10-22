import SwiftUI

/// Printer Setup's test labels (Android's TestLabelSheet, the web kiosk's TestLabelModal): an
/// alignment label (boxes that fill the picked template's size) or a sample label (the picked
/// template with sample values), sent with the offsets in the fields and the saved peel/tear mode.
/// The offsets are here too, so a label can be adjusted and printed again until it lines up.
struct TestLabelSheet: View {
    let vm: PrinterSetupViewModel
    let onDismiss: () -> Void
    @State private var choice = TestLabel.alignment
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let ui = vm.ui
        let size = vm.alignmentSize()
        let templateName = vm.currentPick?.templateName
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Printer Setup", title: "Test labels",
                           subtitle: "Print a test label, then adjust the offsets and print again until it lines up. The offsets save as you type.")
                SetupCard(selected: choice == .alignment, action: { choice = .alignment }) {
                    PrinterCardText(
                        title: "Alignment label",
                        description: size.map { "Boxes that fill the \($0.label) label: \($0.widthDots) × \($0.heightDots) dots at \($0.dpi) DPI." }
                            ?? "Boxes that fill the whole label.")
                }
                .padding(.bottom, 8)
                SetupCard(selected: choice == .sample, action: { choice = .sample }) {
                    PrinterCardText(title: "Sample label", description: "\(templateName ?? "The move's template") filled with sample values.")
                }
                .padding(.bottom, 8)
                if let size { PrinterOffsetFields(vm: vm, dpi: size.dpi) }
                KioskToast(text: ui.testMessage, error: ui.testError)
                if ui.testLocalNetworkDenied || ui.testBluetoothSettings {
                    HStack(spacing: 8) {
                        OpenSettingsButton()
                        // The printer forgot this iPad: Connect once it's forgotten in Settings too.
                        if ui.testPairingLost {
                            SecondaryButton(ui.checking ? "Connecting…" : "Connect", enabled: !ui.busy && !ui.checking) { vm.connectAgain() }
                        }
                    }
                }
                HStack(spacing: 8) {
                    PrimaryButton(ui.testing ? "Sending…" : "Print test label", enabled: !ui.busy) { vm.printTest(choice) }
                    SecondaryButton("Done", enabled: !ui.testing, action: onDismiss)
                }
                .padding(.top, 12)
            }
            .padding(16)
        }
        .background(palette.paper)
        // Not while a label is going out (Android's dialog ignores a dismiss then).
        .interactiveDismissDisabled(ui.testing)
        .presentationBackground(palette.paper)
        .presentationCornerRadius(16)
    }
}
