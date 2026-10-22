import Testing
import Foundation
@testable import ServerSherpa_Kiosk

private final class PrinterFixtureBundle {}

/// The reply parsers, on the portal's sample replies (portal/src/labels/zebraUsb.test.ts), the
/// laptop edge's real network replies (kiosk_laptop/edge/tests/test_printers.py) and a real
/// ZT220's `^HH` configuration (`Fixtures/zt220_hh.txt`, byte for byte the Android test fixture).
/// Ported from Android's ZebraRepliesTest.
struct ZebraRepliesTests {
    private let hi = "\u{02}ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\u{03}"
    private let hs = "\u{02}030,1,0,1245,003,0,0,0,000,0,0,1\u{03}\r\n" +
        "\u{02}000,0,1,0,0,2,4,0,00000012,1,000\u{03}\r\n\u{02}1234,0\u{03}"
    private let hw = "\u{02}- DIR E:*.*\r\n* 85620388.TTF       124336\r\n* TT0003M_.TTF      169188\r\n" +
        "-1928576 bytes free E: ONBOARD FLASH\r\n\u{03}"
    private let hwDrivePrefixed = "\u{02}- DIR E:*.*\r\n*E:85620388.TTF  124336\r\n*E:TT0003M_.TTF 169188\r\n" +
        "-1928576 bytes free E: ONBOARD FLASH\r\n\u{03}"

    // A ZD421-300dpi's replies over port 9100 (2026-10-19), as the edge's tests keep them.
    private let netHi = "\u{02}ZD421-300dpi,V93.21.38Z,12,8176KB\u{03}\r\n"
    private let netHs = "\u{02}030,0,0,0612,000,0,0,0,000,0,0,0\u{03}\r\n" +
        "\u{02}000,0,0,0,0,1,6,0,00000000,1,000\u{03}\r\n\u{02}0000,0\u{03}\r\n"
    private let netHw = "\u{02}\r\n- DIR E:*.* \r\n* E:TEXT.ZPL   5  \r\n\r\n-  32346624 bytes free E: ONBOARD FLASH \r\n\u{03}"

    /// The real ZT220 reply, read as the network code reads replies (Latin-1).
    private func zt220Hh() throws -> String {
        let url = try #require(Bundle(for: PrinterFixtureBundle.self).url(forResource: "zt220_hh", withExtension: "txt"))
        return try #require(String(data: Data(contentsOf: url), encoding: .isoLatin1))
    }

    // MARK: ~HI

    @Test func parsesHostIdentification() {
        #expect(parseHostIdentification(hi) == HostId(model: "ZD421-203dpi ZPL", firmware: "V92.21.16Z", dotsPerMm: 8, memory: "8192KB", dpi: 203))
        #expect(parseHostIdentification(netHi) == HostId(model: "ZD421-300dpi", firmware: "V93.21.38Z", dotsPerMm: 12, memory: "8176KB", dpi: 300))
        #expect(parseHostIdentification("garbage") == nil)
        #expect(parseHostIdentification("") == nil)
    }

