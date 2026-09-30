import Foundation

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

protocol SessionRefresher: Sendable {
    func refresh() async -> SessionData?
    func store(_ data: SessionData) async
    /// Keeps an accepted pair answer: its session and the refresh cookie it set.
    func adopt(_ data: SessionData, cookie: PairCookie?) async
    func clear() async
    /// Sign-out: captures the token and refresh cookie for the server calls,
    /// then clears both locally.
    func signOutLocally() async -> SignOutCredentials
    /// Yields when an authed call could not recover from a 401.
    var sessionEnded: AsyncStream<Void> { get }
}

/// Why (or whether) a refresh produced a session.
enum RefreshOutcome: Sendable {
    case ok(SessionData)
    /// The server answered 401/403: the refresh cookie is dead.
    case rejected
    /// A network error, another non-2xx (502/503 during a deploy) or an
    /// unreadable answer: the cookie may still be good.
    case transient
    /// The session was stored or cleared (a sign-in or sign-out) while the
    /// refresh was in flight: its answer was dropped and nothing was touched.
    case superseded

    var session: SessionData? {
        if case .ok(let data) = self { return data }
        return nil
    }
}

/// The portal's session rules, restated (see kiosk/src/lib/api.ts):
/// access token in memory only; the refresh token is the `ss_refresh` cookie
/// `RefreshCookie` holds; refresh is single-flight; a 401/403 refresh clears
/// local state and the cookie, any other non-OK clears local state only, a
/// network failure keeps everything (as Android's SessionStore).
actor SessionStore: SessionRefresher {
    private let apiUrl: @Sendable () async -> String
    private let cookies: RefreshCookie
    private let session: URLSession
    private let clock: @Sendable () -> Int64

    private var token: String?
    private var tokenExpiresAt: Int64 = 0
    private var sessionExpiry: String?
    private var inFlight: Task<RefreshOutcome, Never>?
    /// Bumped by every store() and clear(): a refresh answer that lands after
    /// the session changed underneath it is dropped.
    private var generation = 0

    nonisolated let sessionEnded: AsyncStream<Void>
    private nonisolated let endedContinuation: AsyncStream<Void>.Continuation

    init(apiUrl: @escaping @Sendable () async -> String, cookies: RefreshCookie, session: URLSession, clock: @escaping @Sendable () -> Int64 = nowMs) {
        self.apiUrl = apiUrl
        self.cookies = cookies
        self.session = session
        self.clock = clock
        (sessionEnded, endedContinuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
    }

    func accessToken() -> String? { token }
    func sessionExpiresAt() -> String? { sessionExpiry }
    func tokenIsStale() -> Bool { token == nil || clock() > tokenExpiresAt - 30_000 }

    func store(_ data: SessionData) {
        generation += 1
        token = data.accessToken
        tokenExpiresAt = clock() + Int64(data.expiresIn) * 1000
        sessionExpiry = data.sessionExpiresAt
    }

    func adopt(_ data: SessionData, cookie: PairCookie?) {
        if let cookie { cookies.set(host: cookie.host, value: cookie.value) }
        store(data)
    }

    func clear() {
        generation += 1
        token = nil
        tokenExpiresAt = 0
        sessionExpiry = nil
    }

    func signOutLocally() async -> SignOutCredentials {
        let base = await apiUrl()
        let host = URL(string: base)?.host
        let credentials = SignOutCredentials(apiUrl: base, accessToken: token, refreshCookie: host.flatMap { cookies.value(forHost: $0) })
        clear()
        if let host { cookies.clear(host: host) }
        return credentials
    }

    /// Clears the session, then tells the coordinator. The refresh cookie goes
    /// only when the server rejected it (`cookieRejected`); a transient failure keeps it.
    func notifySessionEnded(cookieRejected: Bool) async {
        clear()
        if cookieRejected, let host = URL(string: await apiUrl())?.host { cookies.clear(host: host) }
        endedContinuation.yield()
    }

    func refresh() async -> SessionData? { await refreshOutcome().session }

    /// Single-flight: concurrent callers all await the one request in flight.
    func refreshOutcome() async -> RefreshOutcome {
        if let inFlight { return await inFlight.value }
        let task = Task { await self.performRefresh() }
        inFlight = task
        let result = await task.value
        if inFlight == task { inFlight = nil }
        return result
    }

    private func performRefresh() async -> RefreshOutcome {
        let started = generation
        guard let url = URL(string: "\(await apiUrl())/auth/refresh"), let host = url.host else { return .transient }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let value = cookies.value(forHost: host) {
            request.setValue("\(RefreshCookie.name)=\(value)", forHTTPHeaderField: "Cookie")
        }
        let data: Data
        let http: HTTPURLResponse
        do {
            let (body, response) = try await session.data(for: request)
            guard let r = response as? HTTPURLResponse else { return .transient }
            (data, http) = (body, r)
        } catch {
            return .transient   // network hiccup: keep local state
        }
        // Signed in or out meanwhile: this answer belongs to a session that is gone,
        // so neither its token nor its cookie (nor its rejection) may touch the new state.
        guard generation == started else { return .superseded }
        guard (200..<300).contains(http.statusCode) else {
            clear()
            if http.statusCode == 401 || http.statusCode == 403 {
                cookies.clear(host: host)
                return .rejected
            }
            return .transient   // 5xx and the like: the cookie may still be good
        }
        cookies.capture(from: http, url: url)
        guard let session = try? KioskJSON.decoder.decode(SessionData.self, from: data) else {
            return .transient   // an unreadable answer: keep local state
        }
        store(session)
        return .ok(session)
    }
}
