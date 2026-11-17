package com.serversherpa.kiosk.core.rfid

/**
 * The sled's transmit-power table: [levels] as the reader reports them,
 * [inDbm] whether they are whole dBm (else tenths of a dBm), the range in
 * dBm read from the real entries (null when there are none), and [topIndex],
 * the index of the last real entry: no index above it is ever sent.
 */
data class PowerTable(
    val levels: List<Int>,
    val inDbm: Boolean,
    val minDbm: Int?,
    val maxDbm: Int?,
    val topIndex: Int = levels.size - 1,
)

/** The largest entry of a table in whole dBm. */
private const val DBM_TABLE_TOP = 40

private const val TENTHS_PER_DBM = 10

/**
 * The table for the reader's [levels], or null when it reported none.
 *
 * The bundled vendor library builds the table as `MAX_POWER - MIN_POWER + 1`
 * entries of `MIN_POWER + k * POWER_STEPS`, so its real top is
 * `levels[0] + levels.size - 1` (that is, `MAX_POWER`). With a step other
 * than 1 every entry above it is invented, and the vendor sends whatever
 * entry the index names, checking the index only against `MAX_POWER`. So the
 * unit, the range and [PowerTable.topIndex] come from the entries no greater
 * than that top: dBm when the largest of them is 40 or less, else tenths.
 * Tenths are converted to dBm rounding down. The Identity log line prints the
 * raw table's first, second and last entries and its size, so a vendor
 * library that builds it another way shows on the first connect.
 */
fun powerTable(levels: IntArray?): PowerTable? {
    if (levels == null || levels.isEmpty()) return null
    val realTop = levels[0] + levels.size - 1
    val real = levels.filter { it <= realTop }
    val top = real.maxOrNull()
    val inDbm = top != null && top <= DBM_TABLE_TOP
    val toDbm: (Int) -> Int = if (inDbm) { v -> v } else { v -> v / TENTHS_PER_DBM }
    return PowerTable(
        levels = levels.toList(),
        inDbm = inDbm,
        minDbm = real.minOrNull()?.let(toDbm),
        maxDbm = top?.let(toDbm),
        topIndex = levels.indexOfLast { it <= realTop }.takeIf { it >= 0 } ?: (levels.size - 1),
    )
}

/**
 * The power index to send for [wantedDbm]: the last entry of [table] not
 * above it, in the table's unit, never above the table's last real entry
 * ([PowerTable.topIndex]), and 0 when it is below every entry. With no
 * table, `powerToTenths(wantedDbm)`.
 */
fun powerIndex(table: PowerTable?, wantedDbm: Int): Int {
    if (table == null || table.levels.isEmpty()) return powerToTenths(wantedDbm)
    val wanted = if (table.inDbm) wantedDbm else wantedDbm * TENTHS_PER_DBM
    val index = table.levels.indexOfLast { it <= wanted }
    return index.coerceIn(0, table.topIndex.coerceIn(0, table.levels.size - 1))
}
