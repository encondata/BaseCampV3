import SwiftUI

/// The kiosk's Timeclock tile: the guided time clock in kiosk mode. It starts at
/// Enter Your Name, and every exit (Done, idle, Back on Enter Your Name) goes Home.
/// The people are the kiosk's synced copy, re-read whenever a sync lands; camera
/// scans arrive through the scan bus.
struct TimeclockScreen: View {
    @Environment(\.container) private var container

    var body: some View {
        TimeclockKioskHost(container: container)
    }
}

private struct TimeclockKioskHost: View {
    let container: AppContainer
    @State private var model: TimeclockFlowModel
    @State private var camera = false
    @State private var rosterSeen = false
    @Environment(\.goHome) private var goHome

    init(container: AppContainer) {
        self.container = container
        let prefs = container.prefs
        _model = State(initialValue: TimeclockFlowModel(
            mode: .kiosk, backend: SessionTcBackend(container: container), flash: container.flash, sound: container.sound,
            appearance: { prefs.appearance }, fetchImage: { [api = container.api] in try await api.fetchImage(url: $0) }))
    }

    var body: some View {
        TimeclockFlowView(model: model, onCamera: CameraSupport.hasCamera ? { camera = true } : nil, onSettings: nil)
            .task {
                model.onExit = { goHome() }
                for await event in container.scanBus.events() { model.onScan(event.value) }
            }
            .task(id: container.sync.rosterVersion) {
                // the first run is the flow's first read; later ones follow a finished sync
                if rosterSeen { model.loadPeople() } else { model.start() }
                rosterSeen = true
            }
            .onDisappear { if !camera { model.stop() } }
            .fullScreenCover(isPresented: $camera) {
                CameraScanSheet(bus: container.scanBus, prefs: container.prefs) { camera = false }
            }
    }
}
