package com.serversherpa.kiosk.core.rfid

/** What the sled's trigger just did. */
enum class TriggerEvent { PRESSED, RELEASED }

/** What that means for the inventory. */
enum class TriggerAction { START, STOP, NONE }

/** A release inside this window is a click, not the end of a hold. */
const val LATCH_MS = 500L

/**
 * The whole of the trigger's behavior, as a function of the mode, whether an
 * inventory is running, and how long the trigger was down. Keeping it pure is
 * the point: the three modes are fiddly, and nobody wants to hold a sled to
 * find out whether a latch works.
 *
 * `heldMs` matters only for a RELEASED event in latch mode; pass 0 otherwise.
 */
fun nextTriggerAction(mode: RfidTriggerMode, event: TriggerEvent, reading: Boolean, heldMs: Long): TriggerAction =
    when (mode) {
        RfidTriggerMode.HOLD -> when {
            event == TriggerEvent.PRESSED && !reading -> TriggerAction.START
            event == TriggerEvent.RELEASED && reading -> TriggerAction.STOP
            else -> TriggerAction.NONE
        }
        RfidTriggerMode.TOGGLE -> when {
            event == TriggerEvent.RELEASED -> TriggerAction.NONE
            reading -> TriggerAction.STOP
            else -> TriggerAction.START
        }
        RfidTriggerMode.HOLD_OR_LATCH -> when {
            event == TriggerEvent.PRESSED && !reading -> TriggerAction.START
            // A press while it is reading always ends a latched read.
            event == TriggerEvent.PRESSED -> TriggerAction.STOP
            // Released: a quick click latches, a real hold ends.
            reading && heldMs < LATCH_MS -> TriggerAction.NONE
            reading -> TriggerAction.STOP
            else -> TriggerAction.NONE
        }
    }
