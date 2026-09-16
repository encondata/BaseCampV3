package com.serversherpa.kiosk.core.setup

/** `kiosk_setup_complete` — kiosk-local; default INCOMPLETE. */
enum class SetupState(val wire: String, val label: String) {
    INCOMPLETE("incomplete", "Incomplete"), COMPLETE("complete", "Complete"), FAILED("failed", "Failed");

    val isComplete: Boolean get() = this == COMPLETE

    companion object {
        fun fromWire(s: String?): SetupState = entries.firstOrNull { it.wire == s } ?: INCOMPLETE
    }
}
