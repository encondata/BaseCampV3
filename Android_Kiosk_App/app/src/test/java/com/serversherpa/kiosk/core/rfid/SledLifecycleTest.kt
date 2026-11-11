package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Teardown, the batch recovery's steps, the scanner session's gate, the region arguments and the best-step deadline. */
class SledLifecycleTest {
    @Test fun teardownStopsAndDisablesOnlyWhenTheLinkIsUp() {
        val down = TeardownPlan(stopInventory = false, disableBatchMode = false, saveConfig = false)
        assertEquals(down, teardownPlan(linkUp = false, wroteLayout = false))
        assertEquals(down, teardownPlan(linkUp = false, wroteLayout = true))
        assertEquals(
            TeardownPlan(stopInventory = true, disableBatchMode = true, saveConfig = true),
            teardownPlan(linkUp = true, wroteLayout = false),
        )
    }

    @Test fun saveConfigIsSkippedAfterALayoutWrite() {
        assertEquals(
            TeardownPlan(stopInventory = true, disableBatchMode = true, saveConfig = false),
            teardownPlan(linkUp = true, wroteLayout = true),
        )
    }

    @Test fun aBatchResultGetsOneRecoveryThenOnlyAStop() {
        // Ruling 28: one recovery, then stop. A sled still batching at the
        // next connect gets its radio stopped, and no second purge or save.
        assertEquals(
            BatchRecoveryPlan(stop = true, purge = true, disableBatchMode = true, saveConfig = true),
            batchRecoveryPlan(secondInARow = false),
        )
        assertEquals(
            BatchRecoveryPlan(stop = true, purge = false, disableBatchMode = false, saveConfig = false),
            batchRecoveryPlan(secondInARow = true),
        )
    }

    @Test fun theScannerIsWantedOnlyByRuling7() {
        assertTrue(scannerWanted(connected = true, layoutInForceUsesScanner = true, zebraHost = false, hasScanner = null))
        assertTrue(scannerWanted(connected = true, layoutInForceUsesScanner = true, zebraHost = false, hasScanner = true))
        assertFalse(scannerWanted(connected = false, layoutInForceUsesScanner = true, zebraHost = false, hasScanner = true))
        assertFalse(scannerWanted(connected = true, layoutInForceUsesScanner = false, zebraHost = false, hasScanner = true))
        assertFalse(scannerWanted(connected = true, layoutInForceUsesScanner = true, zebraHost = true, hasScanner = true))
        assertFalse(scannerWanted(connected = true, layoutInForceUsesScanner = true, zebraHost = false, hasScanner = false))
    }

    @Test fun regionArgsPassHoppingOnlyWhenConfigurableAndNeverANullChannelList() {
        val channels = listOf("865700", "866300")
        assertEquals(RegionArgs(hopping = true, channels = channels), regionArgs(true, null, channels))
        assertEquals(RegionArgs(hopping = false, channels = channels), regionArgs(true, false, channels))
        assertEquals(RegionArgs(hopping = true, channels = emptyList()), regionArgs(true, true, null))
        assertEquals(RegionArgs(hopping = null, channels = emptyList()), regionArgs(false, true, null))
        assertEquals(RegionArgs(hopping = null, channels = channels), regionArgs(false, false, channels))
    }

    @Test fun bestStepsStopBeingDueAt8s() {
        assertTrue(bestStepDue(0))
        assertTrue(bestStepDue(7_999))
        assertFalse(bestStepDue(8_000))
        assertFalse(bestStepDue(30_000))
        assertEquals(8_000L, SLED_BEST_STEP_DEADLINE_MS)
    }
}
