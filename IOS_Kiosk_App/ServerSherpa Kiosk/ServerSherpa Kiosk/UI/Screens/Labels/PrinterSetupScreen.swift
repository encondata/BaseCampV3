import SwiftUI
import UIKit

/// Printer Setup (Android's PrinterSetupScreen): find a Zebra (network or Bluetooth), check it,
/// fonts, test labels, offsets and peel/tear.
struct PrinterSetupScreen: View {
    @Binding var path: [Route]
    @Environment(\.container) private var container

    var body: some View {
        PrinterSetupBody(container: container, path: $path)
    }
}

private func checkTone(_ state: CheckState) -> ChipTone {
    switch state {
    case .ok: .green
    case .warn, .running: .amber
    case .fail: .red
    }
}

private func checkChipText(_ state: CheckState) -> String {
    switch state {
    case .running: "Checking"
    case .ok: "OK"
    case .warn: "Check"
    case .fail: "Fix"
    }
}

private struct PrinterSetupBody: View {
    let container: AppContainer
    @Binding var path: [Route]
    @State private var vm: PrinterSetupViewModel
    @State private var testOpen = false
    /// The Bluetooth list's "Other devices" row is open.
    @State private var othersOpen = false
    @Environment(\.kioskPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase

    init(container: AppContainer, path: Binding<[Route]>) {
        self.container = container
        _path = path
        _vm = State(initialValue: PrinterSetupViewModel(
            settings: container.labelSettings, build: container.labelBuilder.monitor, engine: container.labelEngine,
            store: container.store, fontsDir: container.fontsDir,
            scanner: { try await ZebraScanner().scan() },
            bluetooth: container.bluetooth,
            zebraFor: { printer in container.zebra(for: printer) },
            printerLock: container.printerLock, printerGuard: container.printerGuard))
    }

    var body: some View {
        let settings = vm.settings
        let printer = settings.printer
        let ui = vm.ui
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Label Printing", title: "Printer Setup",
                           subtitle: printer.map(printerSummary) ?? "No printer set up yet.")

                SectionTitle(title: "Choose a printer")
                SetupCard(selected: ui.findMode == .scan, enabled: !ui.busy, action: { vm.scan() }) {
                    PrinterCardText(title: "Scan network", description: "Find Zebra printers on this device's Wi-Fi or Ethernet network.")
                }
                .padding(.bottom, 10)
                SetupCard(selected: ui.findMode == .ip, enabled: !ui.busy, action: { vm.enterIp() }) {
                    PrinterCardText(title: "Enter IP", description: "Type the printer's IP address.")
                }
                .padding(.bottom, 10)
                SetupCard(selected: ui.findMode == .bluetooth, enabled: !ui.busy, action: { vm.scanBluetooth() }) {
                    PrinterCardText(title: "Bluetooth", description: "Find a Zebra printer nearby over Bluetooth.")
                }
                .padding(.bottom, 10)

                if ui.findMode == .scan { scanResults(ui, printer) }
                if ui.findMode == .ip { ipEntry(ui) }
                if ui.findMode == .bluetooth { bluetoothResults(ui, printer) }
                // Opening the screen connected the saved Bluetooth printer, and Bluetooth refused.
                if ui.findMode == nil { KioskToast(text: ui.bluetoothMessage, error: ui.bluetoothError) }
                KioskToast(text: ui.chooseError, error: true)
                if let steps = ui.pairingLost {
                    // The printer forgot this iPad: forget it in Settings too, then Connect. No Open
                    // Settings: it can't reach Settings › Bluetooth (Ruling 15).
                    KioskToast(text: steps, error: true)
                    SecondaryButton("Connect", enabled: !ui.busy && !ui.checking) { vm.connectAgain() }
                        .padding(.bottom, 8)
                } else if (ui.localNetworkDenied && !ui.scanning) || ui.offersBluetoothSettings {
                    // The scan, choosing a printer or its Answers check met iOS's Local Network or
                    // Bluetooth denial (the test label sheet offers its own).
                    OpenSettingsButton().padding(.bottom, 8)
                }

                if let printer {
                    SectionTitle(title: "Checks")
                    checks(ui)
                    SectionTitle(title: "Test labels")
                    Text("Print an alignment label or a sample label to check where labels print.")
                        .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                    SecondaryButton("Print test labels", enabled: !ui.busy) { testOpen = true }.padding(.top, 8)

                    SectionTitle(title: "Print settings")
                    PrinterOffsetFields(vm: vm, dpi: printer.dpi)
                    SettingsRow(title: "Peel off",
                                detail: "On: the printer holds each label until it's taken off the peeler. Off: labels tear off.") {
                        Toggle("Peel off", isOn: Binding(get: { vm.settings.peel }, set: { vm.setPeel($0) }))
                            .labelsHidden()
                            .disabled(!ui.peelAllowed)
                            .frame(minHeight: 48)
                        if !ui.peelAllowed {
                            Text(NO_PEELER_TEXT).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 4)
                        }
                    }
                }

