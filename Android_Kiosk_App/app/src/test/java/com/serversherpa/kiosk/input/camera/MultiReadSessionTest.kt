package com.serversherpa.kiosk.input.camera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MultiReadSessionTest {
    @Test fun eachDistinctValueOnceNewestFirstCapped() {
        val s = MultiReadSession()
        assertTrue(s.offer("A")); assertFalse(s.offer("A")); assertTrue(s.offer(" B "))
        (1..10).forEach { s.offer("V$it") }
        assertEquals(12, s.count)
        assertEquals(listOf("V10", "V9", "V8", "V7", "V6"), s.recent)
        assertFalse(s.offer(""))
    }
}
