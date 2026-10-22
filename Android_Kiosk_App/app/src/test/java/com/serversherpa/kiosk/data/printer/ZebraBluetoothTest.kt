package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.LOCATION_OFF_TEXT
import com.serversherpa.kiosk.core.printer.ZebraBluetoothSpec
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.data.printer.BluetoothAvailability.LOCATION_OFF
import com.serversherpa.kiosk.data.printer.BluetoothAvailability.POWERED_OFF
import com.serversherpa.kiosk.data.printer.BluetoothAvailability.READY
import com.serversherpa.kiosk.data.printer.BluetoothAvailability.UNAUTHORIZED
import com.serversherpa.kiosk.data.printer.BluetoothAvailability.UNKNOWN
import com.serversherpa.kiosk.data.printer.BluetoothAvailability.UNSUPPORTED
import com.serversherpa.kiosk.data.printer.FakeBluetoothLe.Companion.SERIAL
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Bluetooth link and transport over a fake LE client, in virtual time (nothing here waits
 *  for real time). */
@OptIn(ExperimentalCoroutinesApi::class)
class ZebraBluetoothTest {
    private val addr = "AC:3F:A4:00:00:01"
    private val addr2 = "AC:3F:A4:00:00:02"

    /** The office ZD421-300dpi's `~HS` (three frames). */
    private val hs = "\u0002030,0,0,0612,000,0,0,0,000,0,0,0\u0003\r\n" +
        "\u0002000,0,0,0,0,1,6,0,00000000,1,000\u0003\r\n\u00020000,0\u0003\r\n"
    private val hi = "\u0002ZD421-300dpi,V93.21.38Z,12,8176KB\u0003\r\n"

    private fun TestScope.make(
        state: BluetoothAvailability = READY,
        log: (String, Throwable) -> Unit = { _, _ -> },
    ): Pair<ZebraBluetooth, FakeBluetoothLe> {
        val fake = FakeBluetoothLe(state) { testScheduler.currentTime }
        val bluetooth = ZebraBluetooth(fake, backgroundScope, clock = { testScheduler.currentTime }, log = log)
        return bluetooth to fake
    }

    private fun printer(address: String? = addr) =
        SavedPrinter(PrinterConnection.Bluetooth(SERIAL, address), "ZD421", SERIAL, 300)

    /** Runs [block] beside the test; its outcome (a value or the error) is the result. */
    private fun <T> TestScope.start(block: suspend () -> T): Deferred<Result<T>> = async { runCatching { block() } }

    private inline fun <reified E : Throwable> Result<*>.failure(): E {
        val error = exceptionOrNull() ?: throw AssertionError("expected ${E::class.simpleName}, but the call succeeded")
        return error as? E ?: throw AssertionError("expected ${E::class.simpleName}, got $error", error)
    }

    /** A ZD421 at [addr], connected and ready. */
    private suspend fun ready(bluetooth: ZebraBluetooth, fake: FakeBluetoothLe): FakeGatt {
        if (addr !in fake.printers) fake.printer(addr)
        bluetooth.connect(addr, SERIAL)
        return fake.links.last()
    }

    private fun frames(n: Int): (ByteArray) -> Boolean = { replyHasFrames(it, n) }

    // --- The GATT queue ---

