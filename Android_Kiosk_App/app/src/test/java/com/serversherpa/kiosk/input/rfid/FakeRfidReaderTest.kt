package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledKey
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerFault
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import com.serversherpa.kiosk.core.rfid.readbackOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the fake down to what a real RFD40 would actually allow, so a
 * controller bug that skips connecting fails here instead of only on
 * hardware, and a test that emits before its collector subscribes finds out
 * loudly instead of silently losing the tag. Also pins the recorders, knobs
 * and drivers the controller and screen tests lean on (spec, "What
 * FakeRfidReader must do").
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FakeRfidReaderTest {
    private val rfid = SledConnectRequest(null, SledTriggerLayout.RFID)

    @Test fun startInventoryFailsWhileDisconnected() = runTest {
        val reader = FakeRfidReader()

        val result = reader.startInventory()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is SledNotConnected)
        assertFalse(reader.inventoryRunning)
    }

    @Test fun applyFailsWhileDisconnected() = runTest {
        val reader = FakeRfidReader()

        val result = reader.apply(DEFAULT_RFID_SETTINGS)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is SledNotConnected)
        assertNull(reader.applied)
    }

    @Test fun startInventoryAndApplySucceedAfterConnecting() = runTest {
        val reader = FakeRfidReader()

        val connected = reader.connect(rfid)
        assertTrue(connected.isSuccess)

        val started = reader.startInventory()
        val applied = reader.apply(DEFAULT_RFID_SETTINGS)

        assertTrue(started.isSuccess)
        assertTrue(reader.inventoryRunning)
        assertTrue(applied.isSuccess)
        assertEquals(DEFAULT_RFID_SETTINGS, reader.applied)
    }

    @Test fun aFailedConnectLeavesTheReaderFailedAndStillRefusesInventory() = runTest {
        val reader = FakeRfidReader()
        reader.connectResult = Result.failure(IllegalStateException("No sled paired."))

        val connected = reader.connect(rfid)
        assertTrue(connected.isFailure)
        assertEquals(RfidConnection.Failed("No sled paired."), reader.connection.value)

        val started = reader.startInventory()
        assertTrue(started.isFailure)
        assertFalse(reader.inventoryRunning)
    }

    @Test fun emitTagThrowsWhenNothingIsCollecting() = runTest {
        val reader = FakeRfidReader()

        assertThrows(IllegalStateException::class.java) {
            reader.emitTag("100348")
        }
    }

    @Test fun emitTriggerThrowsWhenNothingIsCollecting() = runTest {
        val reader = FakeRfidReader()

        assertThrows(IllegalStateException::class.java) {
            reader.emitTrigger(TriggerEvent.PRESSED)
        }
    }

    @Test fun emitBarcodeAndEmitUnsolicitedStopThrowWhenNothingIsCollecting() = runTest {
        val reader = FakeRfidReader()

        assertThrows(IllegalStateException::class.java) { reader.emitBarcode(SledBarcode("A-100", "CODE128")) }
        assertThrows(IllegalStateException::class.java) { reader.emitUnsolicitedStop("the sled stopped") }
    }

    @Test fun setConnectionToDisconnectedClearsInventoryRunning() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.startInventory()
        assertTrue(reader.inventoryRunning)

        reader.setConnection(RfidConnection.Disconnected)

        assertFalse(reader.inventoryRunning)
    }

    @Test fun setConnectionToFailedClearsInventoryRunning() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.startInventory()
        assertTrue(reader.inventoryRunning)

        reader.setConnection(RfidConnection.Failed("The reader disconnected."))

        assertFalse(reader.inventoryRunning)
    }

    @Test fun connectAgainWhileInventoryIsRunningClearsInventoryRunning() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.startInventory()
        assertTrue(reader.inventoryRunning)

        reader.connect(rfid)

        assertFalse(reader.inventoryRunning)
    }

    // ── row 21 and the reader contract ──

    @Test fun stopWhileNotConnectedIsSledNotConnected() = runTest {
        val reader = FakeRfidReader()

        val result = reader.stopInventory()

        assertTrue(result.exceptionOrNull() is SledNotConnected)
        reader.connect(rfid)
        reader.startInventory()
        assertTrue(reader.stopInventory().isSuccess)
        assertFalse(reader.inventoryRunning)
    }

    @Test fun connectRecordsTheRequestAndStartsANewGeneration() = runTest {
        val reader = FakeRfidReader()
        val first = SledConnectRequest("00:11:22:33:44:55", SledTriggerLayout.SPLIT)
        reader.connect(first)
        assertEquals(first, reader.lastRequest)
        assertEquals(1, reader.info.value?.generation)
        assertEquals(1, reader.generation)
        reader.startInventory()
        assertTrue(reader.inventoryRunning)

        // Hold the second attempt open: while it runs, info is null and no inventory runs.
        val hold = CompletableDeferred<Unit>()
        reader.holdNext = hold
        val second = SledConnectRequest(null, SledTriggerLayout.BARCODE)
        val job = launch { reader.connect(second) }
        runCurrent()
        assertEquals(RfidConnection.Connecting, reader.connection.value)
        assertNull("info is null at the start of each attempt", reader.info.value)
        assertFalse("a connect leaves no inventory running", reader.inventoryRunning)
        assertEquals(second, reader.lastRequest)
        hold.complete(Unit)
        job.join()

        assertEquals(2, reader.info.value?.generation)
        assertEquals(2, reader.connectCalls)
        assertEquals(RfidConnection.Connected("Fake RFD40", 80), reader.connection.value)
        assertNull("holdNext resets once a call has taken it", reader.holdNext)
    }

    @Test fun needsRegionAllowsOnlyRegions() = runTest {
        val reader = FakeRfidReader()
        reader.needsRegion = true
        reader.reportedRegions = RfidRegions(emptyList(), null)

        assertTrue(reader.connect(rfid).isSuccess)

        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), reader.connection.value)
        assertEquals(1, reader.info.value?.generation)
        assertTrue(reader.regions().isSuccess)
        assertTrue(reader.setRegion("USA", hopping = null).isSuccess)
        assertEquals("USA" to null, reader.lastRegionSet)
        assertTrue(reader.apply(DEFAULT_RFID_SETTINGS).exceptionOrNull() is SledNotConnected)
        assertTrue(reader.startInventory().exceptionOrNull() is SledNotConnected)
        assertTrue(reader.setTriggerLayout(SledTriggerLayout.SPLIT).exceptionOrNull() is SledNotConnected)
        assertNull(reader.applied)
        assertFalse(reader.inventoryRunning)
    }

    @Test fun regionsAndSetRegionAreRefusedWhileDisconnected() = runTest {
        val reader = FakeRfidReader()

        assertTrue(reader.regions().exceptionOrNull() is SledNotConnected)
        assertTrue(reader.setRegion("USA", hopping = true).exceptionOrNull() is SledNotConnected)
        assertEquals(1, reader.regionsCalls)
        assertNull(reader.lastRegionSet)
    }

    @Test fun setConnectionConnectedCreatesInfoOnceAndKeepsItOnABatteryChange() = runTest {
        val reader = FakeRfidReader()

        reader.setConnection(RfidConnection.Connected("RFD4031", 80))
        val info = reader.info.value
        assertEquals(SledInfo(generation = 1, name = "RFD4031"), info)

        reader.setConnection(RfidConnection.Connected("RFD4031", 70))
        assertEquals("a battery change is not a new generation", info, reader.info.value)
        assertEquals(1, reader.generation)

        reader.setConnection(RfidConnection.Disconnected)
        assertNull(reader.info.value)
        reader.setConnection(RfidConnection.NeedsRegion("RFD4031"))
        assertEquals(SledInfo(generation = 2, name = "RFD4031"), reader.info.value)
    }

    @Test fun dropLinkFailsRetryablyAndKeepsInfo() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.setScanner(SledScannerState.Ready)
        reader.startInventory()
        val info = reader.info.value

        reader.dropLink("The sled disconnected.")

        assertEquals(RfidConnection.Failed("The sled disconnected.", retryable = true), reader.connection.value)
        assertEquals(info, reader.info.value)
        assertFalse(reader.inventoryRunning)
        assertEquals(SledScannerState.Off, reader.scanner.value)
    }

    @Test fun emitTriggerStampsPullsAndMapsTriggers() = runTest {
        val reader = FakeRfidReader()
        val pulls = mutableListOf<TriggerPull>()
        val triggers = mutableListOf<TriggerEvent>()
        backgroundScope.launch { reader.pulls.collect { pulls += it } }
        backgroundScope.launch { reader.triggers.collect { triggers += it } }
        runCurrent()

        reader.emitTrigger(TriggerEvent.PRESSED, 123)
        reader.emitTrigger(TriggerEvent.RELEASED)
        runCurrent()

        assertEquals(listOf(TriggerPull(TriggerEvent.PRESSED, 123), TriggerPull(TriggerEvent.RELEASED, null)), pulls)
        assertEquals(listOf(TriggerEvent.PRESSED, TriggerEvent.RELEASED), triggers)
    }

    @Test fun aConnectFailureCarryingAFailedStatePublishesIt() = runTest {
        val reader = FakeRfidReader()
        val failed = RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH)
        reader.connectResult = Result.failure(SledConnectException(failed))

        val result = reader.connect(rfid)

        assertEquals(failed, reader.connection.value)
        assertEquals(failed, (result.exceptionOrNull() as SledConnectException).failed)
        assertNull("a connect that never came up leaves no info", reader.info.value)
        assertEquals(0, reader.generation)

        // Any other failure: its message, else the couldn't-reach sentence; returned as a
        // SledConnectException whose state is the one just published.
        reader.connectResult = Result.failure(IllegalStateException())
        val plain = reader.connect(rfid)
        val published = reader.connection.value
        assertEquals(RfidConnection.Failed(SledWords.couldNotReach("Fake RFD40")), published)
        assertEquals(published, (plain.exceptionOrNull() as SledConnectException).failed)
        assertEquals(SledWords.couldNotReach("Fake RFD40"), plain.exceptionOrNull()?.message)
    }

    @Test fun setTriggerLayoutRecordsAndUpdatesTheReadback() = runTest {
        val reader = FakeRfidReader()
        assertTrue(reader.setTriggerLayout(SledTriggerLayout.SPLIT).exceptionOrNull() is SledNotConnected)
        reader.connect(rfid)
        assertNull(reader.info.value?.trigger)

        val split = reader.setTriggerLayout(SledTriggerLayout.SPLIT).getOrThrow()
        assertEquals(SledTriggerLayout.SPLIT, split.layout)
        assertEquals(SledKey.RFID to SledKey.SLED_SCAN, split.upper to split.lower)
        assertEquals(split, reader.info.value?.trigger)

        // A sled known to have no scanner is written the RFID layout whatever is asked.
        reader.setInfo(reader.info.value!!.copy(hasScanner = false))
        assertEquals(SledTriggerLayout.RFID, reader.setTriggerLayout(SledTriggerLayout.BARCODE).getOrThrow().layout)

        val other = readbackOf(SledKey.RFID, SledKey.TERMINAL_SCAN, 6)
        reader.layoutResult = Result.success(other)
        assertEquals(other, reader.setTriggerLayout(SledTriggerLayout.RFID).getOrThrow())
        assertEquals(other, reader.info.value?.trigger)

        assertEquals(
            listOf(SledTriggerLayout.SPLIT, SledTriggerLayout.SPLIT, SledTriggerLayout.BARCODE, SledTriggerLayout.RFID),
            reader.layoutCalls,
        )
    }

    @Test fun violationsCatchACallDuringARunningInventory() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.setScanner(SledScannerState.Ready)
        reader.startInventory()

        reader.softScan(true)
        reader.retryScanner()
        reader.pairedSleds()
        reader.setVendorLogging(true)
        assertEquals(emptyList<String>(), reader.violations)

        reader.apply(DEFAULT_RFID_SETTINGS)
        assertEquals(1, reader.violations.size)
        assertTrue(reader.violations.single(), reader.violations.single().contains("apply"))

        reader.stopInventory()
        reader.apply(DEFAULT_RFID_SETTINGS)
        assertEquals("stop ends the inventory, so the next call is fine", 1, reader.violations.size)
    }

    @Test fun violationsCatchTwoCallsInFlightAtOnce() = runBlocking {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.setScanner(SledScannerState.Ready)

        val holdApply = CompletableDeferred<Unit>()
        reader.holdNext = holdApply
        val apply = launch(Dispatchers.Default) { reader.apply(DEFAULT_RFID_SETTINGS) }
        withTimeout(5_000) { while (reader.holdNext != null) delay(5) }
        withContext(Dispatchers.Default) { reader.regions() }
        assertEquals(1, reader.violations.size)
        val entry = reader.violations.single()
        assertTrue(entry, entry.contains("regions") && entry.contains("apply"))

        withContext(Dispatchers.Default) {
            reader.softScan(true)
            reader.pairedSleds()
        }
        assertEquals("softScan and pairedSleds are never violations", 1, reader.violations.size)
        holdApply.complete(Unit)
        apply.join()

        val holdConnect = CompletableDeferred<Unit>()
        reader.holdNext = holdConnect
        val connect = launch(Dispatchers.Default) { reader.connect(rfid) }
        withTimeout(5_000) { while (reader.holdNext != null) delay(5) }
        withContext(Dispatchers.Default) { reader.disconnect() }
        assertEquals(2, reader.violations.size)
        assertTrue(reader.violations[1], reader.violations[1].contains("disconnect") && reader.violations[1].contains("connect"))
        holdConnect.complete(Unit)
        connect.join()
    }

    @Test fun vendorLoggingFollowsTheLastSet() = runTest {
        val reader = FakeRfidReader()
        assertFalse(reader.vendorLogging.value)
        reader.setVendorLogging(true)
        assertTrue(reader.vendorLogging.value)
        reader.setVendorLogging(false)
        assertFalse(reader.vendorLogging.value)
    }

    @Test fun connectPublishesTheRequestsAddressBeforeConnected() = runTest {
        val reader = FakeRfidReader()
        var seen: SledInfo? = null
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            reader.connection.collect { if (it is RfidConnection.Connected) seen = reader.info.value }
        }

        reader.connect(SledConnectRequest("00:11:22:33:44:55", SledTriggerLayout.RFID))

        assertEquals(SledInfo(generation = 1, name = "Fake RFD40", address = "00:11:22:33:44:55"), seen)
    }

    @Test fun disconnectCallsAreCounted() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.setScanner(SledScannerState.Ready)
        reader.startInventory()

        reader.disconnect()

        assertEquals(1, reader.disconnectCalls)
        assertEquals(RfidConnection.Disconnected, reader.connection.value)
        assertFalse("a disconnect leaves no inventory running", reader.inventoryRunning)
        assertNull("info is null after disconnect()", reader.info.value)
        assertEquals(SledScannerState.Off, reader.scanner.value)

        reader.disconnect()
        assertEquals(2, reader.disconnectCalls)
        assertEquals(RfidConnection.Disconnected, reader.connection.value)
    }

    @Test fun softScanSucceedsOnlyWhileTheScannerIsReady() = runTest {
        val reader = FakeRfidReader()
        assertTrue(reader.softScan(true).exceptionOrNull() is SledNotConnected)
        reader.connect(rfid)
        reader.setScanner(SledScannerState.Opening)
        assertTrue(reader.softScan(true).exceptionOrNull() is SledNotConnected)
        reader.setScanner(SledScannerState.Ready)
        assertTrue(reader.softScan(true).isSuccess)
        assertTrue(reader.softScan(false).isSuccess)
        reader.setScanner(SledScannerState.Unavailable(SledScannerFault.DID_NOT_START))
        assertTrue(reader.softScan(true).isFailure)

        assertEquals(listOf(true, true, true, false, true), reader.softScans)
    }

    @Test fun retryScannerSucceedsOnlyWhileConnected() = runTest {
        val reader = FakeRfidReader()
        assertTrue(reader.retryScanner().exceptionOrNull() is SledNotConnected)
        reader.connect(rfid)
        assertTrue(reader.retryScanner().isSuccess)
        reader.dropLink("The sled disconnected.")
        assertTrue(reader.retryScanner().exceptionOrNull() is SledNotConnected)

        assertEquals(3, reader.retryScannerCalls)
    }

    @Test fun layoutCallsRecordFailedCallsToo() = runTest {
        val reader = FakeRfidReader()
        reader.connect(rfid)
        reader.layoutResult = Result.failure(IllegalStateException(SledWords.TRIGGER_CHECK_FAILED))

        val result = reader.setTriggerLayout(SledTriggerLayout.BARCODE)

        assertEquals(SledWords.TRIGGER_CHECK_FAILED, result.exceptionOrNull()?.message)
        assertNull("a failed check leaves the read-back as it was", reader.info.value?.trigger)
        reader.disconnect()
        reader.setTriggerLayout(SledTriggerLayout.SPLIT)
        assertEquals(listOf(SledTriggerLayout.BARCODE, SledTriggerLayout.SPLIT), reader.layoutCalls)
    }

    @Test fun theOtherKnobsAndDriversDoWhatTheySay() = runTest {
        val reader = FakeRfidReader()
        val sled = SledCandidate("RFD4031", "00:11:22:33:44:55")
        reader.paired = listOf(sled)
        assertEquals(listOf(sled), reader.pairedSleds())

        reader.requestBattery()
        reader.connect(rfid)
        reader.requestBattery()
        assertEquals(2, reader.batteryRequests)

        reader.setBatchRecovery(true)
        assertTrue(reader.batchRecovery.value)

        reader.startResult = Result.failure(IllegalStateException(SledWords.CHARGING))
        assertEquals(SledWords.CHARGING, reader.startInventory().exceptionOrNull()?.message)
        assertFalse("a refused start runs no inventory", reader.inventoryRunning)
        reader.stopResult = Result.failure(IllegalStateException("not confirmed"))
        assertTrue(reader.stopInventory().isFailure)

        reader.setScanner(SledScannerState.Ready)
        reader.setConnection(RfidConnection.Failed("x", retryable = true))
        assertEquals("anything but Connected turns the scanner off", SledScannerState.Off, reader.scanner.value)

        val barcodes = mutableListOf<SledBarcode>()
        val stops = mutableListOf<String>()
        backgroundScope.launch { reader.barcodes.collect { barcodes += it } }
        backgroundScope.launch { reader.unsolicitedStops.collect { stops += it } }
        runCurrent()
        reader.emitBarcode(SledBarcode("A-100", "CODE128"))
        reader.emitUnsolicitedStop("the sled ended the sweep")
        runCurrent()
        assertEquals(listOf(SledBarcode("A-100", "CODE128")), barcodes)
        assertEquals(listOf("the sled ended the sweep"), stops)
    }
}
