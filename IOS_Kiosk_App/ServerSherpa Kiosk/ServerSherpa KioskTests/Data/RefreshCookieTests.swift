import Testing
import Foundation
@testable import ServerSherpa_Kiosk

struct RefreshCookieTests {
    private let api = URL(string: "https://api.dev.serversherpa.com/auth/login")!

    private func response(_ setCookie: String) -> HTTPURLResponse {
        HTTPURLResponse(url: api, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Set-Cookie": setCookie])!
    }

    @Test func persistsOnlyTheRefreshCookieAndKeysItByHost() {
        let secrets = MemorySecretStore()
        let cookie = RefreshCookie(secrets: secrets)
        cookie.capture(from: response("ss_refresh=abc; Path=/auth; HttpOnly; Secure, csrftoken=zzz; Path=/"), url: api)

        // A fresh instance over the same secrets still has the refresh cookie (persisted) but not the other one.
        let reloaded = RefreshCookie(secrets: secrets)
        #expect(reloaded.value(forHost: "api.dev.serversherpa.com") == "abc")
        #expect(secrets.get("refresh.api.dev.serversherpa.com") == "abc")
        #expect(secrets.get("csrftoken") == nil)
        // Other host: not sent.
        #expect(reloaded.value(forHost: "api.serversherpa.com") == nil)
    }

    @Test func clearForgetsIt() {
        let cookie = RefreshCookie(secrets: MemorySecretStore())
        cookie.capture(from: response("ss_refresh=abc; Path=/auth"), url: api)
        cookie.clear(host: "api.dev.serversherpa.com")
        #expect(cookie.value(forHost: "api.dev.serversherpa.com") == nil)
    }

    @Test func aResponseWithoutTheCookieLeavesTheStoredOne() {
        let cookie = RefreshCookie(secrets: MemorySecretStore())
        cookie.capture(from: response("ss_refresh=abc; Path=/auth"), url: api)
        cookie.capture(from: response("csrftoken=zzz; Path=/"), url: api)
        #expect(cookie.value(forHost: "api.dev.serversherpa.com") == "abc")
    }

    @Test func anExpiredOrEmptyCookieDeletesIt() {
        let cookie = RefreshCookie(secrets: MemorySecretStore())
        let host = "api.dev.serversherpa.com"
        cookie.capture(from: response("ss_refresh=abc; Path=/auth"), url: api)
        cookie.capture(from: response("ss_refresh=abc; Max-Age=0; Path=/auth"), url: api)
        #expect(cookie.value(forHost: host) == nil)

        cookie.capture(from: response("ss_refresh=abc; Path=/auth"), url: api)
        cookie.capture(from: response("ss_refresh=abc; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/auth"), url: api)
        #expect(cookie.value(forHost: host) == nil)

        cookie.capture(from: response("ss_refresh=abc; Path=/auth"), url: api)
        cookie.capture(from: response("ss_refresh=; Path=/auth"), url: api)
        #expect(cookie.value(forHost: host) == nil)
    }
}
