package com.serversherpa.kiosk.nettest

import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Random
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * The Local network path while Internet Test is on (design 4.5). Every socket
 * is opened by [delegate], the Wi-Fi or Ethernet network's own factory, so the
 * network binding is kept, and comes back wrapped in a [ConditionedSocket].
 * Each socket gets its own shaper and state; only [random] is shared, and
 * `java.util.Random` is thread-safe.
 *
 * The connecting overloads open the socket, then connect it through the
 * conditions with no time limit of their own, as a plain socket does. A host
 * name is looked up with the default resolver (printers are reached by
 * address, and the printer code never uses these overloads).
 */
internal class ConditionedSocketFactory(
    private val delegate: SocketFactory,
    private val profile: LinkProfile,
    private val random: Random,
    private val sleeper: Sleeper,
) : SocketFactory() {
    override fun createSocket(): Socket = ConditionedSocket(delegate.createSocket(), profile, random, sleeper)

    override fun createSocket(host: String?, port: Int): Socket =
        open(InetSocketAddress(InetAddress.getByName(host), port), null)

    override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
        open(InetSocketAddress(InetAddress.getByName(host), port), InetSocketAddress(localHost, localPort))

    override fun createSocket(host: InetAddress?, port: Int): Socket = open(InetSocketAddress(host, port), null)

    override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
        open(InetSocketAddress(address, port), InetSocketAddress(localAddress, localPort))

    private fun open(remote: InetSocketAddress, local: InetSocketAddress?): Socket {
        val inner = delegate.createSocket()
        val socket = ConditionedSocket(inner, profile, random, sleeper)
        try {
            if (local != null) inner.bind(local)
            socket.connect(remote)
        } catch (e: Throwable) {
            socket.closeQuietly()
            throw e
        }
        return socket
    }
}

/**
 * A printer connection under the link's conditions (design 4.4). It wraps
 * [inner], the socket the network's factory made, and every query and setting
 * goes to [inner]; this object's own (never connected) socket state plays no
 * part.
 *
 * - **Connecting** costs one round trip, and a lost handshake is retried the
 *   way TCP retries a SYN. A handshake that can't finish within the connect
 *   timeout fails with "connect timed out" and never reaches the printer, and
 *   the socket is closed after any failed or interrupted connect.
 * - **Bursts:** the first write after connecting or after a read costs the
 *   upload delay. The first read after connecting or after a write costs the
 *   download delay.
 * - **Pacing:** each write and read is paced up or down the link (one call for
 *   its byte count, in batches of [PACE_BATCH_BYTES]), so speed and drops apply
 *   to it. Every write or read that carries anything takes at least one
 *   segment's chance of a drop, including the end of the stream, so under 100%
 *   Loss nothing gets through. A zero-length write or read carries nothing and
 *   returns at once, as on a plain socket.
 * - **Timeouts:** a read keeps to the socket's soTimeout (0 means none). When
 *   its delay or drop stalls would pass it, the read fails with a
 *   [SocketTimeoutException] at soTimeout, as on a slow link. Bytes caught in a
 *   stall aren't lost: the next read delivers them (once they get through),
 *   and a delay cut short is finished by the next read. Writes have no timeout
 *   (a plain socket's don't either), so they wait until they get through, or
 *   until the printer code's watchdog closes the socket.
 * - **Closing** ends any wait at once with a [SocketException], and an
 *   interrupt ends one with an [InterruptedIOException], keeping the thread's
 *   interrupt flag.
 *
 * One thread reads and one writes at a time, as with any socket.
 */
