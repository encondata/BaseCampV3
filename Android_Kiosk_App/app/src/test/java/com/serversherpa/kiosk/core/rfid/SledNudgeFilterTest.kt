package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Whose link appearing nudges the reconnect (spec, Controller › Reconnect; hardware script step 32). */
class SledNudgeFilterTest {
    private val a = SledCandidate("RFD4031-A", "AA:BB:CC:00:00:01")
    private val b = SledCandidate("RFD4031-B", "AA:BB:CC:00:00:02")

    @Test fun theLastOrSavedSledCountsOnlyWhileItIsStillPaired() {
        assertEquals("the last sled, matched ignoring case", "aa:bb:cc:00:00:01", sledNudgeAddress("aa:bb:cc:00:00:01", b.address, listOf(a, b)))
        assertEquals("no last sled: the saved one", b.address, sledNudgeAddress(null, b.address, listOf(a, b)))
        assertEquals("the last one was forgotten: the saved one", b.address, sledNudgeAddress(a.address, b.address, listOf(b)))
        assertNull("the saved one was forgotten: none known", sledNudgeAddress(null, a.address, listOf(b)))
        assertNull(sledNudgeAddress(a.address, a.address, emptyList()))
        assertNull(sledNudgeAddress(null, null, listOf(a, b)))
    }

    @Test fun withNoSledKnownAnyDeviceNamedLikeASledCounts() {
        assertTrue(isNudgeFromOurSled("aa:bb:cc:00:00:01", "anything", known = a.address))
        assertFalse(isNudgeFromOurSled(b.address, "RFD4031-B", known = a.address))
        assertTrue(isNudgeFromOurSled(b.address, "RFD4031-B", known = null))
        assertFalse(isNudgeFromOurSled(b.address, "Car stereo", known = null))
        assertFalse(isNudgeFromOurSled(b.address, null, known = null))
    }
}
