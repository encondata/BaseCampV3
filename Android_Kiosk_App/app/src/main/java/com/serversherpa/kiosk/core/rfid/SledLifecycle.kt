package com.serversherpa.kiosk.core.rfid

/** What a teardown does before removing the listener and disconnecting (spec, Teardown). */
data class TeardownPlan(val stopInventory: Boolean, val disableBatchMode: Boolean, val saveConfig: Boolean)

/**
 * The teardown for a link that is [linkUp] or not. Only a link known to be
 * up gets the stop and the batch-mode safety step, and that step skips
 * `saveConfig()` when this connection [wroteLayout] (a layout is never saved;
 * the next connect's prevention step saves before its own layout write).
 */
fun teardownPlan(linkUp: Boolean, wroteLayout: Boolean): TeardownPlan =
    if (!linkUp) {
        TeardownPlan(stopInventory = false, disableBatchMode = false, saveConfig = false)
    } else {
        TeardownPlan(stopInventory = true, disableBatchMode = true, saveConfig = !wroteLayout)
    }

/**
 * Whether the sled's scanner session should be open (ruling 7): the link is
 * [connected], the layout in force uses the scanner, the phone is not a
 * Zebra host, and the sled is not known to lack a scanner.
 */
fun scannerWanted(connected: Boolean, layoutInForceUsesScanner: Boolean, zebraHost: Boolean, hasScanner: Boolean?): Boolean =
    connected && layoutInForceUsesScanner && !zebraHost && hasScanner != false

/** The arguments a region write passes: [hopping] null to leave it out, and a channel list that is never null. */
data class RegionArgs(val hopping: Boolean?, val channels: List<String>)

/**
 * The region write's arguments (ruling 23): when the picked region says
 * hopping is configurable, `hopping ?: true`, else null; the picked region's
 * channels, or empty.
 */
fun regionArgs(hoppingConfigurable: Boolean, hopping: Boolean?, pickedChannels: List<String>?): RegionArgs =
    RegionArgs(
        hopping = if (hoppingConfigurable) hopping ?: true else null,
        channels = pickedChannels ?: emptyList(),
    )

/** A best setup step not started this long after the vendor `connect()` returned is skipped (ruling 9). */
const val SLED_BEST_STEP_DEADLINE_MS = 8_000L

/** Whether a best setup step may still start, [sinceConnectReturnedMs] after the vendor `connect()` returned. */
fun bestStepDue(sinceConnectReturnedMs: Long): Boolean = sinceConnectReturnedMs < SLED_BEST_STEP_DEADLINE_MS
