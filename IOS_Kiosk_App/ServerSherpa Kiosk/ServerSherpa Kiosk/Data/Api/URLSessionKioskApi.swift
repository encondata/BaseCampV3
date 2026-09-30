import Foundation

/// Redirects that leave the original origin (scheme, host, port; default ports
/// normalized): a credentialed request (Authorization or Cookie), a request with a
/// body or anything but a GET is not followed, so its 3xx comes back as the answer
/// (a non-2xx `ApiError`). A credential-less GET (a presigned image) still follows,
/// with any Cookie/Authorization stripped. Same-origin redirects are untouched.
final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(Self.decide(request, original: task.originalRequest ?? task.currentRequest))
    }

    /// The request to follow, or nil to stop at the redirect.
    static func decide(_ request: URLRequest, original: URLRequest?) -> URLRequest? {
        guard let target = request.url else { return nil }
        if sameOrigin(original?.url, target) { return request }
        let method = (original?.httpMethod ?? "GET").uppercased()
        let hasBody = original?.httpBody != nil || original?.httpBodyStream != nil
        let credentialed = original?.value(forHTTPHeaderField: "Authorization") != nil
            || original?.value(forHTTPHeaderField: "Cookie") != nil
        if method != "GET" || hasBody || credentialed { return nil }
        var copy = request
        copy.setValue(nil, forHTTPHeaderField: "Cookie")
        copy.setValue(nil, forHTTPHeaderField: "Authorization")
        return copy
    }

    /// Same scheme, host and port (an absent port is the scheme's default).
    static func sameOrigin(_ a: URL?, _ b: URL?) -> Bool {
        guard let a, let b else { return false }
        func port(_ u: URL) -> Int? { u.port ?? (u.scheme?.lowercased() == "https" ? 443 : u.scheme?.lowercased() == "http" ? 80 : nil) }
        return a.scheme?.lowercased() == b.scheme?.lowercased()
            && a.host?.lowercased() == b.host?.lowercased()
            && port(a) == port(b)
    }
}

final class URLSessionKioskApi: KioskApi {
    private let apiUrl: @Sendable () async -> String
    private let session: URLSession
    private let sessionStore: SessionStore
    private let cookies: RefreshCookie

    init(apiUrl: @escaping @Sendable () async -> String, session: URLSession, sessionStore: SessionStore, cookies: RefreshCookie) {
        self.apiUrl = apiUrl
        self.session = session
        self.sessionStore = sessionStore
        self.cookies = cookies
    }

