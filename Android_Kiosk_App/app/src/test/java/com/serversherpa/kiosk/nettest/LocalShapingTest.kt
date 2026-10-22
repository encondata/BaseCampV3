package com.serversherpa.kiosk.nettest

import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.data.printer.FoundPrinter
import com.serversherpa.kiosk.data.printer.NetworkZebra
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.printer.PrinterUnreachable
import com.serversherpa.kiosk.data.printer.ScanSubnet
import com.serversherpa.kiosk.data.printer.ZebraScanner
import com.serversherpa.kiosk.data.printer.ZebraTimeouts
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.Random
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.SocketFactory
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The Local network path: printer sockets through a conditioned factory. The
 * fake printer is a ServerSocket on 127.0.0.1, after NetworkZebraTest's own.
 * Tests that measure time really sleep (ThreadSleeper), with lower bounds that
 * sleeping guarantees and upper bounds left generous; tests that check which
 * waits happen record them instead of sleeping.
 */
class LocalShapingTest {
    /**
     * Answers each command it recognizes with its reply and keeps the
     * connection open, as a Zebra does. It can also send [greeting] the moment
     * it accepts a connection, and hang up right after ([hangUp]). Counts the
     * connections it accepts and records every byte each one sends.
     */
    private class FakePrinter(
        private val replies: Map<String, String> = emptyMap(),
        private val greeting: String = "",
        private val hangUp: Boolean = false,
    ) : AutoCloseable {
        val server = ServerSocket(0, 128, InetAddress.getLoopbackAddress())
        val port: Int get() = server.localPort
        val address: InetSocketAddress get() = InetSocketAddress(InetAddress.getLoopbackAddress(), port)
        val accepted = AtomicInteger(0)
        val connections = CopyOnWriteArrayList<ByteArray>()
        private val sockets = CopyOnWriteArrayList<Socket>()

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val s = try { server.accept() } catch (_: Exception) { break }
                    accepted.incrementAndGet()
                    sockets += s
                    thread(isDaemon = true) { serve(s) }
                }
            }
        }

        private fun serve(s: Socket) {
            val got = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            try {
                if (greeting.isNotEmpty()) {
                    s.getOutputStream().write(greeting.toByteArray(Charsets.ISO_8859_1))
                    s.getOutputStream().flush()
                }
                if (hangUp) return
                val input = s.getInputStream()
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    got.write(buf, 0, n)
                    val text = String(got.toByteArray(), Charsets.ISO_8859_1)
                    replies.entries.firstOrNull { text.endsWith(it.key) }?.let {
                        s.getOutputStream().write(it.value.toByteArray(Charsets.ISO_8859_1))
                        s.getOutputStream().flush()
                    }
                }
            } catch (_: Exception) {
            } finally {
                connections += got.toByteArray()
                s.close()
            }
        }

        /** Waits for [count] connections to finish and returns what each one sent. */
        fun received(count: Int = 1): List<ByteArray> {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (connections.size < count && System.nanoTime() < until) Thread.sleep(10)
            return connections.toList()
        }

        override fun close() {
            server.close()
            sockets.forEach { it.close() }
        }
    }

    /** Notes each wait instead of sleeping. */
    private class Recorder : Sleeper {
        val calls: MutableList<Long> = Collections.synchronizedList(mutableListOf())

        override fun sleep(ms: Long) {
            calls += ms
        }
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

    /** Runs [block] on a thread of its own; [ended] opens when it returns or throws. */
    private class Blocked(block: () -> Unit) {
        val ended = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()

        @Volatile var interruptFlagKept = false
        val worker: Thread = thread(isDaemon = true) {
            try {
                block()
            } catch (e: Throwable) {
                failure.set(e)
                interruptFlagKept = Thread.currentThread().isInterrupted
            } finally {
                ended.countDown()
            }
        }
    }

    private val fakes = ArrayList<FakePrinter>()
    private val sockets = ArrayList<Socket>()

    private fun fake(replies: Map<String, String> = emptyMap(), greeting: String = "", hangUp: Boolean = false) =
        FakePrinter(replies, greeting, hangUp).also { fakes += it }

    /** A plain socket already connected to [p]: wrapped, it skips the conditioned handshake. */
    private fun connectedTo(p: FakePrinter): Socket = Socket(InetAddress.getLoopbackAddress(), p.port).also { sockets += it }

    /** Waits until [n] bytes have reached this socket, so a single read takes them all. */
    private fun Socket.withBytesWaiting(n: Int): Socket = apply {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (getInputStream().available() < n && System.nanoTime() < until) Thread.sleep(5)
    }

    private fun conditioned(inner: Socket, profile: LinkProfile, random: Random = Random(), sleeper: Sleeper = ThreadSleeper) =
        ConditionedSocket(inner, profile, random, sleeper).also { sockets += it }

    @Before fun setUp() = InternetTestRoutes.resetForTests()

    @After fun tearDown() {
        InternetTestRoutes.resetForTests()
        sockets.forEach { it.close() }
        fakes.forEach { it.close() }
    }

    private inline fun elapsedMs(block: () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000
    }

    private val hi = "\u0002ZD421-300dpi,V93.21.38Z,12,8176KB\u0003\r\n"
    private val zd421 = HostId("ZD421-300dpi", "V93.21.38Z", 12, "8176KB", 300)

    // ── the route ──

    @Test fun offReturnsTheSameFactory() {
        val f = SocketFactory.getDefault()
        InternetTestRoutes.local = null

        assertSame(f, InternetTestRoutes.local(f))

        InternetTestRoutes.local = Preset.WIFI.profile
        assertNotSame(f, InternetTestRoutes.local(f))
    }

    @Test fun delegatesToTheGivenFactory() = runBlocking<Unit> {
        val p = fake(mapOf("~HI" to hi))
        val made = AtomicInteger(0)
        // Stands in for a Wi-Fi network's own (network-bound) factory.
        val spy = object : SocketFactory() {
            override fun createSocket(): Socket {
                made.incrementAndGet()
                return Socket()
            }
            override fun createSocket(host: String?, port: Int): Socket = throw AssertionError("connecting overload")
            override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
                throw AssertionError("connecting overload")
            override fun createSocket(host: InetAddress?, port: Int): Socket = throw AssertionError("connecting overload")
            override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
                throw AssertionError("connecting overload")
        }
        InternetTestRoutes.local = Preset.WIFI.profile

        assertEquals(zd421, NetworkZebra("127.0.0.1", p.port, socketFactory = spy).identify())
        assertEquals(1, made.get())
        assertEquals("~HI", String(p.received().single(), Charsets.US_ASCII))
    }

    @Test fun totalLossTripsPrinterTimeouts() {
        val p = fake(mapOf("~HI" to hi))
        // Warm up off the clock (class loading, the first IO thread), straight to the printer.
        runBlocking { NetworkZebra("127.0.0.1", p.port).identify() }
        p.received(1)
        InternetTestRoutes.local = Preset.LOSS_100.profile
        val z = NetworkZebra("127.0.0.1", p.port, ZebraTimeouts(connectMs = 300, totalMs = 500))

        val took = elapsedMs { assertThrows(PrinterUnreachable::class.java) { runBlocking { z.identify() } } }

        assertTrue("hung to the 300 ms connect timeout, took $took", took >= 300)
        assertTrue("ended at the connect timeout, took $took", took < 400)
        Thread.sleep(100)
        assertEquals("nothing reached the printer", 1, p.accepted.get())
    }

    @Test fun aSendStalledByLossEndsAtTheWatchdog() {
        val p = fake()
        // The handshake gets through (0.99), then every upload segment is dropped.
        InternetTestRoutes.random = object : Random() {
            private var first = true

            @Synchronized override fun nextDouble(): Double = if (first) 0.99.also { first = false } else 0.0
        }
        InternetTestRoutes.local = LinkProfile(upDropPct = 50.0)
        val z = NetworkZebra("127.0.0.1", p.port, ZebraTimeouts(connectMs = 200, sendMs = 300))

        val took = elapsedMs { assertThrows(PrinterTimeout::class.java) { runBlocking { z.send("^XA^XZ") } } }

        assertTrue("the session watchdog fires at 200 + 300 ms, took $took", took >= 500)
        assertTrue("it ends the stall at once, took $took", took < 1_000)
        assertArrayEquals("nothing reached the printer", ByteArray(0), p.received().single())
    }

    @Test fun theScanSeesNothingThroughTotalLoss() = runBlocking<Unit> {
        val p = fake(mapOf("~HI" to hi))
        val scanner = ZebraScanner(subnets = { listOf(ScanSubnet(listOf("127.0.0.1"))) }, port = p.port, identifyMs = 300)
        assertEquals(listOf(FoundPrinter("127.0.0.1", "ZD421-300dpi", null, 300)), scanner.scan())
        val before = p.accepted.get()

        InternetTestRoutes.local = Preset.LOSS_100.profile

        assertEquals(emptyList<FoundPrinter>(), scanner.scan())
        Thread.sleep(100)
        assertEquals("the probe never reached the printer", before, p.accepted.get())
    }

    // ── the socket ──

    @Test fun watchdogCloseUnblocksAStall() {
        val p = fake(greeting = "hello") // the bytes are already on their way
        val socket = conditioned(connectedTo(p), LinkProfile(downDelayMs = 10_000))

        val read = Blocked { socket.getInputStream().read(ByteArray(64)) }

        assertFalse("the read waits out the download delay", read.ended.await(300, TimeUnit.MILLISECONDS))
        socket.close()
        assertTrue("close() ends the stall within 100 ms", read.ended.await(100, TimeUnit.MILLISECONDS))
        assertTrue("it fails as an I/O error, got ${read.failure.get()}", read.failure.get() is IOException)
    }

    @Test fun closeEndsAConnectOrWriteStall() {
        val p = fake()
        InternetTestRoutes.local = Preset.LOSS_100.profile
        val connecting = InternetTestRoutes.local(SocketFactory.getDefault()).createSocket().also { sockets += it }
        val connect = Blocked { connecting.connect(p.address) } // no time limit of its own
        val writing = conditioned(connectedTo(p), Preset.LOSS_100.profile!!)
        val write = Blocked { writing.getOutputStream().write("^XA^XZ".toByteArray()) }

        assertFalse("the handshake hangs", connect.ended.await(300, TimeUnit.MILLISECONDS))
        assertFalse("the write hangs", write.ended.await(1, TimeUnit.MILLISECONDS))
        connecting.close()
        writing.close()

        assertTrue("close() ends the handshake", connect.ended.await(100, TimeUnit.MILLISECONDS))
        assertTrue("close() ends the write", write.ended.await(100, TimeUnit.MILLISECONDS))
        assertTrue(connect.failure.get() is IOException)
        assertTrue(write.failure.get() is IOException)
        assertArrayEquals("the write never reached the printer", ByteArray(0), p.received().single())
        assertEquals("only the plain socket connected", 1, p.accepted.get())
    }

    @Test fun anInterruptedStallIsAnInterruptedIOException() {
        val p = fake(greeting = "hello")
        val socket = conditioned(connectedTo(p), LinkProfile(downDelayMs = 10_000))
        val read = Blocked { socket.getInputStream().read(ByteArray(64)) }
        assertFalse(read.ended.await(200, TimeUnit.MILLISECONDS))

        read.worker.interrupt()

        assertTrue(read.ended.await(1, TimeUnit.SECONDS))
        assertEquals(InterruptedIOException::class.java, read.failure.get()?.javaClass)
        assertTrue("the interrupt flag is kept", read.interruptFlagKept)
    }

    @Test fun aFailedHandshakeNeverReachesThePrinter() {
        val p = fake()
        InternetTestRoutes.local = Preset.LOSS_100.profile
        val socket = InternetTestRoutes.local(SocketFactory.getDefault()).createSocket().also { sockets += it }

        val took = elapsedMs {
            assertThrows(SocketTimeoutException::class.java) { socket.connect(p.address, 300) }
        }

        assertTrue("a stall to the timeout, not an instant error; took $took", took >= 300)
        assertTrue("the socket is closed after a failed connect", socket.isClosed)
        assertThrows(SocketException::class.java) { socket.connect(p.address, 300) }
        Thread.sleep(100)
        assertEquals("nothing reached the printer", 0, p.accepted.get())
    }

    @Test fun readHonorsSoTimeout() {
        val p = fake(greeting = "hello") // here at once, but 2 s down the link
        val socket = conditioned(connectedTo(p), LinkProfile(downDelayMs = 2_000))
        socket.soTimeout = 300

        val took = elapsedMs {
            assertThrows(SocketTimeoutException::class.java) { socket.getInputStream().read(ByteArray(64)) }
        }

        assertTrue("timed out at soTimeout, took $took", took in 300L..400L)
    }

    @Test fun delaysArePaidOncePerTurn() {
        val p = fake(mapOf("B" to "1"))
        val recorder = Recorder()
        InternetTestRoutes.sleeper = recorder
        InternetTestRoutes.local = LinkProfile(upDelayMs = 7, downDelayMs = 11)
        val socket = InternetTestRoutes.local(SocketFactory.getDefault()).createSocket().also { sockets += it }
        socket.connect(p.address, 1_000)
        socket.soTimeout = 100
        val out = socket.getOutputStream()
        val input = socket.getInputStream()
        val buf = ByteArray(16)

        assertEquals("the handshake: one round trip", listOf(18L), recorder.calls.toList())
        out.write("A".toByteArray())
        out.write("B".toByteArray()) // the same burst: no second delay
        assertEquals(1, input.read(buf))
        assertThrows(SocketTimeoutException::class.java) { input.read(buf) } // the same burst, nothing more
        out.write("B".toByteArray())
        assertEquals(1, input.read(buf))

        assertEquals(listOf(18L, 7L, 11L, 7L, 11L), recorder.calls.toList())
    }

    @Test fun aReadDelayPastSoTimeoutTimesOutThenResumes() {
        val p = fake(greeting = "hello")
        val recorder = Recorder()
        val socket = conditioned(connectedTo(p).withBytesWaiting(5), LinkProfile(downDelayMs = 500), sleeper = recorder)
        socket.soTimeout = 300
        val buf = ByteArray(16)

        assertThrows(SocketTimeoutException::class.java) { socket.getInputStream().read(buf) }
        assertEquals("waited out soTimeout, not the whole delay", listOf(300L), recorder.calls.toList())
        val n = socket.getInputStream().read(buf)

        assertEquals("then the rest of the delay", listOf(300L, 200L), recorder.calls.toList())
        assertEquals("hello", String(buf, 0, n, Charsets.US_ASCII))
    }

    @Test fun bytesCaughtInAStallArriveOnTheNextRead() {
        val p = fake(greeting = "hello")
        val recorder = Recorder()
        // The first try at the bytes is dropped, and its stall (200 ms) outlasts soTimeout; the second gets through.
        val socket = conditioned(connectedTo(p).withBytesWaiting(5), LinkProfile(downDropPct = 50.0), ScriptedRandom(0.0, 0.99), recorder)
        socket.soTimeout = 100
        val buf = ByteArray(16)

        assertThrows(SocketTimeoutException::class.java) { socket.getInputStream().read(buf) }
        val n = socket.getInputStream().read(buf)

        assertEquals("hello", String(buf, 0, n, Charsets.US_ASCII))
        assertEquals(listOf(100L), recorder.calls.toList())
    }

    @Test fun totalLossHoldsBackEvenTheEndOfTheStream() {
        val p = fake(hangUp = true)
        val socket = conditioned(connectedTo(p), Preset.LOSS_100.profile!!)
        socket.soTimeout = 200
        p.received(1) // the printer has hung up: the end of the stream is waiting

        repeat(2) {
            val took = elapsedMs {
                assertThrows(SocketTimeoutException::class.java) { socket.getInputStream().read(ByteArray(16)) }
            }
            assertTrue("the read stalled to soTimeout, took $took", took >= 190)
        }
    }

    @Test fun theConnectingOverloadsConnectThroughTheConditions() {
        val p = fake()
        val recorder = Recorder()
        InternetTestRoutes.sleeper = recorder
        InternetTestRoutes.local = LinkProfile(upDelayMs = 5, downDelayMs = 5)

        val socket = InternetTestRoutes.local(SocketFactory.getDefault()).createSocket("127.0.0.1", p.port).also { sockets += it }

        assertTrue(socket.isConnected)
        assertEquals(p.port, socket.port)
        assertEquals("one round trip", listOf(10L), recorder.calls.toList())
    }

    @Test fun scanConcurrency() {
        val p = fake()
        InternetTestRoutes.local = LinkProfile(downDelayMs = 50, upDelayMs = 50)
        val factory = InternetTestRoutes.local(SocketFactory.getDefault())
        val go = CountDownLatch(1)
        val failures = ConcurrentLinkedQueue<Throwable>()
        val tookNs = ConcurrentLinkedQueue<Long>()

        val probes = (1..64).map {
            thread {
                val socket = factory.createSocket()
                try {
                    go.await()
                    val start = System.nanoTime()
                    socket.connect(p.address, 3_000)
                    tookNs += System.nanoTime() - start
                    check(socket.isConnected) { "not connected" }
                } catch (e: Throwable) {
                    failures += e
                } finally {
                    socket.close()
                }
            }
        }
        go.countDown()
        probes.forEach { it.join(10_000) }

        assertTrue("every probe connected: $failures", failures.isEmpty())
        assertEquals(64, tookNs.size)
        val fastest = tookNs.min()
        assertTrue("each paid its own 100 ms handshake; fastest ${fastest / 1_000_000} ms", fastest >= TimeUnit.MILLISECONDS.toNanos(100))
    }
}
