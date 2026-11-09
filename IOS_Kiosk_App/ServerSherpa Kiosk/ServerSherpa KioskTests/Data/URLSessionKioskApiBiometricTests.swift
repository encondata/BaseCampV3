import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The `/kiosk/biometric/*` calls over the stub server (Android OkHttpKioskApiBiometricTest).
@Suite(.serialized, .timeLimit(.minutes(1)))
struct URLSessionKioskApiBiometricTests {
    private func signedIn() async throws -> ApiHarness {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        _ = try await h.api.login(email: "a@b.c", password: "pw")
        _ = h.server.takeRequest()
        return h
    }

    @Test func enrollChallengeIsAuthedAndReturnsTheNonce() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, #"{"nonce":"n1"}"#))
        #expect(try await h.api.biometricEnrollChallenge(serial: "s1") == "n1")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/biometric/enroll-challenge")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.bodyString == #"{"serial":"s1"}"#)
    }

    @Test func enrollSendsTheIosBody() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(200, #"{"key_id":"k1","security_level":"app_attest","renews_at":"2027-01-01T00:00:00Z"}"#))
        let out = try await h.api.biometricEnroll(BiometricIosEnrollIn(serial: "s1", nonce: "n", publicKey: "p", appAttestKeyId: "k", attestation: "a", signature: "g"))
        #expect(out == BiometricEnrollOut(keyId: "k1", securityLevel: "app_attest", renewsAt: "2027-01-01T00:00:00Z"))
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/biometric/enroll")
        #expect(req.header("Authorization") == "Bearer tok1")
        #expect(req.bodyString == #"{"app_attest_key_id":"k","attestation":"a","nonce":"n","platform":"ios","public_key":"p","serial":"s1","signature":"g"}"#)
    }

    @Test func enrollRefusalKeepsTheReason() async throws {
        let h = try await signedIn()
        h.server.enqueue(.json(422, #"{"detail":{"code":"attestation_failed","reason":"environment"}}"#))
        do {
            _ = try await h.api.biometricEnroll(BiometricIosEnrollIn(serial: "s1", nonce: "n", publicKey: "p", appAttestKeyId: "k", attestation: "a", signature: "g"))
            Issue.record("should throw")
        } catch let e as ApiError {
            #expect(e.status == 422); #expect(e.code == "attestation_failed"); #expect(e.detail["reason"] == "environment")
        }
    }

    @Test func aStaleEnrollNonceNeverSignsOut() async throws {
        let h = try await signedIn()
        let ended = LockedFlag(false)
        let watcher = Task { for await _ in h.session.sessionEnded { ended.value = true; break } }
        h.server.enqueue(.json(422, #"{"detail":{"code":"bad_enroll_nonce"}}"#))
        do {
            _ = try await h.api.biometricEnroll(BiometricIosEnrollIn(serial: "s1", nonce: "n", publicKey: "p", appAttestKeyId: "k", attestation: "a", signature: "g"))
            Issue.record("should throw")
        } catch let e as ApiError {
            #expect(e.code == "bad_enroll_nonce")
        }
        #expect(h.server.requests.count == 2)   // login + the one enroll call: no refresh, no retry
        #expect(await h.session.accessToken() == "tok1")
        watcher.cancel()
        #expect(!ended.value)
    }

    @Test func challengeNeedsNoSession() async throws {
        let h = ApiHarness()
        h.server.enqueue(.json(200, #"{"key_id":"k1","challenge":"c1","display_name":"Tina T","photo_url":"https://img/x.jpg","expired":true}"#))
        let out = try await h.api.biometricChallenge(serial: "s1")
        #expect(out == BiometricChallengeOut(keyId: "k1", challenge: "c1", displayName: "Tina T", photoUrl: "https://img/x.jpg", expired: true))
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/biometric/challenge")
        #expect(req.header("Authorization") == nil)
        #expect(req.bodyString == #"{"serial":"s1"}"#)

        h.server.enqueue(.json(200, #"{"key_id":"k2","challenge":"c2","display_name":"Ana","photo_url":null}"#))
        let bare = try await h.api.biometricChallenge(serial: "s1")
        #expect(bare.expired == false); #expect(bare.photoUrl == nil)
    }

    @Test func signInStoresTheSessionLikeLogin() async throws {
        let h = ApiHarness()
        h.server.enqueue(sessionResponse())
        let data = try await h.api.biometricSignIn(keyId: "k1", challenge: "c1", signature: "g1")
        #expect(data.accessToken == "tok1")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "POST"); #expect(req.path == "/kiosk/biometric/sign-in")
        #expect(req.header("Authorization") == nil)
        #expect(req.bodyString == #"{"challenge":"c1","key_id":"k1","signature":"g1"}"#)
        #expect(h.cookies.value(forHost: h.server.host) == "r1")
        #expect(await h.session.accessToken() == "tok1")
    }

    @Test func signInErrorsCarryTheirCode() async throws {
        let h = ApiHarness()
        h.server.enqueue(.json(403, #"{"detail":{"code":"biometric_expired"}}"#))
        do {
            _ = try await h.api.biometricSignIn(keyId: "k1", challenge: "c1", signature: "g1")
            Issue.record("should throw")
        } catch let e as ApiError {
            #expect(e.status == 403); #expect(e.code == "biometric_expired")
        }
        #expect(await h.session.accessToken() == nil)
    }

    @Test func forgetDeletesWithTheSerialInTheQuery() async throws {
        let h = try await signedIn()
        h.server.enqueue(StubResponse(status: 204))
        try await h.api.biometricForget(serial: "s1")
        let req = try #require(h.server.takeRequest())
        #expect(req.method == "DELETE"); #expect(req.path == "/kiosk/biometric?serial=s1")
        #expect(req.header("Authorization") == "Bearer tok1")
    }
}
