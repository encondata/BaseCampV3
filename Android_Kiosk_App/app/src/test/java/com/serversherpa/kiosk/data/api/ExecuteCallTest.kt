package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.BufferedSource
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class ExecuteCallTest {
    /** A body whose read fails with something other than an IOException (an OOM, say). */
    private class Exploding : ResponseBody() {
        override fun contentType(): MediaType? = null
        override fun contentLength() = -1L
        override fun source(): BufferedSource = throw IllegalStateException("boom")
    }

    @Test fun anyThrowableWhileReadingTheBodyResumesWithTheNetworkError() = runBlocking {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(Exploding()).build()
        }.build()
        try {
            withTimeout(5_000) { executeCall(client, Request.Builder().url("http://127.0.0.1:1/x").build()) }
            fail("expected ApiError")
        } catch (e: ApiError) {
            assertEquals(0, e.status)
            assertEquals("network", e.code)
        }
    }

    /** A few stuck heartbeat, outbox or sync calls must not queue a punch behind them. */
    @Test fun theSharedDispatcherAllowsSixteenCallsPerHost() {
        val d = kioskDispatcher()
        assertEquals(16, d.maxRequestsPerHost)
        assertEquals(16, d.maxRequests)
    }
}
