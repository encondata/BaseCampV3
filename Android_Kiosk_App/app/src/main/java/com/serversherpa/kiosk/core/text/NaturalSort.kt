package com.serversherpa.kiosk.core.text

/** Port of the portal's ICU collator (numeric, case-insensitive): digit runs
 *  compare by value, everything else by lowercase char. Null sorts as "". */
fun naturalCompare(a: String?, b: String?): Int {
    val x = (a ?: "").lowercase()
    val y = (b ?: "").lowercase()
    var i = 0
    var j = 0
    var tie = 0
    while (i < x.length && j < y.length) {
        val cx = x[i]
        val cy = y[j]
        if (cx.isAsciiDigit() && cy.isAsciiDigit()) {
            var ei = i
            while (ei < x.length && x[ei].isAsciiDigit()) ei++
            var ej = j
            while (ej < y.length && y[ej].isAsciiDigit()) ej++
            val rx = x.substring(i, ei)
            val ry = y.substring(j, ej)
            val sx = rx.trimStart('0')
            val sy = ry.trimStart('0')
            if (sx.length != sy.length) return sx.length.compareTo(sy.length)
            val c = sx.compareTo(sy)
            if (c != 0) return c
            // equal value: the run with fewer leading zeros first (decided after the rest)
            if (tie == 0 && rx.length != ry.length) tie = rx.length.compareTo(ry.length)
            i = ei
            j = ej
        } else {
            if (cx != cy) return cx.compareTo(cy)
            i++
            j++
        }
    }
    if (i < x.length) return 1
    if (j < y.length) return -1
    return tie
}

private fun Char.isAsciiDigit() = this in '0'..'9'
