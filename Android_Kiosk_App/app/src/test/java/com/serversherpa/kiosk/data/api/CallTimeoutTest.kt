package com.serversherpa.kiosk.data.api

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The flow's 10 s read deadline is a `withTimeoutOrNull` around a client call. It only works if
 * cancelling the coroutine cancels the HTTP call: a blocking `execute()` kept the coroutine
 * waiting for the whole hang. Both clients share [executeCall].
 */
class CallTimeoutTest {
    @get:Rule val tmp = TemporaryFolder()

    private class Cancels : EventListener() {
        val cancelled = CountDownLatch(1)
        override fun canceled(call: Call) = cancelled.countDown()
    }

    private fun ApiHarness.clientWith(listener: EventListener): OkHttpClient =
        client.newBuilder().eventListener(listener).build()

    @Test fun aStationReadWhoseHeadersHangIsCancelledAtTheDeadline() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            val events = Cancels()
            val station = OkHttpStationApi(h.clientWith(events))
            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":false}""").setHeadersDelay(3, TimeUnit.SECONDS))
            val started = System.nanoTime()
            val result = withTimeoutOrNull(500) { station.status(h.creds, "s", "p", "UTC") }
            val tookMs = (System.nanoTime() - started) / 1_000_000
            assertNull(result)
            assertTrue("returned after $tookMs ms", tookMs < 2_000)
            assertTrue("the HTTP call was cancelled", events.cancelled.await(2, TimeUnit.SECONDS))
        }
    }

    @Test fun aSessionReadWhoseBodyTricklesIsCancelledAtTheDeadline() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            val events = Cancels()
            val api = OkHttpKioskApi(h.clientWith(events), h.config, h.session)
            // headers at once, then the body at 8 bytes a second (about 7 s in all): the read itself must be cut off
            h.server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                .setBody("""{"read_only":false,"read_only_message":"","banner":null}""").throttleBody(8, 1, TimeUnit.SECONDS))
            val started = System.nanoTime()
            val result = withTimeoutOrNull(500) { api.systemStatus() }
            val tookMs = (System.nanoTime() - started) / 1_000_000
            assertNull(result)
            assertTrue("returned after $tookMs ms", tookMs < 2_000)
            assertTrue("the HTTP call was cancelled", events.cancelled.await(2, TimeUnit.SECONDS))
        }
    }
}
