import SwiftUI
import UIKit

/// kiosk/src/pages/Timeclock.tsx: scan a badge or type a name, then one button to clock in or out.
struct TimeclockScreen: View {
    @Environment(\.container) private var container

    var body: some View {
        TimeclockBody(container: container)
    }
}

private struct TimeclockBody: View {
    let container: AppContainer
    @State private var vm: TimeclockViewModel
    @State private var camera = false
    @State private var resetToken = 0
    @Environment(\.kioskPalette) private var palette

    init(container: AppContainer) {
        self.container = container
        _vm = State(initialValue: TimeclockViewModel(store: container.store, api: container.api, prefs: container.prefs,
                                                     identity: container.identity, flash: container.flash, sound: container.sound))
    }

    private var setup: KioskSetupSelection? { container.prefs.setupSelection }
    private var empty: Bool { vm.loadStatus == .ready && vm.rosterSize == 0 }
    private var disabled: Bool { vm.loadStatus != .ready || empty }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(eyebrow: "Kiosk · Timeclock", title: "Timeclock",
                           subtitle: setup.map { "\($0.initiativeName) · \($0.siteName)" } ?? "Finish Kiosk Setup first.")
                if vm.loadStatus == .error { KioskToast(text: "Couldn't read this kiosk's local data.", error: true) }
                if empty {
                    Text("No people on this kiosk. Sync from Kiosk Setup.")
                        .font(KioskType.bodyMedium).foregroundStyle(palette.textMute).padding(.bottom, 8)
                }
                KioskToast(text: vm.toast)
                if let selected = vm.selected {
                    selectedBody(selected)
                } else {
                    entryBody
                }
            }
            .padding(16)
        }
        .background(palette.paper2)
        // Any touch restarts the idle countdown without taking it from the controls underneath.
        .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in vm.bumpIdle() })
        .task { for await event in container.scanBus.events() { vm.scan(event.value) } }
        .task(id: container.sync.rosterVersion) { await vm.loadRoster() }
        .onDisappear { vm.stop() }
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

    // MARK: entry

    @ViewBuilder private var entryBody: some View {
        ScanInput(placeholder: "Scan a badge or type a name", enabled: !disabled, keepFocus: !camera,
                  clearOnSubmit: false, resetToken: resetToken, onSubmit: publish) {
            cameraButton.opacity(disabled ? 0.45 : 1).disabled(disabled)
        }
        .onTextChange { vm.onQueryChange($0) }
        // Enter keeps the typed name (several matches wait); the box empties only when the model says so (not found, no data).
        .onChange(of: vm.query) { _, new in if new.isEmpty { resetToken += 1 } }
        KioskToast(text: vm.error, error: true)
        ForEach(vm.results, id: \.id) { person in
            Button { vm.select(person) } label: {
                HStack(spacing: 8) {
                    Text(person.displayName).font(KioskType.bodyLarge).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if person.isWorker { KioskChip(text: "worker", tone: .slate, dot: false) }
                    if person.hasAccount { KioskChip(text: "account", tone: .slate, dot: false) }
                    if let tag = person.rfidTag {
                        Text(displayRfid(tag)).font(KioskType.labelMedium).foregroundStyle(palette.textMute)
                    }
                }
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: selected

    @ViewBuilder private func selectedBody(_ selected: KioskPersonRow) -> some View {
        let status = vm.status
        let name = status?.person.displayName ?? selected.displayName
        SetupCard(selected: true, action: {}) {
            HStack(spacing: 12) {
                AvatarView(image: vm.avatar, name: name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(KioskType.titleLarge).foregroundStyle(palette.text)
                    statusLines(status)
                }
            }
        }
        HStack(spacing: 8) {
            PrimaryButton(vm.busy ? "Working…" : (status?.clockedIn == true ? "Clock out" : "Clock in"),
                          enabled: vm.statusPhase == .ready && !vm.busy) { vm.punch() }
            SecondaryButton("Cancel") { vm.cancel() }
        }
        .padding(.top, 12)
        KioskToast(text: vm.error, error: true)
    }

    @ViewBuilder private func statusLines(_ status: KioskTimeclockStatus?) -> some View {
        if vm.statusPhase == .loading {
            Text("Checking the portal…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
        } else if vm.statusPhase == .error {
            Text("Status unavailable").font(KioskType.bodyMedium).foregroundStyle(ChipTone.red.text)
        } else if let status, status.clockedIn, let entry = status.entry {
            Text("Clocked in for \(formatMinutes(minutesSince(entry.startedAt, nowMs: vm.nowMs)))")
                .font(KioskType.bodyMedium).foregroundStyle(ChipTone.green.text)
            Text(([ "since \(clockTime(entry.startedAt, timeZone: vm.timeZone))", entry.initiativeName, entry.siteName ].compactMap { $0 }).joined(separator: " · "))
                .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        } else if let status {
            Text("Not clocked in").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
            if let last = status.lastEntry {
                Text("Last clock-out \(clockTime(last.endedAt, timeZone: vm.timeZone))")
                    .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            }
        }
    }
}

/// The fetched avatar, or the person's initials until it lands (or if it never does).
private struct AvatarView: View {
    let image: UIImage?
    let name: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ZStack {
            Circle().fill(palette.paper2)
            if let image {
                Image(uiImage: image).resizable().scaledToFill().clipShape(Circle())
            } else {
                Text(initialsOf(name)).font(KioskType.titleLarge).foregroundStyle(palette.textMute)
            }
        }
        .frame(width: 64, height: 64)
        .accessibilityHidden(true)
    }
}