                SecondaryButton("Back") { if !path.isEmpty { path.removeLast() } }.padding(.top, 16)
            }
            .padding(16)
        }
        .background(palette.paper2)
        .sheet(isPresented: Binding(get: { testOpen && printer != nil }, set: { testOpen = $0 })) {
            TestLabelSheet(vm: vm, onDismiss: { testOpen = false })
                .environment(\.kioskPalette, palette)
        }
        // Every phase, the first included: a denied scan's rescan waits until the Local Network
        // prompt is gone (the scene is `.active` again).
        .onChange(of: scenePhase, initial: true) { _, phase in
            vm.scenePhaseChanged(active: phase == .active)
        }
        .onAppear { vm.open() }
        .onDisappear { vm.close() }
    }

    @ViewBuilder private func scanResults(_ ui: PrinterSetupUi, _ printer: SavedPrinter?) -> some View {
        if ui.scanning {
            HStack(spacing: 8) {
                ProgressView().tint(palette.accent)
                Text("Scanning the network…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
            }
            .padding(.vertical, 6)
        }
        KioskToast(text: ui.scanMessage, error: ui.scanError)
        ForEach(ui.found ?? [], id: \.host) { p in
            SetupCard(selected: printer?.host == p.host, enabled: !ui.busy && !ui.scanning, action: { vm.choose(p) }) {
                Text(p.host).font(KioskType.mono(16)).fontWeight(.semibold).foregroundStyle(palette.text)
                Text(ui.choosing == p.host ? "Saving…" : foundDetails(p))
                    .font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 4)
            }
            .padding(.bottom, 8)
        }
        if ui.found != nil && !ui.scanning {
            SecondaryButton("Scan again", enabled: !ui.busy) { vm.scan() }
        }
    }

    @ViewBuilder private func bluetoothResults(_ ui: PrinterSetupUi, _ printer: SavedPrinter?) -> some View {
        if ui.bluetoothScanning {
            HStack(spacing: 8) {
                ProgressView().tint(palette.accent)
                Text("Looking for printers nearby…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                    .frame(maxWidth: .infinity, alignment: .leading)
                SecondaryButton("Stop") { vm.stopBluetoothScan() }
            }
            .padding(.vertical, 6)
        }
        KioskToast(text: ui.bluetoothMessage, error: ui.bluetoothError)
        ForEach(ui.bluetoothZebras) { p in bluetoothRow(p, ui, printer) }
        let others = ui.bluetoothOthers
        if !others.isEmpty {
            Button { othersOpen.toggle() } label: {
                HStack(spacing: 8) {
                    Text("Other devices (\(others.count))").font(KioskType.labelLarge).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: othersOpen ? "chevron.up" : "chevron.down").foregroundStyle(palette.textMute)
                }
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(othersOpen ? "Shown" : "Hidden")
            if othersOpen {
                ForEach(others) { p in bluetoothRow(p, ui, printer) }
            }
        }
        Text(BLUETOOTH_SCAN_HINT_TEXT).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.vertical, 6)
        if !ui.bluetoothScanning && ui.bluetoothFound != nil {
            SecondaryButton("Scan again", enabled: !ui.busy) { vm.scanBluetooth() }
        }
    }

    /// A device the Bluetooth scan heard: its name (a Zebra's is its serial), signal, and Connect.
    private func bluetoothRow(_ p: FoundBluetoothPrinter, _ ui: PrinterSetupUi, _ printer: SavedPrinter?) -> some View {
        SetupCard(selected: isSaved(p, printer), enabled: !ui.busy, action: { vm.chooseBluetooth(p) }) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(p.name).font(KioskType.mono(16)).fontWeight(.semibold).foregroundStyle(palette.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(ui.choosing == p.id.uuidString ? "Connecting…" : "Connect").font(KioskType.labelLarge).foregroundStyle(palette.accent)
            }
            Text(bluetoothSignalText(rssi: p.rssi)).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 4)
        }
        .padding(.bottom, 8)
    }

    /// The device is the saved Bluetooth printer (by the iPad's identifier, or its name, which is its serial).
    private func isSaved(_ p: FoundBluetoothPrinter, _ printer: SavedPrinter?) -> Bool {
        guard case .bluetooth(let serial, let id)? = printer?.connection else { return false }
        return id == p.id || serial.uppercased() == p.name.uppercased()
    }

    @ViewBuilder private func ipEntry(_ ui: PrinterSetupUi) -> some View {
        Text("Printer IP").font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        TextField("192.168.1.50", text: Binding(get: { vm.ui.ipText }, set: { vm.setIpText($0) }))
            .font(KioskType.bodyLarge)
            .keyboardType(.numbersAndPunctuation)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .onSubmit { vm.useIp() }
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
            .padding(.top, 4)
            .accessibilityLabel("Printer IP")
        SecondaryButton(ui.choosing != nil ? "Connecting…" : "Use this printer",
                        enabled: !ui.busy && !kotlinTrimmed(ui.ipText).isEmpty) { vm.useIp() }
            .padding(.top, 8)
    }

    /// A font install going out: the font's progress, about how long it has left, and Cancel (which lets
    /// the font being sent finish: a font cut off part-way leaves the printer waiting for the rest).
    @ViewBuilder private func installProgress(_ ui: PrinterSetupUi) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(ui.installStatus)
                    .font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let eta = ui.installEta {
                    Text(eta).font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                }
            }
            // Print Labels' build bar: accent on a paperLine track.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.paperLine)
                    Capsule().fill(palette.accent).frame(width: geo.size.width * CGFloat(min(max(ui.installProgress ?? 0, 0), 1)))
                }
            }
            .frame(height: 4)
            .accessibilityElement()
            .accessibilityLabel(ui.installStatus)
            .accessibilityValue("\(Int(((ui.installProgress ?? 0) * 100).rounded())) percent\(ui.installEta.map { ", \($0)" } ?? "")")
            HStack(spacing: 12) {
                SecondaryButton(ui.installStopping ? "Stopping…" : "Cancel", enabled: !ui.installStopping) { vm.cancelInstall() }
                Text("Cancel lets the font being sent finish, then stops.")
                    .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.top, 8)
    }

    @ViewBuilder private func checks(_ ui: PrinterSetupUi) -> some View {
        if ui.checks.isEmpty {
            Text("Not checked yet.").font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        }
        ForEach(ui.checks, id: \.key) { row in
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(row.key.label).font(KioskType.titleMedium).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    KioskChip(text: checkChipText(row.state), tone: checkTone(row.state), dot: false)
                }
                if let detail = row.detail {
                    Text(detail).font(KioskType.bodySmall).foregroundStyle(row.state == .fail ? ChipTone.red.text : palette.textMute)
                }
                ForEach(row.notes, id: \.self) { note in
                    Text(note).font(KioskType.bodySmall).foregroundStyle(ChipTone.amber.text)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            Rectangle().fill(palette.paperLine).frame(height: 1)
        }
        if ui.installing {
            installProgress(ui)
        } else if let fix = ui.fontFix, ui.checks.contains(where: { $0.key == .fonts && $0.state == .fail }), !fix.installable.isEmpty {
            SecondaryButton(fontInstallButtonText(installable: fix.installable, damaged: ui.damagedFonts),
                            enabled: !ui.busy && !ui.checking) { vm.installFonts() }
                .padding(.top, 8)
        }
        if let fix = ui.fontFix {
            ForEach(fix.notInLibrary, id: \.self) { name in
                Text("\(name) isn't in the font library. Upload it in the portal's font library, then sync this kiosk.")
                    .font(KioskType.bodySmall).foregroundStyle(ChipTone.red.text).padding(.top, 4)
            }
        }
        KioskToast(text: ui.fontMessage, error: ui.fontError)
        SecondaryButton(ui.checking ? "Checking…" : (ui.checkRuns == 0 ? "Check printer" : "Check again"),
                        enabled: !ui.busy && !ui.checking) { vm.checkAgain() }
            .padding(.top, 8)
    }
}

