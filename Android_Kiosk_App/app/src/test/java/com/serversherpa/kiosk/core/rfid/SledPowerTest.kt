package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The transmit-power index the sled is sent, from its own power table (spec, Power index rule). */
class SledPowerTest {
    @Test fun aDbmTableIndexesByDbm() {
        val table = powerTable(IntArray(31) { it })!!
        assertTrue(table.inDbm)
        assertEquals(0, table.minDbm)
        assertEquals(30, table.maxDbm)
        assertEquals(27, powerIndex(table, 27))
    }

    @Test fun aTenthsTableIndexesByTenths() {
        val table = powerTable(IntArray(201) { 100 + it })!!
        assertFalse(table.inDbm)
        assertEquals(10, table.minDbm)
        assertEquals(30, table.maxDbm)
        assertEquals(170, powerIndex(table, 27))
    }

    @Test fun aStepOfTenUsesOnlyTheRealEntries() {
        // The vendor's table for MIN 100, MAX 300, step 10: 201 entries of
        // 100 + k * 10, so 100 to 2100. Only 100 to 300 are real.
        val table = powerTable(IntArray(201) { 100 + it * 10 })!!
        assertFalse(table.inDbm)
        assertEquals(10, table.minDbm)
        assertEquals("the real top, not an invented entry", 30, table.maxDbm)
        assertEquals(20, table.topIndex)
        assertEquals(17, powerIndex(table, 27))
        assertEquals(20, powerIndex(table, 30))
        assertEquals("never an index past the real top", 20, powerIndex(table, 35))
    }

    @Test fun aSledWhoseTopIsBelowTheSettingsCapIsNeverSentMoreThanItsTop() {
        // MIN 100, MAX 270, step 10: the slider still goes to 30 dBm.
        val table = powerTable(IntArray(171) { 100 + it * 10 })!!
        assertEquals(27, table.maxDbm)
        assertEquals("30 dBm is sent as the sled's own top, 270", 17, powerIndex(table, 30))
        assertEquals(270, table.levels[powerIndex(table, 30)])
    }

    @Test fun aDbmTableWithAStepOfTwoKeepsItsUnit() {
        // MIN 10, MAX 30, step 2: 21 entries of 10 + 2k, so 10 to 50.
        val table = powerTable(IntArray(21) { 10 + it * 2 })!!
        assertTrue("its real entries stop at 30, so it is in dBm", table.inDbm)
        assertEquals(10, table.minDbm)
        assertEquals(30, table.maxDbm)
        assertEquals(10, powerIndex(table, 30))
        assertEquals(10, powerIndex(table, 99))
    }

    @Test fun neverAboveTheLastIndexOrBelowZero() {
        assertEquals(30, powerIndex(powerTable(IntArray(31) { it }), 99))
        assertEquals(0, powerIndex(powerTable(IntArray(31) { 5 + it }), 2))
    }

    @Test fun noTableFallsBackToTenths() {
        assertNull(powerTable(null))
        assertNull(powerTable(IntArray(0)))
        assertEquals(270, powerIndex(null, 27))
        assertEquals(powerToTenths(27), powerIndex(powerTable(IntArray(0)), 27))
    }
}
