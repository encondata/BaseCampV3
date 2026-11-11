package com.serversherpa.kiosk.core.rfid

/**
 * The sled's transmit-power table: [levels] as the reader reports them,
 * [inDbm] whether they are whole dBm (else tenths of a dBm), and the range
 * in dBm read from the entries that decide the unit (null when none do).
 */
data class PowerTable(val levels: List<Int>, val inDbm: Boolean, val minDbm: Int?, val maxDbm: Int?)

/** Entries above this are left out when deciding the unit: a step other than 1 overstates the table's top. */
private const val UNIT_ENTRY_CEILING = 400

/** The largest entry of a table in whole dBm. */
private const val DBM_TABLE_TOP = 40

private const val TENTHS_PER_DBM = 10

/**
 * The table for the reader's [levels], or null when it reported none. The
 * unit comes from the entries of 400 or less: dBm when the largest of them
 * is 40 or less, else tenths. With no such entry the table is read as tenths
 * with no range. Tenths are converted to dBm rounding down.
 */
fun powerTable(levels: IntArray?): PowerTable? {
    if (levels == null || levels.isEmpty()) return null
    val deciding = levels.filter { it <= UNIT_ENTRY_CEILING }
    val top = deciding.maxOrNull()
    val inDbm = top != null && top <= DBM_TABLE_TOP
    val toDbm: (Int) -> Int = if (inDbm) { v -> v } else { v -> v / TENTHS_PER_DBM }
    return PowerTable(
        levels = levels.toList(),
        inDbm = inDbm,
        minDbm = deciding.minOrNull()?.let(toDbm),
        maxDbm = top?.let(toDbm),
    )
}

/**
 * The power index to send for [wantedDbm]: the last entry of [table] not
 * above it, in the table's unit, never above the last index, and 0 when it
 * is below every entry. With no table, `powerToTenths(wantedDbm)`.
 */
fun powerIndex(table: PowerTable?, wantedDbm: Int): Int {
    if (table == null || table.levels.isEmpty()) return powerToTenths(wantedDbm)
    val wanted = if (table.inDbm) wantedDbm else wantedDbm * TENTHS_PER_DBM
    val index = table.levels.indexOfLast { it <= wanted }
    return index.coerceIn(0, table.levels.size - 1)
}
