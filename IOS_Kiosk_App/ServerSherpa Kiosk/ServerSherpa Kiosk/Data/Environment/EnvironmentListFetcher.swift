import Foundation

/// Where the chooser's list came from.
enum ListSource: Equatable, Sendable {
    case fresh, saved, builtIn
}

/// The environment list for the chooser (Android `EnvironmentListFetcher`): a fresh download of
/// the published file, else the last good download, else the built-in list. The download goes
/// only to an https address, on its own session: no cookies or credentials, no redirect followed
/// (a 3xx is a failure), only a 200 counts, it gives up after 5 s and reads at most
/// `Environments.maxBody` bytes. Cancelling the caller ends the download. Only the chooser reads
/// the list; it never changes where the kiosk connects.
@MainActor
final class EnvironmentListFetcher {
    let url: String
    private let store: EnvironmentStore
    private let session: URLSession

    init(store: EnvironmentStore, session: URLSession = .makeEnvironmentListSession(),
         url: String = Environments.statusListURL) {
        self.store = store
        self.session = session
        self.url = url
    }

    func current() async -> (list: [Env], source: ListSource) {
        if let data = await Self.download(url, session: session), let fresh = Environments.parseList(data) {
            store.cacheList(fresh)
            return (fresh, .fresh)
        }
        if let saved = store.cachedList { return (saved, .saved) }
        return (Environments.builtIn, .builtIn)
    }

    /// The body of a 200 answer of at most `maxBody` bytes, or nil. Off the main actor: the body
    /// is read a byte at a time.
    nonisolated private static func download(_ url: String, session: URLSession) async -> Data? {
        guard let target = URL(string: url), target.scheme?.lowercased() == "https" else { return nil }
        var request = URLRequest(url: target)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.expectedContentLength <= Int64(Environments.maxBody) else { return nil }
            var body = Data()
            for try await byte in bytes {
                // More than the limit arrived (with or without a Content-Length).
                if body.count == Environments.maxBody { return nil }
                body.append(byte)
            }
            return body
        } catch {
            return nil
        }
    }
}

/// Refuses every redirect, so the 3xx itself comes back as the answer. Unlike `RedirectGuard`,
/// which follows a credential-less GET to another origin.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

extension URLSession {
    /// The environment list's own session: ephemeral, no cookie store and no cookies set or
    /// accepted, no redirect followed, and `timeout` (5 s) for the request and the whole load.
    static func makeEnvironmentListSession(protocolClasses: [AnyClass]? = nil, timeout: TimeInterval = 5) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        if let protocolClasses { config.protocolClasses = protocolClasses }
        return URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
    }
}
