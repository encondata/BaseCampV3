import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@Suite(.serialized, .timeLimit(.minutes(1)))
struct SessionStoreTests {
    @Test func refreshStoresTokenAndSendsTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())                     // login sets the cookie
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(sessionResponse(cookie: nil, token: "tok2"))
        let data = await h.session.refresh()
        #expect(data?.accessToken == "tok2")
        #expect(await h.session.accessToken() == "tok2")
        #expect(await h.session.tokenIsStale() == false)
        _ = h.server.takeRequest()
        let refreshReq = try #require(h.server.takeRequest())
        #expect(refreshReq.path == "/auth/refresh")
        #expect(refreshReq.method == "POST")
        #expect(refreshReq.header("Cookie")?.contains("ss_refresh=r1") == true)
    }

    @Test func staleWithin30sOfExpiry() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.clock.now += 900_000 - 31_000
        #expect(await h.session.tokenIsStale() == false)
        h.clock.now += 2_000
        #expect(await h.session.tokenIsStale() == true)
    }

    @Test func rejectedRefreshClearsSessionAndDeletesTheCookie() async throws {
        for status in [401, 403] {
            let h = ApiHarness()
            h.server.enqueue(sessionResponse())
            _ = try await h.api.login(email: "a@b.c", password: "pw")
            h.server.enqueue(.json(status, #"{"detail":{"code":"invalid_token"}}"#))
            #expect(await h.session.refresh() == nil)
            #expect(await h.session.accessToken() == nil)
            #expect(h.cookies.value(forHost: h.server.host) == nil)
        }
    }

    @Test func serverErrorRefreshClearsSessionButKeepsTheCookie() async throws {
        for status in [500, 502, 503] {
            let h = ApiHarness()
            h.server.enqueue(sessionResponse())
            _ = try await h.api.login(email: "a@b.c", password: "pw")
            h.server.enqueue(.json(status, #"{"detail":{"code":"unavailable"}}"#))
            #expect(await h.session.refresh() == nil)
            #expect(await h.session.accessToken() == nil)
            #expect(h.cookies.value(forHost: h.server.host) == "r1")
        }
    }

    @Test func networkErrorRefreshKeepsTheSessionAndTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.shutdown()
        #expect(await h.session.refresh() == nil)
        #expect(await h.session.accessToken() == "tok1")
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
    }

    @Test func malformedRefreshBodyKeepsStateAndReturnsNull() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.json(200, "{not json"))
        #expect(await h.session.refresh() == nil)
        #expect(await h.session.accessToken() == "tok1")
    }

    @Test func refreshIsSingleFlight() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse(cookie: nil, token: "slow", delay: 0.3))
        let results = await withTaskGroup(of: SessionData?.self) { group in
            for _ in 1...5 { group.addTask { await h.session.refresh() } }
            var out: [SessionData?] = []
            for await r in group { out.append(r) }
            return out
        }
        #expect(results.count == 5)
        #expect(results.allSatisfy { $0?.accessToken == "slow" })
        #expect(h.server.requestCount == 1)
    }

    @Test func refreshSavesARotatedCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(sessionResponse(cookie: "ss_refresh=r2; Path=/auth; HttpOnly", token: "tok2"))
        _ = await h.session.refresh()
        #expect(h.secrets.get("refresh.\(h.server.host)") == "r2")
    }

    @Test func sessionEndedYieldsAndClears() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        var events = h.session.sessionEnded.makeAsyncIterator()
        await h.session.notifySessionEnded(cookieRejected: true)
        let ended: Void? = await events.next()
        #expect(ended != nil)
        #expect(await h.session.accessToken() == nil)
        #expect(h.cookies.value(forHost: h.server.host) == nil)
    }

    @Test func sessionEndedWithoutRejectionKeepsTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        var events = h.session.sessionEnded.makeAsyncIterator()
        await h.session.notifySessionEnded(cookieRejected: false)
        let ended: Void? = await events.next()
        #expect(ended != nil)
        #expect(await h.session.accessToken() == nil)
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
    }

    // MARK: a refresh answer that lands after the session changed is dropped

    @Test func aRefreshAnsweringAfterSignOutStoresNothing() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        let hold = StubHold()
        var rotated = sessionResponse(cookie: "ss_refresh=r2; Path=/auth; HttpOnly", token: "tok2")
        rotated.hold = hold
        h.server.enqueue(rotated)
        let refresh = Task { await h.session.refreshOutcome() }
        await waitUntil { h.server.requestCount == 2 }            // the refresh is in flight
        await h.session.clear()                                   // sign-out: local session and cookie go
        h.cookies.clear(host: h.server.host)
        hold.release()
        let outcome = await refresh.value
        #expect(outcome.session == nil)
        #expect(await h.session.accessToken() == nil)
        #expect(h.secrets.get("refresh.\(h.server.host)") == nil)  // the rotated cookie was not kept
    }

    @Test func aRejectedRefreshAnsweringAfterSignInKeepsTheNewSession() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        let hold = StubHold()
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))    // the heartbeat
        var rejected = StubResponse.json(401, #"{"detail":{"code":"invalid_token"}}"#)
        rejected.hold = hold
        h.server.enqueue(rejected)                                                // its refresh, held
        let call = Task { try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        await waitUntil { h.server.requestCount == 3 }            // login, heartbeat, refresh in flight
        h.secrets.set("refresh.\(h.server.host)", "r9")           // someone signs in meanwhile
        var fresh = try KioskJSON.decoder.decode(SessionData.self, from: Data(sessionJSON.utf8))
        fresh.accessToken = "tok9"
        await h.session.store(fresh)
        hold.release()
        _ = try? await call.value
        // notifySessionEnded (the only thing that yields sessionEnded) would have cleared the token.
        #expect(await h.session.accessToken() == "tok9")
        #expect(h.cookies.value(forHost: h.server.host) == "r9")
    }
}
