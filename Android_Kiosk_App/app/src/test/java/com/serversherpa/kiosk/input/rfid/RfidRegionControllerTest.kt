package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RfidRegionControllerTest {
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { runCurrent() } }

    private val usa = RfidRegion("USA", "United States", hoppingConfigurable = false, channels = emptyList())
    private val eu = RfidRegion("ETSI", "Europe", hoppingConfigurable = true, channels = emptyList())

    private class Rig(scope: kotlinx.coroutines.CoroutineScope) {
        val reader = FakeRfidReader()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(reader, settings, scope) { 0L }
    }

    @Test fun theRegionListComesFromTheReader() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        val got = r.controller.loadRegions().getOrThrow()
        assertEquals(listOf(usa, eu), got.supported)
        assertEquals("USA", got.active)
    }

    @Test fun pickingARegionReachesTheReader() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        assertTrue(r.controller.setRegion("ETSI", hopping = true).isSuccess)
        assertEquals("ETSI" to true, r.reader.lastRegionSet)
    }

    /** Changing the radio's regulatory domain in the middle of a sweep is not
     *  something to find out about experimentally. */
    @Test fun theRegionCannotBeChangedWhileASweepIsRunning() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()

        val result = r.controller.setRegion("ETSI", hopping = null)
        assertTrue(result.isFailure)
        assertEquals("Finish the current read before changing the region.", result.exceptionOrNull()?.message)
        assertEquals(null, r.reader.lastRegionSet)
    }

    @Test fun aReaderThatRefusesTheRegionSaysWhy() = runTest {
        val r = Rig(backgroundScope)
        r.reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        r.reader.regionResult = Result.failure(IllegalStateException("Region is locked on this reader."))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()

        val result = r.controller.setRegion("ETSI", hopping = null)
        assertEquals("Region is locked on this reader.", result.exceptionOrNull()?.message)
    }

    @Test fun neitherCallWorksWhileDisconnected() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        assertTrue(r.controller.loadRegions().isFailure)
        assertTrue(r.controller.setRegion("ETSI", hopping = null).isFailure)
    }

    /**
     * A reader whose `setRegion()` signals [regionStarted] and then hangs on
     * [proceedRegion] until the test releases it — `RfidControllerTest`'s
     * `SlowApplyReader`/`SlowConnectReader`/`SlowStopReader` idiom, applied
     * to the region vendor call so the Critical mid-sweep-refusal race (a
     * trigger START landing while a region write is still in flight on the
     * vendor link) can be driven deterministically. Everything else
     * delegates straight to [inner].
     */
    private class SlowRegionReader(private val inner: FakeRfidReader) : RfidReader {
        override val connection: StateFlow<RfidConnection> get() = inner.connection
        override val tags: Flow<String> get() = inner.tags
        override val triggers: Flow<TriggerEvent> get() = inner.triggers

        /** Completes the instant `setRegion()` is called. */
        val regionStarted = CompletableDeferred<Unit>()

        /** The test completes this once it wants `setRegion()` to actually
         *  return. */
        val proceedRegion = CompletableDeferred<Unit>()

        override suspend fun connect() = inner.connect()
        override suspend fun disconnect() = inner.disconnect()
        override suspend fun apply(settings: RfidSettings) = inner.apply(settings)
        override suspend fun startInventory() = inner.startInventory()
        override suspend fun stopInventory() = inner.stopInventory()
        override suspend fun regions() = inner.regions()
        override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> {
            regionStarted.complete(Unit)
            proceedRegion.await()
            return inner.setRegion(code, hopping)
        }
    }

    /**
     * The regression test for the Critical mid-sweep-refusal race: before
     * the fix, `setRegion` released `mutex` before its vendor round trip
     * (`reader.setRegion()` ran with no lock held at all), so a trigger
     * press landing in that gap could open a session and call
     * `startInventory()` on the vendor link while this call's
     * `reader.setRegion()` was still in flight — the radio would begin
     * transmitting while its regulatory domain was being rewritten
     * underneath it, the exact hazard the mid-sweep refusal exists to
     * prevent. The fix acquires `applyGate` before releasing `mutex` (the
     * same nesting `onTrigger`'s `TriggerAction.START` branch already uses),
     * so a trigger's own `applyGate.withLock { reader.startInventory() }`
     * cannot proceed until this call's `applyGate.unlock()` runs.
     *
     * This drives exactly that: a region write whose vendor call is gated
     * open, a trigger press fired while it is still in flight, and an
     * assertion that `startInventory()` has not actually run — the session
     * still opens (START's mid-sweep check ran and passed *before* the
     * region write started, and setting `_session` is unchanged by this
     * fix), but the vendor call it gates behind `applyGate` must wait.
     * Releasing the region write must then let the deferred start go
     * through.
     *
     * Against the pre-fix code, `startInventory()` runs immediately —
     * nothing serializes it against the in-flight region write — so
     * `inner.inventoryRunning` is already `true` right after the trigger
     * press, before the region write is ever released, and the assertion
     * below fails.
     */
    @Test fun aTriggerStartWaitsForAnInFlightRegionWriteToFinish() = runTest {
        val inner = FakeRfidReader()
        val slowRegion = SlowRegionReader(inner)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        val controller = RfidController(slowRegion, settings, backgroundScope) { 0L }
        controller.start(); controller.arm(); settle()
        controller.connectNow(); settle()

        var regionResult: Result<Unit>? = null
        backgroundScope.launch { regionResult = controller.setRegion("ETSI", hopping = true) }
        settle()
        assertTrue("setRegion's vendor call should have started", slowRegion.regionStarted.isCompleted)

        inner.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue(
            "the session should still open: the mid-sweep check ran and passed " +
                "before the region write started, and is unaffected by this fix",
            controller.session.value != null,
        )
        assertEquals(
            "a trigger START must not call startInventory() on the vendor link " +
                "while a region write is still in flight",
            false,
            inner.inventoryRunning,
        )

        // Let the stuck setRegion() finish.
        slowRegion.proceedRegion.complete(Unit); settle()

        assertTrue("the region write should have succeeded", regionResult?.isSuccess == true)
        assertEquals(
            "once the region write finishes, the trigger's deferred start should go through",
            true,
            inner.inventoryRunning,
        )
    }
}