internal class ConditionedSocket(
    private val inner: Socket,
    profile: LinkProfile,
    random: Random,
    sleeper: Sleeper,
) : Socket() {
    private val gate = SocketGate(sleeper)
    private val shaper = LinkShaper(profile, random, gate)
    private val downDelayMs = profile.downDelayMs.toLong()

    private enum class Turn { NONE, WRITE, READ }

    /** Which way the last message went, so a change of direction starts a burst. */
    @Volatile private var turn = Turn.NONE

    /** What is left of the current read burst's download delay. Reader only. */
    private var downDelayLeftMs = 0L

    /** Bytes taken off [inner] whose trip down the link stalled past a read's timeout. Reader only. */
    private var held: ByteArray? = null
    private var heldFrom = 0
    private var heldArrived = false

    private val streamLock = Any()
    private var input: InputStream? = null
    private var output: OutputStream? = null

    override fun connect(endpoint: SocketAddress?) = connect(endpoint, 0)

    override fun connect(endpoint: SocketAddress?, timeout: Int) {
        require(timeout >= 0) { "connect: timeout can't be negative" }
        require(endpoint is InetSocketAddress) { "Unsupported address type" }
        if (isClosed) throw SocketException("Socket is closed")
        if (isConnected) throw SocketException("already connected")
        if (endpoint.isUnresolved) throw UnknownHostException(endpoint.hostString)
        val started = System.nanoTime()
        try {
            if (!shaper.connect(noLimitIfZero(timeout))) throw SocketTimeoutException("connect timed out")
            // The real connect gets what the handshake left of the timeout (0 stays "no limit").
            val left = if (timeout == 0) 0 else (timeout - elapsedMs(started)).coerceIn(1L, timeout.toLong()).toInt()
            inner.connect(endpoint, left)
        } catch (e: Throwable) {
            closeQuietly()
            throw e
        }
    }

    override fun getInputStream(): InputStream {
        val raw = inner.getInputStream() // throws as a plain socket would: closed, unconnected, shut down
        return synchronized(streamLock) { input ?: Input(raw).also { input = it } }
    }

    override fun getOutputStream(): OutputStream {
        val raw = inner.getOutputStream()
        return synchronized(streamLock) { output ?: Output(raw).also { output = it } }
    }

    override fun getSoTimeout(): Int = inner.soTimeout

    override fun setSoTimeout(timeout: Int) {
        inner.soTimeout = timeout
    }

    override fun shutdownInput() = inner.shutdownInput()

    override fun shutdownOutput() = inner.shutdownOutput()

    override fun close() {
        gate.close()
        try {
            super.close() // never opened, unless someone set an option on it
        } catch (_: IOException) {
        }
        inner.close()
    }

    override fun isConnected(): Boolean = inner.isConnected

    override fun isClosed(): Boolean = inner.isClosed

    override fun isBound(): Boolean = inner.isBound

    override fun isInputShutdown(): Boolean = inner.isInputShutdown

    override fun isOutputShutdown(): Boolean = inner.isOutputShutdown

    override fun getInetAddress(): InetAddress? = inner.inetAddress

    override fun getPort(): Int = inner.port

    override fun getLocalAddress(): InetAddress? = inner.localAddress

    override fun getLocalPort(): Int = inner.localPort

    override fun getRemoteSocketAddress(): SocketAddress? = inner.remoteSocketAddress

    override fun getLocalSocketAddress(): SocketAddress? = inner.localSocketAddress

    override fun toString(): String = inner.toString()

    /** One write: its burst's upload delay if it starts one, then its bytes paced up, a batch at a time. */
    private fun send(raw: OutputStream, b: ByteArray, off: Int, len: Int) {
        if (turn != Turn.WRITE) {
            turn = Turn.WRITE
            shaper.sendBurst()
        }
        var from = off
        val end = off + len
        while (from < end) {
            val batch = minOf(end - from, PACE_BATCH_BYTES)
            if (!shaper.paceUp(batch, Long.MAX_VALUE)) throw SocketTimeoutException("Write timed out")
            raw.write(b, from, batch)
            from += batch
        }
    }

    /**
     * One read, all within soTimeout: what is left of its burst's download
     * delay, then bytes off [inner] (or the bytes an earlier read left held),
     * paced down. A timeout keeps what it cut short for the next read.
     */
    private fun receive(raw: InputStream, b: ByteArray, off: Int, len: Int): Int {
        val timeout = inner.soTimeout // throws once closed
        val limitMs = noLimitIfZero(timeout)
        val started = System.nanoTime()
        fun leftMs(): Long = if (timeout == 0) Long.MAX_VALUE else limitMs - elapsedMs(started)

        if (turn != Turn.READ) {
            turn = Turn.READ
            downDelayLeftMs = downDelayMs
        }
        if (downDelayLeftMs > 0) {
            val wait = minOf(downDelayLeftMs, limitMs)
            gate.sleep(wait)
            downDelayLeftMs -= wait
            if (downDelayLeftMs > 0) throw SocketTimeoutException("Read timed out")
        }

        held?.let { bytes -> return deliverHeld(bytes, b, off, len, leftMs()) }

        val n = readInner(raw, b, off, minOf(len, PACE_BATCH_BYTES), timeout, leftMs())
        if (!shaper.paceDown(maxOf(n, 1), leftMs())) {
            if (n > 0) {
                held = b.copyOfRange(off, off + n)
                heldFrom = 0
                heldArrived = false
            }
            throw SocketTimeoutException("Read timed out")
        }
        return n
    }

    /** Hands out held bytes, pacing them down first if they haven't made it yet. */
    private fun deliverHeld(bytes: ByteArray, b: ByteArray, off: Int, len: Int, leftMs: Long): Int {
        if (!heldArrived) {
            if (!shaper.paceDown(bytes.size - heldFrom, leftMs)) throw SocketTimeoutException("Read timed out")
            heldArrived = true
        }
        val n = minOf(len, bytes.size - heldFrom)
        System.arraycopy(bytes, heldFrom, b, off, n)
        heldFrom += n
        if (heldFrom == bytes.size) held = null
        return n
    }

    /** Reads off [inner], waiting no longer than [leftMs] of the configured [timeout] (0: no limit). */
    private fun readInner(raw: InputStream, b: ByteArray, off: Int, len: Int, timeout: Int, leftMs: Long): Int {
        if (timeout == 0) return raw.read(b, off, len)
        val bounded = leftMs.coerceIn(1L, timeout.toLong()).toInt()
        if (bounded == timeout) return raw.read(b, off, len)
        inner.soTimeout = bounded
        try {
            return raw.read(b, off, len)
        } finally {
            try {
                inner.soTimeout = timeout
            } catch (_: SocketException) {
                // Closed meanwhile: nothing to restore.
            }
        }
    }

    private inner class Input(private val raw: InputStream) : InputStream() {
        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            checkRange(b.size, off, len)
            return if (len == 0) 0 else receive(raw, b, off, len)
        }

        override fun close() = this@ConditionedSocket.close()
    }

    private inner class Output(private val raw: OutputStream) : OutputStream() {
        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

        override fun write(b: ByteArray, off: Int, len: Int) {
            checkRange(b.size, off, len)
            if (len > 0) send(raw, b, off, len)
        }

        override fun flush() = raw.flush()

        override fun close() = this@ConditionedSocket.close()
    }
}

