import Foundation
@testable import ServerSherpa_Kiosk

/// A settable clock for the session store.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64

    init(_ start: Int64 = 1_000_000) { value = start }

    var now: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); defer { lock.unlock() }; value = newValue }
    }
}

/// One stub server + an API client pointed at it (Android `ApiHarness`).
struct ApiHarness {
    let server = StubServer()
    let secrets = MemorySecretStore()
    let cookies: RefreshCookie
    let clock = TestClock()
    let session: SessionStore
    let api: URLSessionKioskApi

    init() {
        cookies = RefreshCookie(secrets: secrets)
        let urlSession = URLSessionKioskApi.makeSession(protocolClasses: [StubURLProtocol.self])
        let base = server.baseURL
        let clock = self.clock
        session = SessionStore(apiUrl: { base }, cookies: cookies, session: urlSession, clock: { clock.now })
        api = URLSessionKioskApi(apiUrl: { base }, session: urlSession, sessionStore: session, cookies: cookies)
    }
}

let sessionJSON = """
{"access_token":"tok1","token_type":"bearer","expires_in":900,"session_expires_at":"2026-09-16T00:00:00Z",
 "person":{"id":"p1","first_name":"Tina","last_name":"T","preferred_name":null,"display_name":"Tina T","email":null,"job_title":null,"avatar_key":null},
 "roles":["worker"],"must_change_password":false,"preferences":{"accent":"amber","theme":"light"},
 "perms":{"kiosk":{"view":true}},"max_rank":20,"scope":{"global":true,"client_ids":[],"partner_ids":[]},"password_min_length":8}
"""

func sessionResponse(cookie: String? = "ss_refresh=r1; Path=/auth; HttpOnly", token: String = "tok1", delay: TimeInterval = 0) -> StubResponse {
    var r = StubResponse.json(200, sessionJSON.replacingOccurrences(of: "tok1", with: token))
    if let cookie { r.headers["Set-Cookie"] = cookie }
    r.delay = delay
    return r
}
