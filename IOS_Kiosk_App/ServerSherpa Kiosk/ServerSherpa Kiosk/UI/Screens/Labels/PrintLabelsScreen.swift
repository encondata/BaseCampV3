import SwiftUI

/// Print Labels (Android's PrintLabelsScreen, the laptop's Printing Station): scan an asset ID or
/// serial and its stored label goes straight to the saved Zebra (network or Bluetooth), with one
/// Labeled scan.
struct PrintLabelsScreen: View {
    @Binding var path: [Route]
    @Environment(\.container) private var container

    var body: some View {
        PrintLabelsBody(container: container, path: $path)
    }
}

private struct PrintLabelsBody: View {
    let container: AppContainer
    @Binding var path: [Route]
    @State private var vm: PrintLabelsViewModel
    @State private var camera = false
    /// Printer Setup was opened for this visit because no printer was saved.
    @State private var openedPrinterSetup = false
    @Environment(\.kioskPalette) private var palette

    init(container: AppContainer, path: Binding<[Route]>) {
        self.container = container
        _path = path
        _vm = State(initialValue: PrintLabelsViewModel(
            jobs: container.printJobs, store: container.store, sync: container.sync, prefs: container.prefs,
            settings: container.labelSettings, build: container.labelBuilder.monitor,
            flash: container.flash, sound: container.sound))
    }

    private var setup: KioskSetupSelection? { container.prefs.setupSelection }
    private var empty: Bool { vm.loadStatus == .ready && vm.rosterSize == 0 }
    private var disabled: Bool { vm.loadStatus != .ready || empty || setup == nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Label Printing", title: "Print Labels",
                           subtitle: setup.map { "\($0.initiativeName) · \($0.siteName)" } ?? "Finish Kiosk Setup first.")
                LabelStatusHeader(build: vm.build, settings: vm.settings, syncing: vm.syncing,
                                  onSync: { vm.syncNow() }, onPrinterSetup: { path.append(.labelsPrinter) })
                if vm.loadStatus == .error { KioskToast(text: "Couldn't read this kiosk's local data.", error: true) }
                if empty {
                    Text(ScanViewModel.NO_MOVE_DATA).font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.bottom, 8)
                }
                ScanInput(placeholder: "Scan or type an asset ID or serial", enabled: !disabled, keepFocus: !camera,
                          onSubmit: { container.scanBus.publish(ScanEvent(value: $0, source: .keyboard, symbology: nil)) }) {
                    if CameraSupport.hasCamera {
                        Button { camera = true } label: {
                            Image(systemName: "camera").font(.system(size: 20)).foregroundStyle(palette.text).frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.45 : 1)
                        .accessibilityLabel("Scan with camera")
                    }
                }
                // The grey empty-roster line already says it; the red toast is for a scan that arrived anyway.
                if !empty { KioskToast(text: vm.error, error: true) }

                let current = vm.entries.first
                if let current {
                    CurrentPrintCard(entry: current,
                                     onReprint: { vm.reprint(current.id) },
                                     onRetry: { vm.retry(current.id) })
                        .padding(.top, 12)
                }
                if vm.entries.isEmpty {
                    Text("Nothing printed yet.").font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.vertical, 12)
                } else {
                    Divider().overlay(palette.paperLine).padding(.top, 12)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(vm.entries, id: \.id) { e in
                            PrintEntryRow(entry: e, showRetry: e.id != current?.id, onRetry: { vm.retry(e.id) })
                        }
                    }
                }
            }
            .padding(16)
        }
        .background(palette.paper2)
        // Hands scans in only: the prints they start belong to the view model, so this ending
        // (the screen went off screen) cancels nothing already scanned.
        .onAppear {
            if opensPrinterSetupFirst(printer: vm.settings.printer, phase: vm.build.phase, alreadyOpened: openedPrinterSetup) {
                openedPrinterSetup = true
                path.append(.labelsPrinter)
            }
        }
        .task { await vm.follow(container.scanBus.events()) }
        .task(id: container.sync.rosterVersion) { await vm.loadRoster() }
        .fullScreenCover(isPresented: $camera) {
            CameraScanSheet(bus: container.scanBus, prefs: container.prefs) { camera = false }
        }
    }
}

