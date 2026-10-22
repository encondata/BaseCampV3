import SwiftUI

/// Copies the station's key and registration state onto the flow: Welcome takes nobody while
/// paused, and says "waiting for its station key" when the key is missing (web StationRoot's
/// `paused={!ready}` and `keyMissing`).
@MainActor func applyStationState(_ station: TimeclockStation, to model: TimeclockFlowModel) {
    model.paused = station.welcomePaused
    model.keyMissing = station.welcomeKeyMissing
}

/// A signed-out Time Clock station (web components/StationRoot.tsx): the guided time clock in
/// station mode, full screen and outside the shell. KioskGuard shows it in place of sign-in.
///
/// - The people come from the station routes under the key, into SwiftData, when it starts
///   and on every return to Welcome; a resting Welcome also re-reads them once a minute, which
///   picks up new hires and un-pauses a station whose registration was renewed.
/// - Welcome's gear goes to sign-in (`TimeclockStation.requestLogin`), whose "Back to the time
///   clock" returns here.
/// - Camera scans arrive through the scan bus, as on the kiosk's Timeclock route.
struct StationWelcomeHost: View {
    @Environment(\.container) private var container

    var body: some View {
        StationWelcomeBody(container: container)
    }
}

/// How often a resting Welcome re-reads the people (web StationRoot's REFRESH_MS).
let STATION_REFRESH: Duration = .seconds(60)

private struct StationWelcomeBody: View {
    let container: AppContainer
    @State private var model: TimeclockFlowModel
    @State private var camera = false
    @Environment(TimeclockStation.self) private var station

    init(container: AppContainer) {
        self.container = container
        let prefs = container.prefs
        _model = State(initialValue: TimeclockFlowModel(
            mode: .station, backend: StationTcBackend(container: container), flash: container.flash, sound: container.sound,
            appearance: { prefs.appearance }, fetchImage: { [api = container.api] in try await api.fetchImage(url: $0) }))
    }

    var body: some View {
        TimeclockFlowView(model: model, onCamera: CameraSupport.hasCamera ? { camera = true } : nil,
                          onSettings: { station.requestLogin() })
            .onChange(of: StationFlags(paused: station.welcomePaused, keyMissing: station.welcomeKeyMissing), initial: true) {
                applyStationState(station, to: model)
            }
            .task {
                model.start()
                for await event in container.scanBus.events() { model.onScan(event.value) }
            }
            .task {
                while !Task.isCancelled {
                    do { try await Task.sleep(for: STATION_REFRESH) } catch { return }
                    if model.atStart { model.loadPeople() }
                }
            }
            .onDisappear { if !camera { model.stop() } }
            .fullScreenCover(isPresented: $camera) {
                CameraScanSheet(bus: container.scanBus, prefs: container.prefs) { camera = false }
            }
    }
}

private struct StationFlags: Equatable {
    var paused: Bool
    var keyMissing: Bool
}
