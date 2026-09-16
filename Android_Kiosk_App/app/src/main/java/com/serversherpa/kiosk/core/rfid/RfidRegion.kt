package com.serversherpa.kiosk.core.rfid

/**
 * The regulatory region a reader transmits in.
 *
 * An RFD40 ships as a region-specific model: a United States unit is locked to
 * its domain in firmware, a worldwide unit carries several and expects to be
 * told which country it is in. So the list always comes from the reader, never
 * from a list we keep here — that way the kiosk is right about every model
 * without knowing anything about which one it is holding.
 */
data class RfidRegion(
    val code: String,
    val name: String,
    val hoppingConfigurable: Boolean,
    val channels: List<String>,
)

/** What a reader reports: the regions it allows, and the one in force. */
data class RfidRegions(val supported: List<RfidRegion>, val active: String?)

/** What the Admin row should put on screen. */
sealed class RegionChoice {
    /** No reader connected, or it reported no regions at all. */
    data object Unknown : RegionChoice()
    /** Exactly one region: a fact to state, not a choice to offer. */
    data class Locked(val region: RfidRegion) : RegionChoice()
    data class Choosable(val regions: List<RfidRegion>, val active: RfidRegion?) : RegionChoice()
}

fun regionChoice(regions: RfidRegions): RegionChoice {
    val supported = regions.supported
    if (supported.isEmpty()) return RegionChoice.Unknown
    val active = regions.active?.trim()?.let { code -> supported.firstOrNull { it.code == code } }
    if (supported.size == 1) return RegionChoice.Locked(supported.first())
    return RegionChoice.Choosable(supported, active)
}

fun regionLine(choice: RegionChoice): String = when (choice) {
    RegionChoice.Unknown -> "Connect the reader to see its regions."
    is RegionChoice.Locked -> "This reader supports only ${choice.region.name} (${choice.region.code})."
    is RegionChoice.Choosable ->
        choice.active?.let { "Set to ${it.name} (${it.code})." } ?: "No region set on this reader yet."
}