    /// Ephemeral, with URLSession's cookie handling off: the refresh cookie is
    /// the only cookie the kiosk keeps, and `RefreshCookie` keeps it.
    /// `RedirectGuard` keeps credentials and bodies from following a redirect
    /// to another origin (URLSession would forward custom headers).
    static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 20
        if let protocolClasses { config.protocolClasses = protocolClasses }
        return URLSession(configuration: config, delegate: RedirectGuard(), delegateQueue: nil)
    }

    // MARK: plumbing

    private typealias Response = (data: Data, http: HTTPURLResponse)

    private static func url(_ string: String) throws -> URL {
        guard let url = URL(string: string) else { throw ApiError.network() }
        return url
    }

    private static func request(_ url: URL, _ method: String = "GET") -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        return r
    }

    private static func request<T: Encodable>(_ url: URL, post body: T) throws -> URLRequest {
        var r = request(url, "POST")
        r.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        do {
            r.httpBody = try KioskJSON.encoder.encode(body)
        } catch {
            throw ApiError(status: 0, code: "encode_failed")
        }
        return r
    }

    /// Percent-encodes a path segment or query value (URLEncoder with `+` as `%20`).
    private static func q(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func execute(_ request: URLRequest) async throws -> Response {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ApiError.network() }
            return (data, http)
        } catch let e as ApiError {
            throw e
        } catch {
            // A canceled call (the screen went away) is not "Can't reach the portal".
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            throw ApiError.network()
        }
    }

    /// Non-2xx → `ApiError` from the body; else the decoded body. A 2xx body
    /// that does not decode reads as `unknown_error` with its status.
    private static func parse<T: Decodable>(_ response: Response, as type: T.Type = T.self) throws -> T {
        guard (200..<300).contains(response.http.statusCode) else {
            throw ApiError.from(status: response.http.statusCode, body: response.data)
        }
        do {
            return try KioskJSON.decoder.decode(T.self, from: response.data)
        } catch {
            throw ApiError(status: response.http.statusCode, code: "unknown_error")
        }
    }

    /// Unauthenticated call. `build` gets the API base URL.
    private func plain(_ build: (String) throws -> URLRequest) async throws -> Response {
        try await execute(try build(await apiUrl()))
    }

    /// Authenticated call: refresh when stale, bearer header, one refresh + one
    /// retry on 401; a failed refresh or a second 401 ends the session.
    private func authed(_ build: (String) throws -> URLRequest) async throws -> Response {
        if await sessionStore.tokenIsStale() { _ = await sessionStore.refresh() }
        func go() async throws -> Response {
            var request = try build(await apiUrl())
            if let token = await sessionStore.accessToken() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            return try await execute(request)
        }
        var response = try await go()
        if response.http.statusCode == 401 {
            let outcome = await sessionStore.refreshOutcome()
            switch outcome {
            case .ok:
                response = try await go()
                if response.http.statusCode == 401 { await sessionStore.notifySessionEnded(cookieRejected: true) }
            case .rejected:
                await sessionStore.notifySessionEnded(cookieRejected: true)
            case .transient:
                await sessionStore.notifySessionEnded(cookieRejected: false)
            case .superseded:
                break   // a sign-in/out happened meanwhile: the 401 belongs to the old session
            }
        }
        return response
    }

    /// A signed-in answer: keep the refresh cookie and the session.
    private func signedIn(_ response: Response) async throws -> SessionData {
        let data: SessionData = try Self.parse(response)
        if let url = response.http.url { cookies.capture(from: response.http, url: url) }
        await sessionStore.store(data)
        return data
    }

    // MARK: auth

    func login(email: String, password: String) async throws -> SessionData {
        let response = try await plain { try Self.request(Self.url("\($0)/auth/login"), post: LoginIn(email: email, password: password)) }
        return try await signedIn(response)
    }

    func moveLogin(password: String) async throws -> SessionData {
        let response = try await plain { try Self.request(Self.url("\($0)/kiosk/move-login"), post: MoveLoginIn(password: password)) }
        return try await signedIn(response)
    }

    func logout() async {
        let base = await apiUrl()
        guard let url = URL(string: "\(base)/auth/logout") else { await sessionStore.clear(); return }
        var request = Self.request(url, "POST")
        if let host = url.host, let value = cookies.value(forHost: host) {
            request.setValue("\(RefreshCookie.name)=\(value)", forHTTPHeaderField: "Cookie")
        }
        _ = try? await execute(request)   // an offline logout still clears
        if let host = url.host { cookies.clear(host: host) }
        await sessionStore.clear()
    }

    func systemStatus() async throws -> SystemStatus {
        try Self.parse(await plain { try Self.request(Self.url("\($0)/system/status")) })
    }

    // MARK: pairing

    func createPairRequest(serial: String, name: String) async throws -> PairCreated {
        try Self.parse(await plain { try Self.request(Self.url("\($0)/kiosk/pair"), post: PairCreateIn(serial: serial, name: name)) })
    }

    func pollPair(code: String, pollToken: String) async throws -> PairPoll {
        let response = try await plain { try Self.request(Self.url("\($0)/kiosk/pair/\(Self.q(code))/poll"), post: PairPollIn(pollToken: pollToken)) }
        if response.http.statusCode == 404 { return PairPoll(status: .expired, session: nil) }
        let out: PairPollOut = try Self.parse(response)
        let status = PairStatus.fromWire(out.status)
        if status == .approved, let session = out.session {
            if let url = response.http.url { cookies.capture(from: response.http, url: url) }
            await sessionStore.store(session)
        }
        return PairPoll(status: status, session: out.session)
    }

    // MARK: heartbeat

    func heartbeat(_ body: HeartbeatIn) async throws -> HeartbeatResult {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/heartbeat"), post: body) })
    }

    func signOut(serial: String) async {
        _ = try? await authed { try Self.request(Self.url("\($0)/kiosk/sign-out"), post: KioskSignOutIn(serial: serial)) }
    }

    // MARK: setup & sync

    func setupOptions() async throws -> SetupOptions {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/setup-options")) })
    }

    func submitSetup(_ body: KioskSetupIn) async throws -> KioskSetupResult {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/setup"), post: body) })
    }

    func syncAssets(initiativeId: String) async throws -> KioskAssetsSync {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/sync/assets?initiative_id=\(Self.q(initiativeId))")) })
    }

    func syncPeople() async throws -> KioskPeopleSync {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/sync/people")) })
    }

    func syncContainers(initiativeId: String) async throws -> KioskContainersSync {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/sync/containers?initiative_id=\(Self.q(initiativeId))")) })
    }

    func syncTrucks(initiativeId: String) async throws -> KioskTrucksSync {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/sync/trucks?initiative_id=\(Self.q(initiativeId))")) })
    }

    // MARK: scans, RFID, timeclock

    func postScans(_ body: KioskScanBatchIn) async throws -> KioskScanBatchOut {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/scans"), post: body) })
    }

    func postRfidEnroll(assetId: String, _ body: KioskRfidEnrollIn) async throws -> KioskRfidEnroll {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/assets/\(Self.q(assetId))/rfid"), post: body) })
    }

    func timeclockStatus(personId: String) async throws -> KioskTimeclockStatus {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/timeclock/\(Self.q(personId))")) })
    }

    func clockIn(_ body: ClockInIn) async throws -> KioskTimeclockStatus {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/timeclock/clock-in"), post: body) })
    }

    func clockOut(_ body: ClockOutIn) async throws -> KioskTimeclockStatus {
        try Self.parse(await authed { try Self.request(Self.url("\($0)/kiosk/timeclock/clock-out"), post: body) })
    }

    // MARK: images

    func fetchImage(url: String) async throws -> Data {
        let response = try await execute(Self.request(try Self.url(url)))
        guard (200..<300).contains(response.http.statusCode) else {
            throw ApiError.from(status: response.http.statusCode, body: response.data)
        }
        return response.data
    }
}
