import Foundation
import Testing
@testable import ServerSherpa_Kiosk

@MainActor
struct EnvironmentListFetcherTests {
    private let server = StubServer()
    private let store = EnvironmentStore(prefs: KioskPrefs(defaults: freshDefaults()))

    private let twoEnvs = #"{"version":1,"environments":[{"id":"rc2","name":"RC2","domain":"rc2.serversherpa.com"},{"id":"dev","name":"Dev","domain":"dev.serversherpa.com"}]}"#
    private let twoParsed = [Env(id: "rc2", name: "RC2", domain: "rc2.serversherpa.com"), Env(id: "dev", name: "Dev", domain: "dev.serversherpa.com")]

    private func fetcher(store: EnvironmentStore? = nil, timeout: TimeInterval = 5) -> EnvironmentListFetcher {
        EnvironmentListFetcher(store: store ?? self.store,
                               session: .makeEnvironmentListSession(protocolClasses: [StubURLProtocol.self], timeout: timeout),
                               url: "\(server.baseURL)/environments.json")
    }

    @Test func freshThenSavedThenBuiltIn() async throws {
        let fetcher = fetcher()
        server.enqueue(StubResponse(headers: ["Content-Type": "application/json", "Set-Cookie": "ss_refresh=secret; Path=/"], body: Data(twoEnvs.utf8)))
        var got = await fetcher.current()
        #expect(got.list == twoParsed && got.source == .fresh)
        let req = try #require(server.takeRequest())
        #expect(req.method == "GET" && req.path == "/environments.json")
        #expect(req.header("Cookie") == nil)                      // no cookie and no auth ever go out
        #expect(req.header("Authorization") == nil)

        server.enqueue(.json(500, "{}"))
        got = await fetcher.current()
        #expect(got.list == twoParsed && got.source == .saved)
        #expect(server.takeRequest()?.header("Cookie") == nil)    // the first answer's cookie isn't kept

        server.shutdown()                                         // offline, and nothing saved
        let empty = EnvironmentStore(prefs: KioskPrefs(defaults: freshDefaults()))
        got = await self.fetcher(store: empty).current()
        #expect(got.list == Environments.builtIn && got.source == .builtIn)
    }

    /// The session itself: ephemeral, no cookie store, cookies never set, a 5 s timeout.
    @Test func theSessionKeepsNoCookiesAndGivesUpAfterFiveSeconds() {
        let config = URLSession.makeEnvironmentListSession().configuration
        #expect(config.httpCookieStorage == nil)
        #expect(!config.httpShouldSetCookies)
        #expect(config.httpCookieAcceptPolicy == .never)
        #expect(config.timeoutIntervalForRequest == 5)
        #expect(config.timeoutIntervalForResource == 5)
    }

    @Test func onlyA200Counts() async {
        let fetcher = fetcher()
        for status in [201, 204, 304, 404] {
            server.enqueue(.json(status, twoEnvs))
            let got = await fetcher.current()
            #expect(got.source == .builtIn, "\(status)")
        }
        #expect(store.cachedList == nil)
    }

