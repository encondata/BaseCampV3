import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The Time Clock station's calls under its station key: only
/// `Authorization: Station <key>`, never a Bearer token, with `serial` in the
/// query (GET) or the body (POST); errors come back as `ApiError` with no
/// refresh and no retry. Plus the session-side calls the station needs.
@Suite(.serialized, .timeLimit(.minutes(1)))
struct StationApiTests {
    private let statusJSON = #"{"person":{"id":"p 1","display_name":"Tina T"},"clocked_in":true,"entry":{"id":"e","started_at":"2026-10-21T13:00:00Z"},"today_minutes":5,"today_entries":[{"clock_in_at":"2026-10-21T13:00:00Z","clock_out_at":null,"minutes":5}]}"#

    /// A station client and a session client on one stub server.
    private struct Harness {
        let api = ApiHarness()
        let station: URLSessionStationApi
        let base: String
        var server: StubServer { api.server }

        init() {
            base = api.server.baseURL
            station = URLSessionStationApi(session: URLSessionKioskApi.makeSession(protocolClasses: [StubURLProtocol.self]))
        }

        func signIn() async throws {
            server.enqueue(sessionResponse())
            _ = try await api.api.login(email: "a@b.c", password: "pw")
            _ = server.takeRequest()
        }
    }

    /// The URL checked against the key's origin is the URL used: credentials are taken, then
    /// Settings saves a new API URL, then the call is made. It goes to the original host only.
    @MainActor @Test func aUrlSavedAfterTheCheckNeverReceivesTheKey() async throws {
        let h = Harness()
        let other = StubServer()
        let url = MutableBox(h.base)
        let station = TimeclockStation(keys: StationKeyStore(secrets: MemorySecretStore()), serial: { "ios-1" }, apiUrl: { url.value })
        station.storeKey("k3y")
        let creds = try #require(station.credentials())
        url.value = other.baseURL                              // saved in between
        h.server.enqueue(.json(200, #"{"generated_at":"g","people":[]}"#))
        _ = try await h.station.people(base: creds.base, key: creds.key, serial: creds.serial)
        #expect(h.server.requestCount == 1)
        #expect(other.requestCount == 0)                       // the new host never sees the key
        // the next call re-checks: the key no longer matches, so it is dropped and nothing goes out
        #expect(station.credentials() == nil)
        #expect(!station.hasKey)
        #expect(other.requestCount == 0)
    }

    @Test func peopleSendsOnlyTheStationKeyAndTheSerialInTheQuery() async throws {
        let h = Harness()
        try await h.signIn()   // a session exists, and still never rides along
        h.server.enqueue(.json(200, #"{"generated_at":"g","people":[{"id":"p1","display_name":"Bea","badge_uid":"b-1","is_worker":true,"has_account":false}]}"#))
        let people = try await h.station.people(base: h.base, key: "k3y", serial: "ios 1")
        #expect(people.map(\.badgeUid) == ["b-1"])
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "GET")
        #expect(req.path == "/kiosk/station/sync/people?serial=ios%201")
        #expect(req.header("Authorization") == "Station k3y")
        #expect(req.header("Cookie") == nil)
    }

    @Test func statusReadsThePersonWithSerialAndZone() async throws {
        let h = Harness()
        h.server.enqueue(.json(200, statusJSON))
        let st = try await h.station.status(base: h.base, key: "k3y", serial: "ios-1", personId: "p 1", tz: "America/Chicago")
        #expect(st.clockedIn && st.todayMinutes == 5)
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "GET")
        #expect(req.path == "/kiosk/station/timeclock/p%201?serial=ios-1&tz=America%2FChicago")
        #expect(req.header("Authorization") == "Station k3y")
    }

    @Test func punchesPostSerialPersonAndZone() async throws {
        let h = Harness()
        try await h.signIn()
        h.server.enqueue(.json(200, statusJSON))
        _ = try await h.station.clockIn(base: h.base, key: "k3y", serial: "ios-1", personId: "p1", tz: "UTC")
        let inReq = try #require(h.server.takeRequest())
        #expect(inReq.method == "POST")
        #expect(inReq.path == "/kiosk/station/timeclock/clock-in")
        #expect(inReq.header("Authorization") == "Station k3y")
        #expect(inReq.header("Content-Type") == "application/json; charset=utf-8")
        #expect(inReq.bodyString == #"{"person_id":"p1","serial":"ios-1","tz":"UTC"}"#)

        h.server.enqueue(.json(200, #"{"person":{"id":"p1","display_name":"T"},"clocked_in":false,"last_entry":{"id":"e","started_at":"2026-10-21T08:00:00Z","ended_at":"2026-10-21T12:00:00Z","minutes":240}}"#))
        let out = try await h.station.clockOut(base: h.base, key: "k3y", serial: "ios-1", personId: "p1", tz: "UTC")
        #expect(out.lastEntry?.minutes == 240)
        let outReq = try #require(h.server.takeRequest())
        #expect(outReq.path == "/kiosk/station/timeclock/clock-out")
        #expect(outReq.header("Authorization") == "Station k3y")
        #expect(outReq.bodyString == #"{"person_id":"p1","serial":"ios-1","tz":"UTC"}"#)
    }

    /// 401 is answered once: no refresh, no retry, and the session is untouched.
    @Test(arguments: [
        (401, "station_key_invalid"),
        (403, "kiosk_not_registered"),
        (403, "wrong_station_type"),
        (409, "already_clocked_in"),
        (409, "not_clocked_in"),
        (423, "read_only_mode"),
    ])
    func errorsMapToApiErrorWithNoRetry(status: Int, code: String) async throws {
        let h = Harness()
        try await h.signIn()
        h.server.enqueue(.json(status, #"{"detail":{"code":"\#(code)"}}"#))
        do {
            _ = try await h.station.clockIn(base: h.base, key: "k3y", serial: "ios-1", personId: "p1", tz: "UTC")
            Issue.record("expected ApiError")
        } catch let e as ApiError {
            #expect(e.status == status)
            #expect(e.code == code)
        }
        #expect(h.server.requestCount == 2)   // the sign-in and the one punch
        #expect(await h.api.session.accessToken() == "tok1")
    }

    @Test func aTransportFailureIsNetwork() async throws {
        let h = Harness()
        h.server.shutdown()
        do {
            _ = try await h.station.people(base: h.base, key: "k3y", serial: "ios-1")
            Issue.record("expected ApiError")
        } catch let e as ApiError {
            #expect(e.isNetwork)
        }
    }

    // MARK: session side

    @Test func issueStationKeyIsASessionCall() async throws {
        let h = Harness()
        try await h.signIn()
        h.server.enqueue(.json(200, #"{"key":"s3cret"}"#))
        #expect(try await h.api.api.issueStationKey(serial: "ios-1") == "s3cret")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST")
        #expect(req.path == "/kiosk/station-key")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.bodyString == #"{"serial":"ios-1"}"#)
    }

    @Test func sessionTimeclockCallsSendTheZone() async throws {
        let h = Harness()
        try await h.signIn()
        h.server.enqueue(.json(200, statusJSON))
        _ = try await h.api.api.timeclockStatus(personId: "p1", serial: "ios 1", tz: "America/Chicago")
        #expect(h.server.takeRequest()?.path == "/kiosk/timeclock/p1?serial=ios%201&tz=America%2FChicago")
        h.server.enqueue(.json(200, statusJSON))
        _ = try await h.api.api.timeclockStatus(personId: "p1", serial: nil, tz: nil)
        #expect(h.server.takeRequest()?.path == "/kiosk/timeclock/p1")

        h.server.enqueue(.json(200, statusJSON))
        _ = try await h.api.api.clockIn(ClockInIn(serial: "ios-1", personId: "p1", tz: "UTC"))
        #expect(h.server.takeRequest()?.bodyString == #"{"person_id":"p1","serial":"ios-1","tz":"UTC"}"#)
        h.server.enqueue(.json(200, statusJSON))
        _ = try await h.api.api.clockOut(ClockOutIn(serial: "ios-1", personId: "p1", tz: "UTC"))
        #expect(h.server.takeRequest()?.bodyString == #"{"person_id":"p1","serial":"ios-1","tz":"UTC"}"#)
    }
}
