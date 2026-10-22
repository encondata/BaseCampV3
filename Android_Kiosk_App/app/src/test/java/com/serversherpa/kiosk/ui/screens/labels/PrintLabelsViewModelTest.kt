package com.serversherpa.kiosk.ui.screens.labels

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.OUTCOME_OK
import com.serversherpa.kiosk.core.labels.PrintState
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.GeneratedLabelEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelEngineTimeoutException
import com.serversherpa.kiosk.data.labels.LabelEngineUnsupportedException
import com.serversherpa.kiosk.data.labels.LabelSettingsSource
import com.serversherpa.kiosk.data.outbox.MemoryOutboxStore
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothPairingLost
import com.serversherpa.kiosk.data.printer.BluetoothUnavailable
import com.serversherpa.kiosk.data.printer.LabelSender
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.printer.PrinterUnreachable
import com.serversherpa.kiosk.data.printer.lockedSender
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import kotlinx.coroutines.CompletableDeferred
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The two send-time helpers, spelled out so a test can see which settings went in. */
private class PrintHelperEngine : LabelEngine {
    val calls = ArrayList<Pair<String, JsonObject>>()
    var timeoutsLeft = 0
    var unsupported = false
    override suspend fun call(fn: String, argsJson: String): String {
        if (unsupported) throw LabelEngineUnsupportedException()
        if (timeoutsLeft > 0) { timeoutsLeft--; throw LabelEngineTimeoutException(fn) }
        val a = KioskJson.parseToJsonElement(argsJson).jsonObject
        calls += fn to a
        val zpl = a["zpl"]!!.jsonPrimitive.content
        val out = when (fn) {
            "applyPrintSettings" -> "LT${a["verticalOffset"]!!.jsonPrimitive.int}LS${a["horizontalOffset"]!!.jsonPrimitive.int}|$zpl"
            "withPrintMode" -> zpl + if (a["peel"]!!.jsonPrimitive.boolean) "|MMP" else "|MMT"
            else -> error("unexpected $fn")
        }
        return buildJsonObject { put("zpl", out) }.toString()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrintLabelsViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    /** See ScanViewModelTest.settle(): Room answers on its own thread. */
    private fun TestScope.settle() { repeat(6) { Thread.sleep(50); runCurrent() } }

    private val printer = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)

    private class Harness(
        val vm: PrintLabelsViewModel, val db: KioskDatabase, val outbox: Outbox, val engine: PrintHelperEngine,
        val sent: MutableList<Pair<String, String>>, val status: MutableStateFlow<LabelBuildStatus>,
        val sendFailures: IntArray, val timeoutSends: BooleanArray, val sync: Sync,
        /** Every send the printer was asked for, in order, whether or not it went out. */
        val started: MutableList<String>,
        /** When set, every send throws it (a Bluetooth refusal, say). */
        val failWith: Array<Exception?>,
    )

