package com.serversherpa.kiosk.core.labels

import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.PrinterNeedsRestart
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrintQueueTest {
    private data class Asset(val id: String)

    private val printer = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)

    /** Records every call; [label] answers the asset's stored label, [failSends] fails that many sends. */
    private inner class Deps(
        var settings: LabelSettings = LabelSettings(printer = printer, offsetX = 4, offsetY = -2, peel = true),
        var label: (Asset) -> PrintStep = { PrintStep.Ready("^XA^FD${it.id}^FS^XZ") },
        var failSends: Int = 0,
        var failRecord: Boolean = false,
        /** Runs inside each send, before it succeeds or fails. */
        var onSend: suspend () -> Unit = {},
        var sendError: () -> Exception = { java.io.IOException("connect timed out") },
    ) : PrintQueueDeps<Asset> {
        val prepared = ArrayList<String>()
        /** Each send as (host, zpl). */
        val sent = ArrayList<Pair<String, String>>()
        /** The printer each send was given. */
        val sentTo = ArrayList<SavedPrinter>()
        val recorded = ArrayList<Pair<Asset, String>>()
        override suspend fun settings() = settings
        override suspend fun label(asset: Asset) = label.invoke(asset)
        override suspend fun prepare(zpl: String, settings: LabelSettings): PrintStep {
            prepared += zpl
            return PrintStep.Ready("[${settings.offsetX},${settings.offsetY},${settings.peel}]$zpl")
        }
        override suspend fun send(printer: SavedPrinter, zpl: String) {
            onSend()
            if (failSends > 0) { failSends--; throw sendError() }
            sent += printer.host.orEmpty() to zpl
            sentTo += printer
        }
        override suspend fun record(asset: Asset, scannedValue: String) {
            if (failRecord) throw IllegalStateException("disk")
            recorded += asset to scannedValue
        }
    }

    private fun queue(deps: Deps) = PrintQueue(deps, now = { "2026-10-21T12:00:00Z" })

    @Test fun aPrintedScanRecordsOnce() = runTest {
        val deps = Deps()
        val q = queue(deps)
        val e = q.scan(Asset("a1"), "A-1")
        assertEquals(PrintState.PRINTED, e.state)
        assertTrue(e.recorded)
        assertNull(e.message)
        assertEquals(listOf("10.0.0.5" to "[4,-2,true]^XA^FDa1^FS^XZ"), deps.sent)
        // The send gets the whole saved printer: its connection picks the way there.
        assertEquals(listOf(printer), deps.sentTo)
        assertEquals(listOf(Asset("a1") to "A-1"), deps.recorded)
        assertEquals(listOf(e), q.entries.value)
    }

    @Test fun aFailedSendThenRetryResendsTheSameBytesAndRecordsOnce() = runTest {
        val deps = Deps(failSends = 1)
        val q = queue(deps)
        val failed = q.scan(Asset("a1"), "A-1")
        assertEquals(PrintState.FAILED, failed.state)
        assertEquals("Can't reach the printer at 10.0.0.5.", failed.message)
        assertTrue(deps.recorded.isEmpty())
        assertFalse(failed.recorded)

        // The label changed and the offsets moved since: a Retry still sends what the first attempt built.
        deps.label = { PrintStep.Ready("^XA^FDnew^FS^XZ") }
        deps.settings = deps.settings.copy(offsetX = 99)
        val retried = q.retry(failed.id)!!
        assertEquals(failed.id, retried.id)
        assertEquals(PrintState.PRINTED, retried.state)
        assertEquals(listOf("10.0.0.5" to "[4,-2,true]^XA^FDa1^FS^XZ"), deps.sent)
        assertEquals(1, deps.prepared.size)
        assertEquals(listOf(Asset("a1") to "A-1"), deps.recorded)
        // One entry: the retry is the same scan.
        assertEquals(1, q.entries.value.size)
    }

    @Test fun aReprintNeverRecords() = runTest {
        val deps = Deps()
        val q = queue(deps)
        val first = q.scan(Asset("a1"), "A-1")
        val again = q.reprint(first.id)!!
        assertEquals(PrintState.PRINTED, again.state)
        assertTrue(again.reprint)
        assertFalse(again.recorded)
        assertEquals(2, deps.sent.size)
        assertEquals(1, deps.recorded.size)
        assertEquals(listOf(again.id, first.id), q.entries.value.map { it.id })
    }

    @Test fun aFailedReprintRetriedStillNeverRecords() = runTest {
        val deps = Deps()
        val q = queue(deps)
        val first = q.scan(Asset("a1"), "A-1")
        deps.failSends = 1
        val again = q.reprint(first.id)!!
        assertEquals(PrintState.FAILED, again.state)
        assertEquals(PrintState.PRINTED, q.retry(again.id)!!.state)
        assertEquals(1, deps.recorded.size)
    }

    @Test fun anAssetWithNoTemplateAtThisDpiShowsTheReasonAndRecordsNothing() = runTest {
        val deps = Deps(label = { labelFor(StoredLabel(null, NO_TEMPLATE_AT_DPI, null), LabelBuildStatus(LabelBuildPhase.DONE)) })
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals(PrintState.FAILED, e.state)
        assertEquals(
            "No label for this asset: this move has no active label template at this printer's DPI. " +
                "Someone with label access needs to activate one on Labels › Templates.",
            e.message,
        )
        assertTrue(deps.sent.isEmpty())
        assertTrue(deps.recorded.isEmpty())
    }

    @Test fun aScanWhileLabelsAreBeingMadeAndNoRowYetSaysSo() = runTest {
        val running = LabelBuildStatus(LabelBuildPhase.RUNNING, done = 3, total = 10, templateId = "t1")
        val deps = Deps(label = { labelFor(null, running) })
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals(PrintState.FAILED, e.state)
        assertEquals("Labels are still being made (3 of 10).", e.message)
        assertTrue(deps.sent.isEmpty())
        assertTrue(deps.recorded.isEmpty())
    }

    @Test fun anUnreachablePrinterIsAnErrorAndRecordsNothing() = runTest {
        val deps = Deps(failSends = 5)
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals(PrintState.FAILED, e.state)
        assertEquals("Can't reach the printer at 10.0.0.5.", e.message)
        assertTrue(deps.recorded.isEmpty())
    }

    @Test fun noPrinterSaysOpenPrinterSetup() = runTest {
        val deps = Deps(settings = LabelSettings())
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals("No printer set up. Open Printer Setup.", e.message)
        assertTrue(deps.prepared.isEmpty())
    }

    @Test fun noMatchFailsAtOnceAndHasNothingToRetry() = runTest {
        val deps = Deps()
        val q = queue(deps)
        val e = q.scan(null, "ZZZ")
        assertEquals(PrintState.FAILED, e.state)
        assertEquals("No asset matches that scan.", e.message)
        assertNull(q.retry(e.id))
        assertNull(q.reprint(e.id))
        assertTrue(deps.sent.isEmpty())
    }

    @Test fun aRecordThatFailsKeepsThePrintAndWarns() = runTest {
        val deps = Deps(failRecord = true)
        val logged = ArrayList<String>()
        val q = PrintQueue(deps, now = { "t" }, log = { message, _ -> logged += message })
        val e = q.scan(Asset("a1"), "A-1")
        assertEquals(PrintState.PRINTED, e.state)
        assertFalse(e.recorded)
        assertEquals("Printed, but the scan wasn't recorded: this kiosk couldn't save it.", e.recordWarning)
        // A printed entry has nothing to retry.
        assertNull(q.retry(e.id))
        assertEquals(1, deps.sent.size)
        assertEquals(listOf("couldn't record the Labeled scan"), logged)
    }

    @Test fun aLabelThatGoesOutAsTheScreenClosesStillRecordsOnce() = runTest {
        val gate = CompletableDeferred<Unit>()
        val atSend = CompletableDeferred<Unit>()
        val deps = Deps(onSend = { atSend.complete(Unit); gate.await() })
        val q = queue(deps)
        val job = launch { q.scan(Asset("a1"), "A-1") }
        atSend.await()
        job.cancel()
        assertTrue(deps.recorded.isEmpty())
        gate.complete(Unit)
        job.join()
        assertEquals(1, deps.sent.size)
        assertEquals(listOf(Asset("a1") to "A-1"), deps.recorded)
        assertEquals(PrintState.PRINTED, q.entries.value[0].state)
    }

    @Test fun aSendThatTimesOutSaysTheLabelMayHavePrinted() = runTest {
        val deps = Deps(failSends = 1, sendError = { LabelSendTimeout() })
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals(PrintState.FAILED, e.state)
        assertEquals("The printer didn't finish answering. It may have printed the label — check before you retry.", e.message)
        assertTrue(deps.recorded.isEmpty())
    }

    /** A cut font install stops sends to the printer until it answers a check: the label says so. */
    @Test fun printQueueShowsFontCutText() = runTest {
        val deps = Deps(failSends = 1, sendError = { PrinterNeedsRestart() })
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals(PrintState.FAILED, e.state)
        assertEquals(FONT_INSTALL_CUT_TEXT, e.message)
        assertEquals("The font install was cut off. Turn the printer off and on, then tap Check again.", e.message)
        assertTrue(deps.recorded.isEmpty())
    }

    /** A Bluetooth printer that can't be reached is named by its serial. */
    @Test fun anUnreachableBluetoothPrinterIsNamedBySerial() = runTest {
        val bt = SavedPrinter(PrinterConnection.Bluetooth("D8J224508535", "00:11:22:33:44:55"), "ZD421", "D8J224508535", 300)
        val deps = Deps(settings = LabelSettings(printer = bt), failSends = 1)
        val e = queue(deps).scan(Asset("a1"), "A-1")
        assertEquals("Can't reach the printer D8J224508535 over Bluetooth.", e.message)
        deps.label = { PrintStep.Ready("^XA^XZ") }
        assertEquals(PrintState.PRINTED, queue(deps).scan(Asset("a2"), "A-2").state)
        assertEquals(listOf(bt), deps.sentTo)
    }

    @Test fun aPrepareFailureShowsItsMessage() = runTest {
        val deps = object : PrintQueueDeps<Asset> by Deps() {
            override suspend fun prepare(zpl: String, settings: LabelSettings) = PrintStep.Refused(DEVICE_UNSUPPORTED_TEXT)
        }
        val e = PrintQueue(deps, now = { "t" }).scan(Asset("a1"), "A-1")
        assertEquals("This device can't make labels (its system WebView is too old).", e.message)
    }

    @Test fun theListKeepsTheNewestEntries() = runTest {
        val q = PrintQueue(Deps(), now = { "t" }, limit = 3)
        repeat(5) { q.scan(Asset("a$it"), "A-$it") }
        assertEquals(listOf("A-4", "A-3", "A-2"), q.entries.value.map { it.scannedValue })
    }

    // labelFor: the stored label and the build's state → what a scan prints or says.

    @Test fun theReasonsMatchTheLaptop() {
        val done = LabelBuildStatus(LabelBuildPhase.DONE)
        fun said(outcome: String) = (labelFor(StoredLabel(null, outcome, "t1"), done) as PrintStep.Refused).message
        assertEquals("No label for this asset: the label template couldn't be built", said(TEMPLATE_FAILED))
        assertEquals("This device needs an app update to print this template.", said(TEMPLATE_UNSUPPORTED))
        assertEquals("No label for this asset: none was generated for it", said("something_new"))
        assertEquals("No label for this asset: none was generated for it", (labelFor(null, done) as PrintStep.Refused).message)
    }

    @Test fun aStoredLabelPrints() {
        val step = labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t1"), LabelBuildStatus(LabelBuildPhase.DONE))
        assertEquals(PrintStep.Ready("^XA^XZ"), step)
    }

    /** Laptop parity: its edge refuses every label while its runner runs. */
    @Test fun whileLabelsAreBeingMadeNoStoredLabelPrints() {
        val waiting = PrintStep.Refused("Labels are still being made (1 of 4).")
        val running = LabelBuildStatus(LabelBuildPhase.RUNNING, done = 1, total = 4, templateId = "t2")
        assertEquals(waiting, labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t2"), running))
        assertEquals(waiting, labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t1"), running))
        assertEquals(waiting, labelFor(StoredLabel(null, NO_TEMPLATE_AT_DPI, "t2"), running))
        // The plan step: nothing counted yet.
        assertEquals(
            PrintStep.Refused("Labels are being prepared."),
            labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t2"), LabelBuildStatus(LabelBuildPhase.RUNNING)),
        )
    }

    /** A stored label may be for the data the running sync replaces: none prints until it's done. */
    @Test fun whileTheKioskSyncsNoStoredLabelPrints() {
        val syncing = PrintStep.Refused("This kiosk is syncing. Labels will be ready shortly.")
        val done = LabelBuildStatus(LabelBuildPhase.DONE)
        assertEquals(syncing, labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t1"), done, syncing = true))
        assertEquals(syncing, labelFor(null, done, syncing = true))
        assertEquals(syncing, labelFor(null, LabelBuildStatus(LabelBuildPhase.RUNNING, done = 1, total = 4), syncing = true))
        // A device that can't make labels says so first.
        assertEquals(
            PrintStep.Refused("This device can't make labels (its system WebView is too old)."),
            labelFor(null, LabelBuildStatus(LabelBuildPhase.UNSUPPORTED_DEVICE), syncing = true),
        )
        assertEquals(PrintStep.Ready("^XA^XZ"), labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t1"), done, syncing = false))
    }

    @Test fun anUnsupportedDeviceNeverPrints() {
        val step = labelFor(StoredLabel("^XA^XZ", OUTCOME_OK, "t1"), LabelBuildStatus(LabelBuildPhase.UNSUPPORTED_DEVICE))
        assertEquals(PrintStep.Refused("This device can't make labels (its system WebView is too old)."), step)
    }

    @Test fun noLabelAndASyncNeededSaysSync() {
        val step = labelFor(null, LabelBuildStatus(LabelBuildPhase.DONE, needs = LabelBuildNeed.SYNC))
        assertEquals(PrintStep.Refused("Sync this kiosk to make labels."), step)
    }
}
