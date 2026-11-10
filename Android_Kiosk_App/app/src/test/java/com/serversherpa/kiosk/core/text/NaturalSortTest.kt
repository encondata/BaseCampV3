package com.serversherpa.kiosk.core.text

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NaturalSortTest {
    @Test fun numbersByValue() {
        assertTrue(naturalCompare("Rack 2", "Rack 10") < 0)
        assertTrue(naturalCompare("a10", "a9") > 0)
        assertTrue(naturalCompare("a1", "a01") < 0)
        assertEquals(0, naturalCompare("a1", "a1"))
    }

    @Test fun caseIgnored() {
        assertEquals(0, naturalCompare("ABC", "abc"))
        assertTrue(naturalCompare("apple", "Banana") < 0)
    }

    @Test fun nullsFirst() {
        assertTrue(naturalCompare(null, "a") < 0)
        assertEquals(0, naturalCompare(null, ""))
        assertTrue(naturalCompare("a", null) > 0)
    }
}
