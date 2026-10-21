package com.serversherpa.kiosk.core.printer

import com.serversherpa.kiosk.core.model.KioskLabelFont
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The reply parsers, on the portal's sample replies (portal/src/labels/zebraUsb.test.ts), the
 *  laptop edge's real network replies (kiosk_laptop/edge/tests/test_printers.py) and a real
 *  ZT220's `^HH` configuration (kiosk_laptop/edge/tests/fixtures/zt220_hh.txt). */
class ZebraRepliesTest {
    private val hi = "\u0002ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\u0003"
    private val hs = "\u0002030,1,0,1245,003,0,0,0,000,0,0,1\u0003\r\n" +
        "\u0002000,0,1,0,0,2,4,0,00000012,1,000\u0003\r\n\u00021234,0\u0003"
    private val hw = "\u0002- DIR E:*.*\r\n* 85620388.TTF       124336\r\n* TT0003M_.TTF      169188\r\n" +
        "-1928576 bytes free E: ONBOARD FLASH\r\n\u0003"
    private val hwDrivePrefixed = "\u0002- DIR E:*.*\r\n*E:85620388.TTF  124336\r\n*E:TT0003M_.TTF 169188\r\n" +
        "-1928576 bytes free E: ONBOARD FLASH\r\n\u0003"

    // A ZD421-300dpi's replies over port 9100 (2026-10-19), as the edge's tests keep them.
    private val netHi = "\u0002ZD421-300dpi,V93.21.38Z,12,8176KB\u0003\r\n"
    private val netHs = "\u0002030,0,0,0612,000,0,0,0,000,0,0,0\u0003\r\n" +
        "\u0002000,0,0,0,0,1,6,0,00000000,1,000\u0003\r\n\u00020000,0\u0003\r\n"
    private val netHw = "\u0002\r\n- DIR E:*.* \r\n* E:TEXT.ZPL   5  \r\n\r\n-  32346624 bytes free E: ONBOARD FLASH \r\n\u0003"

    private val zt220Hh: String = javaClass.classLoader!!.getResourceAsStream("printer/zt220_hh.txt")!!
        .use { String(it.readBytes(), Charsets.ISO_8859_1) }

    // ── ~HI ──

    @Test fun parsesHostIdentification() {
        assertEquals(HostId("ZD421-203dpi ZPL", "V92.21.16Z", 8, "8192KB", 203), parseHostIdentification(hi))
        assertEquals(HostId("ZD421-300dpi", "V93.21.38Z", 12, "8176KB", 300), parseHostIdentification(netHi))
        assertNull(parseHostIdentification("garbage"))
        assertNull(parseHostIdentification(""))
    }

    @Test fun hostIdentificationReadsTheLastFrame() {
        assertEquals(
            HostId("ZD421-203dpi ZPL", "V92.21.16Z", 8, "8192KB", 203),
            parseHostIdentification("\u0002junk,1\u0003\u0002ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\u0003"),
        )
    }

    @Test fun dpiFromDotsPerMmUsesTheNominalValues() {
        assertEquals(150, dpiFromDotsPerMm(6))
        assertEquals(203, dpiFromDotsPerMm(8))
        assertEquals(300, dpiFromDotsPerMm(12))
        assertEquals(600, dpiFromDotsPerMm(24))
        assertEquals(406, dpiFromDotsPerMm(16)) // 406.4, rounded
    }

    // ── ~HS ──

    @Test fun parsesHostStatus() {
        val s = parseHostStatus(hs)!!
        assertTrue(s.paperOut); assertFalse(s.paused); assertEquals(1245, s.labelLength)
        assertEquals(3, s.formatsQueued); assertFalse(s.bufferFull); assertTrue(s.overTemp)
        assertFalse(s.underTemp); assertTrue(s.headOpen); assertFalse(s.ribbonOut)
        assertFalse(s.thermalTransfer); assertEquals("2", s.printMode); assertEquals(12, s.labelsRemaining)
        assertNull(parseHostStatus("\u0002030,0\u0003"))
        assertNull(parseHostStatus(""))
    }

    @Test fun parsesARealNetworkHostStatus() {
        assertEquals(
            HostStatus(
                paperOut = false, paused = false, labelLength = 612, formatsQueued = 0, bufferFull = false,
                partialFormat = false, corruptRam = false, underTemp = false, overTemp = false,
                headOpen = false, ribbonOut = false, thermalTransfer = false, printMode = "1",
                labelWaiting = false, labelsRemaining = 0,
            ),
            parseHostStatus(netHs),
        )
    }

    @Test fun hostStatusNeedsStringTwoAndSkipsLeftoverFrames() {
        assertNull(parseHostStatus("\u0002030,1,0,1245,003,0,0,0,000,0,0,1\u0003"))
        assertEquals(parseHostStatus(hs), parseHostStatus("\u0002garbage\u0003\u0002x,y\u0003$hs"))
    }

    // ── ^HW ──

    @Test fun parsesADirectoryListing() {
        assertEquals(listOf("85620388.TTF", "TT0003M_.TTF"), parseDirectory(hw))
        assertEquals(parseDirectory(hw), parseDirectory(hwDrivePrefixed))
        assertEquals(emptyList<String>(), parseDirectory("\u0002- DIR E:*.*\r\n-2000000 bytes free E:\u0003"))
        assertTrue(isDirectoryListing("\u0002- DIR E:*.*\r\n-2000000 bytes free E:\u0003"))
        assertEquals(emptyList<String>(), parseDirectory(""))
        assertFalse(isDirectoryListing(""))
        assertEquals(listOf("TEXT.ZPL"), parseDirectory(netHw))
    }

