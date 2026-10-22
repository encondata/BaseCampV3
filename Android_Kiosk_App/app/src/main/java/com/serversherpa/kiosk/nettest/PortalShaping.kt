package com.serversherpa.kiosk.nettest

import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.Random
import java.util.WeakHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.BufferedSink
import okio.BufferedSource

/**
 * Bytes are paced in batches of whole segments. Drops still fall per segment
 * (the shaper splits each batch into [SEGMENT_BYTES] chunks), and the speed
 * cost adds up across the batch. Pacing one segment per call would round each
 * segment's cost to whole milliseconds, which erases the limit at Wi-Fi and LTE
 * speeds (a segment costs under half a millisecond there).
 */
internal const val PACE_BATCH_BYTES = SEGMENT_BYTES * 64

/**
 * The Internet path while Internet Test is on: a copy of the app's own client
 * ([base]) with the same cookie jar, timeouts and dispatcher, but its own
 * connection pool (so conditioned connections never mix with normal ones), a
 * slow DNS, and a network interceptor that adds the link's conditions.
 *
 * [profile] is read when a call starts, so a call made after the switch went
 * off passes straight through. [random] and [sleeper] drive the shaper.
 */
internal class ConditionedPortal(
    base: OkHttpClient,
    profile: () -> LinkProfile?,
    random: () -> Random,
    sleeper: Sleeper,
) {
    val client: OkHttpClient = base.newBuilder()
        .connectionPool(ConnectionPool())
        .dns(DelayedDns(base.dns, profile, sleeper))
        .addNetworkInterceptor(LinkInterceptor(profile, random, sleeper))
        .build()

    /** Closes the idle conditioned connections (calls still in flight keep theirs). */
    fun evict() = client.connectionPool.evictAll()
}

/**
 * Adds the DNS delay to each host-name lookup, then asks [delegate] (the
 * original client's DNS). A lookup only happens for a new connection, before
 * the network interceptor runs, so the profile is read once, here.
 */
internal class DelayedDns(
    private val delegate: Dns,
    private val profile: () -> LinkProfile?,
    private val sleeper: Sleeper,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val delayMs = profile()?.dnsDelayMs ?: 0
        if (delayMs > 0) interruptibly { sleeper.sleep(delayMs.toLong()) }
        return delegate.lookup(hostname)
    }
}

/**
 * The link's conditions on one network exchange (design 4.4). The profile is
 * captured once at the start, so switching the tool mid-call never changes a
 * call already under way.
 *
 * A new connection pays the handshake before it carries anything. Then the
 * request pays the upload delay, its line and headers take one segment's chance
 * of a drop, and its body is paced up the link. The response pays the download
 * delay, its status and headers take one segment's chance of a drop, and its
 * whole body is read and paced down here, on OkHttp's thread, so the caller
 * gets a body that's already in memory. So under 100% Loss nothing gets
 * through, even a bodiless request or an empty response.
 *
 * A stall that outlasts the call's own timeout fails it the way a dead link
 * would, with a [SocketTimeoutException].
 */
