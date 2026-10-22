package com.serversherpa.kiosk.nettest

import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.Random
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.logging.Level
import java.util.logging.Logger
import kotlin.concurrent.thread
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The Internet path against a real (local) server: the router hands out the
 * original client while the switch is off, and a conditioned copy of it while
 * it's on. The conditioned copy really sleeps (ThreadSleeper), so these tests
 * measure wall-clock time, with lower bounds that sleeping guarantees and
 * upper bounds left generous.
 */
class PortalShapingTest {
    /** A cookie jar of its own, so sharing it can be checked by identity. */
    private class Jar : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = Unit
        override fun loadForRequest(url: HttpUrl): List<Cookie> = emptyList()
    }

    /**
     * Plays back a fixed list of drop decisions (a drop happens when the draw
     * is below the drop chance). Drawing more than was scripted fails the call.
     */
    private class ScriptedRandom(private vararg val draws: Double) : Random() {
        private var used = 0

        @Synchronized override fun nextDouble(): Double {
            check(used < draws.size) { "drew more than the ${draws.size} scripted values" }
            return draws[used++]
        }
    }

    /** Really sleeps, and notes each sleep, and lets a test wait for the first one to start. */
    private class WatchedSleeper : Sleeper {
        val started = CountDownLatch(1)
        val calls: MutableList<Long> = Collections.synchronizedList(mutableListOf())

        override fun sleep(ms: Long) {
            calls += ms
            started.countDown()
            ThreadSleeper.sleep(ms)
        }
    }

    private val server = MockWebServer()
    private lateinit var base: OkHttpClient

    // Held, so the level set on it isn't lost to garbage collection.
    private val serverLog: Logger = Logger.getLogger(MockWebServer::class.java.name)
    private val serverLogLevel: Level? = serverLog.level

    /** For a test where a connection opens but, by design, never sends a request: MockWebServer warns about those. */
    private fun expectConnectionsWithoutRequests() {
        serverLog.level = Level.SEVERE
    }

    @Before fun setUp() {
        server.start()
        // Short, and different from OkHttp's 10 s defaults, so sharing them is checkable.
        base = OkHttpClient.Builder()
            .cookieJar(Jar())
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    @After fun tearDown() {
        InternetTestRoutes.resetForTests()
        base.connectionPool.evictAll()
        server.shutdown()
        serverLog.level = serverLogLevel
    }

    private fun get(client: OkHttpClient, url: HttpUrl = server.url("/")): String =
        client.newCall(Request.Builder().url(url).build()).execute().use { it.body!!.string() }

    private inline fun elapsedMs(block: () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000
    }

    private fun ok(body: String = "ok") = MockResponse().setBody(body)

    @Test fun offReturnsTheSameClient() {
        InternetTestRoutes.internet = null

        assertSame(base, InternetTestRoutes.portal(base))
    }

    @Test fun onReturnsDerivedClientSharingCookiesAndTimeouts() {
        InternetTestRoutes.internet = LinkProfile(downDelayMs = 1)

        val conditioned = InternetTestRoutes.portal(base)

        assertNotSame(base, conditioned)
        assertSame(base.cookieJar, conditioned.cookieJar)
        assertEquals(base.connectTimeoutMillis, conditioned.connectTimeoutMillis)
        assertEquals(base.readTimeoutMillis, conditioned.readTimeoutMillis)
        assertEquals(base.writeTimeoutMillis, conditioned.writeTimeoutMillis)
        assertNotSame("conditioned connections never mix with normal ones", base.connectionPool, conditioned.connectionPool)
        assertSame("cached", conditioned, InternetTestRoutes.portal(base))

        val other = OkHttpClient.Builder().cookieJar(Jar()).build()
        val otherConditioned = InternetTestRoutes.portal(other)
        assertNotSame("a different original gets its own conditioned client", conditioned, otherConditioned)
        assertSame(other.cookieJar, otherConditioned.cookieJar)
    }

    @Test fun delayIsMeasurable() {
        repeat(3) { server.enqueue(ok()) }
        InternetTestRoutes.internet = LinkProfile(downDelayMs = 300, upDelayMs = 300)
        val conditioned = InternetTestRoutes.portal(base)

        val first = elapsedMs { assertEquals("ok", get(conditioned)) }
        val second = elapsedMs { assertEquals("ok", get(conditioned)) }
        val direct = elapsedMs { assertEquals("ok", get(base)) }

        assertTrue("first call: a 600 ms handshake, then 300 up and 300 down, took $first", first >= 1_200)
        assertTrue("pooled call: 300 up and 300 down, took $second", second >= 600)
        assertTrue("pooled call doesn't pay the handshake again, took $second", second < 1_200)
        assertTrue("the original client isn't slowed, took $direct", direct < 300)
    }

    @Test fun bodyIsAlreadyRead() {
        val payload = "0123456789".repeat(5_000)
        // Throttled, so the body is still streaming when execute() returns
        // unless the conditioned path has already read all of it.
        server.enqueue(ok(payload).throttleBody(5_000, 50, TimeUnit.MILLISECONDS))
        InternetTestRoutes.internet = LinkProfile(downDelayMs = 1)

        val response = InternetTestRoutes.portal(base).newCall(Request.Builder().url(server.url("/big")).build()).execute()
        server.shutdown()
        val text = response.use { it.body!!.string() }

        assertEquals(50_000, text.length)
        assertEquals(payload, text)
    }

    @Test fun fastSpeedsStillCount() {
        // Under half a millisecond per segment at 40 Mbps: paced one segment at
        // a time, each cost would round away to nothing.
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(1_000_000))))
        InternetTestRoutes.internet = Preset.WIFI.profile

        var size = 0
        val took = elapsedMs {
            InternetTestRoutes.portal(base).newCall(Request.Builder().url(server.url("/wifi")).build()).execute()
                .use { size = it.body!!.bytes().size }
        }

        assertEquals(1_000_000, size)
        assertTrue("1,000,000 bytes at 40,000 kbps is 200 ms, took $took", took >= 190)
    }

    @Test fun totalLossTimesOutNotInstantly() {
        expectConnectionsWithoutRequests()
        server.enqueue(ok())
        val oneSecondConnect = base.newBuilder().connectTimeout(1, TimeUnit.SECONDS).build()
        InternetTestRoutes.internet = Preset.LOSS_100.profile

        var error: SocketTimeoutException? = null
        val took = elapsedMs {
            error = assertThrows(SocketTimeoutException::class.java) { get(InternetTestRoutes.portal(oneSecondConnect)) }
        }

        assertEquals("connect timed out", error?.message)
        assertTrue("hangs until the client's own connect timeout, took $took", took >= 1_000)
        assertTrue("ends at the connect timeout, not the 4 s read timeout, took $took", took < 3_000)
        assertEquals("nothing reached the server", 0, server.requestCount)
    }

    @Test fun uploadPaced() {
        server.enqueue(ok())
        val payload = ByteArray(10 * 1024) { (it % 251).toByte() }
        InternetTestRoutes.internet = LinkProfile(upKbps = 80)
        val request = Request.Builder()
            .url(server.url("/up"))
            .post(payload.toRequestBody("application/octet-stream".toMediaType()))
            .build()

        val took = elapsedMs {
            InternetTestRoutes.portal(base).newCall(request).execute().use { assertEquals("ok", it.body!!.string()) }
        }

        assertTrue("10,240 bytes at 80 kbps is 1,024 ms, took $took", took >= 1_000)
        val received = server.takeRequest()
        assertArrayEquals(payload, received.body.readByteArray())
        assertEquals("application/octet-stream", received.getHeader("Content-Type"))
        assertEquals("the original length is kept", "10240", received.getHeader("Content-Length"))
    }

    @Test fun inFlightKeepsItsConditions() {
        repeat(2) { server.enqueue(ok()) }
        val sleeper = WatchedSleeper()
        InternetTestRoutes.sleeper = sleeper
        InternetTestRoutes.internet = LinkProfile(downDelayMs = 500)
        val conditioned = InternetTestRoutes.portal(base)

        var took = -1L
        var failure: Throwable? = null
        val call = thread {
            try {
                took = elapsedMs { get(conditioned) }
            } catch (t: Throwable) {
                failure = t
            }
        }
        assertTrue("the call reached its handshake", sleeper.started.await(5, TimeUnit.SECONDS))
        InternetTestRoutes.internet = null
        call.join(10_000)

        assertFalse(call.isAlive)
        assertNull(failure)
        assertTrue("a 500 ms handshake and a 500 ms response wait, as it started, took $took", took >= 1_000)
        assertSame("the next call goes direct", base, InternetTestRoutes.portal(base))

        // A call that already holds the conditioned client but starts after the
        // switch went off passes through untouched.
        sleeper.calls.clear()
        assertEquals("ok", get(conditioned))
        assertEquals(emptyList<Long>(), sleeper.calls.toList())

        assertEquals(1, conditioned.connectionPool.connectionCount())
        InternetTestRoutes.evictPortal()
        assertEquals(0, conditioned.connectionPool.connectionCount())
    }

    @Test fun dnsDelayApplied() {
        repeat(2) { server.enqueue(ok()) }
        InternetTestRoutes.internet = LinkProfile(dnsDelayMs = 300)
        val conditioned = InternetTestRoutes.portal(base)
        // A host name, not an address, so DNS is consulted for the new connection.
        val url = "http://localhost:${server.port}/dns".toHttpUrl()

        val first = elapsedMs { assertEquals("ok", get(conditioned, url)) }
        val second = elapsedMs { assertEquals("ok", get(conditioned, url)) }

        assertTrue("a new connection looks the host up slowly, took $first", first >= 300)
        assertTrue("a pooled connection doesn't look it up again, took $second", second < 300)
    }

    @Test fun noTimeoutMeansWaitNotFail() {
        server.enqueue(ok())
        // OkHttp reads 0 as "no timeout". Each drop below stalls; none may fail at once.
        val noTimeouts = OkHttpClient.Builder()
            .connectTimeout(0, TimeUnit.MILLISECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(10, TimeUnit.SECONDS)
            .build()
        InternetTestRoutes.random = ScriptedRandom(
            0.0, 0.99, // handshake: lost once (a 1 s retry), then through
            0.0, 0.99, // the upload's one chunk: dropped once (a 200 ms stall), then through
            0.0, 0.99, // the download's one chunk: the same
        )
        InternetTestRoutes.internet = LinkProfile(downDropPct = 50.0, upDropPct = 50.0)
        val request = Request.Builder().url(server.url("/none")).post("hi".toRequestBody()).build()

        val took = elapsedMs {
            InternetTestRoutes.portal(noTimeouts).newCall(request).execute().use { assertEquals("ok", it.body!!.string()) }
        }

        assertTrue("1 s + 200 ms + 200 ms of stalls, took $took", took >= 1_400)
        assertEquals("hi", server.takeRequest().body.readUtf8())
        noTimeouts.connectionPool.evictAll()
    }

    @Test fun interruptedSleepIsAnIoFailure() {
        expectConnectionsWithoutRequests()
        server.enqueue(ok())
        val sleeper = WatchedSleeper()
        InternetTestRoutes.sleeper = sleeper
        InternetTestRoutes.internet = LinkProfile(downDelayMs = 2_000)
        val conditioned = InternetTestRoutes.portal(base)

        var failure: Throwable? = null
        var stillInterrupted = false
        val call = thread {
            try {
                get(conditioned)
            } catch (t: Throwable) {
                failure = t
                stillInterrupted = Thread.currentThread().isInterrupted
            }
        }
        assertTrue("the call reached its handshake", sleeper.started.await(5, TimeUnit.SECONDS))
        val took = elapsedMs {
            call.interrupt()
            call.join(5_000)
        }

        assertFalse(call.isAlive)
        assertTrue("ends soon after the interrupt, took $took", took < 1_000)
        val error = failure
        assertTrue("an I/O failure OkHttp understands, got $error", error is InterruptedIOException && error !is SocketTimeoutException)
        assertTrue("the interrupt flag is restored", stillInterrupted)
    }
}
