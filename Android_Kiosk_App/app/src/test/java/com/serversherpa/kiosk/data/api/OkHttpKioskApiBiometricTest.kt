package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OkHttpKioskApiBiometricTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun body(raw: String) = KioskJson.parseToJsonElement(raw).jsonObject

    @Test fun enrollChallengeIsAuthedAndReturnsTheNonce() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw"); h.server.takeRequest()
            h.server.enqueue(jsonResponse(200, """{"nonce":"n.o.nce"}"""))
            assertEquals("n.o.nce", h.api.biometricEnrollChallenge("kiosk-android-1"))
            val req = h.server.takeRequest()
            assertEquals("/kiosk/biometric/enroll-challenge", req.path)
            assertEquals("POST", req.method)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))
            assertEquals("kiosk-android-1", body(req.body.readUtf8())["serial"]!!.jsonPrimitive.content)
        }
    }

    @Test fun enrollSendsSerialNonceAndChain() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw"); h.server.takeRequest()
            h.server.enqueue(jsonResponse(200, """{"key_id":"k1","security_level":"strongbox","renews_at":"2026-11-22T00:00:00Z"}"""))
            val out = h.api.biometricEnroll("s1", "n1", listOf("AAA=", "BBB="))
            assertEquals("k1", out.key_id)
            val req = h.server.takeRequest()
            assertEquals("/kiosk/biometric/enroll", req.path)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))
            val b = body(req.body.readUtf8())
            assertEquals("s1", b["serial"]!!.jsonPrimitive.content)
            assertEquals("n1", b["nonce"]!!.jsonPrimitive.content)
            assertEquals(listOf("AAA=", "BBB="), b["chain"]!!.jsonArray.map { it.jsonPrimitive.content })
        }
    }

    @Test fun enrollRefusalKeepsTheReason() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw")
            h.server.enqueue(jsonResponse(422, """{"detail":{"code":"attestation_failed","reason":"root"}}"""))
            try { h.api.biometricEnroll("s1", "n1", listOf("AAA=")); fail("expected ApiError") } catch (e: ApiError) {
                assertEquals("attestation_failed", e.code); assertEquals("root", e.detailString("reason"))
            }
        }
    }

    @Test fun challengeNeedsNoSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(200, """{"key_id":"k1","challenge":"c.h.al","display_name":"Tina T","photo_url":null,"expired":false}"""))
            val c = h.api.biometricChallenge("s1")
            assertEquals("k1", c.key_id); assertEquals("c.h.al", c.challenge); assertEquals("Tina T", c.display_name)
            assertNull(c.photo_url); assertEquals(false, c.expired)
            val req = h.server.takeRequest()
            assertEquals("/kiosk/biometric/challenge", req.path)
            assertNull(req.getHeader("Authorization"))
            assertEquals("s1", body(req.body.readUtf8())["serial"]!!.jsonPrimitive.content)
            h.server.enqueue(jsonResponse(404, """{"detail":{"code":"no_biometric"}}"""))
            try { h.api.biometricChallenge("s1"); fail() } catch (e: ApiError) { assertEquals("no_biometric", e.code) }
        }
    }

    @Test fun signInStoresTheSessionLikeLogin() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse(token = "bio1"))
            val s = h.api.biometricSignIn("k1", "c1", "c2ln")
            assertEquals("bio1", s.access_token)
            assertEquals("bio1", h.session.accessToken())
            val req = h.server.takeRequest()
            assertEquals("/kiosk/biometric/sign-in", req.path)
            assertNull(req.getHeader("Authorization"))
            val b = body(req.body.readUtf8())
            assertEquals("k1", b["key_id"]!!.jsonPrimitive.content)
            assertEquals("c1", b["challenge"]!!.jsonPrimitive.content)
            assertEquals("c2ln", b["signature"]!!.jsonPrimitive.content)
            // The refresh cookie the sign-in set is the one /auth/refresh sends.
            h.server.enqueue(sessionResponse(cookie = null, token = "bio2"))
            h.session.refresh()
            assertEquals("ss_refresh=r1", h.server.takeRequest().getHeader("Cookie"))
        }
    }

    @Test fun signInErrorsCarryTheirCode() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(429, """{"detail":{"code":"biometric_rate_limited"}}"""))
            try { h.api.biometricSignIn("k1", "c1", "sig"); fail() } catch (e: ApiError) {
                assertEquals(429, e.status); assertEquals("biometric_rate_limited", e.code)
            }
            assertNull(h.session.accessToken())
        }
    }

    @Test fun forgetDeletesWithTheSerialInTheQuery() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw"); h.server.takeRequest()
            h.server.enqueue(MockResponse().setResponseCode(204))
            h.api.biometricForget("kiosk android/1")
            val req = h.server.takeRequest()
            assertEquals("DELETE", req.method)
            assertEquals("/kiosk/biometric?serial=kiosk%20android%2F1", req.path)
            assertEquals("Bearer tok1", req.getHeader("Authorization"))
            h.server.enqueue(jsonResponse(423, """{"detail":{"code":"read_only_mode"}}"""))
            try { h.api.biometricForget("s1"); fail() } catch (e: ApiError) { assertEquals("read_only_mode", e.code) }
        }
    }

    @Test fun aStaleEnrollNonceNeverSignsOut() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw"); h.server.takeRequest()
            var ended = false
            val watcher = launch { h.session.sessionEnded.first(); ended = true }
            kotlinx.coroutines.yield()
            h.server.enqueue(jsonResponse(422, """{"detail":{"code":"bad_enroll_nonce"}}"""))
            try { h.api.biometricEnroll("s1", "stale", listOf("AAA=")); fail("expected ApiError") } catch (e: ApiError) {
                assertEquals(422, e.status); assertEquals("bad_enroll_nonce", e.code)
            }
            assertEquals("/kiosk/biometric/enroll", h.server.takeRequest().path)
            assertEquals(2, h.server.requestCount)          // no /auth/refresh, no retry
            assertEquals("tok1", h.session.accessToken())
            assertFalse(ended)
            watcher.cancel()
        }
    }
}