internal class LinkInterceptor(
    private val profile: () -> LinkProfile?,
    private val random: () -> Random,
    private val sleeper: Sleeper,
) : Interceptor {
    /**
     * Each connection's handshake, started by the first exchange on it. Weak,
     * so a long-lived process doesn't keep dead connections. Guarded by itself.
     */
    private val handshakes = WeakHashMap<Connection, Handshake>()

    override fun intercept(chain: Interceptor.Chain): Response {
        val link = profile() ?: return chain.proceed(chain.request())
        val shaper = LinkShaper(link, random(), sleeper)

        chain.connection()?.let { handshake(it, shaper, chain.connectTimeoutMillis().orNoLimit()) }

        interruptibly { shaper.sendBurst() }
        val writeTimeoutMs = chain.writeTimeoutMillis().orNoLimit()
        if (!interruptibly { shaper.paceUp(1, writeTimeoutMs) }) throw SocketTimeoutException("timeout")
        val request = chain.request()
        val body = request.body
        val paced = if (body == null || body.isDuplex()) {
            request
        } else {
            request.newBuilder()
                .method(request.method, PacedRequestBody(body) { bytes -> shaper.paceUp(bytes, writeTimeoutMs) })
                .build()
        }

        val response = chain.proceed(paced)
        try {
            interruptibly { shaper.receiveBurst() }
            val readTimeoutMs = chain.readTimeoutMillis().orNoLimit()
            if (!interruptibly { shaper.paceDown(1, readTimeoutMs) }) throw SocketTimeoutException("timeout")
            val original = response.body ?: return response
            val contentType: MediaType? = original.contentType()
            val bytes = readPaced(original.source(), readTimeoutMs, shaper)
            original.close()
            return response.newBuilder().body(bytes.asResponseBody(contentType, bytes.size)).build()
        } catch (e: Throwable) {
            response.body?.close()
            throw e
        }
    }

    /**
     * Holds the exchange until [connection]'s handshake has succeeded. The first
     * exchange on a connection runs it; any exchange that joins the same
     * connection meanwhile (HTTP/2 multiplexes) waits for that outcome, up to
     * its own [timeoutMs]. A failed or interrupted handshake closes the socket,
     * so OkHttp retires the connection on HTTP/1.1 and HTTP/2 alike, and every
     * exchange on it fails as a connect timeout.
     */
    private fun handshake(connection: Connection, shaper: LinkShaper, timeoutMs: Long) {
        var mine = false
        val handshake = synchronized(handshakes) {
            handshakes.getOrPut(connection) {
                mine = true
                Handshake()
            }
        }
        val connected = if (mine) {
            var ok = false
            try {
                ok = interruptibly { shaper.connect(timeoutMs) }
            } finally {
                handshake.finish(ok)
                if (!ok) retire(connection)
            }
            ok
        } else {
            interruptibly { handshake.await(timeoutMs) }
        }
        if (!connected) throw SocketTimeoutException("connect timed out")
    }

    /** Reads the whole body off the connection, pacing each batch down the link. */
    private fun readPaced(source: BufferedSource, timeoutMs: Long, shaper: LinkShaper): Buffer {
        val bytes = Buffer()
        while (!source.exhausted()) {
            source.request(PACE_BATCH_BYTES.toLong())
            val batch = minOf(source.buffer.size, PACE_BATCH_BYTES.toLong())
            if (!interruptibly { shaper.paceDown(batch.toInt(), timeoutMs) }) throw SocketTimeoutException("timeout")
            bytes.write(source.buffer, batch)
        }
        return bytes
    }
}

/** One connection's handshake outcome, shared by every exchange on that connection. */
private class Handshake {
    private val finished = CountDownLatch(1)

    @Volatile private var succeeded = false

    fun finish(ok: Boolean) {
        succeeded = ok
        finished.countDown()
    }

    /** True once the handshake has succeeded; false if it failed, or hasn't finished within [timeoutMs]. */
    fun await(timeoutMs: Long): Boolean = finished.await(timeoutMs, TimeUnit.MILLISECONDS) && succeeded
}

/** Closes [connection]'s socket. OkHttp then never hands that connection out again. */
private fun retire(connection: Connection) {
    try {
        connection.socket().close()
    } catch (e: IOException) {
        // Already closed: nothing more to do.
    }
}

/**
 * A request body sent up the link at the link's pace. The original is written
 * into memory once (so a one-shot body is only ever read once), and each
 * writeTo sends a copy of those bytes, a batch at a time. The content type and
 * length are the original's.
 */
private class PacedRequestBody(
    private val original: RequestBody,
    private val pace: (bytes: Int) -> Boolean,
) : RequestBody() {
    private var buffered: Buffer? = null

    override fun contentType(): MediaType? = original.contentType()

    override fun contentLength(): Long = original.contentLength()

    override fun isOneShot(): Boolean = original.isOneShot()

    override fun writeTo(sink: BufferedSink) {
        val pending = bytesOnce().copy()
        while (!pending.exhausted()) {
            val batch = minOf(pending.size, PACE_BATCH_BYTES.toLong())
            if (!interruptibly { pace(batch.toInt()) }) throw SocketTimeoutException("timeout")
            sink.write(pending, batch)
            sink.flush()
        }
    }

    @Synchronized private fun bytesOnce(): Buffer =
        buffered ?: Buffer().also {
            original.writeTo(it)
            buffered = it
        }
}

/** OkHttp reports "no timeout" as 0, which the shaper would read as "out of time". */
private fun Int.orNoLimit(): Long = if (this == 0) Long.MAX_VALUE else toLong()

/**
 * Runs a shaper sleep. An interrupted sleep becomes an [InterruptedIOException]
 * (an I/O failure OkHttp handles) with the thread's interrupt flag restored.
 */
private inline fun <T> interruptibly(block: () -> T): T =
    try {
        block()
    } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        throw InterruptedIOException("interrupted").apply { initCause(e) }
    }
