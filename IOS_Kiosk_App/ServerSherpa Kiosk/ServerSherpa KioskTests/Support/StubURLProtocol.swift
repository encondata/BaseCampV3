import Foundation

/// A canned answer: a status, headers and body, optionally after a delay;
/// or a transport failure.
struct StubResponse: Sendable {
    var status: Int = 200
    var headers: [String: String] = ["Content-Type": "application/json"]
    var body: Data = Data()
    var delay: TimeInterval = 0
    var failure: URLError.Code?
    /// Answers 302 with this `Location` (the redirect is delivered to the session delegate).
    var redirectTo: String?
    /// When set, the answer waits until the test calls `release()` (a request held in flight).
    var hold: StubHold?

    static func json(_ status: Int, _ body: String) -> StubResponse {
        StubResponse(status: status, body: Data(body.utf8))
    }

    static func text(_ status: Int, _ body: String) -> StubResponse {
        StubResponse(status: status, headers: [:], body: Data(body.utf8))
    }

    static func redirect(to location: String, status: Int = 302) -> StubResponse {
        StubResponse(status: status, headers: [:], redirectTo: location)
    }

    static func fail(_ code: URLError.Code = .cannotConnectToHost) -> StubResponse {
        StubResponse(failure: code)
    }
}

/// Holds a stub answer in flight until the test releases it.
final class StubHold: Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    func release() { semaphore.signal() }
    fileprivate func wait() { semaphore.wait() }
}

/// One request the stub saw.
struct RecordedRequest: Sendable {
    let method: String
    /// Percent-encoded path plus `?query`, as MockWebServer's `path`.
    let path: String
    let headers: [String: String]
    let body: Data

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }

    var bodyString: String { String(decoding: body, as: UTF8.self) }
}

/// A MockWebServer stand-in for one host. Each instance gets a unique host,
/// so tests (and suites) running in parallel never see each other's traffic.
final class StubServer: @unchecked Sendable {
    let host: String
    var baseURL: String { "https://\(host)" }

    private let lock = NSLock()
    private var queue: [StubResponse] = []
    private var recorded: [RecordedRequest] = []
    private var down = false
    private var taken = 0

    init(host: String = "stub-\(UUID().uuidString.lowercased()).example") {
        self.host = host
        StubURLProtocol.register(self)
    }

    func enqueue(_ response: StubResponse) {
        lock.lock(); defer { lock.unlock() }
        queue.append(response)
    }

    /// Every later request fails at the transport, like a stopped server.
    func shutdown() {
        lock.lock(); defer { lock.unlock() }
        down = true
    }

    var requests: [RecordedRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    var requestCount: Int { requests.count }

    /// The next request not yet taken, in arrival order (MockWebServer's `takeRequest`).
    func takeRequest() -> RecordedRequest? {
        lock.lock(); defer { lock.unlock() }
        guard taken < recorded.count else { return nil }
        defer { taken += 1 }
        return recorded[taken]
    }

    fileprivate func answer(_ request: RecordedRequest) -> StubResponse {
        lock.lock(); defer { lock.unlock() }
        if down { return .fail() }
        recorded.append(request)
        return queue.isEmpty ? .json(500, #"{"detail":{"code":"stub_queue_empty"}}"#) : queue.removeFirst()
    }
}

/// Routes each request to the `StubServer` registered for its host. The
/// registry is static and lock-protected; keying it by host is what keeps
/// concurrently running suites apart.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var servers: [String: StubServer] = [:]

    static func register(_ server: StubServer) {
        lock.lock(); defer { lock.unlock() }
        servers[server.host] = server
    }

    private static func server(for host: String?) -> StubServer? {
        lock.lock(); defer { lock.unlock() }
        return host.flatMap { servers[$0] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        guard let url = request.url, let server = Self.server(for: url.host) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let answer = server.answer(Self.record(request, url: url))
        DispatchQueue.global().asyncAfter(deadline: .now() + answer.delay) { [self] in
            answer.hold?.wait()
            if let failure = answer.failure {
                client?.urlProtocol(self, didFailWithError: URLError(failure))
                return
            }
            if let location = answer.redirectTo, let target = URL(string: location) {
                // Like the loading system: the new request carries the old one's headers.
                var next = URLRequest(url: target)
                next.httpMethod = request.httpMethod
                next.allHTTPHeaderFields = request.allHTTPHeaderFields
                let redirect = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: ["Location": location])!
                client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: redirect)
                // A delegate that refuses the redirect gets the 3xx itself as the answer
                // (as the real loading system does); when it follows, these are ignored.
                client?.urlProtocol(self, didReceive: redirect, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data())
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: answer.body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func record(_ request: URLRequest, url: URL) -> RecordedRequest {
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = parts?.percentEncodedPath ?? url.path
        if let query = parts?.percentEncodedQuery { path += "?\(query)" }
        return RecordedRequest(
            method: request.httpMethod ?? "GET",
            path: path,
            headers: request.allHTTPHeaderFields ?? [:],
            body: request.httpBody ?? readAll(request.httpBodyStream)
        )
    }

    private static func readAll(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}
