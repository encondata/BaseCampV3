package com.serversherpa.kiosk

import android.app.Application
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowBuild

/**
 * The container's sled wiring: sled barcodes on the scan bus once (spec tests 27 and 34, T11),
 * the guard following the scanner, the automatic sled's address saved (ruling 38), the nudge
 * receiver's idempotent registration (row 16), the DataWedge scanner-input broadcast (spec test
 * 31, third part), and the controller reading the printer lock.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppContainerSledTest {
    /** Collectors on a shared flow a fake or the bus exposes read-only (it is a MutableSharedFlow underneath). */
    private fun kotlinx.coroutines.flow.SharedFlow<*>.collectors(): Int =
        (this as kotlinx.coroutines.flow.MutableSharedFlow<*>).subscriptionCount.value

    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val sledA = "84:C6:92:00:00:0A"
    private val sledB = "84:C6:92:00:00:0B"

    private suspend fun eventually(what: String, cond: suspend () -> Boolean) {
        try {
            withTimeout(8_000) { while (!cond()) delay(20) }
        } catch (e: Exception) {
            throw AssertionError("never: $what", e)
        }
    }

    private suspend fun AppContainer.shutDown() {
        withTimeout(10_000) { scope.coroutineContext[Job]!!.cancelAndJoin() }
        db.close()
    }

    /** A DataStore that counts the edits that changed the saved RFID settings. */
    private class CountingStore(private val inner: DataStore<Preferences>) : DataStore<Preferences> {
        val rfidWrites = AtomicInteger(0)
        override val data: Flow<Preferences> = inner.data
        override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences =
            inner.updateData { before ->
                val after = transform(before)
                if (before[RFID] != after[RFID]) rfidWrites.incrementAndGet()
                after
            }
        companion object { val RFID = stringPreferencesKey("ss.kiosk.rfid") }
    }

    private fun countingStore(): CountingStore {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val file = File(app.cacheDir, "kiosk-sled-${UUID.randomUUID()}.preferences_pb")
        return CountingStore(PreferenceDataStoreFactory.create(scope = scope) { file })
    }

    /** Started and in front, with the bus's events collected into the returned list. */
    private suspend fun AppContainer.inFront(): MutableList<ScanEvent> {
        start()
        foreground.value = true
        val events = CopyOnWriteArrayList<ScanEvent>()
        scope.launch { scanBus.events.collect { events += it } }
        eventually("the bus has a collector") { scanBus.events.collectors() > 0 }
        return events
    }

    private suspend fun FakeRfidReader.awaitBarcodeCollector() {
        eventually("the container collects sled barcodes") { barcodes.collectors() > 0 }
    }

    @Test fun aSledBarcodeReachesTheBusOnceAsSled() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        try {
            val events = c.inFront()
            reader.awaitBarcodeCollector()
            val before = c.rfid.lastActivityMs.value
            delay(5)
            reader.emitBarcode(SledBarcode("102466", "Code 128"))
            eventually("published") { events.isNotEmpty() }
            delay(400)
            assertEquals(listOf(ScanEvent("102466", ScanSource.SLED, "Code 128")), events)
            assertTrue("activity noted", c.rfid.lastActivityMs.value > before)
        } finally {
            c.shutDown()
        }
    }

    @Test fun aSledBarcodeWhileInTheBackgroundIsDropped() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        try {
            val events = c.inFront()
            reader.awaitBarcodeCollector()
            c.foreground.value = false
            reader.emitBarcode(SledBarcode("102466", null))
            delay(500)
            assertEquals(emptyList<ScanEvent>(), events)
            // Back in front, the next one goes.
            c.foreground.value = true
            reader.emitBarcode(SledBarcode("102467", null))
            eventually("published") { events.isNotEmpty() }
            assertEquals(listOf("102467"), events.map { it.value })
        } finally {
            c.shutDown()
        }
    }

    @Test fun aSledBarcodeWithNoCollectorIsDroppedWithNoSentence() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        try {
            c.start()
            c.foreground.value = true
            reader.awaitBarcodeCollector()
            reader.emitBarcode(SledBarcode("102466", null))
            delay(500)
            // A screen that starts listening afterward gets nothing: no replay.
            val events = CopyOnWriteArrayList<ScanEvent>()
            c.scope.launch { c.scanBus.events.collect { events += it } }
            delay(300)
            assertEquals(emptyList<ScanEvent>(), events)
            assertNull(c.rfid.readError.value)
            assertNull(c.rfid.connectionError.value)
            assertNull(c.rfid.applyError.value)
        } finally {
            c.shutDown()
        }
    }

    @Test fun theGuardFollowsTheScannerState() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        try {
            c.start()
            assertFalse(c.sledScanGuard.scannerReady)
            reader.setScanner(SledScannerState.Ready)
            eventually("ready") { c.sledScanGuard.scannerReady }
            reader.setScanner(SledScannerState.Opening)
            eventually("not ready while opening") { !c.sledScanGuard.scannerReady }
            reader.setScanner(SledScannerState.Ready)
            eventually("ready again") { c.sledScanGuard.scannerReady }
            reader.setScanner(SledScannerState.Off)
            eventually("off") { !c.sledScanGuard.scannerReady }
        } finally {
            c.shutDown()
        }
    }

    /** The session copy of a scan the sled also typed is refused by the container's guard. */
    @Test fun aSledBarcodeTypedFirstIsNotPublishedAgain() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        try {
            val events = c.inFront()
            reader.awaitBarcodeCollector()
            assertTrue(c.sledScanGuard.acceptTyped("102466", android.os.SystemClock.elapsedRealtime()))
            reader.emitBarcode(SledBarcode("102466", null))
            delay(600)
            assertEquals(emptyList<ScanEvent>(), events)
        } finally {
            c.shutDown()
        }
    }

    @Test fun anAutomaticallyChosenSledsAddressIsSavedOnceAndDoesNotReconnect() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        reader.paired = listOf(SledCandidate("RFD4031-A", sledA), SledCandidate("RFD4031-B", sledB))
        val store = countingStore()
        val c = testContainer(reader, dataStore = store)
        try {
            c.start()
            assertTrue(c.rfid.connectNow().isSuccess)
            assertEquals(1, reader.connectCalls)
            assertNull(reader.lastRequest?.address)
            val writesBefore = store.rfidWrites.get()

            // The adapter picked the sled itself.
            reader.setInfo(reader.info.value!!.copy(address = sledA, autoChosen = true))
            eventually("saved") { c.prefs.rfid.first().readerAddress == sledA }
            delay(500)
            assertEquals(writesBefore + 1, store.rfidWrites.get())
            // The saved address is the connected sled's own: no reconnect.
            assertEquals(1, reader.connectCalls)
            assertEquals(0, reader.disconnectCalls)

            // The same sled again, and a sled that was not chosen automatically: nothing written.
            reader.setInfo(reader.info.value!!.copy(generation = 99))
            reader.setInfo(reader.info.value!!.copy(address = sledB, autoChosen = false))
            delay(500)
            assertEquals(writesBefore + 1, store.rfidWrites.get())
            assertEquals(sledA, c.prefs.rfid.first().readerAddress)
            assertEquals(1, reader.connectCalls)
        } finally {
            c.shutDown()
        }
    }

    @Test fun aPickedSledIsNeverOverwrittenByAnAttemptInFlight() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        reader.paired = listOf(SledCandidate("RFD4031-A", sledA), SledCandidate("RFD4031-B", sledB))
        val c = testContainer(reader)
        try {
            c.start()
            // The operator picked B in the chooser while an attempt that auto-chose A was in flight.
            c.prefs.updateRfid { it.copy(readerAddress = sledB) }
            reader.setConnection(RfidConnection.Connected("RFD4031-A", 80))
            reader.setInfo(reader.info.value!!.copy(address = sledA.lowercase(), autoChosen = true))
            delay(600)
            assertEquals(sledB, c.prefs.rfid.first().readerAddress)

            // A saved sled that is no longer paired is replaced by the one the adapter found
            // (disconnected first, so the new saved address starts no reconnect of its own).
            reader.setConnection(RfidConnection.Disconnected)
            c.prefs.updateRfid { it.copy(readerAddress = "84:C6:92:00:00:FF") }
            reader.setInfo(SledInfo(generation = 50, name = "RFD4031-A", address = sledA, autoChosen = true))
            eventually("replaced") { c.prefs.rfid.first().readerAddress == sledA }
        } finally {
            c.shutDown()
        }
    }

    @Test fun aPickedSledsCaseOnlyDifferenceIsKept() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        reader.paired = listOf(SledCandidate("RFD4031-A", sledA))
        val c = testContainer(reader)
        try {
            c.start()
            c.prefs.updateRfid { it.copy(readerAddress = sledA.lowercase()) }
            reader.setConnection(RfidConnection.Connected("RFD4031-A", 80))
            reader.setInfo(reader.info.value!!.copy(address = sledA, autoChosen = true))
            delay(600)
            assertEquals(sledA.lowercase(), c.prefs.rfid.first().readerAddress)
        } finally {
            c.shutDown()
        }
    }

    @Test fun theNudgeReceiverRegistersIdempotently() = runBlocking<Unit> {
        val c = testContainer()
        try {
            val owner = ProcessLifecycleOwner.get()
            fun registered() = shadowOf(app).registeredReceivers.count { it.broadcastReceiver === c.sledNudgeReceiver }
            c.processLifecycle.onStop(owner)
            assertEquals(0, registered())
            c.processLifecycle.onStart(owner)
            c.processLifecycle.onStart(owner)
            assertEquals(1, registered())
            c.processLifecycle.onStop(owner)
            c.processLifecycle.onStop(owner)
            assertEquals(0, registered())
        } finally {
            c.shutDown()
        }
    }

    private fun scannerInputBroadcasts() = shadowOf(app).broadcastIntents.count {
        it.action == "com.symbol.datawedge.api.ACTION" &&
            it.getStringExtra("com.symbol.datawedge.api.SCANNER_INPUT_PLUGIN") == "ENABLE_PLUGIN"
    }

    @Test fun theScannerInputBroadcastGoesOncePerProcessOnAZebraHostOnly() = runBlocking<Unit> {
        ShadowBuild.setManufacturer("Google")
        val phone = testContainer()
        try {
            assertFalse(phone.isZebraHost)
            phone.enableScannerInputOnce(app)
            assertEquals(0, scannerInputBroadcasts())
        } finally {
            phone.shutDown()
        }

        ShadowBuild.setManufacturer("Zebra Technologies")
        val zebra = testContainer()
        try {
            assertTrue(zebra.isZebraHost)
            zebra.enableScannerInputOnce(app)
            zebra.enableScannerInputOnce(app)
            zebra.enableScannerInputOnce(app)
            assertEquals(1, scannerInputBroadcasts())
            assertEquals(DataWedge.PACKAGE, shadowOf(app).broadcastIntents.last().`package`)
        } finally {
            zebra.shutDown()
        }
    }

    @Test fun theControllerSeesThePrinterLock() = runBlocking<Unit> {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        try {
            c.start()
            var allow = false
            val gateCalls = AtomicInteger(0)
            c.rfid.connectForLifecycle { gateCalls.incrementAndGet(); allow }
            eventually("the lifecycle connect ran its gate") { gateCalls.get() > 0 }
            assertEquals(0, reader.connectCalls)
            allow = true

            val release = CompletableDeferred<Unit>()
            val held = CompletableDeferred<Unit>()
            c.scope.launch { c.printerLock.withLock { held.complete(Unit); release.await() } }
            held.await()
            assertTrue(c.printerLock.isLocked)
            // Bluetooth came on: one try, but not while a label holds the printer.
            c.rfid.nudge(com.serversherpa.kiosk.core.rfid.SledNudge.BLUETOOTH_ON)
            delay(1_500)
            assertEquals(0, reader.connectCalls)
            release.complete(Unit)
            eventually("dialed once the printer was free") { reader.connectCalls == 1 }
        } finally {
            c.shutDown()
        }
    }
}
