package com.serversherpa.kiosk.core.scan

import com.serversherpa.kiosk.core.scan.SledScanGuard.Companion.MAX_HOLD_MS
import com.serversherpa.kiosk.core.scan.SledScanGuard.Companion.QUIET_MS
import com.serversherpa.kiosk.core.scan.SledScanGuard.Companion.SETTLE_MS
import com.serversherpa.kiosk.core.scan.SledScanGuard.Companion.WINDOW_MS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spec test 25 (R1), the pure part: one guard delivers each sled scan once, by whichever route
 *  (typed keystrokes or the scanner session) gets there first. */
class SledScanGuardTest {
    private val log = mutableListOf<String>()
    private fun guard(onTyping: () -> Unit = {}) = SledScanGuard(log = { log += it }, onTyping = onTyping)

    @Test fun theConstantsAreTheSpecsNumbers() {
        assertEquals(2_000L, WINDOW_MS)
        assertEquals(120L, SETTLE_MS)
        assertEquals(150L, QUIET_MS)
        assertEquals(1_500L, MAX_HOLD_MS)
    }

    @Test fun theOtherRoutesCopyWithinTheWindowIsRefused() {
        val typedFirst = guard()
        assertTrue(typedFirst.acceptTyped("100348", 0))
        assertFalse(typedFirst.acceptSession("100348", 1_999))

        val sessionFirst = guard()
        assertTrue(sessionFirst.acceptSession("100348", 0))
        assertFalse(sessionFirst.acceptTyped("100348", 1_999))
    }

    @Test fun aCopyAfterTheWindowIsAccepted() {
        val typedFirst = guard()
        assertTrue(typedFirst.acceptTyped("100348", 0))
        assertTrue(typedFirst.acceptSession("100348", 2_001))

        val sessionFirst = guard()
        assertTrue(sessionFirst.acceptSession("100348", 0))
        assertTrue(sessionFirst.acceptTyped("100348", 2_001))
    }

    @Test fun theSameRouteTwiceIsNeverRefused() {
        val g = guard()
        assertTrue(g.acceptTyped("100348", 0))
        assertTrue(g.acceptTyped("100348", 10))
        assertTrue(g.acceptSession("A-1", 20))
        assertTrue(g.acceptSession("A-1", 30))
    }

    @Test fun aDifferentValueIsNeverRefused() {
        val g = guard()
        assertTrue(g.acceptTyped("100348", 0))
        assertTrue(g.acceptSession("100349", 5))
    }

    /** Two scans of the same code, each sent both ways: delivered twice, once per scan. One
     *  accepted copy cancels at most one copy from the other route. */
    @Test fun twoScansOfTheSameCodeEachSentBothWaysDeliverTwice() {
        val g = guard()
        val delivered = listOf(
            g.acceptTyped("100348", 0),
            g.acceptSession("100348", 130),
            g.acceptTyped("100348", 600),
            g.acceptSession("100348", 730),
        ).count { it }
        assertEquals(2, delivered)
    }

    @Test fun theHoldIsSettleWithNoTyping() {
        val g = guard()
        assertEquals(120L, g.sessionHoldMs(0, 0))
        assertEquals(20L, g.sessionHoldMs(0, 100))
        assertEquals(0L, g.sessionHoldMs(0, 120))
    }

    @Test fun aSessionCopyArrivingMidTypingIsHeld() {
        val g = guard()
        g.noteTyping(100)
        // Settled at 120 ms, but a key 20 ms ago: wait until 150 ms after it.
        assertEquals(130L, g.sessionHoldMs(0, 120))
        assertEquals(0L, g.sessionHoldMs(0, 250))
        // Typing that started before the copy arrived counts too.
        val early = guard()
        early.noteTyping(-50)
        assertEquals(120L, early.sessionHoldMs(0, 0))
        assertEquals(0L, early.sessionHoldMs(0, 120))
    }

