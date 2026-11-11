package com.serversherpa.kiosk.core.rfid

/** Which kind of screen is in front, for [keepDisplayOn]. */
enum class SledRouteKind { SCAN_OR_LOOKUP, ENROLL_OR_PRINT, OTHER }

/** No trigger pull, tag, sled barcode or touch for this long releases the display (ruling 5). */
const val SLED_DISPLAY_IDLE_MS = 600_000L

/**
 * Whether the display stays on (ruling 5; the spec's display table, rows tried top to bottom,
 * the first that matches wins):
 *
 * 1. Scanning or Asset Lookup, the reader [enabled], and `Connected` or `Connecting` or
 *    [reconnecting], with activity within [SLED_DISPLAY_IDLE_MS]: on. While [reconnecting] this
 *    holds whatever the connection state, so a `Failed` between tries keeps it on.
 * 2. RFID Enroll or Print Labels, [enabled], `Connected`, and the layout in force uses the
 *    scanner, with activity within [SLED_DISPLAY_IDLE_MS]: on.
 * 3. Not reconnecting, and `Failed`, `NeedsRegion`, `Disconnected` or the reader off (which
 *    includes after the reconnect gave up): off.
 * 4. Any other screen: off.
 *
 * [idleMs] is the time since the later of the controller's last activity and the last touch.
 */
fun keepDisplayOn(
    kind: SledRouteKind,
    enabled: Boolean,
    connection: RfidConnection,
    reconnecting: Boolean,
    layoutUsesScanner: Boolean,
    idleMs: Long,
): Boolean {
    val active = idleMs < SLED_DISPLAY_IDLE_MS
    val inUse = connection is RfidConnection.Connected || connection == RfidConnection.Connecting || reconnecting
    if (kind == SledRouteKind.SCAN_OR_LOOKUP && enabled && inUse && active) return true
    if (kind == SledRouteKind.ENROLL_OR_PRINT && enabled && connection is RfidConnection.Connected && layoutUsesScanner && active) return true
    // Rows 3 and 4: off.
    return false
}
