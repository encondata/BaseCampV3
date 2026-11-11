package com.serversherpa.kiosk.core.rfid

/** A device on Android's bonded list, as the pre-check sees it; [name] is null when the device has none. */
data class BondedDevice(val name: String?, val address: String)

/** What the pre-check decided, before any vendor object is built. */
sealed interface Precheck {
    /**
     * Connect to [sled]. [autoChosen] is true when it is the only paired
     * sled and no saved address matched; [severalPaired] is true when two or
     * more sleds are paired.
     */
    data class Chosen(val sled: SledCandidate, val autoChosen: Boolean, val severalPaired: Boolean) : Precheck

    /** Do not connect; publish [failed]. */
    data class Refused(val failed: RfidConnection.Failed) : Precheck
}

private fun refuse(reason: String, fix: SledFix): Precheck.Refused =
    Precheck.Refused(RfidConnection.Failed(reason, retryable = false, fix = fix))

/**
 * The pre-check decision (spec, Pre-check), in order: Bluetooth off; Nearby
 * devices not granted; a bonded device with no name (the vendor compares
 * every bonded name with no null check); no paired sled; the saved sled
 * (address matched ignoring case), else the only paired sled, else ask to
 * choose; then two bonded devices with the chosen sled's exact name (the
 * vendor connects by name). No refusal is retryable.
 */
fun precheck(bluetoothOn: Boolean, nearbyGranted: Boolean, bonded: List<BondedDevice>, savedAddress: String?): Precheck {
    if (!bluetoothOn) return refuse(SledWords.BLUETOOTH_OFF, SledFix.TURN_ON_BLUETOOTH)
    if (!nearbyGranted) return refuse(SledWords.PERMISSION_MISSING, SledFix.ALLOW)
    if (bonded.any { it.name == null }) return refuse(SledWords.NAMELESS_DEVICE, SledFix.BLUETOOTH_SETTINGS)
    val sleds = pairedSledsOf(bonded)
    if (sleds.isEmpty()) return refuse(SledWords.NO_SLED_PAIRED, SledFix.BLUETOOTH_SETTINGS)
    val saved = savedAddress?.let { address -> sleds.firstOrNull { it.address.equals(address, ignoreCase = true) } }
    val chosen = saved ?: sleds.singleOrNull() ?: return refuse(SledWords.SEVERAL_PAIRED, SledFix.CHOOSE_SLED)
    if (bonded.count { it.name == chosen.name } >= 2) {
        return refuse(SledWords.duplicateName(chosen.name), SledFix.BLUETOOTH_SETTINGS)
    }
    return Precheck.Chosen(chosen, autoChosen = saved == null, severalPaired = sleds.size >= 2)
}

/** The bonded devices whose names are sled names ([isSledName]), in bonded-list order. */
fun pairedSledsOf(bonded: List<BondedDevice>): List<SledCandidate> =
    bonded.mapNotNull { device -> device.name?.takeIf(::isSledName)?.let { SledCandidate(it, device.address) } }
