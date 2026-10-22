package com.serversherpa.kiosk.ui.screens.settings

import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelPick
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.core.settings.SETTINGS_TABS
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothDrop
import com.serversherpa.kiosk.data.printer.BluetoothLinkInfo
import com.serversherpa.kiosk.data.printer.BluetoothPairingLost
import com.serversherpa.kiosk.data.printer.BluetoothPrinterInfo
import com.serversherpa.kiosk.data.printer.BluetoothUnavailable
import com.serversherpa.kiosk.data.printer.FakeBluetoothPrinting
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.data.printer.LabelSender
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.PrinterNoReply
import com.serversherpa.kiosk.data.printer.lockedSender
import com.serversherpa.kiosk.ui.screens.labels.AlignmentSize
import com.serversherpa.kiosk.ui.screens.labels.printerSummary
import java.time.ZoneOffset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout

/**
 * Settings › Troubleshooting (D13, D16): every call to the printer goes through the app's printer
 * lock and guard (never taking the lock twice), the command box is for admins and developers and
 * the Cut-send test for developers (both checked again when used), the link's details show an
 * address the printer answered at without ever saving it, and the report carries everything the
 * tab found and nothing secret.
 */
class TroubleshootingModelTest {
    /** A printer lock taken twice would hang: fail instead. */
    @get:Rule val timeout: Timeout = Timeout.seconds(30)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = PrinterLock()
    private val guard = PrinterGuard()
    private val bluetooth = FakeBluetoothPrinting()
    private val zebra = TroubleZebra()
    private val network = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)
    private val bluetoothPrinter =
        SavedPrinter(PrinterConnection.Bluetooth(ZD421_SERIAL, SAVED_ADDRESS), "ZD421", ZD421_SERIAL, 300)
    private val allReplies = mapOf(
        ZebraCommands.HOST_STATUS to HS_REPLY, "~HQES" to HQES_REPLY, DPI_COMMAND to "\"300\"",
        ZebraCommands.PEELER_PRESENT to "\"Present\"", ZebraCommands.SERIAL_NUMBER to "\"$ZD421_SERIAL\"",
        ZebraCommands.FONT_DIRECTORY to HW_REPLY,
    )

    @After fun tearDown() = scope.cancel()

    /** A model on [printer], its settings read before it is handed back. */
    private fun model(
        printer: SavedPrinter? = network,
        isAdmin: () -> Boolean = { false },
        isDeveloper: () -> Boolean = { false },
        pick: LabelPick? = null,
    ): TroubleshootingModel = runBlocking {
        val m = TroubleshootingModel(
            settings = FixedSettings(printer), bluetooth = bluetooth, zebraFor = { zebra },
            printerLock = lock, printerGuard = guard, isAdmin = isAdmin, isDeveloper = isDeveloper,
            pick = MutableStateFlow(pick), device = { DEVICE_TEXT }, scopeOverride = scope, zone = ZoneOffset.UTC,
        )
        eventually("settings read") { m.state.value.settings != null }
        m
    }

    /** Print Labels' send, as the container wires it (`lockedSender` around the transport). */
    private val printLabels: LabelSender = lockedSender(lock, guard) { _, zpl -> zebra.send(zpl) }

    private suspend fun eventually(what: String, cond: suspend () -> Boolean) {
        try {
            withTimeout(5_000) { while (!cond()) delay(5) }
        } catch (e: Exception) {
            throw AssertionError("never: $what", e)
        }
    }

    // --- The tab ---

    @Test fun troubleshootingTabVisibleSignedIn() {
        assertEquals(
            listOf(SettingsTabId.APPEARANCE, SettingsTabId.SOUND, SettingsTabId.DEVICES, SettingsTabId.TROUBLESHOOTING, SettingsTabId.RFID, SettingsTabId.THIS_KIOSK),
            visibleTabs(isAdmin = false, isDeveloper = false, signedIn = true).map { it.id },
        )
        assertFalse(visibleTabs(isAdmin = true, isDeveloper = true, signedIn = false).any { it.id == SettingsTabId.TROUBLESHOOTING })
        val tab = SETTINGS_TABS.first { it.id == SettingsTabId.TROUBLESHOOTING }
        assertEquals("Troubleshooting", tab.label)
        assertEquals("Printer connection, tests and a report to share.", tab.blurb)
        assertNull(tab.requires)
        assertEquals(SettingsTabId.TROUBLESHOOTING, SettingsTabId.fromWire("troubleshooting"))
    }

    @Test fun nothingStartsBluetoothOrReachesThePrinterUntilTapped() = runBlocking<Unit> {
        val m = model(bluetoothPrinter, isAdmin = { true }, isDeveloper = { true })
        m.open()
        m.connectionLines()
        m.report()
        m.close()
        delay(50)
        assertEquals(0, bluetooth.scans)
        assertTrue(bluetooth.connects.isEmpty())
        assertTrue(zebra.events.isEmpty())
    }

    // --- One printer connection at a time (ruling 1) ---

    /** The speed test and Print Labels share the app's printer lock: a speed-test label never goes
     *  out while a scanned label is, nor the other way (Review Focus 5). */
    @Test fun troubleshootingSendsGoThroughPrinterLock() = runBlocking<Unit> {
        val line = TroubleLine()
        zebra.line = line
        val m = model()

        // A speed-test label going out holds the printer: the scanned label waits its turn.
        line.hold = "START"
        val speed = m.startSpeedTest()!!
        eventually("speed-test label on the printer") { line.held }
        val asset = async(Dispatchers.Default) { printLabels.send(network, "^XA^FDASSET^FS^XZ") }
        delay(60)
        assertEquals(1, line.started.size)
        line.hold = null
        asset.await()
        speed.join()
        assertEquals(2, line.started.size)
        assertEquals("^XA^FDASSET^FS^XZ", line.started.last())

        // And the other way: a scanned label going out holds the speed test.
        line.held = false
        line.hold = "ASSET"
        val second = async(Dispatchers.Default) { printLabels.send(network, "^XA^FDASSET^FS^XZ") }
        eventually("scanned label on the printer") { line.held }
        val speed2 = m.startSpeedTest()!!
        delay(60)
        assertEquals(3, line.started.size)
        line.hold = null
        second.await()
        speed2.join()
        assertEquals(4, line.started.size)
        assertTrue(line.started.last().contains("START"))
        assertEquals(1, line.maxOpen.get())
        val rows = m.state.value.speedRows
        assertEquals(2, rows.size)
        assertTrue(rows.all { it.error == null && it.seconds != null })
    }

    /** The lock isn't reentrant, so no action takes it while holding it: actions run back to back
     *  (the Cut-send test takes it twice in a row), and one asked for while a print job holds the
     *  lock waits for it, then runs. Nothing deadlocks, and nothing overlaps. */
    @Test fun actionsBackToBackAndBehindAPrintJobNeverDeadlock() = runBlocking<Unit> {
        val line = TroubleLine()
        zebra.line = line
        zebra.replies = allReplies
        val m = model(isDeveloper = { true })
        withTimeout(5_000) {
            m.ask(PrinterAsk.STATUS)!!.join()
            m.startSpeedTest()!!.join()
            m.runCutSendTest()!!.join()
            m.readDetails()!!.join()
        }
        // Status, the speed label, the half label, ~JX and the full label, then ~HI.
        assertEquals(6, line.started.size)
        assertEquals("?~HS", line.started[0])
        assertTrue(line.started[1].contains("START"))
        assertEquals("~JX", line.started[3])
        assertEquals("?~HI", line.started.last())

        // A print job holds the lock: the ask waits for it, then goes.
        line.hold = "ASSET"
        line.held = false
        val job = async(Dispatchers.Default) { printLabels.send(network, "^XA^FDASSET^FS^XZ") }
        eventually("scanned label on the printer") { line.held }
        val ask = m.ask(PrinterAsk.DPI)!!
        delay(60)
        assertEquals("^XA^FDASSET^FS^XZ", line.started.last())
        assertTrue(m.state.value.busy)
        line.hold = null
        withTimeout(5_000) {
            job.await()
            ask.join()
        }
        assertEquals("?$DPI_COMMAND", line.started.last())
        assertEquals(1, line.maxOpen.get())
        assertFalse(m.state.value.busy)
        // One action at a time: a second tap while one runs starts nothing.
        line.hold = "~HS"
        line.held = false
        val first = m.ask(PrinterAsk.STATUS)!!
        eventually("status on the printer") { line.held }
        assertNull(m.ask(PrinterAsk.SERIAL))
        assertNull(m.startSpeedTest())
        line.hold = null
        first.join()
    }

    /** The ask buttons go through the guard: a printer left needing a clear gets `~JX` first. */
    @Test fun asksClearFirstWhenThePrinterNeedsIt() = runBlocking<Unit> {
        zebra.replies = mapOf(ZebraCommands.HOST_STATUS to HS_REPLY)
        guard.markSendFailed(network.connection)
        val m = model()
        m.ask(PrinterAsk.STATUS)!!.join()
        assertEquals(listOf("~JX", "?~HS"), zebra.events.toList())
        assertEquals(PrinterGuard.State.CLEAN, guard.state(network.connection))
        val result = m.state.value.asks.last()
        assertEquals(HS_REPLY, result.reply)
        assertEquals(HS_REPLY.length, result.bytes)
        assertNotNull(result.milliseconds)
        assertTrue(result.meaning!!.startsWith("Ready to print."))
        assertNull(result.error)
    }

    @Test fun eachAskSendsItsCommandAndSaysWhatTheReplyMeans() = runBlocking<Unit> {
        zebra.replies = allReplies
        val m = model()
        for (ask in PrinterAsk.entries) m.ask(ask)!!.join()
        assertEquals(PrinterAsk.entries.map { "?" + it.command }, zebra.events.toList())
        val asks = m.state.value.asks
        assertEquals(listOf("Status", "Error report", "DPI", "Peeler", "Serial number", "Font listing"), asks.map { it.label })
        assertEquals(
            "Ready to print. Formats queued 0 · label waiting no · partial format no · buffer full no · print mode 1",
            asks[0].meaning,
        )
        assertNull(asks[1].meaning)
        assertEquals("300 dpi", asks[2].meaning)
        assertEquals("Present", asks[3].meaning)
        assertEquals(ZD421_SERIAL, asks[4].meaning)
        assertEquals("TT0003M_.TTF (169188 bytes)", asks[5].meaning)
        assertTrue(asks.all { it.error == null && it.bytes > 0 })

        // No reply says so (and how long it waited).
        zebra.replies = emptyMap()
        m.ask(PrinterAsk.PEELER)!!.join()
        assertEquals("No reply.", m.state.value.asks.last().error)
        assertNotNull(m.state.value.asks.last().milliseconds)
    }

    /** What a failed call says: the app's words for what can be fixed (with the Bluetooth refusals
     *  verbatim, so their buttons show), never a stray exception's own message. */
    @Test fun failuresSayWhatToDo() = runBlocking<Unit> {
        val m = model(bluetoothPrinter)
        zebra.failNext = BluetoothUnavailable(ZD421_SERIAL, BluetoothAvailability.POWERED_OFF)
        m.ask(PrinterAsk.STATUS)!!.join()
        assertEquals(BLUETOOTH_OFF_TEXT, m.state.value.asks.last().error)
        zebra.failNext = BluetoothPairingLost(ZD421_SERIAL)
        m.readDetails()!!.join()
        assertEquals(pairingLostText(ZD421_SERIAL), m.state.value.detailsError)
        zebra.failNext = IllegalStateException("socket said: hello")
        m.ask(PrinterAsk.SERIAL)!!.join()
        assertEquals("Something went wrong (IllegalStateException).", m.state.value.asks.last().error)
        assertFalse(m.report().text.contains("socket said"))
        zebra.failNext = com.serversherpa.kiosk.data.printer.PrinterUnreachable(ZD421_SERIAL)
        m.startSpeedTest()!!.join()
        assertEquals("Can't reach the printer D8J224508535 over Bluetooth.", m.state.value.speedRows.last().error)
    }

    // --- The command box and the Cut-send test (ruling 3) ---

    @Test fun freeTextOnlyForAdminsAndDevelopers() = runBlocking<Unit> {
        val hi = "\u0002ZD421-300dpi,V93.21.38Z,12,8176KB\u0003\r\n"
        zebra.replies = mapOf("~HI\r\n" to hi, "! U1 getvar \"device.languages\"\r\n" to "\"zpl\"")
        val crew = model()
        assertFalse(crew.showsCommandBox)
        crew.setCommandText("~HI")
        assertNull(crew.sendCommand())
        assertTrue(zebra.events.isEmpty())

        for ((admin, developer) in listOf(true to false, false to true)) {
            val m = model(isAdmin = { admin }, isDeveloper = { developer })
            assertTrue(m.showsCommandBox)
            m.setCommandText("~HI")
            m.sendCommand()!!.join()
            assertEquals("~HI\r\n", m.state.value.asks.last().command)
            assertEquals(hi, m.state.value.asks.last().reply)
        }
        assertEquals(listOf("?~HI\r\n", "?~HI\r\n"), zebra.events.toList())

        // Some keyboards type curly quotes; the printer needs straight ones.
        val admin = model(isAdmin = { true })
        admin.setCommandText("! U1 getvar “device.languages”")
        admin.sendCommand()!!.join()
        assertEquals("?! U1 getvar \"device.languages\"\r\n", zebra.events.last())
        assertEquals("\"zpl\"", admin.state.value.asks.last().reply)

        // A setvar replies nothing by design: it reads as sent, not failed.
        admin.setCommandText("! U1 setvar \"print.tone\" \"10\"")
        admin.sendCommand()!!.join()
        assertEquals("?! U1 setvar \"print.tone\" \"10\"\r\n", zebra.events.last())
        assertEquals(COMMAND_SENT_TEXT, admin.state.value.asks.last().meaning)
        assertNull(admin.state.value.asks.last().error)
        // An ask that gets no reply still says so.
        admin.ask(PrinterAsk.PEELER)!!.join()
        assertEquals("No reply.", admin.state.value.asks.last().error)

        // The role is read again when the command is sent: an admin signed out (or another person
        // signed in) since the tab opened sends nothing.
        var stillAdmin = true
        val m = model(isAdmin = { stillAdmin })
        m.setCommandText("~HI")
        stillAdmin = false
        assertFalse(m.showsCommandBox)
        assertNull(m.sendCommand())
        assertEquals(5, zebra.events.size)
    }

    @Test fun cutSendTestSendsJXBeforeTheFullLabel() = runBlocking<Unit> {
        val admin = model(isAdmin = { true })
        assertFalse(admin.showsCutSendTest)
        assertNull(admin.runCutSendTest())
        assertTrue(zebra.events.isEmpty())

        val developer = model(isDeveloper = { true })
        assertTrue(developer.showsCutSendTest)
        developer.runCutSendTest()!!.join()
        val events = zebra.events.toList()
        assertEquals(3, events.size)
        val full = events[2]
        assertTrue(full.startsWith("^XA^CI28^PW812^LL406"))
        assertTrue(full.endsWith("^XZ"))
        assertTrue(full.contains("^FDPrinter test^FS"))
        assertEquals(full.substring(0, full.length / 2), events[0])
        assertEquals("~JX", events[1])
        assertTrue(events.none { it.contains("~JA") })
        assertEquals(PrinterGuard.State.CLEAN, guard.state(network.connection))
        assertEquals(CUT_SEND_DONE_TEXT, developer.state.value.cutSendMessage)
        assertFalse(developer.state.value.cutSendError)

        // A developer no longer signed in can't run it.
        var dev = true
        val m = model(isDeveloper = { dev })
        dev = false
        assertNull(m.runCutSendTest())
        assertEquals(3, zebra.events.size)
    }

    /** The half label and its failure mark go in one turn of the lock: a scanned label queued
     *  behind the half gets the `~JX` first instead of merging into it. */
    @Test fun cutSendKeepsAQueuedLabelFromMergingIntoTheHalf() = runBlocking<Unit> {
        val line = TroubleLine()
        zebra.line = line
        val m = model(isDeveloper = { true })
        line.hold = "Printer test"
        val test = m.runCutSendTest()!!
        eventually("half label on the printer") { line.held }
        val asset = async(Dispatchers.Default) { printLabels.send(network, "^XA^FDASSET^FS^XZ") }
        delay(60)
        line.hold = null
        asset.await()
        test.join()
        val events = zebra.events.toList()
        assertEquals(4, events.size)
        assertFalse(events[0].endsWith("^XZ"))
        assertEquals("~JX", events[1])
        assertEquals("^XA^FDASSET^FS^XZ", events[2])
        assertTrue(events[3].endsWith("^XZ"))
        assertEquals(1, line.maxOpen.get())
    }

    // --- Speed test ---

    @Test fun speedTestPrintsOnTheTemplateSizeAndConfirmsMoreThanOneLabel() = runBlocking<Unit> {
        val pick = LabelPick(LabelKind.TOP, 203, synced = true, templateId = "t1", templateName = "Vegas Top", widthIn = 3.0, heightIn = 1.5)
        val m = model(pick = pick)
        eventually("pick read") { m.state.value.pick == pick }
        assertEquals(AlignmentSize(3.0, 1.5, 203), m.speedSize())
        m.setSpeedRuns(1)
        assertFalse(m.state.value.speedNeedsConfirm)
        m.setSpeedRuns(3)
        assertTrue(m.state.value.speedNeedsConfirm)
        m.setSpeedKb(25)
        m.startSpeedTest()!!.join()
        assertEquals(3, zebra.events.size)
        assertTrue(zebra.events.all { it.startsWith("^XA^CI28^PW609^LL305") })
        val rows = m.state.value.speedRows
        assertEquals(listOf(1, 2, 3), rows.map { it.run })
        assertTrue(rows.all { kotlin.math.abs(it.bytes - 25 * 1024) <= 512 && it.targetKb == 25 })
        assertNotNull(m.state.value.speedAverage)
    }

    @Test fun stoppingTheSpeedTestLetsTheLabelGoingOutFinish() = runBlocking<Unit> {
        val line = TroubleLine()
        zebra.line = line
        val m = model()
        m.setSpeedRuns(5)
        line.hold = "Run 1 "
        val run = m.startSpeedTest()!!
        eventually("run 1 on the printer") { line.held }
        m.stopSpeedTest()
        assertTrue(m.state.value.speedStopping)
        line.hold = null
        run.join()
        assertEquals(1, zebra.events.size)
        assertEquals(1, m.state.value.speedRows.size)
        assertNull(m.state.value.speedRows.first().error)
        assertFalse(m.state.value.speedStopping)
        assertNull(m.state.value.running)
    }

    @Test fun aCutFontStopsTheSpeedTestBeforeAnythingGoesOut() = runBlocking<Unit> {
        guard.markFontCut(network.connection)
        val m = model()
        m.setSpeedRuns(3)
        m.startSpeedTest()!!.join()
        assertTrue(zebra.events.isEmpty())
        assertEquals(1, m.state.value.speedRows.size)
        assertEquals(FONT_INSTALL_CUT_TEXT, m.state.value.speedRows.first().error)
    }

    // --- Bluetooth scan (ruling 6) ---

    @Test fun scanListsEveryNamedDeviceFlagsZebrasAndSavesNothing() = runBlocking<Unit> {
        val settings = FixedSettings(network)
        val m = TroubleshootingModel(
            settings, bluetooth, { zebra }, lock, guard, isAdmin = { false }, isDeveloper = { false },
            device = { DEVICE_TEXT }, scopeOverride = scope, zone = ZoneOffset.UTC,
        )
        eventually("settings read") { m.state.value.settings != null }
        m.scan()
        eventually("scanning") { bluetooth.scanning }
        assertTrue(m.state.value.scanning)
        val zd421 = FoundBluetoothPrinter(SAVED_ADDRESS, ZD421_SERIAL, -52, advertisesZebra = false)
        val mac = FoundBluetoothPrinter("11:22:33:44:55:66", "James’s Mac mini", -70, advertisesZebra = false)
        bluetooth.hear(zd421, mac)
        eventually("heard") { m.state.value.found == listOf(zd421, mac) }
        m.stopScan()
        eventually("scan ended") { !m.state.value.scanning }
        assertEquals(listOf(zd421), m.state.value.found!!.filter { it.isZebra })
        assertNull(m.state.value.scanMessage)
        assertEquals(network, settings.settings.value.printer)
        assertTrue(bluetooth.connects.isEmpty())
        assertTrue(zebra.events.isEmpty())

        // Bluetooth off: says so, then scans again by itself once it is on.
        bluetooth.availability.value = BluetoothAvailability.POWERED_OFF
        m.scan()
        eventually("refused") { m.state.value.scanMessage == BLUETOOTH_OFF_TEXT && !m.state.value.scanning }
        val scans = bluetooth.scans
        bluetooth.availability.value = BluetoothAvailability.READY
        eventually("scanning again") { bluetooth.scans == scans + 1 && m.state.value.scanning }
        m.stopScan()
        eventually("scan ended") { !m.state.value.scanning }
        assertEquals(NOTHING_HEARD_TEXT, m.state.value.scanMessage)

        // The permission prompt refused: says so, scans nothing, even when Bluetooth reads ready,
        // until the app comes back with the permissions allowed.
        // (A scan Bluetooth refused was waiting to run again: the refused prompt cancels that too.)
        bluetooth.availability.value = BluetoothAvailability.POWERED_OFF
        eventually("off seen") { m.state.value.availability == BluetoothAvailability.POWERED_OFF }
        m.scan()
        eventually("refused again") { m.state.value.scanMessage == BLUETOOTH_OFF_TEXT && !m.state.value.scanning }
        m.scan(permitted = false)
        assertEquals(BLUETOOTH_DENIED_TEXT, m.state.value.scanMessage)
        val refusedAt = bluetooth.scans
        bluetooth.availability.value = BluetoothAvailability.READY
        eventually("ready seen") { m.state.value.availability == BluetoothAvailability.READY }
        delay(50)
        assertEquals(refusedAt, bluetooth.scans)
        assertEquals(BLUETOOTH_DENIED_TEXT, m.state.value.scanMessage)
        m.appResumed(permitted = false)
        delay(50)
        assertEquals(refusedAt, bluetooth.scans)
        m.appResumed(permitted = true)
        eventually("scanning after the permission") { bluetooth.scans == refusedAt + 1 }

        // A printer call that takes the radio cuts the scan short: it says so. One that ends early
        // otherwise (the app went to the background) says only that.
        bluetooth.link.value = bluetooth.link.value.copy(lastActivityMs = System.currentTimeMillis() + 1_000)
        bluetooth.endScan()
        eventually("cut short") { m.state.value.scanMessage == SCAN_CUT_SHORT_TEXT }
        assertFalse(m.state.value.scanError)
        bluetooth.link.value = bluetooth.link.value.copy(lastActivityMs = null)
        m.scan()
        eventually("scanning") { bluetooth.scanning }
        bluetooth.endScan()
        eventually("ended early") { m.state.value.scanMessage == SCAN_ENDED_EARLY_TEXT }

        // Leaving the tab ends the scan; nothing scans while it is away.
        m.scan()
        eventually("scanning") { bluetooth.scanning }
        val scansBeforeClose = bluetooth.scans
        m.close()
        eventually("scan ended") { !m.state.value.scanning }
        m.scan()
        assertFalse(m.state.value.scanning)
        assertEquals(scansBeforeClose, bluetooth.scans)
    }

    /** No scan starts during a speed test: it shares the radio and would lower the KB/s. */
    @Test fun noScanDuringASpeedTest() = runBlocking<Unit> {
        val line = TroubleLine()
        zebra.line = line
        val m = model()
        line.hold = "START"
        val speed = m.startSpeedTest()!!
        eventually("speed label on the printer") { line.held }
        m.scan()
        assertFalse(m.state.value.scanning)
        assertEquals(0, bluetooth.scans)
        // Nor when the app comes back with the permissions a refused prompt asked for.
        m.scan(permitted = false)
        m.appResumed(permitted = true)
        delay(50)
        assertFalse(m.state.value.scanning)
        assertEquals(0, bluetooth.scans)
        line.hold = null
        speed.join()
        m.scan()
        eventually("scanning") { bluetooth.scanning }
    }

    /** A Bluetooth refusal shows in the section of the call that met it; the next call replaces it,
     *  and Connect (for a printer that forgot this device) keeps it in place if refused again. */
    @Test fun aRefusalShowsInTheSectionOfItsCall() = runBlocking<Unit> {
        zebra.replies = allReplies
        val m = model(bluetoothPrinter)
        zebra.failNext = BluetoothUnavailable(ZD421_SERIAL, BluetoothAvailability.POWERED_OFF)
        m.ask(PrinterAsk.STATUS)!!.join()
        assertEquals(TroubleReach(TroubleAction.ASK, BLUETOOTH_OFF_TEXT), m.state.value.reach)
        m.ask(PrinterAsk.DPI)!!.join()
        assertNull(m.state.value.reach)

        zebra.failNext = BluetoothPairingLost(ZD421_SERIAL)
        m.startSpeedTest()!!.join()
        assertEquals(TroubleReach(TroubleAction.SPEED, pairingLostText(ZD421_SERIAL)), m.state.value.reach)
        zebra.failNext = BluetoothPairingLost(ZD421_SERIAL)
        m.connectAgain()!!.join()
        assertEquals(TroubleReach(TroubleAction.SPEED, pairingLostText(ZD421_SERIAL)), m.state.value.reach)
        m.connectAgain()!!.join()
        assertNull(m.state.value.reach)
        assertEquals("?~HI", zebra.events.last())

        // A clear that Bluetooth refused reads as its cause.
        guard.markSendFailed(bluetoothPrinter.connection)
        zebra.failNext = BluetoothUnavailable(ZD421_SERIAL, BluetoothAvailability.UNAUTHORIZED)
        m.readDetails()!!.join()
        assertEquals(TroubleReach(TroubleAction.DETAILS, BLUETOOTH_DENIED_TEXT), m.state.value.reach)
        assertEquals(BLUETOOTH_DENIED_TEXT, m.state.value.detailsError)
        // Any other failure clears it.
        zebra.failNext = PrinterNoReply(ZD421_SERIAL)
        m.ask(PrinterAsk.SERIAL)!!.join()
        assertNull(m.state.value.reach)
    }

    // --- The link's details (ruling 2) ---

    /** The printer answered at another address than the saved one: shown plainly, never saved. */
    @Test fun linkDetailsShowTheFoundAddressButNeverSaveIt() = runBlocking<Unit> {
        val settings = FixedSettings(bluetoothPrinter)
        val m = TroubleshootingModel(
            settings, bluetooth, { zebra }, lock, guard, isAdmin = { true }, isDeveloper = { true },
            device = { DEVICE_TEXT }, scopeOverride = scope, zone = ZoneOffset.UTC,
        )
        eventually("settings read") { m.state.value.settings != null }
        val idle = m.connectionLines()
        assertEquals(DetailLine("Type", "Bluetooth LE"), idle[0])
        assertTrue(DetailLine("Serial", ZD421_SERIAL) in idle)
        assertTrue(DetailLine("Bluetooth address", SAVED_ADDRESS) in idle)
        assertTrue(DetailLine("Link", "Idle: connects when the printer is next used") in idle)
        assertTrue(DetailLine("Bluetooth", "On") in idle)
        assertFalse(m.state.value.foundElsewhere)
        bluetooth.availability.value = BluetoothAvailability.POWERED_OFF
        eventually("off") { DetailLine("Bluetooth", "Off") in m.connectionLines() }
        bluetooth.availability.value = BluetoothAvailability.READY

        val link = BluetoothLinkInfo(
            connected = true,
            info = BluetoothPrinterInfo(FOUND_ADDRESS, "Zebra Technologies", "ZD421", ZD421_SERIAL, "V93.21.38Z", "7.3"),
            chunkBytes = 244, mtu = 247, connectedAtMs = 1_792_000_000_000L, lastActivityMs = 1_792_000_065_000L,
            lastDrop = BluetoothDrop(1_791_999_000_000L, "The link timed out: the printer is off or out of range (status 8)"),
            savedAddress = SAVED_ADDRESS,
        )
        bluetooth.link.value = link
        eventually("link shown") { m.state.value.link == link }
        val lines = m.connectionLines()
        assertTrue(DetailLine("Found at", "$FOUND_ADDRESS (saved $SAVED_ADDRESS)") in lines)
        assertTrue(DetailLine("Link", "Connected since 17:46:40") in lines)
        assertTrue(DetailLine("Write size", "244 bytes per chunk (MTU 247)") in lines)
        assertTrue(DetailLine("Last used", "17:47:45") in lines)
        assertTrue(DetailLine("Last drop", "17:30:00: The link timed out: the printer is off or out of range (status 8)") in lines)
        assertTrue(m.state.value.foundElsewhere)
        assertEquals(
            listOf("Zebra Technologies", "ZD421", ZD421_SERIAL, "V93.21.38Z", "7.3"),
            m.deviceInfoLines().map { it.value },
        )
        // Nothing reached the printer or the link, and the saved printer is as it was.
        assertEquals(bluetoothPrinter, settings.settings.value.printer)
        assertTrue(bluetooth.connects.isEmpty())
        assertTrue(zebra.events.isEmpty())

        // A link to another printer says nothing about this one.
        bluetooth.link.value = link.copy(info = link.info!!.copy(serial = "XXJ224500000"))
        eventually("other link") { m.state.value.link.info?.serial == "XXJ224500000" }
        assertTrue(DetailLine("Link", "Idle: connects when the printer is next used") in m.connectionLines())
        assertFalse(m.state.value.foundElsewhere)
        assertTrue(m.deviceInfoLines().isEmpty())

        // The MTU request failed: the 20-byte chunk says so.
        bluetooth.link.value = link.copy(mtu = null, chunkBytes = 20)
        eventually("no MTU") { m.state.value.link.mtu == null }
        assertTrue(DetailLine("Write size", "20 bytes per chunk (the MTU request failed)") in m.connectionLines())
    }

    // --- Report (ruling 4) ---

    @Test fun reportCarriesEverything() = runBlocking<Unit> {
        val m = model(bluetoothPrinter, isDeveloper = { true })
        val link = BluetoothLinkInfo(
            connected = true,
            info = BluetoothPrinterInfo(FOUND_ADDRESS, "Zebra Technologies", "ZD421", ZD421_SERIAL, "V93.21.38Z", "7.3"),
            chunkBytes = 244, mtu = 247, connectedAtMs = 1_792_000_000_000L, lastActivityMs = 1_792_000_065_000L,
            lastDrop = BluetoothDrop(1_791_999_000_000L, "The printer ended the link (status 19)"), savedAddress = SAVED_ADDRESS,
        )
        bluetooth.link.value = link
        eventually("link shown") { m.state.value.link == link }
        zebra.replies = allReplies
        m.readDetails()!!.join()
        for (ask in PrinterAsk.entries) m.ask(ask)!!.join()
        zebra.failNext = PrinterNoReply(ZD421_SERIAL)
        m.ask(PrinterAsk.PEELER)!!.join()
        m.startSpeedTest()!!.join()
        m.runCutSendTest()!!.join()
        m.scan()
        eventually("scanning") { bluetooth.scanning }
        bluetooth.hear(
            FoundBluetoothPrinter(SAVED_ADDRESS, ZD421_SERIAL, -52, advertisesZebra = false),
            FoundBluetoothPrinter("11:22:33:44:55:66", "James’s Mac mini", -70, advertisesZebra = false),
        )
        eventually("heard") { m.state.value.found?.size == 2 }
        m.stopScan()
        eventually("scan ended") { !m.state.value.scanning }

        val report = m.report(nowMs = 1_792_000_100_000L)
        assertTrue(report.name, Regex("""^printer-report-\d{8}-\d{6}\.txt$""").matches(report.name))
        assertEquals("printer-report-20261014-174820.txt", report.name)
        val text = report.text
        // This device and app.
        assertTrue(text.contains("Device: Google Pixel 10 Pro XL, Android 16 (API 36)"))
        assertTrue(text.contains("App: version 0.1.0 (build 1)"))
        // The saved printer and its connection: every line the tab shows.
        assertTrue(text.contains(printerSummary(bluetoothPrinter)))
        for (line in m.connectionLines()) assertTrue(line.toString(), text.contains("${line.label}: ${line.value}"))
        assertTrue(text.contains("Bluetooth LE"))
        assertTrue(text.contains("Found at: $FOUND_ADDRESS (saved $SAVED_ADDRESS)"))
        assertTrue(text.contains("244 bytes per chunk (MTU 247)"))
        assertTrue(text.contains("Last drop: 17:30:00: The printer ended the link (status 19)"))
        // The printer's details: ~HI and Device Information.
        assertTrue(m.hostIdLines().isNotEmpty() && m.deviceInfoLines().isNotEmpty())
        for (line in m.hostIdLines() + m.deviceInfoLines()) assertTrue(line.toString(), text.contains("${line.label}: ${line.value}"))
        assertTrue(text.contains("ZD421-300dpi"))
        assertTrue(text.contains("Zebra Technologies"))
        // Every ask: its command and reply with the control bytes visible, bytes and milliseconds,
        // and the one that failed with its error.
        val asks = m.state.value.asks
        assertEquals(PrinterAsk.entries.size + 1, asks.size)
        for (ask in asks) {
            assertTrue(text.contains(visibleCommand(ask.command)))
            assertTrue(text.contains("${ask.bytes} B in ${ask.milliseconds} ms"))
            // ~HS's third string is the printer's front-panel password: masked in the report.
            val reply = if (ask.command == ZebraCommands.HOST_STATUS) ask.reply.replace("\u00020000,0\u0003", "\u0002****,0\u0003") else ask.reply
            for (line in visibleBytes(reply).split("\n")) assertTrue(line, text.contains(line))
        }
        assertTrue(text.contains("␂030,0,0,0612,000,0,0,0,000,0,0,0␃␍␊"))
        assertTrue(text.contains("␂****,0␃␍␊"))
        assertFalse(text.contains("␂0000,0␃"))
        assertTrue(text.contains("ERRORS:         0 00000000 00000000"))
        assertTrue(text.contains("Error: No reply."))
        // The speed rows and the Cut-send test.
        val row = m.state.value.speedRows.first()
        assertTrue(text.contains("1 | 10 | ${row.bytes} | "))
        assertTrue(text.contains(CUT_SEND_DONE_TEXT))
        // What the Bluetooth scan heard: the Zebra by its serial, other devices by signal alone.
        assertTrue(text.contains("$ZD421_SERIAL · -52 dBm · Zebra"))
        assertTrue(text.contains("Other device · -70 dBm"))
        assertFalse(text.contains("James"))
        // The log.
        assertTrue(m.logLines.isNotEmpty())
        for (line in m.logLines) assertTrue(line.text, text.contains(line.text))
    }

    /** A token, a key and a password planted in everything the tab hears (a failed call's own
     *  message, the command typed, the printer's replies) never reach the report. The tab never
     *  sees the session, cookies or keys at all: its inputs are the label settings, the link, the
     *  printer and the role checks. */
    @Test fun reportCarriesNoSecrets() = runBlocking<Unit> {
        val token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aW5hIn0.c2VjcmV0LXRva2VuLTdmM2E"
        val key = "sk-station-9c41d2e7b0"
        val password = "Hunter2-Move-Pass"
        val m = model(isAdmin = { true })
        zebra.failNext = IllegalStateException("Authorization: Bearer $token; station_key=$key")
        m.ask(PrinterAsk.STATUS)!!.join()
        zebra.failNext = RuntimeException("move password $password rejected")
        m.readDetails()!!.join()
        zebra.failNext = com.serversherpa.kiosk.data.printer.PrinterUnreachable("10.0.0.5", java.io.IOException("cookie: refresh=$token"))
        m.startSpeedTest()!!.join()
        // An admin sets a Wi-Fi password and reads secrets back: the report keeps the command, not the values.
        zebra.replies = mapOf(
            "! U1 getvar \"wlan.wpa.psk\"\r\n" to "\"$password\"",
            "! U1 getvar \"wlan.private_key_password\"\r\n" to "\"$key\"",
        )
        for (command in listOf(
            "! U1 setvar \"wlan.wpa.psk\" \"$password\"",
            "! U1 getvar \"wlan.wpa.psk\"",
            "! U1 getvar \"wlan.private_key_password\"",
            "password=$password&token=$token",
        )) {
            m.setCommandText(command)
            m.sendCommand()!!.join()
        }
        val text = m.report().text
        for (secret in listOf(token, key, password, "Bearer", "rejected")) {
            assertFalse("the report carries $secret:\n$text", text.contains(secret))
        }
        // What was asked still shows.
        assertTrue(text.contains("setvar \"wlan.wpa.psk\""))
        assertTrue(text.contains("getvar \"wlan.private_key_password\""))
        assertTrue(text.contains("Something went wrong (IllegalStateException)."))
        assertTrue(text.contains("Can't reach the printer at 10.0.0.5."))
    }

    /** A quoted secret is hidden whole, spaces and all, up to its matching closing quote: in SGD's
     *  `"name" "value"`, `name: "value"`, single quotes, JSON, with an escaped or embedded quote,
     *  and one that never closes; in what an admin types and in what the printer replies. (The
     *  report is built from fields that can't hold the app's secrets; this is the backstop for the
     *  free text an admin types and a printer sends back.) */
    @Test fun aQuotedSecretWithSpacesIsHiddenWhole() = runBlocking<Unit> {
        val m = model(isAdmin = { true })
        val replyCommand = "! U1 getvar \"device.config\"\r\n"
        zebra.replies = mapOf(replyCommand to "{\"wlan.wpa.psk\": \"uniform7 victor7 whiskey7\", \"ip.addr\": \"10.0.0.5\"}")
        val typed = listOf(
            "! U1 setvar \"wlan.wpa.psk\" \"horse7 battery7 staple7\"",
            "password: \"alpha7 bravo7 charlie7\"",
            "token='delta7 echo7 foxtrot7'",
            "{\"api_key\": \"golf7 hotel7 india7\", \"user\": \"tina\"}",
            "password=\"juliet7 \\\"kilo7\\\" lima7\"",
            "secret='mike7 \"november7\" oscar7'",
            "! U1 setvar \"wlan.wpa.psk\" \"it's7 papa7 quebec7\"",
            "passphrase: \"romeo7 sierra7 tango7",
            "! U1 getvar \"device.config\"",
        )
        for (command in typed) {
            m.setCommandText(command)
            m.sendCommand()!!.join()
        }
        val text = m.report().text
        val words = listOf(
            "horse7", "battery7", "staple7", "alpha7", "bravo7", "charlie7", "delta7", "echo7", "foxtrot7",
            "golf7", "hotel7", "india7", "juliet7", "kilo7", "lima7", "mike7", "november7", "oscar7",
            "it's7", "papa7", "quebec7", "romeo7", "sierra7", "tango7", "uniform7", "victor7", "whiskey7",
        )
        for (word in words) assertFalse("the report carries $word:\n$text", text.contains(word))
        // What was asked, and what isn't secret, still shows.
        assertTrue(text, text.contains("setvar \"wlan.wpa.psk\" \"[redacted]\""))
        assertTrue(text, text.contains("\"user\": \"tina\""))
        assertTrue(text, text.contains("\"ip.addr\": \"10.0.0.5\""))
    }

    @Test fun redactionHidesEachQuotedFormWhole() {
        assertEquals("! U1 setvar \"wlan.wpa.psk\" \"[redacted]\"␍␊", redactSecrets("! U1 setvar \"wlan.wpa.psk\" \"a b c\"␍␊"))
        assertEquals("password: \"[redacted]\" next", redactSecrets("password: \"a b c\" next"))
        assertEquals("token='[redacted]' next", redactSecrets("token='a \"b\" c' next"))
        assertEquals("{\"api_key\": \"[redacted]\", \"user\": \"tina\"}", redactSecrets("{\"api_key\": \"a b c\", \"user\": \"tina\"}"))
        assertEquals("password=\"[redacted]\" next", redactSecrets("password=\"a \\\"b\\\" c\" next"))
        assertEquals("passphrase: \"[redacted]\"", redactSecrets("passphrase: \"a b c"))
        // Unquoted values end at a space or a delimiter, as before.
        assertEquals("password=[redacted]&token=[redacted]", redactSecrets("password=hunter2&token=abc.def"))
        // A setting whose name says nothing secret is left alone.
        assertEquals("! U1 setvar \"print.tone\" \"10\"", redactSecrets("! U1 setvar \"print.tone\" \"10\""))
    }

    @Test fun logKeepsTheLast5000LinesAndTheSharedReportFits() {
        val m = model()
        for (i in 1..5_010) m.log("line $i")
        assertEquals(5_000, m.logLines.size)
        assertEquals("line 11", m.logLines.first().text)
        val text = m.report().text
        assertTrue(text.contains("  line 5010\n"))
        assertTrue(text.contains("  line 11\n"))
        assertFalse(text.contains("  line 10\n"))

        // Shared or copied, it fits Android's limit: the oldest log lines go first, and it says so.
        for (i in 1..5_000) m.log("a long line $i " + "x".repeat(80))
        val shared = m.report(maxChars = SHARE_MAX_CHARS).text
        assertTrue(shared.length <= SHARE_MAX_CHARS)
        assertTrue(shared.contains("== Saved printer =="))
        assertTrue(shared.contains("a long line 5000 "))
        assertTrue(shared.contains("older log lines left out to fit"))
        assertFalse(shared.contains("a long line 1 x"))
    }
}
