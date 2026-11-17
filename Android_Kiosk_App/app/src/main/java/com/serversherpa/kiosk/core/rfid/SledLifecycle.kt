package com.serversherpa.kiosk.core.rfid

/** What a teardown does before removing the listener and disconnecting (spec, Teardown). */
data class TeardownPlan(val stopInventory: Boolean, val disableBatchMode: Boolean, val saveConfig: Boolean)

/**
 * The teardown for a link that is [linkUp] or not. Only a link known to be
 * up gets the stop and the batch-mode safety step, and that step skips
 * `saveConfig()` when [wroteLayout]: a trigger layout may be in the sled's
 * running config ([SledLayoutMemory]), and a layout is never saved.
 */
fun teardownPlan(linkUp: Boolean, wroteLayout: Boolean): TeardownPlan =
    if (!linkUp) {
        TeardownPlan(stopInventory = false, disableBatchMode = false, saveConfig = false)
    } else {
        TeardownPlan(stopInventory = true, disableBatchMode = true, saveConfig = !wroteLayout)
    }

/**
 * The sleds, by address (case ignored), that a trigger layout was written to
 * while the adapter lived, which is the life of the process. `saveConfig()`
 * saves the sled's whole running config, and a layout written by an earlier
 * connection stays in it through a link drop until the sled is switched off,
 * which the app cannot see. So nothing saves the config of a sled named here
 * (spec: a layout is never saved).
 */
class SledLayoutMemory {
    private val addresses = mutableSetOf<String>()

    /** A layout write went to the sled at [address]. */
    @Synchronized
    fun written(address: String?) {
        if (address != null) addresses += address.uppercase()
    }

    /** Whether the running config of the sled at [address] may hold a layout this process wrote. */
    @Synchronized
    fun mayHoldLayout(address: String?): Boolean = address != null && address.uppercase() in addresses
}

/** What connect step 2 does once it has read the batch-mode attribute ([batchPrevention]). */
enum class BatchPrevention {
    /** The attribute reads "0": batch mode is off already. */
    NOTHING,

    /** Batch mode off, not saved. */
    OFF,

    /** Batch mode off, then saved. */
    OFF_AND_SAVE,
}

/**
 * Connect step 2's decision for the batch-mode attribute's [value] as read
 * (null when the reply was for another attribute): "0" needs nothing; any
 * other value turns batch mode off and saves, unless [layoutMayBeLive] (a
 * save would keep that layout). A rejected read is unknown, so batch mode is
 * turned off without a save.
 */
fun batchPrevention(value: String?, layoutMayBeLive: Boolean): BatchPrevention = when {
    value == BATCH_MODE_OFF -> BatchPrevention.NOTHING
    value == null || layoutMayBeLive -> BatchPrevention.OFF
    else -> BatchPrevention.OFF_AND_SAVE
}

/** The batch-mode attribute's value when batch mode is off. */
private const val BATCH_MODE_OFF = "0"

/** What the adapter runs when `connect()` says `RFID_BATCHMODE_IN_PROGRESS` (spec, Special connect results). */
data class BatchRecoveryPlan(val stop: Boolean, val purge: Boolean, val disableBatchMode: Boolean, val saveConfig: Boolean)

/**
 * Ruling 28, one recovery then stop. The first batch result in a row runs the
 * whole recovery: stop, purge, batch mode off, save. A [secondInARow] (the
 * open before this one was a batch result too) only stops the radio and goes
 * to the end state, so a sled holding stored tags gets one purge-and-save
 * cycle, not one per Connect press. The save is left out when
 * [layoutMayBeLive] ([SledLayoutMemory]): it would keep that layout.
 */
fun batchRecoveryPlan(secondInARow: Boolean, layoutMayBeLive: Boolean = false): BatchRecoveryPlan =
    if (secondInARow) {
        BatchRecoveryPlan(stop = true, purge = false, disableBatchMode = false, saveConfig = false)
    } else {
        BatchRecoveryPlan(stop = true, purge = true, disableBatchMode = true, saveConfig = !layoutMayBeLive)
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
