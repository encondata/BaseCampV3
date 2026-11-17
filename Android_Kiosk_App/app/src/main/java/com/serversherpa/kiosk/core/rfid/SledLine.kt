package com.serversherpa.kiosk.core.rfid

/**
 * The one sentence about the sled that the RFID tab, the Devices tab and the
 * scan-screen slot all show (spec, Screens), with the button that fixes it
 * ([fix], when there is one) and whether it offers Stop ([offersStop]: only
 * while the app is reconnecting).
 */
data class SledLine(val text: String, val fix: SledFix?, val offersStop: Boolean)

/**
 * The sled line for [connection], tried top to bottom: the reader off; a
 * reconnect in progress ([reconnecting], about [retry]); `Connected`;
 * `NeedsRegion`; `Connecting`; a missing permission ([permissionMissing]:
 * something in `RfidPermissions.REQUIRED` is not granted); `Failed`;
 * `Disconnected`.
 *
 * While reconnecting, the trigger sentence wins when that was the last
 * failure, then the drop sentence, then "Connecting to *name*…" (with
 * [retry] null, "the sled"). `Disabled` while [enabled] is true (no reader
 * writes it) reads as not connected.
 */
fun sledLine(
    connection: RfidConnection,
    reconnecting: Boolean,
    enabled: Boolean,
    permissionMissing: Boolean,
    retry: SledRetry? = null,
): SledLine = when {
    !enabled -> SledLine(SledWords.OFF, fix = null, offersStop = false)
    reconnecting -> SledLine(
        when {
            retry?.lastReason == SledWords.TRIGGER_NOT_SET_UP -> SledWords.TRIGGER_NOT_SET_UP_RETRYING
            retry?.afterDrop == true -> SledWords.RECONNECTING_AFTER_DROP
            else -> SledWords.connectingTo(retry?.name)
        },
        fix = null,
        offersStop = true,
    )
    connection is RfidConnection.Connected -> SledLine(SledWords.connected(connection.name, connection.batteryPct), null, false)
    connection is RfidConnection.NeedsRegion -> SledLine(SledWords.noRegion(connection.name), null, false)
    connection == RfidConnection.Connecting -> SledLine(SledWords.CONNECTING, null, false)
    permissionMissing -> SledLine(SledWords.PERMISSION_MISSING, SledFix.ALLOW, false)
    connection is RfidConnection.Failed -> SledLine(connection.reason, connection.fix, false)
    else -> SledLine(SledWords.NOT_CONNECTED, SledFix.CONNECT, false)
}

/**
 * What the scan-screen slot shows: [text] with [fix] and Stop ([offersStop])
 * under it, red ([red]) or muted.
 */
data class SlotLine(val text: String, val fix: SledFix?, val offersStop: Boolean, val red: Boolean)

/**
 * The slot's one line, or null while the sled is `Connected` and working.
 * Priority: the connection ([line] whenever the link is not up, or a
 * reconnect is running), the region ([line] in `NeedsRegion`), the sled's
 * barcode scanner (starting, or one of its two failures), then [readError].
 *
 * Red is for what went wrong during this visit (spec, Screens: a drop during
 * the visit is red; a state already there at open is muted). A connection
 * line is red exactly when [dropDuringVisit] says it is the sign of a drop
 * seen during the visit ([slotDropDuringVisit]); a sled that was already out
 * of reach stays muted, and so do the tries an open screen starts for it.
 * The region and scanner lines are red unless their text equals [textAtOpen]
 * (what the slot said when the screen opened). Starting the scanner is always
 * muted; a read error is always red.
 */
fun scanSlotLine(
    line: SledLine,
    connection: RfidConnection,
    scanner: SledScannerState,
    readError: String?,
    textAtOpen: String?,
    dropDuringVisit: Boolean,
): SlotLine? {
    fun tone(text: String) = text != textAtOpen
    if (line.offersStop || (connection !is RfidConnection.Connected && connection !is RfidConnection.NeedsRegion)) {
        return SlotLine(line.text, line.fix, line.offersStop, red = dropDuringVisit)
    }
    if (connection is RfidConnection.NeedsRegion) return SlotLine(line.text, line.fix, false, tone(line.text))
    val scannerText = when (scanner) {
        SledScannerState.Opening -> return SlotLine(SledWords.SCANNER_STARTING, null, false, red = false)
        is SledScannerState.Unavailable -> when (scanner.kind) {
            SledScannerFault.DID_NOT_START -> SledWords.SCANNER_DID_NOT_START
            SledScannerFault.STOPPED_RESPONDING -> SledWords.SCANNER_STOPPED_RESPONDING
            SledScannerFault.BLUETOOTH_OFF -> null
        }
        SledScannerState.Off, SledScannerState.Ready -> null
    }
    if (scannerText != null) return SlotLine(scannerText, null, false, tone(scannerText))
    if (readError != null) return SlotLine(readError, null, false, red = true)
    return null
}

/**
 * Whether the slot's connection line is a drop seen during this visit, so red:
 * - while reconnecting, only a reconnect after a drop ([retry] `afterDrop`) that this
 *   visit saw begin: the link was up since the screen opened ([linkWasUp]), or that
 *   reconnect was not already running when it opened ([dropAtOpen] false);
 * - a failure, once the link was up since the screen opened (the drop's own reason, or
 *   the give-up after it);
 * - never for the app's own doing (`Connecting`, `Disconnected`), nor for a sled that was
 *   already out of reach at open and the tries the open screen starts for it.
 */
fun slotDropDuringVisit(
    connection: RfidConnection,
    reconnecting: Boolean,
    retry: SledRetry?,
    linkWasUp: Boolean,
    dropAtOpen: Boolean,
): Boolean = when {
    reconnecting -> retry?.afterDrop == true && (linkWasUp || !dropAtOpen)
    connection is RfidConnection.Failed -> linkWasUp
    else -> false
}