    @Test func anUnusableFileIsAFailedDownloadAndIsNotSaved() async {
        let fetcher = fetcher()
        server.enqueue(.json(200, #"{"version":2,"environments":[{"id":"dev","name":"Dev","domain":"dev.serversherpa.com"}]}"#))
        var got = await fetcher.current()
        #expect(got.list == Environments.builtIn && got.source == .builtIn)
        server.enqueue(.json(200, #"{"version":1,"environments":[{"id":"x1","name":"X","domain":"evil.example.com"}]}"#))
        got = await fetcher.current()
        #expect(got.source == .builtIn)
        server.enqueue(.text(200, "<html>not json</html>"))
        got = await fetcher.current()
        #expect(got.source == .builtIn)
        #expect(store.cachedList == nil)
    }

    /// Review Focus 5: a redirect is a failure, and its target is never asked, even a
    /// credential-less GET to another origin (which the API session's RedirectGuard follows).
    @Test func aRedirectIsAFailureAndItsTargetIsNeverHit() async {
        let target = StubServer()
        target.enqueue(.json(200, twoEnvs))
        let fetcher = fetcher()
        for status in [301, 302, 307, 308] {
            server.enqueue(.redirect(to: "\(target.baseURL)/environments.json", status: status))
            let got = await fetcher.current()
            #expect(got.source == .builtIn, "\(status)")
        }
        server.enqueue(.redirect(to: "\(server.baseURL)/other.json"))   // same origin too
        let got = await fetcher.current()
        #expect(got.source == .builtIn)
        #expect(target.requestCount == 0)
        #expect(server.requests.map(\.path).allSatisfy { $0 == "/environments.json" })
    }

    /// Review Focus 5: over 64 KB is a failure, whether or not the server says how long it is;
    /// exactly 64 KB is read.
    @Test func anOversizedBodyIsAFailure() async {
        let fetcher = fetcher()
        let padding = String(repeating: " ", count: Environments.maxBody)
        let big = Data((twoEnvs + padding).utf8)
        server.enqueue(StubResponse(headers: ["Content-Type": "application/json", "Content-Length": "\(big.count)"], body: big))
        var got = await fetcher.current()
        #expect(got.source == .builtIn)
        server.enqueue(StubResponse(headers: ["Content-Type": "application/json"], body: big))   // no Content-Length
        got = await fetcher.current()
        #expect(got.source == .builtIn)
        #expect(store.cachedList == nil)

        let exact = Data((twoEnvs + String(repeating: " ", count: Environments.maxBody - twoEnvs.utf8.count)).utf8)
        #expect(exact.count == Environments.maxBody)
        server.enqueue(StubResponse(headers: ["Content-Type": "application/json"], body: exact))
        got = await fetcher.current()
        #expect(got.list == twoParsed && got.source == .fresh)
    }

    /// A server that never answers falls back to the saved list once the session's timeout passes
    /// (shortened here; the app's is 5 s).
    @Test func aSilentServerFallsBackAfterTheTimeout() async {
        store.cacheList(twoParsed)
        server.enqueue(StubResponse(body: Data(twoEnvs.utf8), delay: 5))
        let started = ContinuousClock.now
        let got = await fetcher(timeout: 0.5).current()
        let took = ContinuousClock.now - started
        #expect(got.list == twoParsed && got.source == .saved)
        #expect(took < .seconds(3), "took \(took)")
    }

    /// Cancelling the caller ends the download at once; the chooser still gets a list.
    @Test func cancellingTheCallerEndsTheDownload() async {
        let hold = StubHold()
        defer { hold.release() }
        server.enqueue(StubResponse(body: Data(twoEnvs.utf8), hold: hold))
        let fetcher = fetcher()
        let task = Task { await fetcher.current() }
        #expect(await waitUntil { server.requestCount == 1 })
        let started = ContinuousClock.now
        task.cancel()
        let got = await task.value
        #expect(ContinuousClock.now - started < .seconds(2))
        #expect(got.source == .builtIn)
        #expect(store.cachedList == nil)
    }

    /// Review Focus 1: the kiosk keeps connecting to its saved domain whatever a later list says
    /// (the entry's domain changed there, or the entry is gone).
    @Test func aLaterListNeverMovesTheSavedEnvironment() async {
        let rc1 = SavedEnvironment.named(id: "rc1", name: "RC1", domain: "rc1.serversherpa.com")
        store.save(rc1)
        let config = KioskConfig(store: store, defaultEnvironment: .named(id: "dev", name: "Dev", domain: "dev.serversherpa.com"), kioskVersion: "0.1.0")
        let fetcher = fetcher()
        server.enqueue(.json(200, #"{"version":1,"environments":[{"id":"rc1","name":"RC1","domain":"rc1-new.serversherpa.com"}]}"#))
        var got = await fetcher.current()
        #expect(got.source == .fresh)
        #expect(config.apiUrl == "https://api.rc1.serversherpa.com")
        server.enqueue(.json(200, twoEnvs))                        // rc1 dropped from the list
        got = await fetcher.current()
        #expect(got.source == .fresh)
        #expect(config.apiUrl == "https://api.rc1.serversherpa.com")
        #expect(config.portalUrl == "https://portal.rc1.serversherpa.com")
        #expect(store.saved == rc1)
    }

    /// Only an https address is ever fetched.
    @Test func anHttpListAddressIsNeverFetched() async {
        let fetcher = EnvironmentListFetcher(store: store,
                                             session: .makeEnvironmentListSession(protocolClasses: [StubURLProtocol.self]),
                                             url: "http://\(server.host)/environments.json")
        server.enqueue(.json(200, twoEnvs))
        let got = await fetcher.current()
        #expect(got.source == .builtIn)
        #expect(server.requestCount == 0)
    }

    @Test func theDefaultAddressIsTheStatusSite() {
        #expect(EnvironmentListFetcher(store: store).url == "https://status.serversherpa.com/environments.json")
    }
}
