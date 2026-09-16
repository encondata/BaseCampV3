package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidTriggerTest {
    private fun act(mode: RfidTriggerMode, event: TriggerEvent, reading: Boolean, heldMs: Long = 0) =
        nextTriggerAction(mode, event, reading, heldMs)

    @Test fun holdReadsWhileTheTriggerIsDown() {
        assertEquals(TriggerAction.START, act(RfidTriggerMode.HOLD, TriggerEvent.PRESSED, reading = false))
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD, TriggerEvent.RELEASED, reading = true, heldMs = 1_500))
        // Even a flick of the trigger stops: hold mode never latches.
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD, TriggerEvent.RELEASED, reading = true, heldMs = 20))
    }

    @Test fun holdIgnoresEventsThatDoNotChangeAnything() {
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.HOLD, TriggerEvent.PRESSED, reading = true))
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.HOLD, TriggerEvent.RELEASED, reading = false))
    }

    @Test fun toggleFlipsOnEveryPressAndIgnoresRelease() {
        assertEquals(TriggerAction.START, act(RfidTriggerMode.TOGGLE, TriggerEvent.PRESSED, reading = false))
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.TOGGLE, TriggerEvent.PRESSED, reading = true))
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.TOGGLE, TriggerEvent.RELEASED, reading = true, heldMs = 5_000))
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.TOGGLE, TriggerEvent.RELEASED, reading = false))
    }

    @Test fun latchKeepsReadingAfterAQuickClick() {
        assertEquals(TriggerAction.START, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.PRESSED, reading = false))
        // Let go quickly and it stays on.
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.RELEASED, reading = true, heldMs = LATCH_MS - 1))
        // The next press ends the latched read.
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.PRESSED, reading = true))
    }

    @Test fun latchStillBehavesLikeHoldWhenTheTriggerIsHeld() {
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.RELEASED, reading = true, heldMs = LATCH_MS))
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.RELEASED, reading = true, heldMs = 3_000))
    }

    @Test fun aReleaseWhileStoppedNeverStartsAnything() {
        for (mode in RfidTriggerMode.entries) {
            assertEquals(mode.name, TriggerAction.NONE, act(mode, TriggerEvent.RELEASED, reading = false, heldMs = 10))
        }
    }
}
