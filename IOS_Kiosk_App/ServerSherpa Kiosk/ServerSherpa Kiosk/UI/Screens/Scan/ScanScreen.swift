import SwiftUI

/// kiosk/src/pages/Scan.tsx: the scan box, the counts and the receipt list.
struct ScanScreen: View {
    @Environment(\.container) private var container

    var body: some View {
        ScanBody(container: container)
    }
}

private struct ScanBody: View {
    let container: AppContainer
    @State private var vm: ScanViewModel
    @State private var camera = false
    /// Content width inside the padding; nil until measured.
    @State private var contentWidth: CGFloat?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.kioskPalette) private var palette

    /// The table needs room for five columns; narrower content stacks.
    private static let wideWidth: CGFloat = 700

    init(container: AppContainer) {
        self.container = container
        _vm = State(initialValue: ScanViewModel(store: container.store, sync: container.sync, outbox: container.outbox,
                                                prefs: container.prefs, flash: container.flash, sound: container.sound))
    }

    /// Until the first measurement, regular-width devices (iPad) start on the table so there is no stacked first frame.
    private var wide: Bool { contentWidth.map { $0 >= Self.wideWidth } ?? (sizeClass == .regular) }

    private var setup: KioskSetupSelection? { container.prefs.setupSelection }
    private var empty: Bool { vm.loadStatus == .ready && vm.rosterSize == 0 }
    private var disabled: Bool { vm.loadStatus != .ready || empty || setup == nil }

    var body: some View {
        let snapshot = container.outbox.snapshot
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Scanning", title: "Scanning",
                           subtitle: setup.map { "\($0.initiativeName) · \($0.siteName) · \($0.scanLabel)" } ?? "Finish Kiosk Setup first.")
                if vm.loadStatus == .error { KioskToast(text: "Couldn't read this kiosk's local data.", error: true) }
                if empty {
                    Text(ScanViewModel.NO_MOVE_DATA).font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.bottom, 8)
                }
                ScanInput(placeholder: "Scan or type an asset ID, serial, or tag", enabled: !disabled, keepFocus: !camera,
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
                KioskToast(text: vm.storageError, error: true)
                ScanTools(counts: snapshot.counts,
                          onRetry: { Task { await vm.retryFailed() } },
                          onClear: { Task { await vm.clearSent() } },
                          onDiscard: { vm.askDiscard() })
                Divider().overlay(palette.paperLine)
                if wide { ScanTable(rows: snapshot.rows) } else { ScanRows(rows: snapshot.rows) }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
            .padding(16)
        }
        .background(palette.paper2)
        .task { for await event in container.scanBus.events() { await vm.onScan(event.value) } }
        .task(id: container.sync.rosterVersion) { await vm.loadRoster() }
        .fullScreenCover(isPresented: $camera) {
            CameraScanSheet(bus: container.scanBus, prefs: container.prefs) { camera = false }
        }
        .confirmationDialog("Discard failed scans?", isPresented: Binding(get: { vm.confirmDiscard }, set: { if !$0 { vm.cancelDiscard() } }),
                            titleVisibility: .visible) {
            Button("Discard", role: .destructive) { Task { await vm.discardFailed() } }
            Button("Keep", role: .cancel) { vm.cancelDiscard() }
        } message: {
            Text("These scans never reached the portal. Discarding them throws them away for good.")
        }
    }
}
