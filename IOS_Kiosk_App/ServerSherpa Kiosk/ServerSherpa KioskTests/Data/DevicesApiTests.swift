import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The update check against the Devices site: a bearer call that never refreshes
/// on its answers and never ends the kiosk session (Devices verifies the token
/// with the main API, so its 401 says nothing about the session).
@Suite(.serialized, .timeLimit(.minutes(1)))
struct DevicesApiTests {
    private let query = UpdateQuery(bundleId: "Server-Sherpas.ServerSherpa-Kiosk", build: "1", profile: .adhoc)
    private let answerJSON = #"{"status":"available","version_name":"1.2.0","build":"7","notes":"Fixes","size":1234,"install_url":"itms-services://?action=download-manifest&url=https%3A%2F%2Fx"}"#

    private struct Harness {
        let api = ApiHarness()
        let devices = StubServer()
        let client: URLSessionDevicesApi

        init(devicesUrl: String?? = nil) {
            let base = devices.baseURL
            let url: String? = devicesUrl ?? base
            client = URLSessionDevicesApi(devicesUrl: { url },
                                          session: URLSessionKioskApi.makeSession(protocolClasses: [StubURLProtocol.self]),
                                          sessionStore: api.session)
        }

        func signIn() async throws {
            api.server.enqueue(sessionResponse())
            _ = try await api.api.login(email: "a@b.c", password: "pw")
            _ = api.server.takeRequest()
        }
    }

    @Test func sendsTheQueryWithTheBearer() async throws {
        let h = Harness()
        try await h.signIn()
        h.devices.enqueue(.json(200, answerJSON))
        let answer = try await h.client.checkUpdates(query)
        #expect(answer.status == "available")
        #expect(answer.versionName == "1.2.0")
        #expect(answer.build == "7")
        let req = try #require(h.devices.takeRequest())
        #expect(req.method == "GET")
        #expect(req.path == "/api/updates?platform=ios&bundle_id=Server-Sherpas.ServerSherpa-Kiosk&build=1&profile_kind=adhoc")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(h.api.server.takeRequest() == nil)
    }

    @Test func unauthorizedNeverEndsTheSession() async throws {
        let h = Harness()
        try await h.signIn()
        var events = h.api.session.sessionEnded.makeAsyncIterator()
        h.devices.enqueue(.json(401, #"{"detail":{"code":"unauthenticated","message":"Sign in to continue."}}"#))
        do {
            _ = try await h.client.checkUpdates(query)
            Issue.record("expected ApiError")
        } catch let e as ApiError {
            #expect(e.status == 401)
            #expect(e.code == "unauthenticated")
        }
        #expect(h.devices.requestCount == 1)                   // no retry
        #expect(h.api.server.takeRequest() == nil)                // no refresh
        #expect(await h.api.session.accessToken() == "tok1")
        let ended = await withTaskGroup(of: Bool.self) { group in
            group.addTask { await events.next() != nil }
            group.addTask { try? await Task.sleep(for: .milliseconds(300)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        #expect(!ended)
    }

    @Test func refreshesAStaleTokenFirst() async throws {
        let h = Harness()
        try await h.signIn()
        h.api.clock.now += 20 * 60 * 1000                      // past the 15-minute expiry
        h.api.server.enqueue(sessionResponse(cookie: nil, token: "tok2"))
        h.devices.enqueue(.json(200, answerJSON))
        _ = try await h.client.checkUpdates(query)
        #expect(h.api.server.takeRequest()?.path == "/auth/refresh")
        #expect(h.devices.takeRequest()?.header("Authorization") == "Bearer tok2")
    }

    @Test func noDevicesUrlThrows() async throws {
        let h = Harness(devicesUrl: .some(nil))
        try await h.signIn()
        do {
            _ = try await h.client.checkUpdates(query)
            Issue.record("expected noDevicesUrl")
        } catch {
            #expect(error as? DevicesApiError == .noDevicesUrl)
        }
        #expect(h.devices.requestCount == 0)
        #expect(h.api.server.takeRequest() == nil)
    }

    @Test func networkFailureIsApiNetwork() async throws {
        let h = Harness()
        try await h.signIn()
        h.devices.enqueue(.fail())
        do {
            _ = try await h.client.checkUpdates(query)
            Issue.record("expected ApiError")
        } catch {
            #expect(error as? ApiError == ApiError.network())
        }
    }
}
