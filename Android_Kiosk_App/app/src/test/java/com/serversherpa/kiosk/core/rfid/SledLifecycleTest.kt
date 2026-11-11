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

    @Test fun nothingSavesTheConfigOfASledThatMayHoldALayout() {
        // saveConfig() saves the whole running config, and a layout written by
        // an earlier connection stays in it through a link drop.
        val memory = SledLayoutMemory()
        assertFalse(memory.mayHoldLayout("00:11:22:33:44:55"))
        assertFalse(memory.mayHoldLayout(null))
        memory.written("00:11:22:33:44:55")
        assertTrue("case is ignored", memory.mayHoldLayout("00:11:22:33:44:55".lowercase()))
        assertFalse("another sled", memory.mayHoldLayout("00:11:22:33:44:66"))

        assertEquals(
            BatchRecoveryPlan(stop = true, purge = true, disableBatchMode = true, saveConfig = false),
            batchRecoveryPlan(secondInARow = false, layoutMayBeLive = true),
        )
        assertEquals(
            TeardownPlan(stopInventory = true, disableBatchMode = true, saveConfig = false),
            teardownPlan(linkUp = true, wroteLayout = memory.mayHoldLayout("00:11:22:33:44:55")),
        )
    }

    @Test fun connectStep2SavesOnlyAReadItCanTrustAndNeverOverALayout() {
        assertEquals(BatchPrevention.NOTHING, batchPrevention("0", layoutMayBeLive = false))
        assertEquals(BatchPrevention.NOTHING, batchPrevention("0", layoutMayBeLive = true))
        assertEquals(BatchPrevention.OFF_AND_SAVE, batchPrevention("2", layoutMayBeLive = false))
        assertEquals("a save would keep the layout", BatchPrevention.OFF, batchPrevention("2", layoutMayBeLive = true))
        assertEquals("a rejected read is unknown: off, not saved", BatchPrevention.OFF, batchPrevention(null, layoutMayBeLive = false))
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
