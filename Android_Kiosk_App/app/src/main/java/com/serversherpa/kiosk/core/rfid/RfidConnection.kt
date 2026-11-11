package com.serversherpa.kiosk.core.rfid

/** Where the reader stands, in the one shape the whole app reads. Only the reader writes it. */
sealed class RfidConnection {
    /** The operator has not turned the reader on. Nothing connects, and no
     *  permission is asked for, while this is the state. No reader writes it:
     *  screens show it from `enabled == false`. */
    data object Disabled : RfidConnection()

    /** No link, and none wanted by the last call. */
    data object Disconnected : RfidConnection()

    /** An attempt is running. */
    data object Connecting : RfidConnection()

    /** Link up, region set. */
    data class Connected(val name: String, val batteryPct: Int?) : RfidConnection()

    /** Link up but the sled has no region: only reading and setting the region work. */
    data class NeedsRegion(val name: String) : RfidConnection()

    /** Carries a sentence the operator can act on, not an SDK code. [retryable]
     *  says whether waiting and trying again can help; [fix] names the button
     *  that fixes it, when there is one. */
    data class Failed(val reason: String, val retryable: Boolean = false, val fix: SledFix? = null) : RfidConnection()
}

/** The button that fixes a [RfidConnection.Failed]. */
enum class SledFix { TURN_ON_BLUETOOTH, BLUETOOTH_SETTINGS, ALLOW, CHOOSE_SLED, CONNECT }

fun connectionLine(c: RfidConnection): String = when (c) {
    RfidConnection.Disabled -> SledWords.OFF
    RfidConnection.Disconnected -> SledWords.NOT_CONNECTED
    RfidConnection.Connecting -> SledWords.CONNECTING
    is RfidConnection.Connected -> SledWords.connected(c.name, c.batteryPct)
    is RfidConnection.NeedsRegion -> SledWords.noRegion(c.name)
    is RfidConnection.Failed -> c.reason
}
