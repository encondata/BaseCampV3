package com.serversherpa.kiosk.core.rfid

/**
 * What a reconnect in progress is about, so the sled line can pick its
 * sentence: "The sled disconnected. Reconnecting…" after a drop, "Connecting
 * to *name*…" for a connect that never came up, and the trigger sentence when
 * that failure came last.
 *
 * [afterDrop] and [name] are fixed when the schedule starts (each attempt
 * clears the reader's `info`, so they cannot be read again per try): [name] is
 * the sled's name at the drop, else the paired sled whose address matches the
 * saved one, else null ("the sled"). [lastReason] is the last
 * `RfidConnection.Failed.reason` seen in the schedule.
 */
data class SledRetry(val afterDrop: Boolean, val name: String?, val lastReason: String?)
