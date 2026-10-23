package com.serversherpa.kiosk.core.printer

import java.time.ZoneOffset
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Troubleshooting's labels (the Bluetooth test screen's, which printed on a ZD421): the speed-test
 * label is the size asked for and proves every byte arrived by printing END after a count-based
 * picture; the sample label fits the label.
 */
class PrinterTestLabelsTest {
    /** 4x2 at 203 dpi, 4x2 at 300 dpi, 2x1 at 203 dpi, 4x6 at 600 dpi. */
    private val sizes = listOf(812 to 406, 1200 to 600, 406 to 203, 2400 to 3600)

    private class Graphic(val total: Int, val count: Int, val perRow: Int, val hex: String, val end: Int)

    /** The `^GFA,total,total,bytesPerRow,` header's numbers and the hex after it (up to `^FS`). */
    private fun graphic(zpl: String): Graphic {
        val start = zpl.indexOf("^GFA,")
        assertTrue("no ^GFA", start >= 0)
        val fields = zpl.substring(start + 5).split(",", limit = 4)
        assertEquals(4, fields.size)
        val close = fields[3].indexOf("^FS")
        assertTrue("no ^FS after the picture", close >= 0)
        val hex = fields[3].substring(0, close)
        val end = zpl.indexOf(hex, start) + hex.length + 3
        return Graphic(fields[0].toInt(), fields[1].toInt(), fields[2].toInt(), hex, end)
    }

    private fun bytes(s: String) = s.toByteArray(Charsets.UTF_8).size

    @Test fun speedLabelHitsTargetAndEndsWithEND() {
        for (kb in listOf(10, 25, 50)) {
            for ((w, h) in sizes) {
                val target = kb * 1024
                val zpl = speedTestLabel(targetBytes = target, widthDots = w, heightDots = h, run = 2)
                val what = "$kb KB on ${w}x$h"
                assertTrue("$what: ${bytes(zpl)} bytes", abs(bytes(zpl) - target) <= target / 50)
                assertTrue(what, zpl.startsWith("^XA"))
                assertTrue(what, zpl.endsWith("^XZ"))
                assertTrue(what, zpl.contains("^PW$w^LL$h"))
                assertTrue(what, zpl.contains("Run 2 · $kb KB · START"))

                // The picture's counts agree: whole rows of the label's width, two hex digits a byte.
                val g = graphic(zpl)
                assertEquals(what, g.total, g.count)
                assertEquals(what, (w + 7) / 8, g.perRow)
                assertEquals(what, 0, g.total % g.perRow)
                assertEquals(what, 2 * g.total, g.hex.length)
                assertTrue("$what: hex digits only", g.hex.all { it in '0'..'9' || it in 'A'..'F' })

                // END comes after the picture, and prints inside the label's length.
                val after = zpl.substring(g.end)
                val end = after.indexOf("^FDEND^FS")
                assertTrue(what, end >= 0)
                val field = after.substring(0, end)
                val fo = field.lastIndexOf("^FO")
                val font = field.lastIndexOf("^A0N,")
                val y = field.substring(fo + 3).split(",")[1].takeWhile { it.isDigit() }.toInt()
                val height = field.substring(font + 5).takeWhile { it.isDigit() }.toInt()
                assertTrue("$what: END at $y+$height", y > 0 && y + height <= h)

                // Nothing after the picture but the END box and caption: padding there would let a
                // lost last chunk still print END.
                assertFalse(what, after.contains("^FX"))
                assertTrue(what, zpl.endsWith("^FDEND^FS^XZ"))
            }
        }
    }

    /** A label narrower than a byte of dots (a sub-dot template width, a printer that reported no
     *  resolution) still makes a label instead of dividing by zero. */
    @Test fun aTinyOrEmptyLabelSizeStillMakesALabel() {
        for ((w, h) in listOf(0 to 0, 1 to 1, 7 to 3, -5 to 10)) {
            val zpl = speedTestLabel(targetBytes = 10 * 1024, widthDots = w, heightDots = h, run = 1)
            assertTrue("${w}x$h", zpl.startsWith("^XA"))
            assertTrue("${w}x$h", zpl.endsWith("^FDEND^FS^XZ"))
            val g = graphic(zpl)
            assertEquals("${w}x$h", 1, g.perRow)
            assertEquals("${w}x$h", 2 * g.total, g.hex.length)
            assertTrue(sampleTestLabel(widthDots = w, heightDots = h, dpi = 0).endsWith("^XZ"))
        }
    }

    @Test fun speedLabelRowsAreDiagonalStripes() {
        val zpl = speedTestLabel(targetBytes = 10 * 1024, widthDots = 16, heightDots = 400, run = 1)
        val g = graphic(zpl)
        // 16 dots a row (2 bytes), stripes 16 dots wide moving one dot a row.
        assertEquals("FFFF", g.hex.substring(0, 4))
        assertEquals("FFFE", g.hex.substring(4, 8))
    }

    @Test fun sampleLabelFitsTheLabelAndIsPlainAscii() {
        val now = 1_792_000_000_000L
        for ((w, h, dpi) in listOf(Triple(812, 406, 203), Triple(1200, 600, 300), Triple(406, 203, 203))) {
            val zpl = sampleTestLabel(widthDots = w, heightDots = h, dpi = dpi, nowMs = now, zone = ZoneOffset.UTC)
            assertTrue(zpl.startsWith("^XA^CI28^PW$w^LL$h"))
            assertTrue(zpl.endsWith("^XZ"))
            assertTrue(zpl.contains("^FDPrinter test^FS"))
            assertTrue(zpl.contains("^FD2026-10-14 17:46:40^FS"))
            assertTrue(zpl.contains("^BCN,"))
            assertTrue(zpl.contains("^FD$SAMPLE_BARCODE_DATA^FS"))
            assertTrue(zpl.contains("^BQN,2,"))
            assertTrue(zpl.contains("^FDMA,$SAMPLE_QR_URL^FS"))
            // Plain ASCII: half its characters are half its bytes (the Cut-send test halves it).
            assertEquals(zpl.length, bytes(zpl))
            assertEquals(zpl, sampleTestLabel(widthDots = w, heightDots = h, dpi = dpi, nowMs = now, zone = ZoneOffset.UTC))
        }
    }

    /** The layout numbers match the iOS port's for the office ZD421's 4x2 at 300 dpi (byte for byte,
     *  so both apps print the same label). */
    @Test fun sampleLabelMatchesTheIosLayout() {
        val zpl = sampleTestLabel(widthDots = 1200, heightDots = 600, dpi = 300, nowMs = 1_792_000_000_000L, zone = ZoneOffset.UTC)
        assertEquals(
            "^XA^CI28^PW1200^LL600" +
                "^FO25,25^A0N,60,60^FDPrinter test^FS" +
                "^FO25,97^A0N,37,37^FD2026-10-14 17:46:40^FS" +
                "^FO25,146^BY2^BCN,120,Y,N,N^FD$SAMPLE_BARCODE_DATA^FS" +
                "^FO943,25^BQN,2,8^FDMA,$SAMPLE_QR_URL^FS" +
                "^XZ",
            zpl,
        )
    }
}