    @Test fun gattOperationsRunOneAtATime() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr).apply {
            autoAnswer = false
            autoAck = false
        }
        val send = start { bluetooth.transport(printer()).write(listOf(ByteArray(300) { it.toByte() })) }
        runCurrent()
        val gatt = fake.links.single()
        val steps = listOf(
            "discover", "read 2A29", "read 2A25", "read 2A24", "read 2A26", "read 2A28",
            "mtu 247", "cccd", "write 244", "write 56",
        )
        for (n in 1..steps.size) {
            runCurrent()
            assertEquals("after ${n - 1} answers", steps.take(n), gatt.ops)
            advanceTimeBy(200)
            runCurrent()
            assertEquals("nothing else goes out before the answer", steps.take(n), gatt.ops)
            assertTrue(gatt.waitingForAnswer)
            gatt.answer()
        }
        runCurrent()
        assertTrue(send.await().isSuccess)
        assertEquals(0, gatt.overlaps)
        assertEquals("high priority is asked once indications are on", 8, gatt.priorityAfterOps)
    }

    @Test fun aSlowDeviceInformationReadKeepsItsTurn() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr).silentReads += ZebraBluetoothSpec.FIRMWARE_UUID
        val connect = start { bluetooth.connect(addr, SERIAL) }
        runCurrent()
        val gatt = fake.links.single()
        assertEquals("read 2A26", gatt.ops.last())
        // Past its fallback the link stops waiting for the value, but Android allows one
        // operation at a time: nothing else goes out until the read is answered.
        advanceTimeBy(ZebraBluetoothSpec.DEVICE_INFO_READ_MS + 1_000)
        runCurrent()
        assertEquals("read 2A26", gatt.ops.last())
        assertFalse(connect.isCompleted)
        gatt.answer()
        runCurrent()
        val info = connect.await().getOrThrow()
        assertEquals(listOf("read 2A28", "mtu 247", "cccd"), gatt.ops.takeLast(3))
        assertEquals("a value that came late is kept", "V93.21.38Z", info.firmware)
        assertEquals(0, gatt.overlaps)

        // A manufacturer that can't be read says nothing about the device: unreachable.
        val (other, otherFake) = make()
        otherFake.printer(addr).readStatus[ZebraBluetoothSpec.MANUFACTURER_UUID] = 2 // read not permitted
        runCatching { other.connect(addr, SERIAL) }.failure<PrinterUnreachable>()
        assertTrue(otherFake.links.single().closed)
    }

    // --- Writes ---

    @Test fun writesInAckedChunks() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val bytes = ByteArray(1_000) { (it % 251).toByte() }
        val sent = mutableListOf<Long>()
        val totals = mutableSetOf<Long>()
        val send = start {
            bluetooth.transport(printer()).write(listOf(bytes.copyOfRange(0, 600), bytes.copyOfRange(600, 1_000))) { s, t ->
                sent += s
                totals += t
            }
        }
        for (n in 1..5) {
            runCurrent()
            assertEquals(n, gatt.writes.size)
            advanceTimeBy(500)
            runCurrent()
            assertEquals("no chunk before the last one's ack", n, gatt.writes.size)
            gatt.ack()
        }
        runCurrent()
        assertTrue(send.await().isSuccess)
        assertEquals(listOf(244, 244, 244, 244, 24), gatt.writes.map { it.size })
        assertArrayEquals(bytes, gatt.written())
        assertEquals(0, gatt.overlaps)
        assertEquals(listOf(0L, 244L, 488L, 732L, 976L, 1_000L), sent)
        assertEquals(setOf(1_000L), totals)
        assertEquals(244, bluetooth.link.value.chunkBytes)
        assertEquals(247, bluetooth.link.value.mtu)
    }

    @Test fun smallMtuFallsBackTo20() = runTest {
        // The MTU request fails.
        val (bluetooth, fake) = make()
        fake.printer(addr).mtuStatus = 257
        bluetooth.connect(addr, SERIAL)
        assertEquals(20, bluetooth.link.value.chunkBytes)
        assertNull(bluetooth.link.value.mtu)
        bluetooth.transport(printer()).write(listOf(ByteArray(100)))
        assertEquals(listOf(20, 20, 20, 20, 20), fake.links.single().writes.map { it.size })

        // The printer grants only the minimum.
        val (small, smallFake) = make()
        smallFake.printer(addr).mtuGranted = 23
        small.connect(addr, SERIAL)
        assertEquals(20, small.link.value.chunkBytes)
        assertEquals(23, small.link.value.mtu)
    }

    @Test fun writeReportsZeroOnlyOnceItsBytesGoOut() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr).connect = FakePrinter.Connect.SILENT
        val unanswered = mutableListOf<Long>()
        val failing = start { bluetooth.transport(printer()).write(listOf(ByteArray(10))) { s, _ -> unanswered += s } }
        advanceTimeBy(ZebraBluetoothSpec.CONNECT_READY_MS)
        runCurrent()
        failing.await().failure<PrinterUnreachable>()
        assertTrue("nothing went out, nothing is reported", unanswered.isEmpty())

        fake.printers.getValue(addr).connect = FakePrinter.Connect.ANSWER
        fake.printers.getValue(addr).autoAck = false
        val started = mutableListOf<Long>()
        val send = start { bluetooth.transport(printer()).write(listOf(ByteArray(300))) { s, _ -> started += s } }
        runCurrent()
        val gatt = fake.links.last()
        assertEquals(1, gatt.writes.size)
        assertEquals(listOf(0L), started)
        gatt.ack()
        runCurrent()
        gatt.ack()
        runCurrent()
        assertTrue(send.await().isSuccess)
        assertEquals(listOf(0L, 244L, 300L), started)
    }

    @Test fun sendBudgetEndsAStalledWrite() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val budget = ZebraBluetoothSpec.sendBudgetMs(1_000)
        // Run as the printer lock runs it: the caller can't cancel it, so the budget must end it.
        val stalled = start { withContext(NonCancellable) { bluetooth.transport(printer()).write(listOf(ByteArray(1_000))) } }
        runCurrent()
        assertEquals(1, gatt.writes.size)
        val startedAt = currentTime
        advanceTimeBy(budget - 1)
        runCurrent()
        assertFalse(stalled.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        val error = stalled.await().failure<PrinterTimeout>()
        assertEquals(SERIAL, error.host)
        assertEquals(budget, currentTime - startedAt)
        assertFalse(bluetooth.link.value.connected)
        assertEquals(currentTime, bluetooth.link.value.lastDrop?.atMs)
        assertTrue("a late ack must never count for the next write", gatt.closed)
        assertEquals(1, gatt.writes.size)
    }

    @Test fun writeAckWithPairingLostEndsTheLink() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val send = start { bluetooth.transport(printer()).write(listOf(ByteArray(600))) }
        runCurrent()
        gatt.ack(15) // insufficient encryption
        runCurrent()
        assertEquals(pairingLostText(SERIAL), send.await().failure<BluetoothPairingLost>().message)
        assertEquals("no chunk after the refusal", 1, gatt.writes.size)
        assertFalse(bluetooth.link.value.connected)
        assertEquals(currentTime, bluetooth.link.value.lastDrop?.atMs)
        assertTrue(gatt.closed)
    }

    @Test fun writeAckWithAnotherBadStatusFailsTheWrite() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val zebra = bluetooth.transport(printer())
        val send = start { zebra.write(listOf(ByteArray(600))) }
        runCurrent()
        gatt.ack(3) // write not permitted
        runCurrent()
        assertEquals(SERIAL, send.await().failure<PrinterUnreachable>().host)
        assertEquals("no chunk after the refusal", 1, gatt.writes.size)
        // Only that write failed: the link stays up for the next one (the guard's ~JX, say).
        assertTrue(bluetooth.link.value.connected)
        assertFalse(gatt.closed)
        fake.printers.getValue(addr).autoAck = true
        zebra.write(listOf("~JX".toByteArray()))
        assertEquals(1, fake.connects.size)
        assertEquals("~JX", String(gatt.writes.last()))
    }

    @Test fun dropDuringAWriteFailsItAtOnce() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val send = start { bluetooth.transport(printer()).write(listOf(ByteArray(1_000))) }
        runCurrent()
        val at = currentTime
        gatt.drop(8)
        runCurrent()
        assertEquals(SERIAL, send.await().failure<PrinterUnreachable>().host)
        assertEquals(at, currentTime)
        assertEquals(at, bluetooth.link.value.lastDrop?.atMs)
        assertTrue(gatt.closed)
    }

    // --- Queries ---

    @Test fun queryWaitsForCompleteReply() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        val zebra = bluetooth.transport(printer())
        val query = start { zebra.query(ZebraCommands.HOST_STATUS, frames(3)) }
        runCurrent()
        assertEquals("~HS", String(gatt.writes.last(), Charsets.US_ASCII))
        val t0 = currentTime
        val third = hs.length / 3
        gatt.indicate(hs.substring(0, third))
        advanceTimeBy(400)
        runCurrent()
        assertFalse(query.isCompleted)
        gatt.indicate(hs.substring(third, 2 * third))
        advanceTimeBy(400)
        runCurrent()
        assertFalse(query.isCompleted)
        gatt.indicate(hs.substring(2 * third))
        runCurrent()
        assertEquals(hs, query.await().getOrThrow())
        assertEquals("whole as the last frame lands: no idle wait", 800L, currentTime - t0)

        // The shared commands parse it as they do over the network.
        val writes = gatt.writes.size
        val status = start { zebra.status() }
        advanceTimeBy(ZebraBluetoothSpec.DRAIN_QUIET_MS) // the last reply's bytes just landed: quiet first
        runCurrent()
        assertEquals(writes + 1, gatt.writes.size)
        gatt.indicate(hs)
        runCurrent()
        assertTrue(status.await().isSuccess)
    }

    @Test fun queryDrainsLateBytes() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        val zebra = bluetooth.transport(printer())

        // An earlier ~HI ended on quiet with half its reply...
        val first = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION, frames(1)) }
        runCurrent()
        gatt.indicate("\u0002ZD421-300dpi,")
        advanceTimeBy(ZebraBluetoothSpec.QUERY_IDLE_MS)
        runCurrent()
        assertEquals("\u0002ZD421-300dpi,", first.await().getOrThrow())

        // ... and the rest of it arrives late, still trickling as the next query starts.
        gatt.indicate("V93.21.38Z,12,")
        val writes = gatt.writes.size
        val second = start { zebra.query(ZebraCommands.HOST_STATUS, frames(3)) }
        runCurrent()
        assertEquals("waits for quiet before writing", writes, gatt.writes.size)
        advanceTimeBy(200)
        gatt.indicate("8176KB\u0003\r\n")
        runCurrent()
        val lastStray = currentTime
        advanceTimeBy(ZebraBluetoothSpec.DRAIN_QUIET_MS - 1)
        runCurrent()
        assertEquals(writes, gatt.writes.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(writes + 1, gatt.writes.size)
        assertEquals(lastStray + ZebraBluetoothSpec.DRAIN_QUIET_MS, gatt.writeTimes.last())
        gatt.indicate(hs)
        runCurrent()
        assertEquals("none of the stray bytes is in the reply", hs, second.await().getOrThrow())

        // A printer that never goes quiet: the drain gives up after DRAIN_MAX_MS.
        val drainFrom = currentTime
        val chatter = launch {
            repeat(10) {
                gatt.indicate(".")
                delay(100)
            }
        }
        val third = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION, frames(1)) }
        advanceTimeBy(ZebraBluetoothSpec.DRAIN_MAX_MS)
        runCurrent()
        assertEquals(drainFrom + ZebraBluetoothSpec.DRAIN_MAX_MS, gatt.writeTimes.last())
        chatter.join()
        gatt.indicate(hi)
        runCurrent()
        assertEquals(hi, third.await().getOrThrow())
    }

    @Test fun queryEndsOnIdleAndTotal() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        val zebra = bluetooth.transport(printer())

        // No ETX: it ends QUERY_IDLE_MS after its last byte.
        val partial = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION, frames(1)) }
        runCurrent()
        advanceTimeBy(500)
        gatt.indicate("ZD421")
        runCurrent()
        advanceTimeBy(ZebraBluetoothSpec.QUERY_IDLE_MS - 1)
        runCurrent()
        assertFalse(partial.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertEquals("ZD421", partial.await().getOrThrow())

        // An endless trickle: it ends QUERY_TOTAL_MS after the write.
        advanceTimeBy(1_000)
        val trickled = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION, frames(1)) }
        runCurrent()
        val wroteAt = gatt.writeTimes.last()
        val trickle = launch {
            repeat(8) {
                delay(1_000)
                gatt.indicate("x")
            }
        }
        advanceTimeBy(ZebraBluetoothSpec.QUERY_TOTAL_MS - 1)
        runCurrent()
        assertFalse(trickled.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertEquals("xxxx", trickled.await().getOrThrow())
        assertEquals(wroteAt + ZebraBluetoothSpec.QUERY_TOTAL_MS, currentTime)
        trickle.cancel()

        // Nothing at all: no reply, QUERY_IDLE_MS after the write.
        advanceTimeBy(1_000)
        val silent = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION, frames(1)) }
        runCurrent()
        advanceTimeBy(ZebraBluetoothSpec.QUERY_IDLE_MS)
        runCurrent()
        assertEquals(SERIAL, silent.await().failure<PrinterNoReply>().host)
    }

    // --- Connecting ---

    @Test fun connectByAddressThenBySerial() = runTest {
        // The printer answers at another address now; nothing answers at the saved one.
        val (bluetooth, fake) = make()
        fake.printer(addr2)
        val send = start { bluetooth.transport(printer(addr)).write(listOf("^XA^XZ".toByteArray())) }
        runCurrent()
        assertEquals(listOf(addr), fake.connects)
        assertFalse(fake.scanning)
        advanceTimeBy(ZebraBluetoothSpec.ADDRESS_TRY_MS)
        runCurrent()
        assertTrue("the saved address had its share; now the serial is scanned for", fake.scanning)
        assertTrue(fake.links[0].closed)
        fake.advertise("11:22:33:44:55:66", "Jimmy's Pixel", -40)
        fake.advertise(addr2, SERIAL, -60)
        runCurrent()
        assertFalse("a scan never runs beside a send", fake.scanning)
        assertEquals(listOf(addr, addr2), fake.connects)
        assertTrue(send.await().isSuccess)
        assertEquals("^XA^XZ", String(fake.links.last().written()))
        assertEquals(addr2, bluetooth.link.value.info?.address)
        assertEquals("found elsewhere: the saved address is kept for the details", addr, bluetooth.link.value.savedAddress)

        // A saved address that fails at once goes straight to the scan.
        val (quick, quickFake) = make()
        quickFake.printer(addr).connectFailStatus = 133
        val quickFrom = currentTime
        val found = start { quick.connect(addr, SERIAL) }
        runCurrent()
        assertTrue("no wait for the address's share", quickFake.scanning)
        assertEquals(quickFrom, currentTime)
        assertTrue(quickFake.links.single().closed)
        quickFake.printers.getValue(addr).connectFailStatus = null
        quickFake.advertise(addr, SERIAL, -55)
        runCurrent()
        assertEquals(addr, found.await().getOrThrow().address)
        assertEquals(listOf(addr, addr), quickFake.connects)

        // No address at all: found by its serial.
        val (byName, byNameFake) = make()
        byNameFake.printer(addr2)
        val named = start { byName.connect(null, SERIAL) }
        runCurrent()
        assertTrue(byNameFake.scanning)
        assertTrue(byNameFake.connects.isEmpty())
        byNameFake.advertise(addr2, SERIAL, -60)
        runCurrent()
        val info = named.await().getOrThrow()
        assertEquals(addr2, info.address)
        assertEquals(SERIAL, info.serial)
        assertEquals("Zebra Technologies", info.manufacturer)
        assertEquals("ZD421", info.model)
    }

    @Test fun savedAddressIsTriedFirst() = runTest {
        // The printer answers only at B; it is saved at A, so it is found by its serial.
        val (bluetooth, fake) = make()
        fake.printer(addr2)
        val first = start { bluetooth.transport(printer(addr)).write(listOf("^XA^XZ".toByteArray())) }
        advanceTimeBy(ZebraBluetoothSpec.ADDRESS_TRY_MS)
        runCurrent()
        assertTrue(fake.scanning)
        fake.advertise(addr2, SERIAL, -60)
        runCurrent()
        assertTrue(first.await().isSuccess)
        assertEquals(listOf(addr, addr2), fake.connects)
        assertEquals(addr2, bluetooth.link.value.info?.address)
        assertEquals(addr, bluetooth.link.value.savedAddress)

        // The link drops. The next use tries the saved A first, then B (known this run, never
        // saved), with no scan: they share the address time.
        fake.links.last().drop(8)
        runCurrent()
        val scans = fake.scanStarts
        val from = currentTime
        val again = start { bluetooth.transport(printer(addr)).write(listOf("^XA^XZ".toByteArray())) }
        runCurrent()
        assertEquals("the first attempt targets the saved address", addr, fake.connects[2])
        advanceTimeBy(ZebraBluetoothSpec.ADDRESS_TRY_MS / 2)
        runCurrent()
        assertTrue(again.await().isSuccess)
        assertEquals(listOf(addr, addr2, addr, addr2), fake.connects)
        assertEquals(ZebraBluetoothSpec.ADDRESS_TRY_MS / 2, currentTime - from)
        assertEquals(scans, fake.scanStarts)
        assertEquals(addr, bluetooth.link.value.savedAddress)

        // The printer answers at A again: the link is there, and the mismatch is gone.
        fake.links.last().drop(8)
        runCurrent()
        fake.printer(addr)
        bluetooth.transport(printer(addr)).write(listOf("^XA^XZ".toByteArray()))
        assertEquals(addr, fake.connects.last())
        assertEquals(5, fake.connects.size)
        assertEquals(addr, bluetooth.link.value.info?.address)
        assertNull(bluetooth.link.value.savedAddress)
    }

    @Test fun aDeviceFoundByNameMustStillBeTheZebra() = runTest {
        suspend fun spoofed(setUp: FakeBluetoothLe.() -> Unit, refusal: Class<out PrinterException>) {
            val (bluetooth, fake) = make()
            fake.setUp()
            val send = start { bluetooth.transport(printer(null)).write(listOf("^XA^XZ".toByteArray())) }
            runCurrent()
            assertTrue(fake.scanning)
            fake.advertise(addr2, SERIAL, -50) // it advertises the serial as its name
            runCurrent()
            val error = send.await().exceptionOrNull()
            assertTrue("expected ${refusal.simpleName}, got $error", refusal.isInstance(error))
            val gatt = fake.links.single()
            assertFalse("indications never turned on", "cccd" in gatt.ops)
            assertTrue("nothing written", gatt.writes.isEmpty())
            assertTrue(gatt.closed)
            assertNull(bluetooth.link.value.info)

            // It never becomes the address the serial is tried at: the next use scans again.
            val next = start { bluetooth.connect(null, SERIAL) }
            runCurrent()
            assertTrue(fake.scanning)
            assertEquals(1, fake.connects.size)
            advanceTimeBy(ZebraBluetoothSpec.CONNECT_READY_MS)
            runCurrent()
            next.await().failure<BluetoothPrinterNotFound>()
        }
        spoofed({ printer(addr2, manufacturer = "Acme Labels") }, BluetoothNotZebra::class.java)
        spoofed({ printer(addr2, serial = "D8J999999999") }, BluetoothSerialMismatch::class.java)
    }

    @Test fun serialMismatchIsRefused() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr, serial = "D8J999999999") // a replacement ZD421 at the saved address
        val error = runCatching { bluetooth.connect(addr, SERIAL) }.failure<BluetoothSerialMismatch>()
        assertEquals(SERIAL, error.host)
        assertEquals("D8J999999999", error.found)
        val gatt = fake.links.single()
        assertFalse("cccd" in gatt.ops)
        assertTrue(gatt.closed)
        assertFalse(bluetooth.link.value.connected)
        assertEquals(0, fake.scanStarts)

        // A label for the saved printer isn't sent to it.
        runCatching { bluetooth.transport(printer()).write(listOf("^XA^XZ".toByteArray())) }.failure<BluetoothSerialMismatch>()
        assertTrue(fake.links.all { it.writes.isEmpty() && it.closed })
    }

    @Test fun nonZebraIsRefused() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr, manufacturer = "Acme Labels")
        runCatching { bluetooth.connect(addr, SERIAL) }.failure<BluetoothNotZebra>()
        assertFalse("cccd" in fake.links.single().ops)
        assertTrue(fake.links.single().closed)

        // No Zebra parser service: refused before anything is read.
        val (plain, plainFake) = make()
        plainFake.printer(addr).hasParserService = false
        runCatching { plain.connect(addr, SERIAL) }.failure<BluetoothNotZebra>()
        assertEquals(listOf("discover"), plainFake.links.single().ops)
        assertTrue(plainFake.links.single().closed)
    }

    @Test fun connectTimesOutWithinBudget() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr).connect = FakePrinter.Connect.SILENT // off, or out of range
        val sent = mutableListOf<Long>()
        val send = start { bluetooth.transport(printer()).write(listOf(ByteArray(10))) { s, _ -> sent += s } }
        runCurrent()
        advanceTimeBy(ZebraBluetoothSpec.CONNECT_READY_MS - 1)
        runCurrent()
        assertFalse(send.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(SERIAL, send.await().failure<PrinterUnreachable>().host)
        assertEquals(ZebraBluetoothSpec.CONNECT_READY_MS, currentTime)
        assertEquals(listOf(addr), fake.connects)
        assertTrue(fake.links.all { it.closed })
        assertFalse(fake.scanning)
        assertTrue(sent.isEmpty())

        // Retry works once the printer is back.
        fake.printers.getValue(addr).connect = FakePrinter.Connect.ANSWER
        bluetooth.transport(printer()).write(listOf("^XA^XZ".toByteArray()))
        assertEquals("^XA^XZ", String(fake.links.last().written()))

        // No address, and nothing nearby is named the serial: not found, within the same budget.
        val (unknown, unknownFake) = make()
        val from = currentTime
        val search = start { unknown.connect(null, SERIAL) }
        runCurrent()
        assertTrue(unknownFake.scanning)
        unknownFake.advertise("11:22:33:44:55:66", "Jimmy's Pixel", -40)
        advanceTimeBy(ZebraBluetoothSpec.CONNECT_READY_MS)
        runCurrent()
        assertEquals(SERIAL, search.await().failure<BluetoothPrinterNotFound>().host)
        assertEquals(ZebraBluetoothSpec.CONNECT_READY_MS, currentTime - from)
        assertFalse(unknownFake.scanning)
        assertTrue(unknownFake.connects.isEmpty())
    }

    @Test fun pairingLostStopsRetries() = runTest {
        suspend fun refused(setUp: FakePrinter.() -> Unit) {
            val (bluetooth, fake) = make()
            fake.printer(addr).setUp()
            val error = runCatching { bluetooth.connect(addr, SERIAL) }.failure<BluetoothPairingLost>()
            assertEquals(SERIAL, error.host)
            assertEquals(pairingLostText(SERIAL), error.message)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals("no retry", 1, fake.connects.size)
            assertEquals(0, fake.scanStarts)
            assertTrue(fake.links.single().closed)
        }
        refused { dropsOnDiscover += 5 } // the link drops with an authentication failure
        refused { readStatus[ZebraBluetoothSpec.MANUFACTURER_UUID] = 8 } // insufficient authorization
        refused { cccdStatus = 137 } // authentication failed
        refused { connectFailStatus = 5 }

        // The bond is removed mid-link: the write going out fails at once, and nothing reconnects.
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val send = start { bluetooth.transport(printer()).write(listOf(ByteArray(600))) }
        runCurrent()
        fake.bondLost(addr)
        runCurrent()
        assertEquals(pairingLostText(SERIAL), send.await().failure<BluetoothPairingLost>().message)
        assertTrue(gatt.closed)
        assertNotNull(bluetooth.link.value.lastDrop)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, fake.connects.size)
    }

    @Test fun aLateDeviceInformationAnswerCanStillSayPairingLost() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr).silentReads += ZebraBluetoothSpec.FIRMWARE_UUID
        val connect = start { bluetooth.connect(addr, SERIAL) }
        runCurrent()
        val gatt = fake.links.single()
        advanceTimeBy(ZebraBluetoothSpec.DEVICE_INFO_READ_MS + 1_000) // past its fallback
        runCurrent()
        assertFalse(connect.isCompleted)
        gatt.answer(5) // insufficient authentication, late
        runCurrent()
        assertEquals(pairingLostText(SERIAL), connect.await().failure<BluetoothPairingLost>().message)
        assertFalse("cccd" in gatt.ops)
        assertTrue(gatt.closed)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals("no retry", 1, fake.connects.size)
    }

    @Test fun dropBeforeReadyRetriesThreeTimes() = runTest {
        val (bluetooth, fake) = make()
        // Status 8 (the supervision timeout) is an ordinary drop, never a lost pairing.
        fake.printer(addr).dropsOnDiscover.addAll(listOf(8, 8, 8, 8))
        val connect = start { bluetooth.connect(addr, SERIAL) }
        runCurrent()
        assertEquals(1, fake.connects.size)
        for (n in 2..4) {
            advanceTimeBy(ZebraBluetoothSpec.RECONNECT_SPACING_MS - 1)
            runCurrent()
            assertEquals(n - 1, fake.connects.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(n, fake.connects.size)
        }
        assertEquals(SERIAL, connect.await().failure<PrinterUnreachable>().host)
        assertEquals(listOf(addr, addr, addr, addr), fake.connects)
        assertTrue("every failed attempt closed its GATT", fake.links.all { it.closed })
        assertEquals(0, fake.scanStarts)
        assertNotNull(bluetooth.link.value.lastDrop)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(4, fake.connects.size)

        // Two drops, then a link that holds: the retries recover it.
        val (recovers, recoversFake) = make()
        recoversFake.printer(addr).dropsOnDiscover.addAll(listOf(8, 8))
        recovers.connect(addr, SERIAL)
        assertEquals(3, recoversFake.connects.size)
        assertTrue(recovers.link.value.connected)
        assertTrue(recoversFake.links.take(2).all { it.closed })
    }

    @Test fun idleDropDoesNotReconnectUntilUsed() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        advanceTimeBy(1_000)
        gatt.drop(8)
        runCurrent()
        val drop = bluetooth.link.value.lastDrop
        assertFalse(bluetooth.link.value.connected)
        assertEquals(currentTime, drop?.atMs)
        assertTrue(drop!!.reason.contains("8"))
        assertTrue(gatt.closed)
        assertEquals("the last link's details stay", SERIAL, bluetooth.link.value.info?.serial)

        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, fake.connects.size)
        assertFalse(fake.scanning)

        bluetooth.transport(printer()).write(listOf("^XA^XZ".toByteArray()))
        assertEquals(2, fake.connects.size)
        assertEquals("^XA^XZ", String(fake.links.last().written()))
        assertTrue(bluetooth.link.value.connected)
        assertEquals(drop, bluetooth.link.value.lastDrop)
    }

    // --- Closing (background, sign-out, printer change) ---

    @Test fun closeFailsPendingWrite() = runTest {
        // A write still waiting for the link fails at once; nothing went out.
        val (bluetooth, fake) = make()
        fake.printer(addr).connect = FakePrinter.Connect.SILENT
        val sent = mutableListOf<Long>()
        val waiting = start { bluetooth.transport(printer()).write(listOf(ByteArray(10))) { s, _ -> sent += s } }
        advanceTimeBy(1_000)
        runCurrent()
        bluetooth.close()
        runCurrent()
        assertEquals(SERIAL, waiting.await().failure<PrinterUnreachable>().host)
        assertEquals(1_000L, currentTime)
        assertTrue(sent.isEmpty())
        assertTrue(fake.links.all { it.closed })

        // A write and a query waiting for their turn behind a label going out fail at once and
        // never reconnect; a query in flight fails at once too.
        val (busy, busyFake) = make()
        val gatt = ready(busy, busyFake)
        busyFake.printers.getValue(addr).autoAck = false
        val zebra = busy.transport(printer())
        val going = start { zebra.write(listOf(ByteArray(300))) }
        runCurrent()
        val queuedWrite = start { zebra.write(listOf("^XA^FDB^FS^XZ".toByteArray())) }
        val queuedQuery = start { zebra.query(ZebraCommands.HOST_STATUS, frames(3)) }
        runCurrent()
        busy.close()
        runCurrent()
        assertEquals(SERIAL, queuedWrite.await().failure<PrinterUnreachable>().host)
        queuedQuery.await().failure<PrinterUnreachable>()
        gatt.ack()
        runCurrent()
        gatt.ack()
        runCurrent()
        assertTrue(going.await().isSuccess)
        assertEquals(1, busyFake.connects.size)
        assertEquals(300, gatt.written().size)

        val (asking, askingFake) = make()
        val askingGatt = ready(asking, askingFake)
        val inFlight = start { asking.transport(printer()).query(ZebraCommands.HOST_STATUS, frames(3)) }
        runCurrent()
        askingGatt.indicate(hs.substring(0, 10))
        runCurrent()
        asking.close()
        runCurrent()
        inFlight.await().failure<PrinterUnreachable>()
        assertTrue(askingGatt.closed)
    }

    @Test fun closeLetsTheWriteGoingOutFinish() = runTest {
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val going = start { bluetooth.transport(printer()).write(listOf(ByteArray(600))) }
        runCurrent()
        bluetooth.close()
        runCurrent()
        assertFalse("a label (or font) going out keeps its link", gatt.closed)
        repeat(3) {
            gatt.ack()
            runCurrent()
        }
        assertTrue(going.await().isSuccess)
        assertEquals(600, gatt.written().size)
        assertTrue("then the link closes", gatt.closed)
        assertFalse(bluetooth.link.value.connected)
        assertNull("closing isn't a drop", bluetooth.link.value.lastDrop)

        // One whose printer stops answering ends at its send budget: it never hangs.
        val (stuck, stuckFake) = make()
        val stuckGatt = ready(stuck, stuckFake)
        stuckFake.printers.getValue(addr).autoAck = false
        val stalled = start { withContext(NonCancellable) { stuck.transport(printer()).write(listOf(ByteArray(600))) } }
        runCurrent()
        stuck.close()
        runCurrent()
        advanceTimeBy(ZebraBluetoothSpec.sendBudgetMs(600) - 1)
        runCurrent()
        assertFalse(stalled.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertTrue("ended by its budget, not later", stalled.isCompleted)
        stalled.await().failure<PrinterTimeout>()
        assertTrue(stuckGatt.closed)
    }

    @Test fun aCutLabelIsClearedBeforeTheNextOne() = runTest {
        // Through Task 2's lock and guard, as Print Labels and Printer Setup send.
        val (bluetooth, fake) = make()
        val gatt = ready(bluetooth, fake)
        fake.printers.getValue(addr).autoAck = false
        val saved = printer()
        val guard = PrinterGuard()
        val zebra = LockedZebra(TransportSetupZebra(bluetooth.transport(saved)), saved.connection, PrinterLock(), guard)
        val label = "^XA^FO50,50^FD" + "A".repeat(560) + "^FS^XZ"
        val cut = start { zebra.send(label) }
        runCurrent()
        assertEquals(1, gatt.writes.size)
        gatt.drop(8) // out of range mid-label
        runCurrent()
        cut.await().failure<PrinterUnreachable>()
        assertEquals(PrinterGuard.State.NEEDS_CLEAR, guard.state(saved.connection))

        fake.printers.getValue(addr).autoAck = true
        zebra.send(label)
        val next = fake.links.last()
        assertEquals("~JX" + label, String(next.written(), Charsets.UTF_8))
        assertEquals(PrinterGuard.State.CLEAN, guard.state(saved.connection))
    }

    // --- Availability ---

    @Test fun availabilityMapsStates() = runTest {
        for (state in listOf(POWERED_OFF, UNAUTHORIZED, UNSUPPORTED)) {
            val (bluetooth, fake) = make(state)
            fake.printer(addr)
            runCurrent()
            assertEquals(state, bluetooth.availability.value)
            val error = runCatching { bluetooth.connect(addr, SERIAL) }.failure<BluetoothUnavailable>()
            assertEquals(state, error.availability)
            assertEquals(SERIAL, error.host)
            val sent = mutableListOf<Long>()
            runCatching { bluetooth.transport(printer()).write(listOf(ByteArray(1))) { s, _ -> sent += s } }
                .failure<BluetoothUnavailable>()
            assertTrue("$state: nothing is tried", fake.connects.isEmpty())
            assertEquals(0, fake.scanStarts)
            assertTrue(sent.isEmpty())
            assertTrue("$state: a scan ends at once", bluetooth.scan().toList().isEmpty())
            assertEquals(0, fake.scanStarts)
        }
        assertEquals(BLUETOOTH_OFF_TEXT, BluetoothUnavailable(SERIAL, POWERED_OFF).message)
        assertEquals(BLUETOOTH_DENIED_TEXT, BluetoothUnavailable(SERIAL, UNAUTHORIZED).message)
        assertEquals(LOCATION_OFF_TEXT, BluetoothUnavailable(SERIAL, LOCATION_OFF).message)

        // Location off (API 30): finding a printer needs a scan, and a scan needs Location...
        val (bluetooth, fake) = make(LOCATION_OFF)
        fake.printer(addr)
        assertEquals(LOCATION_OFF, runCatching { bluetooth.connect(null, SERIAL) }.failure<BluetoothUnavailable>().availability)
        assertTrue(bluetooth.scan().toList().isEmpty())
        assertTrue(fake.connects.isEmpty())
        assertEquals(0, fake.scanStarts)
        // ... but a printer whose address is known is reached without one.
        assertEquals(addr, bluetooth.connect(addr, SERIAL).address)

        // Bluetooth switched off under a ready link.
        fake.report(POWERED_OFF)
        runCurrent()
        assertEquals(POWERED_OFF, bluetooth.availability.value)
        assertFalse(bluetooth.link.value.connected)
        assertNotNull(bluetooth.link.value.lastDrop)
        assertTrue(fake.links.single().closed)
        runCatching { bluetooth.transport(printer()).write(listOf(ByteArray(1))) }.failure<BluetoothUnavailable>()

        // Turned back on; a permission granted later is read on the next use, or on refresh.
        fake.report(READY)
        runCurrent()
        assertEquals(READY, bluetooth.availability.value)
        fake.state = UNAUTHORIZED
        bluetooth.refreshAvailability()
        runCurrent()
        assertEquals(UNAUTHORIZED, bluetooth.availability.value)

        // The adapter's own reading: no LE radio, then permission, then the switch, then Location.
        assertEquals(UNSUPPORTED, bluetoothAvailability(false, false, false, false, true, false))
        assertEquals(UNAUTHORIZED, bluetoothAvailability(true, false, false, false, true, false))
        assertEquals(UNKNOWN, bluetoothAvailability(true, true, false, true, true, true))
        assertEquals(POWERED_OFF, bluetoothAvailability(true, true, false, false, true, false))
        assertEquals(LOCATION_OFF, bluetoothAvailability(true, true, true, false, true, false))
        assertEquals(READY, bluetoothAvailability(true, true, true, false, false, false))
        assertEquals(READY, bluetoothAvailability(true, true, true, false, true, true))
    }

    @Test fun locationTurningOffEndsASearchBySerial() = runTest {
        val (bluetooth, fake) = make()
        fake.printer(addr2)
        val search = start { bluetooth.connect(null, SERIAL) }
        runCurrent()
        assertTrue(fake.scanning)
        fake.report(LOCATION_OFF)
        runCurrent()
        assertEquals(LOCATION_OFF, search.await().failure<BluetoothUnavailable>().availability)
        assertFalse(fake.scanning)
        assertTrue(fake.connects.isEmpty())
    }

    @Test fun waitsWhileBluetoothIsUnknownUntilItIsReady() = runTest {
        val (bluetooth, fake) = make(UNKNOWN) // turning on
        fake.printer(addr)
        val connect = start { bluetooth.connect(addr, SERIAL) }
        runCurrent()
        advanceTimeBy(2_000)
        runCurrent()
        assertFalse(connect.isCompleted)
        assertTrue("nothing is tried while Bluetooth is turning on", fake.connects.isEmpty())
        fake.report(READY)
        runCurrent()
        assertEquals(addr, connect.await().getOrThrow().address)
        assertEquals(listOf(addr), fake.connects)
        assertEquals(READY, bluetooth.availability.value)
    }

    @Test fun transportIsForBluetoothPrintersOnly() = runTest {
        val (bluetooth, _) = make()
        val network = SavedPrinter("10.0.0.5", "ZD421", SERIAL, 203)
        assertTrue(runCatching { bluetooth.transport(network) }.exceptionOrNull() is IllegalArgumentException)
        assertEquals(SERIAL, bluetooth.transport(printer()).address)
        assertEquals(
            "The Bluetooth device found for D8J224508535 isn't a Zebra printer.",
            BluetoothNotZebra(SERIAL).message,
        )
    }

    @Test fun aFailedEventIsLoggedAndTheLinkCarriesOn() = runTest {
        val logged = mutableListOf<Pair<String, Throwable>>()
        val (bluetooth, fake) = make(log = { message, e -> logged += message to e })
        val gatt = ready(bluetooth, fake)
        val zebra = bluetooth.transport(printer())
        // A reply check that throws while an indication is handled.
        val broken = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION) { throw IllegalStateException("bad check") } }
        runCurrent()
        gatt.indicate(hi)
        runCurrent()
        assertEquals(1, logged.size)
        assertEquals("bad check", logged.single().second.message)
        advanceTimeBy(ZebraBluetoothSpec.QUERY_IDLE_MS)
        runCurrent()
        assertEquals("the query still ends on quiet", hi, broken.await().getOrThrow())

        // The next event and the next call are handled as usual.
        advanceTimeBy(1_000)
        val next = start { zebra.query(ZebraCommands.HOST_IDENTIFICATION, frames(1)) }
        runCurrent()
        gatt.indicate(hi)
        runCurrent()
        assertEquals(hi, next.await().getOrThrow())
        assertEquals(1, logged.size)
    }

    // --- Scanning ---

    @Test fun scanSortsZebrasFirstAndUsesTheScanRecordName() = runTest {
        val (bluetooth, fake) = make()
        val lists = mutableListOf<List<FoundBluetoothPrinter>>()
        val collecting = launch { bluetooth.scan().collect { lists += it } }
        runCurrent()
        assertTrue(fake.scanning)
        fake.advertise("00:00:00:00:00:01", "Jimmy's Pixel", -40)
        fake.advertise("00:00:00:00:00:02", SERIAL, -70)
        fake.advertise("00:00:00:00:00:03", "XXJ111111111", -50)
        fake.advertise("00:00:00:00:00:04", "Printer X", -80, advertisesZebra = true)
        fake.advertise("00:00:00:00:00:05", null, -30) // its scan record carries no name: not listed
        fake.advertise("00:00:00:00:00:06", "Headphones", -45)
        runCurrent()
        assertEquals(
            listOf("XXJ111111111", SERIAL, "Printer X", "Jimmy's Pixel", "Headphones"),
            lists.last().map { it.name },
        )
        assertEquals(listOf(true, true, true, false, false), lists.last().map { it.isZebra })

        // A signal change within its 10 dB step reorders nothing; one into Jimmy's step ties on
        // signal and sorts by name (refreshed within half a second).
        fake.advertise("00:00:00:00:00:06", "Headphones", -41)
        advanceTimeBy(600)
        runCurrent()
        assertEquals(listOf("Jimmy's Pixel", "Headphones"), lists.last().takeLast(2).map { it.name })
        fake.advertise("00:00:00:00:00:06", "Headphones", -35)
        advanceTimeBy(600)
        runCurrent()
        assertEquals(listOf("Headphones", "Jimmy's Pixel"), lists.last().takeLast(2).map { it.name })
        assertEquals(-35, lists.last().first { it.name == "Headphones" }.rssi)

        // It ends by itself after SCAN_MS.
        advanceTimeBy(ZebraBluetoothSpec.SCAN_MS)
        runCurrent()
        assertTrue(collecting.isCompleted)
        assertFalse(fake.scanning)

        // stopScan() ends it early, and so does a connect.
        val stopped = launch { bluetooth.scan().collect {} }
        runCurrent()
        assertTrue(fake.scanning)
        bluetooth.stopScan()
        runCurrent()
        assertTrue(stopped.isCompleted)
        assertFalse(fake.scanning)

        val beforeConnect = launch { bluetooth.scan().collect {} }
        runCurrent()
        assertTrue(fake.scanning)
        ready(bluetooth, fake)
        runCurrent()
        assertTrue(beforeConnect.isCompleted)
        assertFalse(fake.scanning)
    }
}
