import Foundation

/// kiosk/src/timeclock/backend.ts: where the time clock flow gets its people and
/// its punches. The same steps run in two places: on a signed-in kiosk
/// (`SessionTcBackend`: the synced people in SwiftData, the kiosk's own session
/// for status and punches) and on the signed-out Time Clock station (a station
/// backend over `StationApi` and the station key). Both send the device's own
/// zone as `tz` for "today" when the site has none.
protocol TcBackend: Sendable {
    func people() async throws -> [KioskPersonRow]
    func status(personId: String) async throws -> KioskTimeclockStatus
    func clockIn(personId: String) async throws -> KioskTimeclockStatus
    func clockOut(personId: String) async throws -> KioskTimeclockStatus
}

/// A signed-in kiosk: people from the local roster, the session routes for the rest.
/// Clock-in names the kiosk's move and site when it has them (never ""), so the
/// portal falls back to the device row's otherwise.
struct SessionTcBackend: TcBackend {
    typealias Context = @MainActor @Sendable () -> (serial: String, selection: KioskSetupSelection?)

    private let store: KioskStore
    private let api: KioskApi
    private let timeZone: TimeZone
    private let context: Context

    init(store: KioskStore, api: KioskApi, timeZone: TimeZone = .current, context: @escaping Context) {
        self.store = store
        self.api = api
        self.timeZone = timeZone
        self.context = context
    }

    @MainActor init(container: AppContainer, timeZone: TimeZone = .current) {
        let identity = container.identity
        let prefs = container.prefs
        self.init(store: container.store, api: container.api, timeZone: timeZone) {
            (serial: identity.current.serial, selection: prefs.setupSelection)
        }
    }

    func people() async throws -> [KioskPersonRow] { try await store.people() }

    func status(personId: String) async throws -> KioskTimeclockStatus {
        let serial = await context().serial
        return try await api.timeclockStatus(personId: personId, serial: serial, tz: timeZone.identifier)
    }

    func clockIn(personId: String) async throws -> KioskTimeclockStatus {
        let (serial, selection) = await context()
        return try await api.clockIn(ClockInIn(serial: serial, personId: personId, siteId: selection?.siteIdOrNil,
                                               initiativeId: selection?.moveId, tz: timeZone.identifier))
    }

    func clockOut(personId: String) async throws -> KioskTimeclockStatus {
        let serial = await context().serial
        return try await api.clockOut(ClockOutIn(serial: serial, personId: personId, tz: timeZone.identifier))
    }
}
