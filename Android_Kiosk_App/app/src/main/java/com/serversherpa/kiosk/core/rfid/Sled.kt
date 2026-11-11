package com.serversherpa.kiosk.core.rfid

/**
 * What one sled trigger is assigned to, mirroring the vendor's five key
 * assignments (in its order: RFID 0, sled scan 1, terminal scan 2, scan
 * notify 3, no action 4) plus [UNKNOWN] for a value the app cannot decode.
 */
enum class SledKey { RFID, SLED_SCAN, TERMINAL_SCAN, SCAN_NOTIFY, NO_ACTION, UNKNOWN }

/** What a connect asks for: the saved sled's address (null when none is saved) and the trigger layout to write. */
data class SledConnectRequest(val address: String?, val layout: SledTriggerLayout)

/**
 * What the sled reports its two triggers are set to. [raw] is the attribute
 * value as read, when there was one. [layout] is null when the pair is not
 * one of the three layouts the app offers.
 */
data class SledTriggerReadback(val upper: SledKey, val lower: SledKey, val raw: Int?, val layout: SledTriggerLayout?) {
    /** True when either trigger reads tags. */
    val readsTags: Boolean get() = upper == SledKey.RFID || lower == SledKey.RFID
}

/** A read-back of [upper] and [lower], naming the layout they form when they form one. */
fun readbackOf(upper: SledKey, lower: SledKey, raw: Int?): SledTriggerReadback =
    SledTriggerReadback(upper, lower, raw, layoutOf(upper, lower))

/** The (upper, lower) pair each layout writes. */
fun SledTriggerLayout.keys(): Pair<SledKey, SledKey> = when (this) {
    SledTriggerLayout.RFID -> SledKey.RFID to SledKey.RFID
    SledTriggerLayout.SPLIT -> SledKey.RFID to SledKey.SLED_SCAN
    SledTriggerLayout.BARCODE -> SledKey.SLED_SCAN to SledKey.SLED_SCAN
}

/** The layout an (upper, lower) pair forms, or null when it forms none of the three. */
fun layoutOf(upper: SledKey, lower: SledKey): SledTriggerLayout? =
    SledTriggerLayout.entries.firstOrNull { it.keys() == (upper to lower) }

/**
 * What the reader knows about the sled it is connected to. [generation]
 * counts successful connects, so a drop (info present) can be told from a
 * connect that never came up (info null). [hasScanner] is null until the
 * sled has said. [autoChosen] is true when the pre-check picked the only
 * paired sled because no saved address matched.
 */
data class SledInfo(
    val generation: Int,
    val name: String,
    val address: String? = null,
    val model: String? = null,
    val serial: String? = null,
    val firmware: String? = null,
    val hasScanner: Boolean? = null,
    val powerMinDbm: Int? = null,
    val powerMaxDbm: Int? = null,
    val trigger: SledTriggerReadback? = null,
    val autoChosen: Boolean = false,
)

/** The sled's own barcode scanner, as the reader sees it. */
sealed interface SledScannerState {
    /** Not in use: the link is down, the layout in force does not use it, or the phone is a Zebra host. */
    data object Off : SledScannerState
    data object Opening : SledScannerState
    /** Up, and past the window in which stale barcodes are dropped. */
    data object Ready : SledScannerState
    data class Unavailable(val kind: SledScannerFault) : SledScannerState
}

enum class SledScannerFault { DID_NOT_START, STOPPED_RESPONDING, BLUETOOTH_OFF }

/** A barcode the sled's own scanner read: the decoded, trimmed value and its type label, when known. */
data class SledBarcode(val value: String, val label: String?)

/** A sled on Android's bonded list. */
data class SledCandidate(val name: String, val address: String)

/** A trigger event, stamped by the reader when it arrived ([atMs], wall-clock ms), or null when it stamps none. */
data class TriggerPull(val event: TriggerEvent, val atMs: Long?)

/** A call made while the reader is in the wrong state. The controller recognizes it and shows nothing. */
class SledNotConnected : Exception()

/** How a reader's `connect` fails: [failed] is the state it just published, so the message is its sentence. */
class SledConnectException(val failed: RfidConnection.Failed) : Exception(failed.reason)

/** Why the app's Bluetooth receiver asks the controller to try the sled again. */
enum class SledNudge { BLUETOOTH_ON, LINK_APPEARED }

/** Bluetooth names a sled goes by: RFD40, RFD90 and RFD8500 models. */
val SLED_NAME_PREFIXES: List<String> = listOf("RFD40", "RFD90", "RFD8500")

/** True when [name] starts with one of [SLED_NAME_PREFIXES], matching case. */
fun isSledName(name: String?): Boolean = name != null && SLED_NAME_PREFIXES.any { name.startsWith(it) }

/** The layout actually written: RFID on a Zebra host or for a sled known to have no scanner, else [setting]. */
fun effectiveLayout(setting: SledTriggerLayout, zebraHost: Boolean, hasScanner: Boolean?): SledTriggerLayout =
    if (zebraHost || hasScanner == false) SledTriggerLayout.RFID else setting

/** True when a trigger in this layout scans barcodes. */
fun SledTriggerLayout.usesScanner(): Boolean = this != SledTriggerLayout.RFID

/** True when the sled reports a trigger assigned to its own scanner. */
fun SledTriggerReadback.usesScanner(): Boolean = upper == SledKey.SLED_SCAN || lower == SledKey.SLED_SCAN

/** Whether the layout in force uses the sled's scanner: the accepted [readback] when there is one,
 *  else the effective layout of the [requested] one. */
fun layoutInForceUsesScanner(
    readback: SledTriggerReadback?,
    requested: SledTriggerLayout,
    zebraHost: Boolean,
    hasScanner: Boolean?,
): Boolean = readback?.usesScanner() ?: effectiveLayout(requested, zebraHost, hasScanner).usesScanner()

/** Whether the layout in force has a trigger assigned to tags (ruling 27): the accepted [readback]
 *  when there is one, else anything but an effective Barcode layout. */
fun layoutInForceReadsTags(
    readback: SledTriggerReadback?,
    requested: SledTriggerLayout,
    zebraHost: Boolean,
    hasScanner: Boolean?,
): Boolean = readback?.readsTags ?: (effectiveLayout(requested, zebraHost, hasScanner) != SledTriggerLayout.BARCODE)
