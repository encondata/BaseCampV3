import SwiftUI

/// kiosk/src/pages/Enroll.tsx: scan the asset, then its tag; a session log of what this kiosk enrolled.
struct EnrollScreen: View {
    @Environment(\.container) private var container

    var body: some View {
        EnrollBody(container: container)
    }
}

private struct EnrollBody: View {
    let container: AppContainer
    @State private var vm: EnrollViewModel
    @State private var camera = false
    /// Content width inside the padding; nil until measured.
    @State private var contentWidth: CGFloat?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.kioskPalette) private var palette

    /// Steps left and the session log beside them need room; narrower content stacks.
    private static let wideWidth: CGFloat = 1000
    private static let logWidth: CGFloat = 360

    init(container: AppContainer) {
        self.container = container
        _vm = State(initialValue: EnrollViewModel(store: container.store, api: container.api, prefs: container.prefs,
                                                  identity: container.identity, flash: container.flash, sound: container.sound))
    }

    /// Until the first measurement, regular-width devices (iPad) start wide so there is no stacked first frame.
    private var wide: Bool { contentWidth.map { $0 >= Self.wideWidth } ?? (sizeClass == .regular) }

    private var setup: KioskSetupSelection? { container.prefs.setupSelection }
    private var empty: Bool { vm.loadStatus == .ready && vm.rosterSize == 0 }
    private var disabled: Bool { vm.loadStatus != .ready || empty || setup == nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · RFID Enroll", title: "RFID Enroll",
                           subtitle: setup.map { "\($0.initiativeName) · \($0.siteName)" } ?? "Finish Kiosk Setup first.")
                if vm.loadStatus == .error { KioskToast(text: "Couldn't read this kiosk's local data.", error: true) }
                if empty {
                    Text("No move data on this kiosk. Sync it from Kiosk Setup.")
                        .font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.bottom, 8)
                }
                KioskToast(text: vm.toast)
                if wide {
                    HStack(alignment: .top, spacing: 24) {
                        steps.frame(maxWidth: .infinity, alignment: .topLeading)
                        SessionLog(rows: vm.enrollments).frame(width: Self.logWidth, alignment: .topLeading)
                    }
                } else {
                    steps
                    SessionLog(rows: vm.enrollments)
                }
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
    }

    private func publish(_ value: String) {
        container.scanBus.publish(ScanEvent(value: value, source: .keyboard, symbology: nil))
    }

    private var cameraButton: some View {
        Group {
            if CameraSupport.hasCamera {
                Button { camera = true } label: {
                    Image(systemName: "camera").font(.system(size: 20)).foregroundStyle(palette.text).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Scan with camera")
            }
        }
    }

    @ViewBuilder private var steps: some View {
        if let asset = vm.asset {
            AssetCard(asset: asset, currentTag: vm.currentTag)
            if vm.awaitingUpdate {
                // The asset walked in wearing a tag. Nothing here listens for a new one until
                // the operator says to replace it, so a stray read cannot retag anything.
                Text(vm.enrolledHere
                     ? "You enrolled this asset a moment ago. Replacing its tag is the only thing left to do here."
                     : "This asset already has a tag. Replace it only if the tag on the asset has changed.")
                    .font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 8)
                KioskToast(text: vm.error, error: true)
                HStack(spacing: 8) {
                    PrimaryButton("Update RFID Value") { vm.confirmUpdate() }
                    SecondaryButton("Cancel") { vm.cancel() }
                }
                .padding(.top, 12)
            } else {
                ScanInput(placeholder: vm.currentTag != nil ? "Scan the replacement tag" : "Scan the RFID tag",
                          enabled: !vm.saving, keepFocus: !camera,
                          onSubmit: publish) { cameraButton.opacity(vm.saving ? 0.45 : 1).disabled(vm.saving) }
                    .onTextChange { vm.setTagValue($0) }
                    .padding(.top, 12)
                if let preview = vm.tagPreview {
                    HStack(spacing: 0) {
                        Text("Will be stored as ").font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                        Text(preview).font(KioskType.mono(12)).foregroundStyle(palette.text)
                    }
                } else {
                    Text("24 characters, zero-padded.").font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                }
                KioskToast(text: vm.error, error: true)
                SecondaryButton("Cancel") { vm.cancel() }
            }
        } else {
            ScanInput(placeholder: "Scan a serial or asset ID", enabled: !disabled, keepFocus: !camera, onSubmit: publish) {
                cameraButton.opacity(disabled ? 0.45 : 1).disabled(disabled)
            }
            KioskToast(text: vm.error, error: true)
        }
    }
}

private struct Fact: View {
    let label: String
    let value: String
    var tint: Color?
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Text(label.uppercased()).font(KioskType.labelSmall).foregroundStyle(palette.textMute)
            Text(value).font(KioskType.mono(12)).foregroundStyle(tint ?? palette.text)
        }
        .padding(.top, 4)
    }
}

private struct AssetCard: View {
    let asset: KioskAssetRow
    let currentTag: String?
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(asset.name ?? "Unnamed asset").font(KioskType.titleLarge).foregroundStyle(palette.text)
            Fact(label: "Asset ID", value: asset.assetId.isEmpty ? "—" : asset.assetId)
            Fact(label: "Serial", value: asset.serialNumber ?? "—")
            Fact(label: "Make / Model", value: asset.makeModel.isEmpty ? "—" : asset.makeModel)
            if let currentTag { Fact(label: "Current tag", value: displayRfid(currentTag), tint: ChipTone.amber.text) }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.accent, lineWidth: 2))
    }
}

/// This session's enrollments, newest first (25 at most, memory only).
private struct SessionLog: View {
    let rows: [EnrollmentRow]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("This session").font(KioskType.titleMedium).foregroundStyle(palette.text).padding(.top, 16).padding(.bottom, 6)
                Divider().overlay(palette.paperLine)
                ForEach(rows) { row in
                    HStack(alignment: .top, spacing: 8) {
                        Text(scanTime(row.at)).font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                        Text("\(row.name)\(row.serial.map { " · \($0)" } ?? "") → \(displayRfid(row.rfid))\(row.replaced ? " (replaced)" : "")")
                            .font(KioskType.bodySmall).foregroundStyle(palette.text)
                    }
                    .padding(.vertical, 6)
                    Divider().overlay(palette.paperLine)
                }
            }
        }
    }
}