    /** [syncGate]: when set, a sync waits for it (holding the RUNNING phase). [guard]: when set, the
     *  sender is the container's ([lockedSender] under a lock and [guard]) over the fake printer. */
    private suspend fun TestScope.harness(
        name: String, settings: LabelSettings = LabelSettings(printer = printer, offsetX = 4, offsetY = -2, peel = true),
        syncGate: CompletableDeferred<Unit>? = null,
        guard: PrinterGuard? = null,
    ): Harness {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Rack 1", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity(),
            KioskAssetRow("a2", "A-2", "Rack 2", serial_number = "SN2", make_model = "HP").toEntity(),
        ))
        db.generatedLabels().upsert(listOf(
            GeneratedLabelEntity("a1", "^XA^FDA-1^FS^XZ", OUTCOME_OK, "f1", "t1"),
            GeneratedLabelEntity("a2", null, "no_template_at_dpi", "f2", null),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "$name.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val outbox = Outbox(MemoryOutboxStore(), api, Identity(prefs), backgroundScope, clock = { testScheduler.currentTime })
        val engine = PrintHelperEngine()
        val sent = ArrayList<Pair<String, String>>()
        val started = ArrayList<String>()
        val sendFailures = intArrayOf(0)
        val timeoutSends = booleanArrayOf(false)
        val failWith = arrayOfNulls<Exception>(1)
        val status = MutableStateFlow(LabelBuildStatus(LabelBuildPhase.DONE, ready = 1, problems = mapOf("no_template_at_dpi" to 1), templateId = "t1"))
        val source = object : LabelSettingsSource { override val settings = MutableStateFlow(settings) }
        val syncApi = if (syncGate == null) api else object : KioskApi by api {
            override suspend fun syncPeople(): KioskPeopleSync { syncGate.await(); return api.syncPeople() }
        }
        val sync = Sync(syncApi, db, backgroundScope)
        val device = LabelSender { p, zpl ->
            val host = p.host.orEmpty()
            started += zpl
            failWith[0]?.let { throw it }
            if (sendFailures[0] > 0) { sendFailures[0]--; throw if (timeoutSends[0]) PrinterTimeout(host) else PrinterUnreachable(host) }
            sent += host to zpl
        }
        val vm = PrintLabelsViewModel(
            db, sync, outbox, prefs, source, status, engine,
            sender = if (guard == null) device else lockedSender(PrinterLock(), guard, device),
            flash = FlashController(backgroundScope), sound = null, scopeOverride = backgroundScope,
        )
        settle()
        return Harness(vm, db, outbox, engine, sent, status, sendFailures, timeoutSends, sync, started, failWith)
    }

    @Test fun aScannedAssetIdPrintsItsStoredLabelWithTheSendSettingsAndRecordsOneLabeledScan() = runTest {
        val h = harness("p1")
        h.vm.onScan("a-1"); settle()
        assertEquals(listOf("10.0.0.5" to "LT-2LS4|^XA^FDA-1^FS^XZ|MMP"), h.sent)
        assertEquals(listOf("applyPrintSettings", "withPrintMode"), h.engine.calls.map { it.first })
        val rows = h.outbox.snapshot.value.rows
        assertEquals(1, rows.size)
        val row = rows[0]
        assertEquals("a-1", row.scannedValue); assertEquals("barcode", row.scanType); assertEquals("labeled", row.scanStatus)
        assertEquals("a1", row.asset?.id); assertEquals("s1", row.siteId); assertEquals("i1", row.initiativeId)
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)

        // Reprint: one more label, no more scans.
        h.vm.reprint(h.vm.entries.value[0].id); settle()
        assertEquals(2, h.sent.size)
        assertEquals(1, h.outbox.snapshot.value.rows.size)
        h.db.close()
    }

    @Test fun aSerialMatchesButAnRfidTagDoesNot() = runTest {
        val h = harness("p2")
        h.vm.onScan("100348"); settle()
        assertEquals("No asset matches that scan.", h.vm.entries.value[0].message)
        assertTrue(h.sent.isEmpty())
        h.vm.onScan("SN1"); settle()
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)
        assertEquals(listOf("a1"), h.outbox.snapshot.value.rows.map { it.asset?.id })
        h.db.close()
    }

    @Test fun anAssetWithoutALabelSaysWhyAndRecordsNothing() = runTest {
        val h = harness("p3")
        h.vm.onScan("A-2"); settle()
        assertEquals(PrintState.FAILED, h.vm.entries.value[0].state)
        assertTrue(h.vm.entries.value[0].message!!.startsWith("No label for this asset: this move has no active label template"))
        assertTrue(h.sent.isEmpty())
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())
        h.db.close()
    }

    @Test fun anUnreachablePrinterRecordsNothingUntilARetryPrints() = runTest {
        val h = harness("p4")
        h.sendFailures[0] = 1
        h.vm.onScan("A-1"); settle()
        val failed = h.vm.entries.value[0]
        assertEquals("Can't reach the printer at 10.0.0.5.", failed.message)
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())
        h.vm.retry(failed.id); settle()
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)
        assertEquals(1, h.outbox.snapshot.value.rows.size)
        assertEquals(2, h.engine.calls.size) // the retry resent the same bytes
        h.db.close()
    }

    @Test fun aPrinterTimeoutSaysTheLabelMayHavePrinted() = runTest {
        val h = harness("p9")
        h.sendFailures[0] = 1; h.timeoutSends[0] = true
        h.vm.onScan("A-1"); settle()
        assertEquals("The printer didn't finish answering. It may have printed the label — check before you retry.", h.vm.entries.value[0].message)
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())
        h.db.close()
    }

    /** The container's sender: after a failed send the next label first clears the printer. A clear
     *  that fails never sent the label, so it can't have printed: a timeout reads as unreachable
     *  (not "it may have printed"). */
    @Test fun aClearThatFailsSaysThePrinterCantBeReached() = runTest {
        val guard = PrinterGuard()
        val h = harness("p12", guard = guard)
        guard.markSendFailed(printer.connection)
        h.sendFailures[0] = 1; h.timeoutSends[0] = true
        h.vm.onScan("A-1"); settle()
        assertEquals(PrintState.FAILED, h.vm.entries.value[0].state)
        assertEquals("Can't reach the printer at 10.0.0.5.", h.vm.entries.value[0].message)
        assertEquals(listOf("~JX"), h.started)
        assertTrue(h.sent.isEmpty())
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())

        h.timeoutSends[0] = false
        h.vm.retry(h.vm.entries.value[0].id); settle()
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)
        assertEquals(listOf("10.0.0.5" to "~JX", "10.0.0.5" to "LT-2LS4|^XA^FDA-1^FS^XZ|MMP"), h.sent)
        assertEquals(1, h.outbox.snapshot.value.rows.size)
        h.db.close()
    }

    /** A cut font install keeps labels from the printer, saying to restart it, until a check gets
     *  an answer; nothing is sent or recorded meanwhile. */
    @Test fun aCutFontStopsLabelsAndSaysToRestartThePrinter() = runTest {
        val guard = PrinterGuard()
        val h = harness("p13", guard = guard)
        guard.markFontCut(printer.connection)
        h.vm.onScan("A-1"); settle()
        assertEquals(PrintState.FAILED, h.vm.entries.value[0].state)
        assertEquals(FONT_INSTALL_CUT_TEXT, h.vm.entries.value[0].message)
        assertTrue(h.started.isEmpty())
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())

        guard.printerAnswered(printer.connection)
        h.vm.retry(h.vm.entries.value[0].id); settle()
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)
        assertEquals(listOf("LT-2LS4|^XA^FDA-1^FS^XZ|MMP"), h.started)
        h.db.close()
    }

    /** A Bluetooth printer's failures name it by its serial, and one the crew fixes on the device
     *  (Bluetooth off or not allowed, a printer that forgot it) says what to do, also when it
     *  stopped the `~JX` owed before the label (which then never went out). */
    @Test fun printLabelsBluetoothUnreachableCopy() = runTest {
        val serial = "D8J224508535"
        val bluetooth = SavedPrinter(PrinterConnection.Bluetooth(serial, "AC:3F:A4:00:00:01"), "ZD421", serial, 300)
        val guard = PrinterGuard()
        val h = harness("p14", LabelSettings(printer = bluetooth), guard = guard)
        h.failWith[0] = PrinterUnreachable(serial)
        h.vm.onScan("A-1"); settle()
        val entry = h.vm.entries.value[0]
        assertEquals(PrintState.FAILED, entry.state)
        assertEquals("Can't reach the printer D8J224508535 over Bluetooth.", entry.message)

        h.failWith[0] = BluetoothUnavailable(serial, BluetoothAvailability.POWERED_OFF)
        h.vm.retry(entry.id); settle()
        assertEquals(BLUETOOTH_OFF_TEXT, h.vm.entries.value[0].message)
        assertEquals(listOf("^XA^FDA-1^FS^XZ|MMT", "~JX"), h.started.map { it.substringAfter("LT0LS0|") })

        h.failWith[0] = BluetoothUnavailable(serial, BluetoothAvailability.UNAUTHORIZED)
        h.vm.retry(entry.id); settle()
        assertEquals(BLUETOOTH_DENIED_TEXT, h.vm.entries.value[0].message)

        h.failWith[0] = BluetoothPairingLost(serial)
        h.vm.retry(entry.id); settle()
        assertEquals(pairingLostText(serial), h.vm.entries.value[0].message)
        assertTrue(h.sent.isEmpty())
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())

        h.failWith[0] = null
        h.vm.retry(entry.id); settle()
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)
        assertEquals(listOf("~JX", "LT0LS0|^XA^FDA-1^FS^XZ|MMT"), h.sent.map { it.second })
        assertEquals(1, h.outbox.snapshot.value.rows.size)
        h.db.close()
    }

    @Test fun aScanWhileTheBuildRunsIsRefusedEvenWithAStoredLabel() = runTest {
        val h = harness("p10")
        h.status.value = LabelBuildStatus(LabelBuildPhase.RUNNING, done = 0, total = 0)
        h.vm.onScan("A-1"); settle()
        assertEquals("Labels are being prepared.", h.vm.entries.value[0].message)
        assertTrue(h.sent.isEmpty())
        h.db.close()
    }

    @Test fun aScanWhileTheKioskSyncsIsRefusedEvenWithAStoredLabel() = runTest {
        val gate = CompletableDeferred<Unit>()
        val h = harness("p11", syncGate = gate)
        h.sync.run("i1", "Move"); settle()
        assertEquals(SyncPhase.RUNNING, h.sync.status.value.phase)

        h.vm.onScan("A-1"); settle()
        assertEquals(PrintState.FAILED, h.vm.entries.value[0].state)
        assertEquals("This kiosk is syncing. Labels will be ready shortly.", h.vm.entries.value[0].message)
        assertTrue(h.sent.isEmpty())
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())

        // Let the sync finish before the database closes.
        gate.complete(Unit)
        repeat(40) { if (h.sync.status.value.phase == SyncPhase.RUNNING) settle() }
        assertTrue(h.sync.status.value.phase != SyncPhase.RUNNING)
        h.db.close()
    }

    @Test fun aPrintHelperThatTimesOutOnceIsAskedAgain() = runTest {
        val h = harness("p5")
        h.engine.timeoutsLeft = 1
        h.vm.onScan("A-1"); settle()
        assertEquals(PrintState.PRINTED, h.vm.entries.value[0].state)
        assertEquals(1, h.sent.size)
        h.db.close()
    }

    @Test fun anUnsupportedEngineSaysSoAndPrintsNothing() = runTest {
        val h = harness("p6")
        h.engine.unsupported = true
        h.vm.onScan("A-1"); settle()
        assertEquals("This device can't make labels (its system WebView is too old).", h.vm.entries.value[0].message)
        assertTrue(h.sent.isEmpty())
        assertTrue(h.outbox.snapshot.value.rows.isEmpty())
        h.db.close()
    }

    @Test fun aScanWhileTheBuildRunsAndTheAssetHasNoRowSaysStillBeingMade() = runTest {
        val h = harness("p7")
        h.db.generatedLabels().delete(listOf("a1"))
        h.status.value = LabelBuildStatus(LabelBuildPhase.RUNNING, done = 200, total = 800, templateId = "t1")
        h.vm.onScan("A-1"); settle()
        assertEquals("Labels are still being made (200 of 800).", h.vm.entries.value[0].message)
        assertTrue(h.sent.isEmpty())
        h.db.close()
    }

    @Test fun noPrinterSaysOpenPrinterSetup() = runTest {
        val h = harness("p8", LabelSettings())
        h.vm.onScan("A-1"); settle()
        assertEquals("No printer set up. Open Printer Setup.", h.vm.entries.value[0].message)
        assertTrue(h.engine.calls.isEmpty())
        h.db.close()
    }

    @Test fun theHeaderCountsReadyLabelsAndWhyTheOthersHaveNone() {
        assertEquals("1 label ready", readySummary(LabelBuildStatus(LabelBuildPhase.DONE, ready = 1)))
        assertEquals(
            "12 labels ready · 2 with no template at this DPI, 1 whose template couldn't be built",
            readySummary(LabelBuildStatus(LabelBuildPhase.DONE, ready = 12, problems = linkedMapOf("no_template_at_dpi" to 2, "template_failed" to 1))),
        )
        assertEquals(
            "0 labels ready · 1 whose template needs an app update, 4 with no label",
            readySummary(LabelBuildStatus(LabelBuildPhase.DONE, problems = linkedMapOf("template_unsupported" to 1, "something_new" to 4))),
        )
    }

    @Test fun printLabelsOpensPrinterSetupFirstOnlyWithNoPrinterOncePerVisit() {
        val printer = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)
        // No printer: straight on to Printer Setup, whatever the build is doing.
        for (phase in listOf(LabelBuildPhase.IDLE, LabelBuildPhase.RUNNING, LabelBuildPhase.DONE, LabelBuildPhase.ERROR)) {
            assertTrue(phase.name, opensPrinterSetupFirst(null, phase, alreadyOpened = false))
        }
        // A saved printer stays on Print Labels.
        assertFalse(opensPrinterSetupFirst(printer, LabelBuildPhase.IDLE, alreadyOpened = false))
        // Back from Printer Setup without saving: no bounce.
        assertFalse(opensPrinterSetupFirst(null, LabelBuildPhase.DONE, alreadyOpened = true))
        // A device that can't make labels says so instead.
        assertFalse(opensPrinterSetupFirst(null, LabelBuildPhase.UNSUPPORTED_DEVICE, alreadyOpened = false))
    }
}
