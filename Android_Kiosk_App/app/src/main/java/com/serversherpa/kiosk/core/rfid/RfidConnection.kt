package com.serversherpa.kiosk.core.rfid

/** Where the reader stands, in the one shape the whole app reads. */
sealed class RfidConnection {
    /** The operator has not turned the reader on. Nothing connects, and no
     *  permission is asked for, while this is the state. */
    data object Disabled : RfidConnection()
    data object Disconnected : RfidConnection()
    data object Connecting : RfidConnection()
    data class Connected(val name: String, val batteryPct: Int?) : RfidConnection()
    /** Carries a sentence the operator can act on, not an SDK code. */
    data class Failed(val reason: String) : RfidConnection()
}

fun connectionLine(c: RfidConnection): String = when (c) {
    RfidConnection.Disabled -> "Off. Turn the reader on to use the sled."
    RfidConnection.Disconnected -> "Not connected."
    RfidConnection.Connecting -> "Connecting…"
    is RfidConnection.Connected -> if (c.batteryPct == null) "Connected to ${c.name}" else "Connected to ${c.name} · battery ${c.batteryPct}%"
    is RfidConnection.Failed -> c.reason
}