/// Opens this app's page in Settings (its Local Network and Bluetooth switches). iOS has no way
/// to open Settings › Bluetooth itself, so a printer that forgot this iPad never gets this button.
struct OpenSettingsButton: View {
    var body: some View {
        SecondaryButton("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }
}

/// A section's small caps title (Printer Setup, Settings › Troubleshooting).
struct SectionTitle: View {
    let title: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Text(title.uppercased()).font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
            .padding(.top, 16).padding(.bottom, 8)
    }
}

/// A setup card's title and description.
struct PrinterCardText: View {
    let title: String
    let description: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Text(title).font(KioskType.titleMedium).foregroundStyle(palette.text)
        Text(description).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 4)
    }
}

/// Top and left offsets in dots, saved as they're typed (Printer Setup and the test labels share them).
struct PrinterOffsetFields: View {
    let vm: PrinterSetupViewModel
    let dpi: Int

    var body: some View {
        let perMm = offsetHint(dpi: dpi)
        OffsetField(label: "Top offset (dots)", hint: "+ moves the printing down, − moves it up. \(perMm)",
                    text: vm.ui.offsetYText, onChange: { vm.setOffsetY($0) }, onDone: { vm.tidyOffsets() })
        OffsetField(label: "Left offset (dots)", hint: "+ moves the printing right, − moves it left. \(perMm)",
                    text: vm.ui.offsetXText, onChange: { vm.setOffsetX($0) }, onDone: { vm.tidyOffsets() })
    }
}

private struct OffsetField: View {
    let label: String
    let hint: String
    let text: String
    let onChange: (String) -> Void
    let onDone: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            TextField(label, text: Binding(get: { text }, set: onChange))
                .font(KioskType.bodyLarge)
                // Has the minus sign on iPhone (the number pad doesn't).
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused)
                .onSubmit(onDone)
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
                .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
                .padding(.top, 4)
                .onChange(of: focused) { was, now in
                    if was && !now { onDone() }
                }
            Text(hint).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 2)
        }
        .padding(.top, 8)
    }
}
