import Foundation

/// The Time Clock station (web `stationBackend`, with no edge in between): every call goes to
/// the station routes under the station key (`StationApi`), never the session, so the station
/// behaves the same whoever is signed in. People are synced into SwiftData (people only,
/// through `KioskStore` on its own queue), and the last list answers while the portal is out of
/// reach. What the portal says about the key is reported to `TimeclockStation` (drop it on 401
/// `station_key_invalid` / 403 `wrong_station_type`, pause on 403 `kiosk_not_registered`).
struct StationTcBackend: TcBackend {
    /// No key on this device: nothing is sent (web edge `station_not_ready`).
    static let notReady = ApiError(status: 409, code: "station_not_ready")

    private let api: StationApi
    private let store: KioskStore
    private let station: TimeclockStation
    private let timeZone: TimeZone

    init(api: StationApi, store: KioskStore, station: TimeclockStation, timeZone: TimeZone = .current) {
        self.api = api
        self.store = store
        self.station = station
        self.timeZone = timeZone
    }

    @MainActor init(container: AppContainer, timeZone: TimeZone = .current) {
        self.init(api: container.stationApi, store: container.store, station: container.station, timeZone: timeZone)
    }

    /// The portal's list replaces the local one. The local one answers when the portal can't be
    /// reached or refuses the key (Welcome is paused then anyway); with nothing local either, a
    /// network failure is the error.
    func people() async throws -> [KioskPersonRow] {
        do {
            let rows = try await call { key, serial in try await api.people(key: key, serial: serial) }
            try await store.replacePeople(rows)
            return rows
        } catch let error as ApiError {
            let cached = try await store.people()
            if cached.isEmpty && (error.isNetwork || error.status >= 500) { throw error }
            return cached
        }
    }

    func status(personId: String) async throws -> KioskTimeclockStatus {
        let tz = timeZone.identifier
        return try await call { key, serial in try await api.status(key: key, serial: serial, personId: personId, tz: tz) }
    }

    func clockIn(personId: String) async throws -> KioskTimeclockStatus {
        let tz = timeZone.identifier
        return try await call { key, serial in try await api.clockIn(key: key, serial: serial, personId: personId, tz: tz) }
    }

    func clockOut(personId: String) async throws -> KioskTimeclockStatus {
        let tz = timeZone.identifier
        return try await call { key, serial in try await api.clockOut(key: key, serial: serial, personId: personId, tz: tz) }
    }

    /// One station call under the stored key, its outcome reported to the station.
    private func call<T: Sendable>(_ op: @Sendable (String, String) async throws -> T) async throws -> T {
        guard let credentials = await station.credentials() else { throw Self.notReady }
        let key = credentials.key
        do {
            let result = try await op(key, credentials.serial)
            await station.noteAnswered()
            return result
        } catch {
            await station.noteFailure(error, key: key)
            throw error
        }
    }
}

/// The kiosk's Timeclock route: on a Time Clock station it punches through the station key
/// even while someone is signed in (spec §6); anywhere else through the session.
@MainActor func kioskTimeclockBackend(container: AppContainer) -> TcBackend {
    if container.prefs.setupSelection?.isTimeclockStation == true { return StationTcBackend(container: container) }
    return SessionTcBackend(container: container)
}
