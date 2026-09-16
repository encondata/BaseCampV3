package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
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
}