/// The header: what stops labels (device, printer, sync), the build's progress, and the counts.
private struct LabelStatusHeader: View {
    let build: LabelBuildStatus
    let settings: LabelSettings
    let syncing: Bool
    let onSync: () -> Void
    let onPrinterSetup: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        if build.phase == .unsupportedDevice {
            KioskToast(text: DEVICE_UNSUPPORTED_TEXT, error: true)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                if settings.printer == nil {
                    KioskToast(text: NO_PRINTER_TEXT, error: true)
                    SecondaryButton("Printer Setup", action: onPrinterSetup).padding(.bottom, 8)
                }
                if build.needs == .sync {
                    HStack(spacing: 12) {
                        Text(SYNC_NEEDED_TEXT).font(KioskType.bodyMedium).foregroundStyle(palette.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        SecondaryButton(syncing ? "Syncing…" : "Sync now", enabled: !syncing, action: onSync)
                    }
                    .padding(.vertical, 6)
                }
                if build.phase == .running {
                    Text("Making labels: \(build.done) of \(build.total)")
                        .font(KioskType.labelMedium).foregroundStyle(palette.textMute).padding(.top, 4)
                    // Android's LinearProgressIndicator: accent on a paperLine track.
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(palette.paperLine)
                            Capsule().fill(palette.accent).frame(width: geo.size.width * CGFloat(min(max(build.progress, 0), 1)))
                        }
                    }
                    .frame(height: 4)
                    .padding(.vertical, 6)
                    .accessibilityElement()
                    .accessibilityLabel("Making labels")
                    .accessibilityValue("\(build.done) of \(build.total)")
                }
                // LabelBuilder logs the cause.
                if build.phase == .error { KioskToast(text: BUILD_FAILED_TEXT, error: true) }
                if build.needs == nil && build.phase != .idle {
                    Text(readySummary(build)).font(KioskType.labelMedium).foregroundStyle(palette.textMute).padding(.vertical, 6)
                }
            }
        }
    }
}

/// The latest scan, big: the asset, what happened, and Reprint or Retry.
private struct CurrentPrintCard: View {
    let entry: PrintEntry<PrintTarget>
    let onReprint: () -> Void
    let onRetry: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let tone = printStatusTone(entry.state)
        VStack(alignment: .leading, spacing: 4) {
            if let a = entry.asset?.asset {
                Text(printEntryTitle(a)).font(KioskType.titleLarge).foregroundStyle(palette.text)
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    fact("Asset ID", nonBlankText(a.assetId) ?? "—", mono: true)
                    fact("Make / Model", nonBlankText(a.makeModel) ?? "—")
                    fact("Serial", nonBlankText(a.serialNumber) ?? "—", mono: true)
                    fact("Source", labelPlacement(a.label, "source"))
                    fact("Destination", labelPlacement(a.label, "destination"))
                }
                .padding(.top, 4)
            } else {
                Text(entry.scannedValue).font(KioskType.mono(16)).foregroundStyle(palette.text)
            }
            KioskChip(text: printStatusText(entry), tone: tone, dot: false).padding(.top, 6)
            if let message = entry.message {
                Text(message).font(KioskType.bodyMedium).foregroundStyle(ChipTone.red.text)
            }
            if let warning = entry.recordWarning {
                Text(warning).font(KioskType.bodySmall).foregroundStyle(ChipTone.amber.text)
            }
            if entry.state == .printed && entry.asset != nil { SecondaryButton("Reprint", action: onReprint).padding(.top, 6) }
            if entry.state == .failed && entry.asset != nil { SecondaryButton("Retry", action: onRetry).padding(.top, 6) }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(tone.border, lineWidth: 2))
    }

    private func fact(_ name: String, _ value: String, mono: Bool = false) -> some View {
        GridRow(alignment: .firstTextBaseline) {
            Text(name.uppercased()).font(KioskType.labelSmall).foregroundStyle(palette.textMute)
            Text(value).font(mono ? KioskType.mono(12) : KioskType.bodySmall).foregroundStyle(palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// One scan on the list, newest first.
private struct PrintEntryRow: View {
    let entry: PrintEntry<PrintTarget>
    let showRetry: Bool
    let onRetry: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(scanTime(entry.scannedAt)).font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                Text(entry.asset?.asset.assetId ?? entry.scannedValue).font(KioskType.labelMedium).foregroundStyle(palette.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                KioskChip(text: printStatusText(entry), tone: printStatusTone(entry.state), dot: false)
            }
            Text(printEntryLine(entry.asset?.asset)).font(KioskType.bodySmall)
                .foregroundStyle(entry.asset == nil ? ChipTone.red.text : palette.text)
            if entry.state == .failed, let message = entry.message {
                Text(message).font(KioskType.labelSmall).foregroundStyle(ChipTone.red.text)
            }
            if let warning = entry.recordWarning {
                Text(warning).font(KioskType.labelSmall).foregroundStyle(ChipTone.amber.text)
            }
            if showRetry && entry.state == .failed && entry.asset != nil {
                SecondaryButton("Retry", action: onRetry).padding(.top, 4)
            }
        }
        .padding(.vertical, 8)
        Divider().overlay(palette.paperLine)
    }
}
