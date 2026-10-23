package com.serversherpa.kiosk.core.printer

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// The labels Settings › Troubleshooting prints, from the Bluetooth test screen that printed them on
// a ZD421 (branch ble-spike), as the iOS kiosk prints them (PrinterTestLabels.swift). Nothing here
// changes a saved printer setting: no ^MM, ^JUS, ~SD or any other command the printer keeps.

/** What the sample label's Code 128 encodes: 15 characters, so the symbol is 200 modules wide
 *  (start 11 + 15 × 11 + check 11 + stop 13) in subset B. */
const val SAMPLE_BARCODE_DATA = "TEST-0123456789"

/** What the sample label's QR encodes: "MA,<37-character URL>" is a version 3 QR (29 × 29 modules)
 *  at error correction M. */
const val SAMPLE_QR_URL = "https://serversherpa.com/printer-test"

private const val SAMPLE_BARCODE_MODULES = 200
private const val SAMPLE_QR_MODULES = 29

/** A sample label: "Printer test", the date and time ([nowMs] in [zone]), a Code 128 of
 *  [SAMPLE_BARCODE_DATA] and a QR of [SAMPLE_QR_URL], laid out to fit a [widthDots] × [heightDots]
 *  label at [dpi]. Plain ASCII, so half its characters are half its bytes (the Cut-send test sends
 *  half of one). */
fun sampleTestLabel(
    widthDots: Int,
    heightDots: Int,
    dpi: Int,
    nowMs: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
): String {
    // At least a dot each way (a sub-dot template size still makes a label).
    val w = maxOf(1, widthDots)
    val h = maxOf(1, heightDots)
    val m = maxOf(10, dpi / 12)
    val titleH = maxOf(16, minOf(dpi / 5, h / 7))
    val dateH = maxOf(14, minOf(dpi / 8, h / 10))

    // ^BY2 when the barcode leaves room for a QR beside it, else ^BY1 (a 2x1 at 203 dpi).
    var module = 2
    if (w - 3 * m - SAMPLE_BARCODE_MODULES * module < SAMPLE_QR_MODULES * 2) module = 1
    val barcodeW = SAMPLE_BARCODE_MODULES * module
    val interpretationH = 12 * module + 6

    val titleY = m
    val dateY = titleY + titleH + m / 2
    val barcodeY = dateY + dateH + m / 2
    val barcodeH = maxOf(20, minOf((dpi * 0.4).toInt(), h - barcodeY - m - interpretationH))

    // The QR sits top right, as big as fits beside the barcode (magnification 1–8). ^BQ prints
    // about 10 dots below its ^FO, so that's left free at the top.
    val qrRoomW = w - 3 * m - barcodeW
    val qrRoomH = h - 2 * m - 10
    val mag = maxOf(1, minOf(8, minOf(qrRoomW, qrRoomH) / SAMPLE_QR_MODULES))
    val qrX = w - m - SAMPLE_QR_MODULES * mag

    return "^XA^CI28^PW$w^LL$h" +
        "^FO$m,$titleY^A0N,$titleH,$titleH^FDPrinter test^FS" +
        "^FO$m,$dateY^A0N,$dateH,$dateH^FD${STAMP.format(Instant.ofEpochMilli(nowMs).atZone(zone))}^FS" +
        "^FO$m,$barcodeY^BY$module^BCN,$barcodeH,Y,N,N^FD$SAMPLE_BARCODE_DATA^FS" +
        "^FO$qrX,$m^BQN,2,$mag^FDMA,$SAMPLE_QR_URL^FS" +
        "^XZ"
}

