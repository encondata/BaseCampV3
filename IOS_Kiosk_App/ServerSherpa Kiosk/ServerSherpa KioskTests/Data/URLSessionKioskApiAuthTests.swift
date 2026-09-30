import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@Suite(.serialized, .timeLimit(.minutes(1)))
struct URLSessionKioskApiAuthTests {
    private func expectApiError(_ call: () async throws -> Void) async -> ApiError? {
        do {
            try await call()
            Issue.record("expected ApiError")
            return nil
        } catch let e as ApiError {
            return e
        } catch {
            Issue.record("expected ApiError, got \(error)")
            return nil
        }
    }

    @Test func loginSendsClientKioskAndStoresSession() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        let s = try await h.api.login(email: "a@b.c", password: "pw")
        #expect(s.accessToken == "tok1")
        let req = try #require(h.server.takeRequest())
        #expect(req.path == "/auth/login")
        #expect(req.bodyString.contains(#""client":"kiosk""#))
        #expect(req.header("Authorization") == nil)
        #expect(await h.session.accessToken() == "tok1")
    }

    @Test func loginCapturesTheRefreshCookieIntoTheSecretStore() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse(cookie: "ss_refresh=abc; Path=/auth; HttpOnly"))
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        #expect(h.secrets.get("refresh.\(h.server.host)") == "abc")
    }

    @Test func errorCodesComeFromDetail() async throws {
        let h = ApiHarness()
        h.server.enqueue(.json(403, #"{"detail":{"code":"kiosk_not_allowed"}}"#))
        let e1 = await expectApiError { _ = try await h.api.login(email: "a@b.c", password: "pw") }
        #expect(e1?.status == 403)
        #expect(e1?.code == "kiosk_not_allowed")
        h.server.enqueue(.text(500, "boom"))
        let e2 = await expectApiError { _ = try await h.api.login(email: "a@b.c", password: "pw") }
        #expect(e2?.code == "unknown_error")
    }

    @Test func networkFailureIsApiErrorNetwork() async throws {
        let h = ApiHarness()
        h.server.shutdown()
        let e = await expectApiError { _ = try await h.api.systemStatus() }
        #expect(e?.status == 0)
        #expect(e?.code == "network")
    }

    @Test func authedCallRefreshesOnceOn401AndRetries() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(sessionResponse(cookie: nil, token: "tok2"))
        h.server.enqueue(.json(200, #"{"device_id":"d1","name":"Kiosk","registration":"ok","token_expires_at":null}"#))
        let r = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk"))
        #expect(r.registration == "ok")
        _ = h.server.takeRequest()
        #expect(h.server.takeRequest()?.header("Authorization") == "Bearer tok1")
        #expect(h.server.takeRequest()?.path == "/auth/refresh")
        #expect(h.server.takeRequest()?.header("Authorization") == "Bearer tok2")
    }

    @Test func secondFailureEndsTheSession() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        var events = h.session.sessionEnded.makeAsyncIterator()
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(.json(401, #"{"detail":{"code":"invalid_token"}}"#))   // refresh fails
        let e = await expectApiError { _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        #expect(e?.status == 401)
        #expect(e?.code == "token_expired")
        let ended: Void? = await events.next()
        #expect(ended != nil)
    }

    @Test func secondUnauthorizedAfterASuccessfulRefreshEndsTheSession() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        var events = h.session.sessionEnded.makeAsyncIterator()
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(sessionResponse(cookie: nil, token: "tok2"))
        h.server.enqueue(.json(401, #"{"detail":{"code":"invalid_token"}}"#))
        let e = await expectApiError { _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        #expect(e?.status == 401)
        #expect(e?.code == "invalid_token")
        let ended: Void? = await events.next()
        #expect(ended != nil)
        #expect(h.server.requestCount == 4)                   // login, call, refresh, one retry
    }

    @Test func pairPollMapsStatusesAnd404ToExpired() async throws {
        let h = ApiHarness()
        h.server.enqueue(.json(200, #"{"status":"pending","session":null}"#))
        #expect(try await h.api.pollPair(code: "ABCD1234", pollToken: "pt").status == .pending)
        var approvedResponse = sessionResponse()
        approvedResponse.body = Data(#"{"status":"approved","session":\#(sessionJSON)}"#.utf8)
        h.server.enqueue(approvedResponse)
        let approved = try await h.api.pollPair(code: "ABCD1234", pollToken: "pt")
        #expect(approved.status == .approved)
        #expect(await h.session.accessToken() == "tok1")
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
        h.server.enqueue(.json(404, #"{"detail":{"code":"not_found"}}"#))
        #expect(try await h.api.pollPair(code: "ABCD1234", pollToken: "pt").status == .expired)
        let first = try #require(h.server.takeRequest())
        #expect(first.path == "/kiosk/pair/ABCD1234/poll")
        #expect(first.bodyString == #"{"poll_token":"pt"}"#)
    }

    @Test func signOutNeverThrows() async throws {
        let h = ApiHarness()
        h.server.shutdown()
        await h.api.signOut(serial: "serial")   // no exception
    }

    @Test func moveLoginPostsThePasswordWithoutABearerAndStoresTheSession() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(sessionResponse(cookie: "ss_refresh=m1; Path=/auth; HttpOnly", token: "move1"))
        let s = try await h.api.moveLogin(password: "hunter22")
        #expect(s.accessToken == "move1")
        _ = h.server.takeRequest()
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST")
        #expect(req.path == "/kiosk/move-login")
        #expect(req.bodyString == #"{"password":"hunter22"}"#)
        #expect(req.header("Authorization") == nil)
        #expect(await h.session.accessToken() == "move1")
        #expect(h.cookies.value(forHost: h.server.host) == "m1")
    }

    @Test func theCookieIsSentOnlyOnRefreshAndLogout() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.json(200, #"{"read_only":false}"#)); _ = try await h.api.systemStatus()
        h.server.enqueue(.json(200, #"{"initiatives":[],"scan_types":[]}"#)); _ = try await h.api.setupOptions()
        h.server.enqueue(sessionResponse(cookie: nil, token: "tok2")); _ = await h.session.refresh()
        h.server.enqueue(.json(204, ""))
        await h.api.logout()
        let withCookie = h.server.requests.filter { $0.header("Cookie") != nil }.map(\.path)
        #expect(withCookie == ["/auth/refresh", "/auth/logout"])
        #expect(h.server.requests.last?.header("Cookie") == "ss_refresh=r1")
        #expect(h.server.requests.last?.header("Authorization") == nil)
    }

    @Test func logoutClearsTheCookieAndSessionEvenOffline() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.shutdown()
        await h.api.logout()
        #expect(await h.session.accessToken() == nil)
        #expect(h.cookies.value(forHost: h.server.host) == nil)
    }

    @Test func aDifferentHostGetsNoCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        // Same secret store, but the API now points somewhere else.
        let other = StubServer()
        let urlSession = URLSessionKioskApi.makeSession(protocolClasses: [StubURLProtocol.self])
        let otherBase = other.baseURL
        let store = SessionStore(apiUrl: { otherBase }, cookies: h.cookies, session: urlSession)
        other.enqueue(.json(401, #"{"detail":{"code":"invalid_token"}}"#))
        _ = await store.refresh()
        #expect(other.takeRequest()?.header("Cookie") == nil)
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
    }

    @Test func systemStatusAndPairCreateSendNoBearer() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.json(200, #"{"read_only":true,"read_only_message":"Maintenance"}"#))
        #expect(try await h.api.systemStatus().readOnlyMessage == "Maintenance")
        h.server.enqueue(.json(200, #"{"code":"ABCD1234","poll_token":"pt","link_url":"https://x/p","expires_at":"2026-09-30T00:00:00Z"}"#))
        #expect(try await h.api.createPairRequest(serial: "kiosk-ios-1", name: "Kiosk 0001").pollToken == "pt")
        _ = h.server.takeRequest()
        let status = try #require(h.server.takeRequest())
        #expect(status.method == "GET"); #expect(status.path == "/system/status")
        #expect(status.header("Authorization") == nil)
        let pair = try #require(h.server.takeRequest())
        #expect(pair.method == "POST"); #expect(pair.path == "/kiosk/pair")
        #expect(pair.bodyString == #"{"name":"Kiosk 0001","serial":"kiosk-ios-1"}"#)
        #expect(pair.header("Authorization") == nil)
    }

    @Test func authed401ThenNetworkFailedRefreshEndsTheSessionButKeepsTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        var events = h.session.sessionEnded.makeAsyncIterator()
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(.fail())                               // the refresh never arrives
        _ = await expectApiError { _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        let ended: Void? = await events.next()
        #expect(ended != nil)
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
    }

    @Test func authed401ThenServerErrorRefreshKeepsTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        var events = h.session.sessionEnded.makeAsyncIterator()
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(.json(503, #"{"detail":{"code":"unavailable"}}"#))
        _ = await expectApiError { _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        let ended: Void? = await events.next()
        #expect(ended != nil)
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
    }

    @Test func authed401ThenRejectedRefreshDeletesTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(.json(401, #"{"detail":{"code":"invalid_token"}}"#))
        _ = await expectApiError { _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        #expect(h.cookies.value(forHost: h.server.host) == nil)
    }

    @Test func secondUnauthorizedAfterSuccessfulRefreshDeletesTheCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.json(401, #"{"detail":{"code":"token_expired"}}"#))
        h.server.enqueue(sessionResponse(cookie: "ss_refresh=r2; Path=/auth; HttpOnly", token: "tok2"))
        h.server.enqueue(.json(401, #"{"detail":{"code":"invalid_token"}}"#))
        _ = await expectApiError { _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk")) }
        #expect(h.cookies.value(forHost: h.server.host) == nil)
    }

    // MARK: redirects never carry credentials to another host

    @Test func refreshRedirectedToAnotherHostLeaksNoCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        let other = StubServer()
        other.enqueue(sessionResponse(cookie: nil, token: "tok2"))
        h.server.enqueue(.redirect(to: "\(other.baseURL)/auth/refresh"))
        _ = await h.session.refresh()
        let seen = try #require(other.takeRequest())
        #expect(seen.header("Cookie") == nil)
        #expect(seen.header("Authorization") == nil)
    }

    @Test func logoutRedirectedToAnotherHostLeaksNoCookie() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        let other = StubServer()
        other.enqueue(.json(200, "{}"))
        h.server.enqueue(.redirect(to: "\(other.baseURL)/auth/logout"))
        await h.api.logout()
        #expect(other.takeRequest()?.header("Cookie") == nil)
    }

    @Test func authedCallRedirectedToAnotherHostLeaksNoBearer() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        let other = StubServer()
        other.enqueue(.json(200, #"{"device_id":"d1","name":"Kiosk","registration":"ok","token_expires_at":null}"#))
        h.server.enqueue(.redirect(to: "\(other.baseURL)/kiosk/heartbeat"))
        _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk"))
        let seen = try #require(other.takeRequest())
        #expect(seen.header("Authorization") == nil)
        #expect(seen.header("Cookie") == nil)
    }

    @Test func sameHostRedirectKeepsTheBearer() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse()); _ = try await h.api.login(email: "a@b.c", password: "pw")
        h.server.enqueue(.redirect(to: "\(h.server.baseURL)/kiosk/heartbeat2"))
        h.server.enqueue(.json(200, #"{"device_id":"d1","name":"Kiosk","registration":"ok","token_expires_at":null}"#))
        _ = try await h.api.heartbeat(HeartbeatIn(serial: "s", name: "Kiosk"))
        _ = h.server.takeRequest()
        _ = h.server.takeRequest()
        let followed = try #require(h.server.takeRequest())
        #expect(followed.path == "/kiosk/heartbeat2")
        #expect(followed.header("Authorization") == "Bearer tok1")
    }
}