    @Test func hostIdentificationReadsTheLastFrame() {
        #expect(
            parseHostIdentification("\u{02}junk,1\u{03}\u{02}ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\u{03}")
                == HostId(model: "ZD421-203dpi ZPL", firmware: "V92.21.16Z", dotsPerMm: 8, memory: "8192KB", dpi: 203)
        )
    }

    @Test func aNetworkIdentificationNeedsItsStxFrame() {
        // the laptop edge's network parser: a reply over port 9100 without STX isn't a Zebra's
        #expect(parseNetworkHostIdentification(netHi) == parseHostIdentification(netHi))
        #expect(parseNetworkHostIdentification(netHi) != nil)
        #expect(parseNetworkHostIdentification("ZD421-300dpi,V93.21.38Z,12,8176KB\r\n") == nil)
        #expect(parseHostIdentification("ZD421-300dpi,V93.21.38Z,12,8176KB\r\n")?.dpi == 300) // portal parity
        #expect(parseNetworkHostIdentification("") == nil)
    }

    @Test func dpiFromDotsPerMmUsesTheNominalValues() {
        #expect(dpiFromDotsPerMm(6) == 150)
        #expect(dpiFromDotsPerMm(8) == 203)
        #expect(dpiFromDotsPerMm(12) == 300)
        #expect(dpiFromDotsPerMm(24) == 600)
        #expect(dpiFromDotsPerMm(16) == 406) // 406.4, rounded
    }

    @Test func dotsPerMmIsReadLikeJavaScriptParseInt() {
        // leading whitespace, a sign, then the leading digits; a huge value clamps instead of trapping
        #expect(parseHostIdentification("\u{02}M,F, 12mm,8MB\u{03}")?.dotsPerMm == 12)
        #expect(parseHostIdentification("\u{02}M,F,+8,8MB\u{03}")?.dotsPerMm == 8)
        #expect(parseHostIdentification("\u{02}M,F,x8,8MB\u{03}") == nil)
        #expect(parseHostIdentification("\u{02}M,F,99999999999999999999,8MB\u{03}")?.dotsPerMm == Int(Int32.max))
        // ... and so does its DPI, as Kotlin's Double.toInt() clamps
        #expect(parseHostIdentification("\u{02}M,F,99999999999999999999,8MB\u{03}")?.dpi == Int(Int32.max))
        #expect(parseHostIdentification("\u{02}M,F,-99999999999999999999,8MB\u{03}")?.dpi == Int(Int32.min))
        #expect(dpiFromDotsPerMm(100_000_000) == Int(Int32.max))
        #expect(parseHostIdentification("\u{02},F,8,8MB\u{03}") == nil) // no model
    }

    // MARK: ~HS

    @Test func parsesHostStatus() throws {
        let s = try #require(parseHostStatus(hs))
        #expect(s.paperOut); #expect(!s.paused); #expect(s.labelLength == 1245)
        #expect(s.formatsQueued == 3); #expect(!s.bufferFull); #expect(s.overTemp)
        #expect(!s.underTemp); #expect(s.headOpen); #expect(!s.ribbonOut)
        #expect(!s.thermalTransfer); #expect(s.printMode == "2"); #expect(s.labelsRemaining == 12)
        #expect(parseHostStatus("\u{02}030,0\u{03}") == nil)
        #expect(parseHostStatus("") == nil)
    }

    @Test func parsesARealNetworkHostStatus() {
        #expect(
            parseHostStatus(netHs) == HostStatus(
                paperOut: false, paused: false, labelLength: 612, formatsQueued: 0, bufferFull: false,
                partialFormat: false, corruptRam: false, underTemp: false, overTemp: false,
                headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: "1",
                labelWaiting: false, labelsRemaining: 0
            )
        )
    }

    @Test func hostStatusNeedsStringTwoAndSkipsLeftoverFrames() {
        #expect(parseHostStatus("\u{02}030,1,0,1245,003,0,0,0,000,0,0,1\u{03}") == nil)
        #expect(parseHostStatus(hs) != nil)
        #expect(parseHostStatus("\u{02}garbage\u{03}\u{02}x,y\u{03}" + hs) == parseHostStatus(hs))
    }

    // MARK: ^HW

    @Test func parsesADirectoryListing() {
        #expect(parseDirectory(hw) == ["85620388.TTF", "TT0003M_.TTF"])
        #expect(parseDirectory(hwDrivePrefixed) == parseDirectory(hw))
        #expect(parseDirectory("\u{02}- DIR E:*.*\r\n-2000000 bytes free E:\u{03}") == [])
        #expect(isDirectoryListing("\u{02}- DIR E:*.*\r\n-2000000 bytes free E:\u{03}"))
        #expect(parseDirectory("") == [])
        #expect(!isDirectoryListing(""))
        #expect(parseDirectory(netHw) == ["TEXT.ZPL"])
    }

    @Test func keepsTheLastListingAndCollapsesRepeatedNames() {
        let twice = "\u{02}- DIR E:*.*\r\n*E:85620388.TTF  1035\r\n*E:IN001.DMP  900\r\n-2000 bytes free E:\u{03}" +
            "\u{02}- DIR E:*.*\r\n*E:85620388.TTF  1036\r\n*E:NEW.TTF  901\r\n-1999 bytes free E:\u{03}"
        #expect(parseDirectory(twice) == ["85620388.TTF", "NEW.TTF"])
        let dup = "\u{02}- DIR E:*.*\r\n*E:A.TTF  1\r\n*E:B.TTF  1\r\n*E:A.TTF  2\r\n-5 bytes free E:\u{03}"
        #expect(parseDirectory(dup) == ["B.TTF", "A.TTF"])
    }

    @Test func directoryRowsMayCarryFlagsAndLowerCaseNames() {
        // a ZT220 (2026-10-19): a stored font has a K flag after its size
        let zt220 = "\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960          \r\n" +
            "* E:TEXT.ZPL         5          \r\n* E:TT0003M_.TTF    160676       K  \r\n\r\n" +
            "-  32346624 bytes free E: ONBOARD FLASH \r\n"
        #expect(parseDirectory(zt220) == ["85620388.TTF", "TEXT.ZPL", "TT0003M_.TTF"])
        // a ZD421-300dpi's Z: listing (2026-10-20): P flags, and a trailing 0 on the first row
        let z = "\r\n- DIR Z:*.TTF\r\n* Z:0.TTF    125904  P    0\r\n* Z:T0025.TTF     92552  P\r\n" +
            "* Z:TT0003M_.TTF    169188  P\r\n"
        #expect(parseDirectory(z) == ["0.TTF", "T0025.TTF", "TT0003M_.TTF"])
        #expect(parseDirectory("- DIR E:*.*\r\n* e:roboto_r.ttf  12\r\n") == ["ROBOTO_R.TTF"])
    }

    // MARK: a real ZT220's ^HH is neither a status nor a listing
    // (Like the portal's parser, ~HI parsing doesn't reject it: its counters' commas split it into
    // four "fields". NetworkZebra asks each query on its own connection, so no other reply reaches it.)

    @Test func aConfigurationReplyIsNotStatusOrListing() throws {
        let zt220 = try zt220Hh()
        #expect(zt220.utf8.count > 2_000)
        #expect(zt220.contains("TEAR OFF            PRINT MODE"))
        #expect(parseHostStatus(zt220) == nil)
        #expect(!isDirectoryListing(zt220))
        #expect(parseDirectory(zt220) == [])
    }

    // MARK: getvar

    @Test func parsesGetvarReplies() {
        #expect(parseGetvar("\"Present\"") == "Present")
        #expect(parseGetvar("\"Not Present\"") == "Not Present")
        #expect(parseGetvar("\"?\"") == nil)
        #expect(parseGetvar("") == nil)
        #expect(parseGetvar(" \"peel off\" ") == "peel off")
        #expect(parseGetvar("\"peel off\"\r\n") == "peel off")
        #expect(parseGetvar("\"\"") == nil)
        // Kotlin's trim(): Char.isWhitespace, so U+001C..U+001F and no-break spaces go, U+0085 stays
        #expect(parseGetvar("\u{1C}\u{1F}\"x\"\u{A0}\u{2007}") == "x")
        #expect(parseGetvar("\u{85}\"x\"") == "\u{85}\"x\"")
        #expect(parseGetvar("\u{85}") == "\u{85}")
    }

    @Test func theCommandsAreByteForByteTheKiosks() {
        #expect(ZebraCommands.hostIdentification == "~HI")
        #expect(ZebraCommands.hostStatus == "~HS")
        #expect(ZebraCommands.fontDirectory == "^XA^HWE:*.*^XZ")
        #expect(ZebraCommands.peelerPresent == "! U1 getvar \"sensor.peeler_present\"\r\n")
        #expect(ZebraCommands.serialNumber == "! U1 getvar \"device.unique_id\"\r\n")
        #expect(Array(ZebraCommands.peelerPresent.utf8).suffix(2) == [0x0D, 0x0A])
        #expect(ZebraCommands.downloadFontHeader(name: "ROBOTO_R.TTF", totalBytes: 1234) == "~DYE:ROBOTO_R.TTF,B,T,1234,,")
    }

    // MARK: checks

    @Test func statusProblemsNamePaperHeadAndPause() throws {
        let ok = try #require(parseHostStatus(netHs))
        #expect(statusProblems(ok) == [])
        var bad = ok
        bad.paperOut = true
        bad.headOpen = true
        bad.paused = true
        #expect(statusProblems(bad) == [
            "Paper out: load labels.", "Head open: close the print head.",
            "Paused: press Pause on the printer to resume.",
        ])
    }

    @Test func missingFontsAreTheNeededOnesNotOnThePrinter() {
        #expect(
            missingFonts(needed: ["85620388.TTF", "ROBOTO_R.TTF", "TT0003M_.TTF"], onPrinter: ["85620388.TTF", "TEXT.ZPL"])
                == ["ROBOTO_R.TTF", "TT0003M_.TTF"]
        )
        #expect(missingFonts(needed: ["A.TTF"], onPrinter: ["a.ttf"]) == [])
    }

    @Test func theFontFixNeverInstallsAResidentFont() {
        let library = [
            // an older library row not yet flagged: the name still keeps it off the install list
            KioskLabelFont(id: "f-s", name: "TT0003M_.TTF", size: 160676),
            KioskLabelFont(id: "f-r", name: "ROBOTO_R.TTF", size: 4, resident: false),
            KioskLabelFont(id: "f-x", name: "SWISS2.TTF", size: 0, resident: true),
        ]
        #expect(
            fontFixFor(missing: ["NOPE.TTF", "ROBOTO_R.TTF", "SWISS2.TTF", "TT0003M_.TTF"], library: library)
                == FontFix(installable: [library[1]], builtIn: ["SWISS2.TTF", "TT0003M_.TTF"], notInLibrary: ["NOPE.TTF"])
        )
        // missing from the library too: still built in, never "upload it"
        #expect(
            fontFixFor(missing: ["TT0003M_.TTF"], library: [])
                == FontFix(installable: [], builtIn: ["TT0003M_.TTF"], notInLibrary: [])
        )
    }

    // The rest of PrinterChecks has no Android unit test; these pin its copy.

    @Test func noTemplateTextNamesTheFixOrTheOtherDpis() {
        #expect(
            noTemplateText(kind: .top, printerDpi: 203, available: [])
                == "No active Top template for this move. Someone with label access needs to activate one on "
                + "Labels › Templates in the portal (Generic Rack and RU covers every move), then sync this kiosk."
        )
        #expect(
            noTemplateText(kind: .front, printerDpi: 203, available: [203])
                == "No active Front template for this move. Someone with label access needs to activate one on "
                + "Labels › Templates in the portal, then sync this kiosk."
        )
        #expect(
            noTemplateText(kind: .top, printerDpi: 203, available: [600, 300, 300])
                == "This move's Top template prints at 300 and 600 DPI only; this printer is 203 DPI. "
                + "Activate a 203 DPI version on Labels › Templates, or use a 300 or 600 DPI printer."
        )
        #expect(
            noTemplateText(kind: .front, printerDpi: 300, available: [203, 600, 150])
                == "This move's Front template prints at 150, 203 and 600 DPI only; this printer is 300 DPI. "
                + "Activate a 300 DPI version on Labels › Templates, or use a 150, 203 or 600 DPI printer."
        )
    }

    @Test func builtInFontTextIsSingularOrPlural() {
        #expect(builtInFontText(["TT0003M_.TTF"]) == "Printer is missing its built-in font TT0003M_.TTF.")
        #expect(builtInFontText(["A.TTF", "B.TTF"]) == "Printer is missing its built-in fonts A.TTF, B.TTF.")
    }

    @Test func isIpv4RejectsLeadingZerosAndOutOfRangeParts() {
        #expect(isIpv4("192.168.1.37"))
        #expect(isIpv4("0.0.0.0"))
        #expect(isIpv4("255.255.255.255"))
        #expect(!isIpv4("192.168.01.37"))
        #expect(!isIpv4("256.1.1.1"))
        #expect(!isIpv4("1.2.3"))
        #expect(!isIpv4("1.2.3.4.5"))
        #expect(!isIpv4(" 1.2.3.4"))
        #expect(!isIpv4("a.b.c.d"))
        #expect(!isIpv4("١.٢.٣.٤")) // non-ASCII digits
    }

    // MARK: Local Network access

    @Test func localNetworkIsDeniedOnlyWhenEveryProbeWasRefusedByPolicy() {
        #expect(scanWasDeniedLocalNetwork([.deniedByPolicy, .deniedByPolicy]))
        #expect(!scanWasDeniedLocalNetwork([]))
        #expect(!scanWasDeniedLocalNetwork([.deniedByPolicy, .unanswered]))
        #expect(!scanWasDeniedLocalNetwork([.deniedByPolicy, .answered]))
        #expect(!scanWasDeniedLocalNetwork([.unanswered]))
        #expect(LOCAL_NETWORK_DENIED_TEXT == "Allow Local Network access for ServerSherpa Kiosk in Settings to find printers.")
        #expect(LOCAL_NETWORK_PRINTER_DENIED_TEXT == "Allow Local Network access for ServerSherpa Kiosk in Settings to reach the printer.")
    }
}