/**
 * A speed-test label [targetBytes] long (as UTF-8) for a [widthDots] × [heightDots] label: a caption
 * "Run N · 10 KB · START" at the top, a comment that makes up the few bytes the picture's whole rows
 * can't, an uncompressed ASCII-hex `^GFA` of diagonal stripes sized to make up the bytes, then "END"
 * near the bottom of the label, the last thing before `^XZ`.
 *
 * How to read the result: `^GFA` is count-based. The printer takes exactly the byte count the header
 * announces as picture data, then goes on parsing ZPL. If any chunk were lost on the way, the printer
 * would swallow the bytes after the picture (the END caption, even the `^XZ`) as picture data; if
 * chunks were reordered, the stripes would be torn and the tail would usually be swallowed too. So a
 * label that prints END (with clean stripes) means every byte arrived, in order: nothing but END's
 * box and caption follows the picture, so a lost last chunk can't hide behind padding. The picture
 * may run past the label's length; the printer still parses every byte and just clips the picture.
 * A white box is drawn under END so it reads even over the stripes. A size under a dot (a sub-dot
 * template width, a printer that reported no resolution) is taken as one dot, one byte a row.
 */
fun speedTestLabel(targetBytes: Int, widthDots: Int, heightDots: Int, run: Int): String {
    val w = maxOf(1, widthDots)
    val h = maxOf(1, heightDots)
    val m = maxOf(10, minOf(w, h) / 24)
    val bytesPerRow = (w + 7) / 8
    val captionH = maxOf(16, minOf(h / 8, w / 24))
    val endH = maxOf(20, minOf(50, h / 5))
    val graphicY = m + captionH + m / 2
    val endY = maxOf(graphicY, h - endH - 10)
    val caption = "Run $run · ${testLabelKb(targetBytes)} KB · START"

    fun assemble(total: Int, hex: String, pad: String = ""): String =
        "^XA^CI28^PW$w^LL$h" +
            "^FO$m,$m^A0N,$captionH,$captionH^FD$caption^FS" +
            pad +
            "^FO0,$graphicY^GFA,$total,$total,$bytesPerRow,$hex^FS" +
            "^FO0,${endY - 10}^GB$w,${endH + 20},${endH + 20},W^FS" +
            "^FO$m,$endY^A0N,$endH,$endH^FDEND^FS"

    // Everything but the hex, then as many whole rows as the rest of the budget holds (two hex
    // characters a byte; at least one row). A second pass settles the header's digit count.
    val close = "^XZ"
    var total = bytesPerRow
    repeat(2) {
        val overhead = utf8Bytes(assemble(total, "")) + close.length
        val rows = maxOf(1, (targetBytes - overhead) / 2 / bytesPerRow)
        total = rows * bytesPerRow
    }
    val stripes = testLabelStripes(rows = total / bytesPerRow, bytesPerRow = bytesPerRow)
    // A comment (`^FX…^FS`, which prints nothing) makes up what's left of the target, before the
    // picture: END stays the last thing the printer parses.
    val left = targetBytes - utf8Bytes(assemble(total, stripes)) - close.length
    val pad = if (left >= 6) "^FX" + "-".repeat(left - 6) + "^FS" else ""
    return assemble(total, stripes, pad) + close
}

/** Uncompressed ASCII hex (0-9, A-F only: ZPL reads G–Z and g–z as repeat counts) of 45° stripes
 *  16 dots wide. */
private fun testLabelStripes(rows: Int, bytesPerRow: Int): String {
    val digits = "0123456789ABCDEF"
    val out = StringBuilder(rows * bytesPerRow * 2)
    for (row in 0 until rows) {
        for (col in 0 until bytesPerRow) {
            var byte = 0
            for (bit in 0 until 8) {
                val x = col * 8 + bit
                if (((x + row) / 16) % 2 == 0) byte = byte or (0x80 shr bit)
            }
            out.append(digits[byte shr 4]).append(digits[byte and 0x0F])
        }
    }
    return out.toString()
}

/** "10", "2.5": [bytes] in KB (1,024 bytes). */
private fun testLabelKb(bytes: Int): String {
    val kb = bytes / 1024.0
    return if (kb == Math.rint(kb)) kb.toLong().toString() else String.format(Locale.US, "%.1f", kb)
}

private fun utf8Bytes(text: String): Int = text.toByteArray(Charsets.UTF_8).size

private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.US)
