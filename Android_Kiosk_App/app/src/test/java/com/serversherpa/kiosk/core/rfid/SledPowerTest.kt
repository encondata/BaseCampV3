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

    @Test fun aStepOfTenUsesOnlyTheEntriesUpTo400ForTheUnit() {
        val table = powerTable(IntArray(201) { 100 + it * 10 })!!
        assertFalse(table.inDbm)
        assertEquals(10, table.minDbm)
        assertEquals(40, table.maxDbm)
        assertEquals(17, powerIndex(table, 27))
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
