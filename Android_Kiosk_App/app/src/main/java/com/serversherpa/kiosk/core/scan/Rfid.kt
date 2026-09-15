package com.serversherpa.kiosk.core.scan

/** The house RFID format: 24 characters, zero-padded on the left. The
 *  server normalizes independently (`normalize_rfid` in routes/kiosk.py);
 *  the kiosk pads so the operator sees what will be stored. */
const val RFID_LENGTH = 24

enum class RfidProblem { EMPTY, NOT_ALPHANUMERIC, TOO_LONG }

data class PaddedRfid(val tag: String?, val problem: RfidProblem?)

private val ALPHANUMERIC = Regex("^[0-9A-Z]+$")

fun padRfid(raw: String): PaddedRfid {
    val tag = raw.replace(Regex("\\s+"), "").uppercase()
    if (tag.isEmpty()) return PaddedRfid(null, RfidProblem.EMPTY)
    if (!ALPHANUMERIC.matches(tag)) return PaddedRfid(null, RfidProblem.NOT_ALPHANUMERIC)
    if (tag.length > RFID_LENGTH) return PaddedRfid(null, RfidProblem.TOO_LONG)
    return PaddedRfid(tag.padStart(RFID_LENGTH, '0'), null)
}

fun rfidProblemText(problem: RfidProblem): String = when (problem) {
    RfidProblem.EMPTY -> "Scan the RFID tag."
    RfidProblem.TOO_LONG -> "That tag is longer than $RFID_LENGTH characters."
    RfidProblem.NOT_ALPHANUMERIC -> "That tag has characters we can't store — letters and numbers only."
}

/** portal/src/lib/format.ts: leading zeros stripped for display; a
 *  missing tag renders as an em dash. */
fun displayRfid(tag: String?): String {
    if (tag.isNullOrEmpty()) return "—"
    return tag.replace(Regex("^0+(?=.)"), "")
}
