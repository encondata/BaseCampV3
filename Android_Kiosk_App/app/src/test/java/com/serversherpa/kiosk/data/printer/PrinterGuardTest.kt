package com.serversherpa.kiosk.data.printer

import android.app.Application
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.PrinterIdentity
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.labels.identity
import com.serversherpa.kiosk.core.printer.DirectoryEntry
import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.PrinterNeedsRestart
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.data.prefs.PrinterStopsStore
import com.serversherpa.kiosk.data.printer.PrinterGuard.State
import com.serversherpa.kiosk.testContainer
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A printer that records what reaches it, in order: each send's text, each font as `font NAME`,
 *  and each query as `?name`. A write that fails never counts as written. */
private class RecordingZebra : SetupZebra {
    private val lock = Any()
    private val _events = ArrayList<String>()
    private var failWrites = 0
    private var refuse = 0
    @Volatile var timeouts = false
    /** Queries fail with no reply while false. */
    @Volatile var answers = true

    /** Everything that reached the printer, in order. */
    val events: List<String> get() = synchronized(lock) { _events.toList() }
    /** Sends and fonts only. */
    val written: List<String> get() = events.filter { !it.startsWith("?") }

    /** The next [n] writes fail part-way: a font after its bytes started (it reports progress
     *  first), a send as unreachable, or as a timeout while [timeouts]. */
    fun failWrites(n: Int) = synchronized(lock) { failWrites = n }
    /** The next [n] writes find nothing listening: they fail before anything is sent. */
    fun refuse(n: Int) = synchronized(lock) { refuse = n }

    private enum class Outcome { REFUSED, FAILED, WRITTEN }

    private fun write(what: String): Outcome = synchronized(lock) {
        when {
            refuse > 0 -> { refuse--; Outcome.REFUSED }
            failWrites > 0 -> { failWrites--; Outcome.FAILED }
            else -> { _events += what; Outcome.WRITTEN }
        }
    }

    private fun failure(): Exception = if (timeouts) PrinterTimeout(HOST) else PrinterUnreachable(HOST)

    private fun ask(what: String) {
        synchronized(lock) { _events += "?$what" }
        if (!answers) throw PrinterNoReply(HOST)
    }

    override suspend fun identify(): HostId { ask("identify"); return HostId("ZD421", "V1", 8, "8192", 203) }
    override suspend fun serial(): String? { ask("serial"); return "S1" }
    override suspend fun status(): HostStatus {
        ask("status")
        return HostStatus(false, false, 0, 0, false, false, false, false, false, false, false, false, "0", false, 0)
    }
    override suspend fun peelerPresent(): Boolean? { ask("peeler"); return null }
    override suspend fun fonts(): List<String> { ask("fonts"); return emptyList() }
    override suspend fun fontEntries(): List<DirectoryEntry> { ask("fontEntries"); return emptyList() }
    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String { ask(command); return "" }

    override suspend fun send(zpl: String) {
        when (write(zpl)) {
            Outcome.REFUSED -> throw PrinterUnreachable(HOST)
            Outcome.FAILED -> throw failure()
            Outcome.WRITTEN -> Unit
        }
    }

    override suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress?) {
        when (write("font $name")) {
            Outcome.REFUSED -> throw PrinterUnreachable(HOST)
            Outcome.FAILED -> {
                progress?.invoke(0, bytes.size.toLong()) // the download started
                throw failure()
            }
            Outcome.WRITTEN -> {
                progress?.invoke(0, bytes.size.toLong())
                progress?.invoke(bytes.size.toLong(), bytes.size.toLong())
            }
        }
    }

    companion object {
        const val HOST = "10.0.0.5"
    }
}

