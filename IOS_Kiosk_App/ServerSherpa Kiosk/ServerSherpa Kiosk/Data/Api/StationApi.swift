import Foundation

/// A Time Clock station's calls under its station key (Android `StationApi`), with no
/// person signed in. Each sends only `Authorization: Station <key>`, with `serial` in
/// the query (GET) or the body (POST): never a Bearer token, never a refresh or retry,
/// and never the session-ended path. Implementations throw `ApiError` on any non-2xx
/// or transport failure; the caller decides what each code means for the key
/// (401 `station_key_invalid`, 403 `kiosk_not_registered` / `wrong_station_type`,
/// 409 `already_clocked_in` / `not_clocked_in`, 423 read-only).
///
/// Issuing the key is a session call: `KioskApi.issueStationKey(serial:)`.
///
/// `base` is the API base URL the key was checked against (`TimeclockStation.credentials()`):
/// every request is built from it and never from a fresh read of the kiosk's settings, so a URL
/// saved in between can never receive the key.
protocol StationApi: Sendable {
    /// `GET /kiosk/station/sync/people?serial=`: everyone the station may punch.
    func people(base: String, key: String, serial: String) async throws -> [KioskPersonRow]
    /// `GET /kiosk/station/timeclock/{person_id}?serial=&tz=`.
    func status(base: String, key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus
    /// `POST /kiosk/station/timeclock/clock-in` with `{serial, person_id, tz}`.
    func clockIn(base: String, key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus
    /// `POST /kiosk/station/timeclock/clock-out` with `{serial, person_id, tz}`.
    func clockOut(base: String, key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus
}

/// `StationApi` over the app's one URLSession (its redirect guard keeps the key from
/// following a redirect to another origin), built and parsed as `URLSessionKioskApi` does.
/// It holds no API URL of its own: each call names the checked base.
final class URLSessionStationApi: StationApi {
    private let session: URLSession

    init(session: URLSession) {
        self.session = session
    }

    private typealias Api = URLSessionKioskApi

    /// Builds the request against the checked base URL and adds the station key, nothing else.
    private func station(_ base: String, _ key: String, _ build: (String) throws -> URLRequest) async throws -> Api.Response {
        var request = try build(base)
        request.setValue("Station \(key)", forHTTPHeaderField: "Authorization")
        return try await Api.execute(request, on: session)
    }

    func people(base: String, key: String, serial: String) async throws -> [KioskPersonRow] {
        let body: KioskPeopleSync = try Api.parse(await station(base, key) {
            try Api.request(Api.url("\($0)/kiosk/station/sync/people?serial=\(Api.q(serial))"))
        })
        return body.people
    }

    func status(base: String, key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus {
        try Api.parse(await station(base, key) {
            try Api.request(Api.url("\($0)/kiosk/station/timeclock/\(Api.q(personId))?serial=\(Api.q(serial))&tz=\(Api.q(tz))"))
        })
    }

    func clockIn(base: String, key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus {
        try Api.parse(await station(base, key) {
            try Api.request(Api.url("\($0)/kiosk/station/timeclock/clock-in"), post: StationClockIn(serial: serial, personId: personId, tz: tz))
        })
    }

    func clockOut(base: String, key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus {
        try Api.parse(await station(base, key) {
            try Api.request(Api.url("\($0)/kiosk/station/timeclock/clock-out"), post: StationClockIn(serial: serial, personId: personId, tz: tz))
        })
    }
}
