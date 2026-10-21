package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.printer.HostId
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** NetworkZebra and ZebraScanner against a fake printer: a local ServerSocket on 127.0.0.1. */
class NetworkZebraTest {
    /** Answers each command it recognizes with its reply and keeps the connection open (a Zebra
     *  answers in ~30 ms and never closes first); records every byte it receives. */
    private class FakePrinter(private val replies: Map<String, String> = emptyMap()) : AutoCloseable {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val port: Int get() = server.localPort
        val connections = CopyOnWriteArrayList<ByteArray>()
        private val sockets = CopyOnWriteArrayList<Socket>()

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val s = try { server.accept() } catch (_: Exception) { break }
                    sockets += s
                    thread(isDaemon = true) { serve(s) }
                }
            }
        }

        private fun serve(s: Socket) {
            val got = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            try {
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

    private val fakes = ArrayList<FakePrinter>()
    private fun fake(replies: Map<String, String> = emptyMap()) = FakePrinter(replies).also { fakes += it }
    @After fun closeFakes() = fakes.forEach { it.close() }

    private val fast = ZebraTimeouts(connectMs = 1_000, idleMs = 300, totalMs = 2_000, sendMs = 5_000)
    private fun zebra(p: FakePrinter) = NetworkZebra("127.0.0.1", p.port, fast)

    /** A port nothing listens on. */
    private fun closedPort(): Int = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }

    private val hi = "\u0002ZD421-300dpi,V93.21.38Z,12,8176KB\u0003\r\n"
    private val hs = "\u0002030,0,0,0612,000,0,0,0,000,0,0,0\u0003\r\n" +
        "\u0002000,0,1,0,0,1,6,0,00000000,1,000\u0003\r\n\u00020000,0\u0003\r\n"

    @Test fun sendDeliversTheExactUtf8Bytes() = runBlocking<Unit> {
        val p = fake()
        val zpl = "^XA^CI28^FO50,50^A0N,30,30^FDCafé ✓^FS^XZ"
        zebra(p).send(zpl)
        assertArrayEquals(zpl.toByteArray(Charsets.UTF_8), p.received().single())
    }

    @Test fun identifyParsesTheHostIdentificationReply() = runBlocking<Unit> {
        val p = fake(mapOf("~HI" to hi))
        val started = System.nanoTime()
        assertEquals(HostId("ZD421-300dpi", "V93.21.38Z", 12, "8176KB", 300), zebra(p).identify())
        // the reply is whole at its ETX: no waiting out the idle time on an open connection
        assertTrue(System.nanoTime() - started < TimeUnit.MILLISECONDS.toNanos(250))
        assertEquals("~HI", String(p.received().single(), Charsets.US_ASCII))
    }

    @Test fun statusReadsAllThreeFrames() = runBlocking<Unit> {
        val p = fake(mapOf("~HS" to hs))
        val s = zebra(p).status()
        assertTrue(s.headOpen)
        assertEquals(612, s.labelLength)
    }

    @Test fun peelerPresentReadsTheGetvar() = runBlocking<Unit> {
        val query = "! U1 getvar \"sensor.peeler_present\"\r\n"
        assertEquals(true, zebra(fake(mapOf(query to "\"Present\""))).peelerPresent())
        assertEquals(false, zebra(fake(mapOf(query to "\"Not Present\""))).peelerPresent())
        assertNull(zebra(fake(mapOf(query to "\"?\""))).peelerPresent())
        assertNull(zebra(fake()).peelerPresent()) // no answer
        assertNull(NetworkZebra("127.0.0.1", closedPort(), fast).peelerPresent())
    }

    @Test fun serialReadsTheUniqueId() = runBlocking<Unit> {
        val p = fake(mapOf("! U1 getvar \"device.unique_id\"\r\n" to "\"D2J123456789\""))
        assertEquals("D2J123456789", zebra(p).serial())
        assertNull(zebra(fake()).serial())
    }

    @Test fun fontsListsTheEDrive() = runBlocking<Unit> {
        val listing = "\u0002\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960 \r\n* E:TT0003M_.TTF    160676       K  \r\n" +
            "\r\n-  32346624 bytes free E: ONBOARD FLASH \r\n\u0003"
        val p = fake(mapOf("^XA^HWE:*.*^XZ" to listing))
        assertEquals(listOf("85620388.TTF", "TT0003M_.TTF"), zebra(p).fonts())
        val garbage = fake(mapOf("^XA^HWE:*.*^XZ" to "\u0002nope\u0003"))
        assertThrows(PrinterBadReply::class.java) { runBlocking { zebra(garbage).fonts() } }
    }

    @Test fun installFontSendsTheHeaderThenTheBytes() = runBlocking<Unit> {
        val p = fake()
        val bytes = ByteArray(70_000) { (it % 251).toByte() }
        zebra(p).installFont("roboto_r.ttf", bytes)
        val header = "~DYE:ROBOTO_R.TTF,B,T,70000,,".toByteArray(Charsets.US_ASCII)
        assertArrayEquals(header + bytes, p.received().single())
    }

    @Test fun installFontRefusesAResidentFontOrABadName() = runBlocking<Unit> {
        val p = fake()
        val z = zebra(p)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { z.installFont("TT0003M_.TTF", byteArrayOf(1)) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { z.installFont("A,B.TTF", byteArrayOf(1)) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { z.installFont("X.TTF^XA", byteArrayOf(1)) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { z.installFont("EMPTY.TTF", ByteArray(0)) } }
        assertTrue(p.connections.isEmpty())
    }

    @Test fun aClosedPortIsUnreachable() {
        val z = NetworkZebra("127.0.0.1", closedPort(), fast)
        val e = assertThrows(PrinterUnreachable::class.java) { runBlocking { z.identify() } }
        assertEquals("127.0.0.1", e.host)
        assertThrows(PrinterUnreachable::class.java) { runBlocking { z.send("^XA^XZ") } }
    }

    @Test fun anEmptyReplyIsNoReply() {
        val p = fake()
        val started = System.nanoTime()
        assertThrows(PrinterNoReply::class.java) { runBlocking { zebra(p).identify() } }
        // ended at the idle wait, not the total
        assertTrue(System.nanoTime() - started < TimeUnit.MILLISECONDS.toNanos(1_500))
    }

    @Test fun aCancelledQueryStopsAtOnceAndStaysACancellation() = runBlocking<Unit> {
        val p = fake()
        val slow = NetworkZebra("127.0.0.1", p.port, ZebraTimeouts(idleMs = 5_000, totalMs = 5_000))
        val started = System.nanoTime()
        assertNull(withTimeoutOrNull(200) { slow.identify() })
        assertTrue(System.nanoTime() - started < TimeUnit.MILLISECONDS.toNanos(1_000))
    }

    @Test fun anUnreadableReplyIsABadReply() {
        val p = fake(mapOf("~HS" to "\u0002030,0\u0003\u0002x\u0003\u0002y\u0003"))
        assertThrows(PrinterBadReply::class.java) { runBlocking { zebra(p).status() } }
    }

    // ── the subnet scan ──

    @Test fun theScanListsZebrasWithModelSerialAndDpi() = runBlocking<Unit> {
        val p = fake(mapOf("~HI" to hi, "! U1 getvar \"device.unique_id\"\r\n" to "\"D2J123\""))
        val scanner = ZebraScanner(subnets = { listOf(ScanSubnet(listOf("127.0.0.1"))) }, port = p.port)
        assertEquals(listOf(FoundPrinter("127.0.0.1", "ZD421-300dpi", "D2J123", 300)), scanner.scan())
    }

    @Test fun theScanKeepsAResponderThatWontSayWhatItIs() = runBlocking<Unit> {
        val p = fake()
        val scanner = ZebraScanner(subnets = { listOf(ScanSubnet(listOf("127.0.0.1"))) }, port = p.port, identifyMs = 300)
        assertEquals(listOf(FoundPrinter("127.0.0.1", null, null, null)), scanner.scan())
    }

    @Test fun theScanSkipsHostsThatDontAnswer() = runBlocking<Unit> {
        val scanner = ZebraScanner(subnets = { listOf(ScanSubnet(listOf("127.0.0.1"))) }, port = closedPort())
        assertEquals(emptyList<FoundPrinter>(), scanner.scan())
    }

    @Test fun theScanProbesSixtyFourHostsAtOnce() = runBlocking<Unit> {
        val probed = AtomicInteger(0)
        val open = AtomicInteger(0)
        val peak = AtomicInteger(0)
        val scanner = ZebraScanner(
            subnets = { listOf(ScanSubnet((1..254).map { "10.0.0.$it" })) },
            probe = { _, _ ->
                peak.accumulateAndGet(open.incrementAndGet(), ::maxOf)
                delay(50)
                open.decrementAndGet()
                probed.incrementAndGet()
                null
            },
        )
        assertEquals(emptyList<FoundPrinter>(), scanner.scan())
        assertEquals(254, probed.get())
        assertEquals(64, peak.get())
    }

    @Test fun theScanStopsAtItsBudgetWithWhatItFound() = runBlocking<Unit> {
        val scanner = ZebraScanner(
            subnets = { listOf(ScanSubnet(listOf("10.0.0.1", "10.0.0.2"))) },
            budgetMs = 300,
            probe = { host, _ ->
                if (host == "10.0.0.2") delay(10_000)
                FoundPrinter(host, "ZD421", null, 203)
            },
        )
        val started = System.nanoTime()
        assertEquals(listOf(FoundPrinter("10.0.0.1", "ZD421", null, 203)), scanner.scan())
        assertTrue(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(2))
    }

    @Test fun scanTargetsAreTheDevicesPrivateSlash24() {
        val t = scanTargets("192.168.1.37", 24)
        assertEquals(253, t.size) // .1–.254 without the device itself
        assertEquals("192.168.1.1", t.first()); assertEquals("192.168.1.254", t.last())
        assertTrue("192.168.1.37" !in t)
        // a larger subnet still scans only the device's /24
        assertEquals(scanTargets("10.20.30.40", 24), scanTargets("10.20.30.40", 16))
        // a smaller one scans just itself
        assertEquals(listOf("172.16.5.129", "172.16.5.131", "172.16.5.132", "172.16.5.133", "172.16.5.134"),
            scanTargets("172.16.5.130", 29))
        // public, loopback and link-local addresses are never scanned
        assertEquals(emptyList<String>(), scanTargets("8.8.8.8", 24))
        assertEquals(emptyList<String>(), scanTargets("127.0.0.1", 8))
        assertEquals(emptyList<String>(), scanTargets("169.254.3.4", 16))
        assertEquals(emptyList<String>(), scanTargets("not an ip", 24))
    }
}