/**
 * The `~JX` clear after a failed send (D16) and the stop after a cut font install (D8), on both
 * ways bytes reach the printer: Print Labels' sender and Printer Setup's [LockedZebra]. Each mark
 * belongs to the printer it happened on.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrinterGuardTest {
    private val printer = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)
    private val other = SavedPrinter("10.0.0.6", "ZD421", "S2", 203)
    private val a: PrinterConnection get() = printer.connection
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After fun tearDown() = scope.cancel()

    /** A DataStore of its own (one app launch's prefs, shared by the containers of a relaunch test). */
    private fun freshStore(): DataStore<Preferences> {
        val app = ApplicationProvider.getApplicationContext<Application>()
        return PreferenceDataStoreFactory.create(scope = scope) { File(app.cacheDir, "guard-${UUID.randomUUID()}.preferences_pb") }
    }

    /** The container's Print Labels sender over [zebra]. */
    private fun sender(zebra: RecordingZebra, guard: PrinterGuard): LabelSender =
        lockedSender(PrinterLock(), guard) { _, zpl -> zebra.send(zpl) }

    /** Printer Setup's view of [zebra] as [p]. */
    private fun setup(zebra: RecordingZebra, guard: PrinterGuard, p: SavedPrinter = printer) =
        LockedZebra(zebra, p.connection, PrinterLock(), guard)

    private inline fun <reified T : Throwable> throws(crossinline block: suspend () -> Unit): T =
        assertThrows(T::class.java) { runBlocking { block() } }

    @Test fun failedSendClearsBeforeNextLabel() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val send = sender(zebra, guard)
        zebra.failWrites(1)
        throws<PrinterUnreachable> { send.send(printer, "A") }
        assertEquals(State.NEEDS_CLEAR, guard.state(a))

        send.send(printer, "B")
        assertEquals(listOf("~JX", "B"), zebra.written)
        assertEquals(State.CLEAN, guard.state(a))

        // A normal label never carries the clear.
        send.send(printer, "C")
        assertEquals(listOf("~JX", "B", "C"), zebra.written)
    }

    /** D16: Printer Setup's checks clear first too, and the mark clears with that `~JX`. */
    @Test fun aFailedSendClearsBeforeTheNextQuery() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val setup = setup(zebra, guard)
        zebra.failWrites(1)
        throws<PrinterUnreachable> { setup.send("TEST") }
        setup.identify()
        assertEquals(listOf("~JX", "?identify"), zebra.events)
        assertEquals(State.CLEAN, guard.state(a))
        setup.send("TEST")
        assertEquals(listOf("~JX", "?identify", "TEST"), zebra.events)
    }

    /** Every query through [LockedZebra] honors a pending clear: identify, serial, status, peeler,
     *  fonts and the font listing. */
    @Test fun everyQueryClearsFirst() = runBlocking<Unit> {
        val queries: List<Pair<String, suspend (LockedZebra) -> Unit>> = listOf(
            "identify" to { z -> z.identify() },
            "serial" to { z -> z.serial() },
            "status" to { z -> z.status() },
            "peeler" to { z -> z.peelerPresent() },
            "fonts" to { z -> z.fonts() },
            "fontEntries" to { z -> z.fontEntries() },
        )
        for ((name, query) in queries) {
            val zebra = RecordingZebra()
            val guard = PrinterGuard()
            guard.markSendFailed(a)
            val setup = setup(zebra, guard)
            query(setup)
            query(setup)
            assertEquals(name, listOf("~JX", "?$name", "?$name"), zebra.events)
        }
    }

    /** Printer Setup's sends and font installs clear the same way. */
    @Test fun aFailedSetupSendClearsBeforeTheNextFont() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val setup = setup(zebra, guard)
        zebra.failWrites(1)
        throws<PrinterUnreachable> { setup.send("TEST") }
        setup.installFont("ROBOTO.TTF", byteArrayOf(1))
        assertEquals(listOf("~JX", "font ROBOTO.TTF"), zebra.written)
        setup.send("TEST")
        assertEquals(listOf("~JX", "font ROBOTO.TTF", "TEST"), zebra.written)
    }

    /** The mark clears only once `~JX` is delivered: a clear that fails is its own error (the job
     *  never went out), sends nothing else, and the next send clears again. */
    @Test fun aClearThatFailsKeepsTheMark() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val send = sender(zebra, guard)
        zebra.failWrites(2) // the label, then its clear
        zebra.timeouts = true
        throws<PrinterTimeout> { send.send(printer, "A") }
        val failed = throws<PrinterClearFailed> { send.send(printer, "B") }
        assertTrue(failed.cause is PrinterTimeout)
        assertEquals("10.0.0.5", failed.host)
        assertTrue(zebra.written.isEmpty())
        assertEquals(State.NEEDS_CLEAR, guard.state(a))
        send.send(printer, "C")
        assertEquals(listOf("~JX", "C"), zebra.written)
    }

    @Test fun clearUsesJX() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        guard.markSendFailed(a)
        sender(zebra, guard).send(printer, "^XA^XZ")
        assertEquals(listOf("~JX", "^XA^XZ"), zebra.written)
        // Exactly the three bytes of `~JX` (cancel the partial format), never `~JA` (cancel all).
        assertEquals("~JX", ZebraCommands.CANCEL_PARTIAL_FORMAT)
        assertArrayEquals(byteArrayOf(0x7E, 0x4A, 0x58), zebra.written[0].toByteArray(Charsets.UTF_8))
    }

    @Test fun fontCutBlocksSendsUntilAPrinterAnswers() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val setup = setup(zebra, guard)
        val send = sender(zebra, guard)
        zebra.failWrites(1)
        throws<PrinterUnreachable> { setup.installFont("ROBOTO.TTF", byteArrayOf(1, 2)) }
        assertEquals(State.FONT_CUT, guard.state(a))

        // Nothing more is sent: test labels, labels, fonts.
        val refused = throws<PrinterNeedsRestart> { setup.send("TEST") }
        assertEquals(FONT_INSTALL_CUT_TEXT, refused.message)
        throws<PrinterNeedsRestart> { send.send(printer, "LABEL") }
        throws<PrinterNeedsRestart> { setup.installFont("ROBOTO.TTF", byteArrayOf(1, 2)) }
        // A failed send doesn't soften it to a clear.
        guard.markSendFailed(a)
        assertEquals(State.FONT_CUT, guard.state(a))

        // Queries still go out (no clear: the printer would take it as font data), and one that
        // gets no answer keeps the stop.
        setup.status()
        setup.fontEntries()
        zebra.answers = false
        throws<PrinterNoReply> { setup.identify() }
        assertEquals(State.FONT_CUT, guard.state(a))
        assertTrue(zebra.written.isEmpty())

        // The printer answers (it was restarted): sends go out again, with no clear first.
        zebra.answers = true
        setup.identify()
        assertEquals(State.CLEAN, guard.state(a))
        send.send(printer, "LABEL")
        assertEquals(listOf("LABEL"), zebra.written)
    }

    /** Only a download whose bytes started going out leaves the printer waiting for the rest: one
     *  that found nothing listening leaves the state as it was; a refused font name sends nothing. */
    @Test fun aFontIsCutOnlyOnceItsBytesStarted() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val setup = setup(zebra, guard)
        zebra.refuse(1)
        throws<PrinterUnreachable> { setup.installFont("ROBOTO.TTF", byteArrayOf(1, 2)) }
        assertEquals(State.CLEAN, guard.state(a))

        val refusedName = LockedZebra(TransportSetupZebra(NetworkZebra("127.0.0.1", 9)), a, PrinterLock(), guard)
        throws<IllegalArgumentException> { refusedName.installFont("A,B.TTF", byteArrayOf(1)) }
        assertEquals(State.CLEAN, guard.state(a))

        zebra.failWrites(1)
        throws<PrinterUnreachable> { setup.installFont("ROBOTO.TTF", byteArrayOf(1, 2)) }
        assertEquals(State.FONT_CUT, guard.state(a))
    }

    /** A mark belongs to the printer it happened on: another printer gets no `~JX` and no stop,
     *  and the marked one keeps its mark. */
    @Test fun marksBelongToTheirPrinter() = runBlocking<Unit> {
        val zebra = RecordingZebra()
        val guard = PrinterGuard()
        val send = sender(zebra, guard)
        guard.markSendFailed(a)
        send.send(other, "B1")
        setup(zebra, guard, other).identify()
        assertEquals(listOf("B1", "?identify"), zebra.events)
        assertEquals(State.NEEDS_CLEAR, guard.state(a))

        guard.markFontCut(a)
        send.send(other, "B2")
        setup(zebra, guard, other).installFont("ROBOTO.TTF", byteArrayOf(1))
        assertEquals(listOf("B1", "B2", "font ROBOTO.TTF"), zebra.written)
        assertEquals(State.FONT_CUT, guard.state(a))
        assertEquals(State.CLEAN, guard.state(other.connection))

        // B's own failure marks B alone.
        zebra.failWrites(1)
        throws<PrinterUnreachable> { send.send(other, "B3") }
        assertEquals(State.NEEDS_CLEAR, guard.state(other.connection))
        assertEquals(State.FONT_CUT, guard.state(a))
    }

    /** A mark belongs to the printer, not to the way it was reached: a Bluetooth printer saved
     *  again at another address (or none), or with its serial in another case, is the same printer
     *  and keeps its mark (iOS keys by host or upper-cased serial: Ruling 7). */
    @Test fun aMarkIsKeyedByThePrintersIdentityNotItsAddress() = runBlocking<Unit> {
        val guard = PrinterGuard()
        val atA = PrinterConnection.Bluetooth("D8J224508535", "AC:3F:A4:00:00:01")
        val atB = PrinterConnection.Bluetooth("d8j224508535", "AC:3F:A4:00:00:02")
        val noAddress = PrinterConnection.Bluetooth("D8J224508535", null)
        guard.markSendFailed(atA)
        assertEquals(State.NEEDS_CLEAR, guard.state(atB))
        assertEquals(State.NEEDS_CLEAR, guard.state(noAddress))
        guard.markFontCut(atB)
        assertEquals(State.FONT_CUT, guard.state(atA))
        guard.printerAnswered(noAddress)
        assertEquals(State.CLEAN, guard.state(atA))
        // Another serial is another printer; a network host is its own.
        guard.markFontCut(atA)
        assertEquals(State.CLEAN, guard.state(PrinterConnection.Bluetooth("XXJ224508599", "AC:3F:A4:00:00:01")))
        assertEquals(State.CLEAN, guard.state(a))
        assertEquals(PrinterIdentity.Bluetooth("D8J224508535"), atB.identity)
        assertEquals(PrinterIdentity.Network("10.0.0.5"), a.identity)
    }

    /** Ruling 16: marks are keyed to their printer, so saving another printer drops none of them:
     *  a printer left needing a clear still gets its `~JX` after A→B→A, and a cut font's stop stays
     *  through a switch to Bluetooth, to none, and through Reset app (the printer is still waiting
     *  for the rest of the font). */
    @Test fun marksStayWhenAnotherPrinterIsSaved() = runBlocking<Unit> {
        val c = testContainer()
        try {
            val guard = c.printerGuard
            c.labelSettings.setPrinter(printer)
            guard.markSendFailed(a)

            // A → B → A: A's clear is still owed.
            c.labelSettings.setPrinter(other)
            c.labelSettings.setPrinter(printer)
            assertEquals(State.NEEDS_CLEAR, guard.state(a))
            val zebra = RecordingZebra()
            lockedSender(c.printerLock, guard) { _, zpl -> zebra.send(zpl) }.send(printer, "LABEL")
            assertEquals(listOf("~JX", "LABEL"), zebra.written)

            // B's cut font through a Bluetooth printer, none at all, and Reset app.
            val bluetooth = PrinterConnection.Bluetooth("D8J224508535", "00:11:22:33:44:55")
            guard.markFontCut(other.connection)
            c.labelSettings.setPrinter(SavedPrinter(bluetooth, "ZD421", "D8J224508535", 300))
            assertEquals(State.FONT_CUT, guard.state(other.connection))
            c.labelSettings.setPrinter(null)
            assertEquals(State.FONT_CUT, guard.state(other.connection))
            c.labelSettings.setPrinter(printer)
            c.resetApp(clearLocalData = {})
            assertEquals(State.FONT_CUT, guard.state(other.connection))
            assertNotNull(c.prefs.snapshot()[stringPreferencesKey("ss.kiosk.printerStops")])
        } finally {
            c.scope.cancel()
            c.db.close()
        }
    }

    /** D8 outlives a relaunch: a font install cut off (the crew switched apps mid-install, then
     *  Android killed the kiosk) leaves the printer waiting for the rest of the font, so the next
     *  launch still refuses labels to it until it answers a check, which lifts the stop for good.
     *  A pending clear stays in memory (D16): a relaunch forgets it. */
    @Test fun aCutFontStopOutlivesARelaunch() = runBlocking<Unit> {
        val store = freshStore()
        val zebra = RecordingZebra()
        val containers = ArrayList<AppContainer>()
        fun launch(): AppContainer = testContainer(dataStore = store).also { containers += it }
        try {
            val first = launch()
            zebra.failWrites(1)
            val cutting = LockedZebra(zebra, a, first.printerLock, first.printerGuard)
            throws<PrinterUnreachable> { cutting.installFont("ROBOTO.TTF", byteArrayOf(1, 2)) }
            assertEquals(State.FONT_CUT, first.printerGuard.state(a))
            first.printerGuard.markSendFailed(other.connection)

            // Killed and launched again: still stopped, and only that printer. The stop is in place
            // before anything can be sent.
            val second = launch()
            val send = lockedSender(second.printerLock, second.printerGuard) { _, zpl -> zebra.send(zpl) }
            throws<PrinterNeedsRestart> { send.send(printer, "LABEL") }
            assertTrue(zebra.written.isEmpty())
            assertEquals(State.FONT_CUT, second.printerGuard.state(a))
            assertEquals(State.CLEAN, second.printerGuard.state(other.connection))
            send.send(other, "B1")
            assertEquals(listOf("B1"), zebra.written)

            // Restarted, it answers a check: the stop lifts, here and in every later launch.
            LockedZebra(zebra, a, second.printerLock, second.printerGuard).identify()
            assertEquals(State.CLEAN, second.printerGuard.state(a))
            val third = launch()
            lockedSender(third.printerLock, third.printerGuard) { _, zpl -> zebra.send(zpl) }.send(printer, "LABEL")
            assertEquals(listOf("B1", "LABEL"), zebra.written)
            assertEquals(State.CLEAN, third.printerGuard.state(a))
        } finally {
            for (c in containers) {
                c.scope.cancel()
                c.db.close()
            }
        }
    }

    /** The stops are kept by printer identity (a network host, or a Bluetooth serial in any case),
     *  under `ss.kiosk.printerStops` in iOS's JSON shape; an unreadable value keeps none. */
    @Test fun stopsAreKeptByPrinterIdentity() = runBlocking<Unit> {
        val store = freshStore()
        val key = stringPreferencesKey("ss.kiosk.printerStops")
        val stops = PrinterStopsStore(store)
        val first = PrinterGuard(stops, scope)
        val bluetooth = PrinterConnection.Bluetooth("d8j224508535", "AC:3F:A4:00:00:01")
        first.markFontCut(bluetooth)
        first.markFontCut(a)
        assertEquals(
            """[{"type":"bluetooth","serial":"D8J224508535"},{"type":"network","host":"10.0.0.5"}]""",
            store.data.first()[key],
        )
        assertEquals(setOf(PrinterIdentity.Bluetooth("D8J224508535"), PrinterIdentity.Network("10.0.0.5")), stops.load())
        // A pending clear isn't kept.
        first.markSendFailed(other.connection)
        assertEquals(2, stops.load().size)

        val again = PrinterGuard(stops, scope)
        again.awaitRestored()
        assertEquals(State.FONT_CUT, again.state(PrinterConnection.Bluetooth("D8J224508535", "AC:3F:A4:00:00:09")))
        assertEquals(State.FONT_CUT, again.state(a))
        assertEquals(State.CLEAN, again.state(other.connection))
        again.printerAnswered(a)
        assertEquals(setOf(PrinterIdentity.Bluetooth("D8J224508535")), stops.load())
        again.printerAnswered(bluetooth)
        assertNull("none left: the key goes", store.data.first()[key])

        store.edit { it[key] = "not json" }
        assertTrue(stops.load().isEmpty())
        val unreadable = PrinterGuard(stops, scope)
        unreadable.awaitRestored()
        assertEquals(State.CLEAN, unreadable.state(bluetooth))
    }

    /** The container reaches a Bluetooth printer over the Bluetooth link, never over TCP (host
     *  ""): with Bluetooth off, every call says so, naming its serial. */
    @Test fun aBluetoothPrinterNeverFallsThroughToTcp() = runBlocking<Unit> {
        val c = testContainer(bluetooth = FakeBluetoothLe(BluetoothAvailability.POWERED_OFF))
        val bt = SavedPrinter(PrinterConnection.Bluetooth("D8J224508535", null), "ZD421", "D8J224508535", 300)
        val z = c.zebraFor(bt)
        assertTrue(z is BluetoothZebra)
        assertEquals("D8J224508535", z.address)
        for (e in listOf(
            throws<BluetoothUnavailable> { z.identify() },
            throws<BluetoothUnavailable> { z.send("^XA^XZ") },
            throws<BluetoothUnavailable> { c.labelSender.send(bt, "^XA^XZ") },
        )) {
            assertEquals("D8J224508535", e.host)
            assertEquals(BluetoothAvailability.POWERED_OFF, e.availability)
        }
    }
}
