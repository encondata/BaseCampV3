package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.PairStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OkHttpKioskApiAuthTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun loginSendsClientKioskAndStoresSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            val s = h.api.login("a@b.c", "pw")
            assertEquals("tok1", s.access_token)
            val req = h.server.takeRequest()
            assertEquals("/auth/login", req.path)
            assertTrue(req.body.readUtf8().contains("\"client\":\"kiosk\""))
            assertEquals("tok1", h.session.accessToken())
        }
    }

    @Test fun errorCodesComeFromDetail() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"kiosk_not_allowed"}}"""))
            try { h.api.login("a@b.c", "pw"); fail("expected ApiError") } catch (e: ApiError) {
                assertEquals(403, e.status); assertEquals("kiosk_not_allowed", e.code)
            }
            h.server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
            try { h.api.login("a@b.c", "pw"); fail() } catch (e: ApiError) { assertEquals("unknown_error", e.code) }
        }
    }

    @Test fun networkFailureIsApiErrorNetwork() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.shutdown()
            try { h.api.systemStatus(); fail() } catch (e: ApiError) { assertEquals(0, e.status); assertEquals("network", e.code) }
        }
    }

    @Test fun authedCallRefreshesOnceOn401AndRetries() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw")
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"token_expired"}}"""))
            h.server.enqueue(sessionResponse(cookie = null, token = "tok2"))
            h.server.enqueue(jsonResponse(200, """{"device_id":"d1","name":"Kiosk","registration":"ok","token_expires_at":null}"""))
            val r = h.api.heartbeat(HeartbeatIn(serial = "s", name = "Kiosk"))
            assertEquals("ok", r.registration)
            h.server.takeRequest()
            assertEquals("Bearer tok1", h.server.takeRequest().getHeader("Authorization"))
            assertEquals("/auth/refresh", h.server.takeRequest().path)
            assertEquals("Bearer tok2", h.server.takeRequest().getHeader("Authorization"))
        }
    }

    @Test fun secondFailureEndsTheSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw")
            var ended = false
            val collector = launch { h.session.sessionEnded.first(); ended = true }
            kotlinx.coroutines.yield()   // let the collector subscribe before the emit
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"token_expired"}}"""))
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"invalid_token"}}"""))   // refresh fails
            try { h.api.heartbeat(HeartbeatIn(serial = "s", name = "Kiosk")); fail() } catch (e: ApiError) {
                assertEquals(401, e.status)
                assertEquals("token_expired", e.code)
            }
            collector.join()
            assertTrue(ended)
        }
    }

    @Test fun pairPollMapsStatusesAnd404ToExpired() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(200, """{"status":"pending","session":null}"""))
            assertEquals(PairStatus.PENDING, h.api.pollPair("ABCD1234", "pt").status)
            h.server.enqueue(sessionResponse().setBody("""{"status":"approved","session":$SESSION_JSON}"""))
            val approved = h.api.pollPair("ABCD1234", "pt")
            assertEquals(PairStatus.APPROVED, approved.status)
            assertEquals("tok1", h.session.accessToken())
            h.server.enqueue(jsonResponse(404, """{"detail":{"code":"not_found"}}"""))
            assertEquals(PairStatus.EXPIRED, h.api.pollPair("ABCD1234", "pt").status)
        }
    }

    @Test fun signOutNeverThrows() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.shutdown()
            h.api.signOut("serial")   // no exception
        }
    }
}
