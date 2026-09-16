package com.serversherpa.kiosk.data.api

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun refreshStoresTokenAndSendsTheCookie() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())                     // login sets the cookie
            h.api.login("a@b.c", "pw")
            h.server.enqueue(sessionResponse(cookie = null, token = "tok2"))
            val data = h.session.refresh()
            assertEquals("tok2", data?.access_token)
            assertEquals("tok2", h.session.accessToken())
            assertFalse(h.session.tokenIsStale())
            h.server.takeRequest()
            val refreshReq = h.server.takeRequest()
            assertEquals("/auth/refresh", refreshReq.path)
            assertEquals("POST", refreshReq.method)
            assertTrue(refreshReq.getHeader("Cookie")!!.contains("ss_refresh=r1"))
        }
    }

    @Test fun staleWithin30sOfExpiry() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            h.api.login("a@b.c", "pw")
            h.now += 900_000 - 31_000
            assertFalse(h.session.tokenIsStale())
            h.now += 2_000
            assertTrue(h.session.tokenIsStale())
        }
    }

    @Test fun failedRefreshClearsButNetworkErrorKeepsState() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            h.api.login("a@b.c", "pw")
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"invalid_token"}}"""))
            assertNull(h.session.refresh())
            assertNull(h.session.accessToken())
            h.server.enqueue(sessionResponse(cookie = null, token = "tok3")); h.session.refresh()
            h.server.shutdown()
            assertNull(h.session.refresh())
            assertEquals("tok3", h.session.accessToken())   // kept on a network hiccup
        }
    }

    @Test fun malformedRefreshBodyKeepsStateAndReturnsNull() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            h.api.login("a@b.c", "pw")
            h.server.enqueue(jsonResponse(200, "{not json"))
            assertNull(h.session.refresh())
            assertEquals("tok1", h.session.accessToken())
        }
    }

    @Test fun refreshIsSingleFlight() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse(cookie = null, token = "slow").setBodyDelay(300, TimeUnit.MILLISECONDS))
            val results = (1..5).map { async { h.session.refresh() } }.awaitAll()
            assertTrue(results.all { it?.access_token == "slow" })
            assertEquals(1, h.server.requestCount)
        }
    }
}
