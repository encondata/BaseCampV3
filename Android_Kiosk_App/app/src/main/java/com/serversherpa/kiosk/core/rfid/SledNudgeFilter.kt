package com.serversherpa.kiosk.core.rfid

/**
 * Whose link appearing nudges the reconnect (spec, Controller › Reconnect): of [last] (the
 * sled the link was last up with) and [saved] (the saved `readerAddress`), the first that is
 * still in [paired]. Null when neither is, and then [isNudgeFromOurSled] falls back to the
 * sled-name rule, so a sled forgotten in Bluetooth settings never stands in for the one that is
 * paired now.
 */
fun sledNudgeAddress(last: String?, saved: String?, paired: List<SledCandidate>): String? =
    listOfNotNull(last, saved).firstOrNull { address -> paired.any { it.address.equals(address, ignoreCase = true) } }

/**
 * A link appearing for [address] (a device named [name]) is the sled's: the [known] address
 * ([sledNudgeAddress]) when there is one, ignoring case, else any device named like a sled.
 */
fun isNudgeFromOurSled(address: String?, name: String?, known: String?): Boolean =
    if (known != null) address.equals(known, ignoreCase = true) else isSledName(name)
