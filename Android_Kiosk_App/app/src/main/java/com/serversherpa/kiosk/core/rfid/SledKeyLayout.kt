package com.serversherpa.kiosk.core.rfid

/**
 * The key-layout attribute value of an ([upper], [lower]) pair:
 * `upper * 5 + 4 + lower`, each key by the vendor's order (RFID 0, sled
 * scan 1, terminal scan 2, scan notify 3, no action 4). Null when either key
 * is [SledKey.UNKNOWN].
 */
fun keyLayoutValue(upper: SledKey, lower: SledKey): Int? {
    val u = vendorOrder(upper) ?: return null
    val l = vendorOrder(lower) ?: return null
    return u * KEYS + FIRST_PAIR_VALUE + l
}

/** The five assignable keys in the vendor's order; [SledKey] declares them in the same order. */
private val VENDOR_KEYS = listOf(SledKey.RFID, SledKey.SLED_SCAN, SledKey.TERMINAL_SCAN, SledKey.SCAN_NOTIFY, SledKey.NO_ACTION)
private const val KEYS = 5
private const val FIRST_PAIR_VALUE = 4
private const val LAST_PAIR_VALUE = FIRST_PAIR_VALUE + KEYS * KEYS - 1

private fun vendorOrder(key: SledKey): Int? = VENDOR_KEYS.indexOf(key).takeIf { it >= 0 }

/** The four values older firmware uses for a pair (the vendor's own table). */
private val LEGACY_PAIRS = mapOf(
    0 to (SledKey.RFID to SledKey.TERMINAL_SCAN),
    1 to (SledKey.TERMINAL_SCAN to SledKey.RFID),
    2 to (SledKey.RFID to SledKey.SLED_SCAN),
    3 to (SledKey.SLED_SCAN to SledKey.RFID),
)

/**
 * What a key-layout attribute [value] says the triggers do: the legacy
 * values 0 to 3, then 4 to 28 by the formula of [keyLayoutValue]; anything
 * else (or no value) is unknown for both. [SledTriggerReadback.raw] is [value].
 */
fun decodeKeyLayout(value: Int?): SledTriggerReadback {
    val pair = when {
        value == null -> null
        value in LEGACY_PAIRS -> LEGACY_PAIRS.getValue(value)
        value in FIRST_PAIR_VALUE..LAST_PAIR_VALUE -> {
            val offset = value - FIRST_PAIR_VALUE
            VENDOR_KEYS[offset / KEYS] to VENDOR_KEYS[offset % KEYS]
        }
        else -> null
    }
    val (upper, lower) = pair ?: (SledKey.UNKNOWN to SledKey.UNKNOWN)
    return readbackOf(upper, lower, value)
}

/** One key-layout write: a pair through the typed setter, or raw attribute digits. */
sealed interface LayoutWrite {
    data class Keys(val upper: SledKey, val lower: SledKey) : LayoutWrite

    data class Raw(val digits: String) : LayoutWrite
}

/** The pair [this] write asks for, as the read-back would decode it. */
private fun LayoutWrite.pair(): Pair<SledKey, SledKey> = when (this) {
    is LayoutWrite.Keys -> upper to lower
    is LayoutWrite.Raw -> decodeKeyLayout(digits.toIntOrNull()).let { it.upper to it.lower }
}

/**
 * The writes for [layout], in order: the pair the layout names, then the
 * fallbacks the spec lists (tried only after a refusal).
 */
fun layoutWrites(layout: SledTriggerLayout): List<LayoutWrite> = when (layout) {
    SledTriggerLayout.RFID -> listOf(
        LayoutWrite.Keys(SledKey.RFID, SledKey.RFID),
        LayoutWrite.Keys(SledKey.RFID, SledKey.TERMINAL_SCAN),
        LayoutWrite.Raw("0"),
    )
    SledTriggerLayout.SPLIT -> listOf(
        LayoutWrite.Keys(SledKey.RFID, SledKey.SLED_SCAN),
        LayoutWrite.Raw("2"),
    )
    SledTriggerLayout.BARCODE -> listOf(
        LayoutWrite.Keys(SledKey.SLED_SCAN, SledKey.SLED_SCAN),
        LayoutWrite.Keys(SledKey.SLED_SCAN, SledKey.RFID),
        LayoutWrite.Raw("3"),
    )
}

/** One read of the key-layout attribute. */
sealed interface AttributeRead {
    /** The attribute answered with [value] (its number checked). */
    data class Value(val value: Int) : AttributeRead

    /** An answer came back for another attribute number. */
    data object WrongAttribute : AttributeRead

    data class Error(val error: VendorError) : AttributeRead
}

/** How a key-layout write ended. */
sealed interface LayoutWriteOutcome {
    /** The sled reported [readback]; it may differ from the request. */
    data class Accepted(val readback: SledTriggerReadback) : LayoutWriteOutcome

    /** No value could be read back. */
    data object CheckFailed : LayoutWriteOutcome

    /** The sled stopped answering, on a write or on its read-back. */
    data object LinkTrouble : LayoutWriteOutcome
}

/**
 * Writes [layout] through [write] (null: the write succeeded) and checks it
 * with [readBack] after every write.
 *
 * A successful write ends with whatever the read-back says: a value is
 * [LayoutWriteOutcome.Accepted], anything else [LayoutWriteOutcome.CheckFailed].
 * After a failed write, a read-back equal to the pair that write asked for is
 * accepted. Otherwise the write's error decides: out of step retries the same
 * write once (a second one counts as a refusal); a refusal moves on to the
 * next entry of [layoutWrites]; link trouble, from a write or from a
 * read-back error, ends with [LayoutWriteOutcome.LinkTrouble]. After the last
 * entry, the first value read back wins, else a check failure.
 */
fun runLayoutWrite(
    layout: SledTriggerLayout,
    write: (LayoutWrite) -> VendorError?,
    readBack: () -> AttributeRead,
): LayoutWriteOutcome {
    var firstRead: SledTriggerReadback? = null
    for (entry in layoutWrites(layout)) {
        var retried = false
        while (true) {
            val error = write(entry)
            val read = readBack()
            if (read is AttributeRead.Error && classifyResult(read.error) == ResultClass.LINK_TROUBLE) {
                return LayoutWriteOutcome.LinkTrouble
            }
            val readback = (read as? AttributeRead.Value)?.let { decodeKeyLayout(it.value) }
            if (firstRead == null) firstRead = readback
            if (error == null) {
                return readback?.let { LayoutWriteOutcome.Accepted(it) } ?: LayoutWriteOutcome.CheckFailed
            }
            if (readback != null && (readback.upper to readback.lower) == entry.pair()) {
                return LayoutWriteOutcome.Accepted(readback)
            }
            val cls = classifyResult(error)
            if (cls == ResultClass.LINK_TROUBLE) return LayoutWriteOutcome.LinkTrouble
            if (cls == ResultClass.OUT_OF_STEP && !retried) {
                retried = true
                continue
            }
            break
        }
    }
    return firstRead?.let { LayoutWriteOutcome.Accepted(it) } ?: LayoutWriteOutcome.CheckFailed
}

/** The trigger-type filter is a deny-list (ruling 26): only a SCAN-type event is dropped. */
private const val SCAN_TRIGGER_TYPE = "HANDHELD_TRIGGER_SCAN"

/** True unless [typeName] is the SCAN trigger type; RFID, DUAL and unknown (null) pass. */
fun triggerTypePasses(typeName: String?): Boolean = typeName != SCAN_TRIGGER_TYPE