    @Test fun theHoldNeverExceedsMaxHold() {
        val g = guard()
        var now = 0L
        var waited = 0L
        while (true) {
            val h = g.sessionHoldMs(0, now)
            if (h == 0L) break
            // A key every 50 ms, without end.
            val step = minOf(h, 50L)
            now += step
            waited += step
            g.noteTyping(now)
            assertTrue("held $waited ms", waited <= MAX_HOLD_MS)
        }
        assertEquals(MAX_HOLD_MS, now)
        assertEquals(0L, g.sessionHoldMs(0, 1_500))
        // Close to the cap, the hold is cut to what is left.
        val near = guard()
        near.noteTyping(1_450)
        assertEquals(40L, near.sessionHoldMs(0, 1_460))
    }

    @Test fun theDefaultGuardAcceptsEverything() {
        val g = SledScanGuard.ACCEPT_ALL
        assertTrue(g.acceptTyped("100348", 0))
        assertTrue(g.acceptSession("100348", 1))
        assertTrue(g.acceptTyped("100348", 2))
        g.noteTyping(3)
        assertEquals(0L, g.sessionHoldMs(3, 3))
        val off = SledScanGuard(enabled = false, log = { log += it })
        assertTrue(off.acceptSession("X", 0))
        assertTrue(off.acceptTyped("X", 1))
        assertEquals(emptyList<String>(), log)
    }

    @Test fun aRefusalLogsRouteGapAndLengthNeverTheValue() {
        val g = guard()
        g.acceptTyped("SECRET-BADGE-77", 1_000)
        g.acceptSession("SECRET-BADGE-77", 1_340)
        assertEquals(1, log.size)
        val line = log.single()
        assertTrue(line, line.contains("typed first"))
        assertTrue(line, line.contains("340 ms"))
        assertTrue(line, line.contains("15 characters"))
        assertFalse(line, line.contains("SECRET"))
        assertFalse(line, line.contains("77"))

        log.clear()
        val s = guard()
        s.acceptSession("SECRET-BADGE-77", 0)
        s.acceptTyped("SECRET-BADGE-77", 25)
        val other = log.single()
        assertTrue(other, other.contains("session first"))
        assertTrue(other, other.contains("25 ms"))
        assertFalse(other, other.contains("SECRET"))
    }

    @Test fun aTypedOnlyAcceptanceIsLoggedAtTheNextCall() {
        val g = guard()
        g.scannerReady = true
        assertTrue(g.acceptTyped("100348", 0))
        g.noteTyping(1_999)
        assertEquals(emptyList<String>(), log)
        g.noteTyping(2_001)
        assertEquals(1, log.size)
        assertTrue(log.single(), log.single().contains("typed only"))
        assertTrue(log.single(), log.single().contains("6 characters"))
        assertFalse(log.single(), log.single().contains("100348"))
        // Once.
        g.noteTyping(5_000)
        assertEquals(1, log.size)

        // A session copy arrived: not typed only.
        log.clear()
        val paired = guard()
        paired.scannerReady = true
        paired.acceptTyped("100348", 0)
        paired.acceptSession("100348", 130)
        log.clear()
        paired.noteTyping(3_000)
        assertEquals(emptyList<String>(), log)

        // The scanner not ready: typing is the only route, nothing to say.
        val notReady = guard()
        notReady.acceptTyped("100348", 0)
        notReady.noteTyping(3_000)
        assertEquals(emptyList<String>(), log)
    }

    @Test fun copiesDifferingOnlyInSurroundingWhitespaceAreTheSameValue() {
        val typedFirst = guard()
        assertTrue(typedFirst.acceptTyped("100348\n", 0))
        assertFalse(typedFirst.acceptSession("  100348 ", 130))

        val sessionFirst = guard()
        assertTrue(sessionFirst.acceptSession("100348\r\n", 0))
        assertFalse(sessionFirst.acceptTyped("\t100348", 40))
    }

    @Test fun noteTypingRunsTheActivityHook() {
        var hooks = 0
        val g = guard(onTyping = { hooks++ })
        g.noteTyping(0)
        g.noteTyping(10)
        assertEquals(2, hooks)
    }
}
