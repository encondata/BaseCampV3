package com.serversherpa.kiosk.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RfidTest {
    @Test fun padsTo24AndUppercases() {
        val p = padRfid(" 10 03 48 ")
        assertEquals("000000000000000000100348", p.tag)
        assertNull(p.problem)
        assertEquals("00000000000000000000ABCD", padRfid("abcd").tag)
    }

    @Test fun problems() {
        assertEquals(RfidProblem.EMPTY, padRfid("   ").problem)
        assertEquals(RfidProblem.NOT_ALPHANUMERIC, padRfid("10-03").problem)
        assertEquals(RfidProblem.TOO_LONG, padRfid("1".repeat(25)).problem)
        assertEquals("Scan the RFID tag.", rfidProblemText(RfidProblem.EMPTY))
        assertEquals("That tag is longer than 24 characters.", rfidProblemText(RfidProblem.TOO_LONG))
    }

    @Test fun displayStripsLeadingZerosButKeepsOne() {
        assertEquals("100348", displayRfid("000000000000000000100348"))
        assertEquals("0", displayRfid("0000"))
        assertEquals("—", displayRfid(null))
        assertEquals("—", displayRfid(""))
    }
}
