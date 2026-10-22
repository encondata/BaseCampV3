import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Troubleshooting's labels (the Bluetooth test screen's, which printed on a ZD421): the speed-test
/// label is the size asked for and proves every byte arrived by printing END after a count-based
/// picture; the sample label fits the label.
struct PrinterTestLabelsTests {
    /// 4x2 at 203 dpi, 4x2 at 300 dpi, 2x1 at 203 dpi, 4x6 at 600 dpi.
    private let sizes: [(w: Int, h: Int)] = [(812, 406), (1200, 600), (406, 203), (2400, 3600)]

    /// The `^GFA,total,total,bytesPerRow,` header's numbers and the hex after it (up to `^FS`).
    private func graphic(_ zpl: String) throws -> (total: Int, count: Int, perRow: Int, hex: Substring, end: String.Index) {
        let start = try #require(zpl.range(of: "^GFA,"))
        let rest = zpl[start.upperBound...]
        let fields = rest.split(separator: ",", maxSplits: 3, omittingEmptySubsequences: false)
        try #require(fields.count == 4)
        let total = try #require(Int(fields[0]))
        let count = try #require(Int(fields[1]))
        let perRow = try #require(Int(fields[2]))
        let close = try #require(fields[3].range(of: "^FS"))
        return (total, count, perRow, fields[3][..<close.lowerBound], close.upperBound)
    }

    @Test func speedLabelHitsTargetAndEndsWithEND() throws {
        for kb in [10, 25, 50] {
            for size in sizes {
                let target = kb * 1024
                let zpl = speedTestLabel(targetBytes: target, widthDots: size.w, heightDots: size.h, run: 2)
                let what = "\(kb) KB on \(size.w)x\(size.h)"
                #expect(abs(zpl.utf8.count - target) <= target / 50, "\(what): \(zpl.utf8.count) bytes")
                #expect(zpl.hasPrefix("^XA"), "\(what)")
                #expect(zpl.hasSuffix("^XZ"), "\(what)")
                #expect(zpl.contains("^PW\(size.w)^LL\(size.h)"), "\(what)")
                #expect(zpl.contains("Run 2 · \(kb) KB · START"), "\(what)")

                // The picture's counts agree: whole rows of the label's width, two hex digits a byte.
                let g = try graphic(zpl)
                #expect(g.total == g.count, "\(what)")
                #expect(g.perRow == (size.w + 7) / 8, "\(what)")
                #expect(g.total % g.perRow == 0, "\(what)")
                #expect(g.hex.utf8.count == 2 * g.total, "\(what)")
                #expect(g.hex.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) }, "\(what): hex digits only")

                // END comes after the picture, and prints inside the label's length.
                let after = zpl[g.end...]
                let end = try #require(after.range(of: "^FDEND^FS"), "\(what)")
                let field = after[..<end.lowerBound]
                let fo = try #require(field.range(of: "^FO", options: .backwards))
                let font = try #require(field.range(of: "^A0N,", options: .backwards))
                let y = try #require(Int(field[fo.upperBound...].split(separator: ",")[1].prefix { $0.isNumber }))
                let height = try #require(Int(field[font.upperBound...].prefix { $0.isNumber }))
                #expect(y > 0 && y + height <= size.h, "\(what): END at \(y)+\(height)")

                // Nothing after the picture but the END box and caption: padding there would let a
                // lost last chunk still print END.
                #expect(!after.contains("^FX"), "\(what)")
                #expect(zpl.hasSuffix("^FDEND^FS^XZ"), "\(what)")
            }
        }
    }

    /// A label narrower than a byte of dots (a sub-dot template width, a printer that reported no
    /// resolution) still makes a label instead of dividing by zero.
    @Test func aTinyOrEmptyLabelSizeStillMakesALabel() throws {
        for (w, h) in [(0, 0), (1, 1), (7, 3), (-5, 10)] {
            let zpl = speedTestLabel(targetBytes: 10 * 1024, widthDots: w, heightDots: h, run: 1)
            #expect(zpl.hasPrefix("^XA"), "\(w)x\(h)")
            #expect(zpl.hasSuffix("^FDEND^FS^XZ"), "\(w)x\(h)")
            let g = try graphic(zpl)
            #expect(g.perRow == 1, "\(w)x\(h)")
            #expect(g.hex.utf8.count == 2 * g.total, "\(w)x\(h)")
            #expect(sampleTestLabel(widthDots: w, heightDots: h, dpi: 0).hasSuffix("^XZ"))
        }
    }

    @Test func speedLabelRowsAreDiagonalStripes() throws {
        let zpl = speedTestLabel(targetBytes: 10 * 1024, widthDots: 16, heightDots: 400, run: 1)
        let g = try graphic(zpl)
        // 16 dots a row (2 bytes), stripes 16 dots wide moving one dot a row.
        #expect(g.hex.prefix(4) == "FFFF")
        #expect(g.hex.dropFirst(4).prefix(4) == "FFFE")
    }

    @Test func sampleLabelFitsTheLabelAndIsPlainAscii() {
        let now = Date(timeIntervalSince1970: 1_792_000_000)
        for (w, h, dpi) in [(812, 406, 203), (1200, 600, 300), (406, 203, 203)] {
            let zpl = sampleTestLabel(widthDots: w, heightDots: h, dpi: dpi, now: now)
            #expect(zpl.hasPrefix("^XA^CI28^PW\(w)^LL\(h)"))
            #expect(zpl.hasSuffix("^XZ"))
            #expect(zpl.contains("^FDPrinter test^FS"))
            #expect(zpl.contains("^BCN,"))
            #expect(zpl.contains("^FD\(SAMPLE_BARCODE_DATA)^FS"))
            #expect(zpl.contains("^BQN,2,"))
            #expect(zpl.contains("^FDMA,\(SAMPLE_QR_URL)^FS"))
            // Plain ASCII: half its characters are half its bytes (the Cut-send test halves it).
            #expect(zpl.utf8.count == zpl.count)
            #expect(zpl == sampleTestLabel(widthDots: w, heightDots: h, dpi: dpi, now: now))
        }
    }
}