/**
 * One socket's waits. [close] ends them all: a wait in progress fails at once
 * with "Socket closed", as a blocked read on a closed socket does, and so does
 * any wait after it. On the real clock ([ThreadSleeper]) a wait is a wait on a
 * latch that [close] opens. Any other sleeper (a test's) is called as is, and
 * a close during it is noticed when it returns. An interrupt ends a wait with
 * an [InterruptedIOException], keeping the thread's interrupt flag.
 */
private class SocketGate(private val clock: Sleeper) : Sleeper {
    private val closed = CountDownLatch(1)

    fun close() = closed.countDown()

    override fun sleep(ms: Long) {
        if (closed.count == 0L) throw SocketException("Socket closed")
        val cut = try {
            if (clock === ThreadSleeper) {
                closed.await(ms, TimeUnit.MILLISECONDS)
            } else {
                clock.sleep(ms)
                closed.count == 0L
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw InterruptedIOException("interrupted").apply { initCause(e) }
        }
        if (cut) throw SocketException("Socket closed")
    }
}

/** A socket timeout of 0 means none, which the shaper would read as "out of time". */
private fun noLimitIfZero(ms: Int): Long = if (ms == 0) Long.MAX_VALUE else ms.toLong()

private fun elapsedMs(since: Long): Long = (System.nanoTime() - since) / 1_000_000

private fun checkRange(size: Int, off: Int, len: Int) {
    if (off < 0 || len < 0 || len > size - off) throw IndexOutOfBoundsException("off $off, len $len, size $size")
}

private fun Socket.closeQuietly() {
    try {
        close()
    } catch (_: IOException) {
    }
}