    @Test fun keepsTheLastListingAndCollapsesRepeatedNames() {
        val twice = "\u0002- DIR E:*.*\r\n*E:85620388.TTF  1035\r\n*E:IN001.DMP  900\r\n-2000 bytes free E:\u0003" +
            "\u0002- DIR E:*.*\r\n*E:85620388.TTF  1036\r\n*E:NEW.TTF  901\r\n-1999 bytes free E:\u0003"
        assertEquals(listOf("85620388.TTF", "NEW.TTF"), parseDirectory(twice))
        val dup = "\u0002- DIR E:*.*\r\n*E:A.TTF  1\r\n*E:B.TTF  1\r\n*E:A.TTF  2\r\n-5 bytes free E:\u0003"
        assertEquals(listOf("B.TTF", "A.TTF"), parseDirectory(dup))
    }

    @Test fun directoryRowsMayCarryFlagsAndLowerCaseNames() {
        // a ZT220 (2026-10-19): a stored font has a K flag after its size
        val zt220 = "\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960          \r\n" +
            "* E:TEXT.ZPL         5          \r\n* E:TT0003M_.TTF    160676       K  \r\n\r\n" +
            "-  32346624 bytes free E: ONBOARD FLASH \r\n"
        assertEquals(listOf("85620388.TTF", "TEXT.ZPL", "TT0003M_.TTF"), parseDirectory(zt220))
        // a ZD421-300dpi's Z: listing (2026-10-20): P flags, and a trailing 0 on the first row
        val z = "\r\n- DIR Z:*.TTF\r\n* Z:0.TTF    125904  P    0\r\n* Z:T0025.TTF     92552  P\r\n" +
            "* Z:TT0003M_.TTF    169188  P\r\n"
        assertEquals(listOf("0.TTF", "T0025.TTF", "TT0003M_.TTF"), parseDirectory(z))
        assertEquals(listOf("ROBOTO_R.TTF"), parseDirectory("- DIR E:*.*\r\n* e:roboto_r.ttf  12\r\n"))
    }

    // ── a real ZT220's ^HH is neither a status nor a listing ──
    // (Like the portal's parser, ~HI parsing doesn't reject it: its counters' commas split it into
    // four "fields". NetworkZebra asks each query on its own connection, so no other reply reaches it.)

    @Test fun aConfigurationReplyIsNotStatusOrListing() {
        assertTrue(zt220Hh.contains("TEAR OFF            PRINT MODE"))
        assertNull(parseHostStatus(zt220Hh))
        assertFalse(isDirectoryListing(zt220Hh))
        assertEquals(emptyList<String>(), parseDirectory(zt220Hh))
    }

    // ── getvar ──

    @Test fun parsesGetvarReplies() {
        assertEquals("Present", parseGetvar("\"Present\""))
        assertEquals("Not Present", parseGetvar("\"Not Present\""))
        assertNull(parseGetvar("\"?\""))
        assertNull(parseGetvar(""))
        assertEquals("peel off", parseGetvar(" \"peel off\" "))
        assertEquals("peel off", parseGetvar("\"peel off\"\r\n"))
        assertNull(parseGetvar("\"\""))
    }

    @Test fun theCommandsAreByteForByteTheKiosks() {
        assertEquals("~HI", ZebraCommands.HOST_IDENTIFICATION)
        assertEquals("~HS", ZebraCommands.HOST_STATUS)
        assertEquals("^XA^HWE:*.*^XZ", ZebraCommands.FONT_DIRECTORY)
        assertEquals("! U1 getvar \"sensor.peeler_present\"\r\n", ZebraCommands.PEELER_PRESENT)
        assertEquals("~DYE:ROBOTO_R.TTF,B,T,1234,,", ZebraCommands.downloadFontHeader("ROBOTO_R.TTF", 1234))
    }

    // ── checks ──

    @Test fun statusProblemsNamePaperHeadAndPause() {
        val ok = parseHostStatus(netHs)!!
        assertEquals(emptyList<String>(), statusProblems(ok))
        assertEquals(
            listOf(
                "Paper out: load labels.", "Head open: close the print head.",
                "Paused: press Pause on the printer to resume.",
            ),
            statusProblems(ok.copy(paperOut = true, headOpen = true, paused = true)),
        )
    }

    @Test fun missingFontsAreTheNeededOnesNotOnThePrinter() {
        assertEquals(
            listOf("ROBOTO_R.TTF", "TT0003M_.TTF"),
            missingFonts(listOf("85620388.TTF", "ROBOTO_R.TTF", "TT0003M_.TTF"), listOf("85620388.TTF", "TEXT.ZPL")),
        )
        assertEquals(emptyList<String>(), missingFonts(listOf("A.TTF"), listOf("a.ttf")))
    }

    @Test fun theFontFixNeverInstallsAResidentFont() {
        val library = listOf(
            // an older library row not yet flagged: the name still keeps it off the install list
            KioskLabelFont("f-s", "TT0003M_.TTF", 160676),
            KioskLabelFont("f-r", "ROBOTO_R.TTF", 4, resident = false),
            KioskLabelFont("f-x", "SWISS2.TTF", 0, resident = true),
        )
        assertEquals(
            FontFix(installable = listOf(library[1]), builtIn = listOf("SWISS2.TTF", "TT0003M_.TTF"), notInLibrary = listOf("NOPE.TTF")),
            fontFixFor(listOf("NOPE.TTF", "ROBOTO_R.TTF", "SWISS2.TTF", "TT0003M_.TTF"), library),
        )
        // missing from the library too: still built in, never "upload it"
        assertEquals(
            FontFix(installable = emptyList(), builtIn = listOf("TT0003M_.TTF"), notInLibrary = emptyList()),
            fontFixFor(listOf("TT0003M_.TTF"), emptyList()),
        )
    }
}
