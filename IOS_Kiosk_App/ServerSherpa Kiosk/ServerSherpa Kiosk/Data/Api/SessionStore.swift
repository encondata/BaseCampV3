import Foundation

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

protocol SessionRefresher: Sendable {
    func refresh() async -> SessionData?
    func store(_ data: SessionData) async
    func clear() async
    /// Yields when an authed call could not recover from a 401.
    var sessionEnded: AsyncStream<Void> { get }
}

/// The portal's session rules, restated (see kiosk/src/lib/api.ts):
/// access token in memory only; the refresh token is the `ss_refresh` cookie
/// `RefreshCookie` holds; refresh is single-flight; a non-OK refresh clears
/// local state, a network failure keeps it.
actor SessionStore: SessionRefresher {
    private let apiUrl: @Sendable () async -> String
    private let cookies: RefreshCookie
    private let session: URLSession
    private let clock: @Sendable () -> Int64

    private var token: String?
    private var tokenExpiresAt: Int64 = 0
    private var sessionExpiry: String?
    private var inFlight: Task<SessionData?, Never>?

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
        token = data.accessToken
        tokenExpiresAt = clock() + Int64(data.expiresIn) * 1000
        sessionExpiry = data.sessionExpiresAt
    }

    func clear() {
        token = nil
        tokenExpiresAt = 0
        sessionExpiry = nil
    }

    /// Clears the session and the refresh cookie, then tells the coordinator.
    func notifySessionEnded() async {
        clear()
        if let host = URL(string: await apiUrl())?.host { cookies.clear(host: host) }
        endedContinuation.yield()
    }

    /// Single-flight: concurrent callers all await the one request in flight.
    func refresh() async -> SessionData? {
        if let inFlight { return await inFlight.value }
        let task = Task { await self.performRefresh() }
        inFlight = task
        let result = await task.value
        if inFlight == task { inFlight = nil }
        return result
    }

    private func performRefresh() async -> SessionData? {
        guard let url = URL(string: "\(await apiUrl())/auth/refresh"), let host = url.host else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let value = cookies.value(forHost: host) {
            request.setValue("\(RefreshCookie.name)=\(value)", forHTTPHeaderField: "Cookie")
        }
        let data: Data
        let http: HTTPURLResponse
        do {
            let (body, response) = try await session.data(for: request)
            guard let r = response as? HTTPURLResponse else { return nil }
            (data, http) = (body, r)
        } catch {
            return nil   // network hiccup: keep local state
        }
        guard (200..<300).contains(http.statusCode) else {
            clear()
            cookies.clear(host: host)
            return nil
        }
        cookies.capture(from: http, url: url)
        guard let session = try? KioskJSON.decoder.decode(SessionData.self, from: data) else {
            return nil   // an unreadable answer: keep local state
        }
        store(session)
        return session
    }
}
