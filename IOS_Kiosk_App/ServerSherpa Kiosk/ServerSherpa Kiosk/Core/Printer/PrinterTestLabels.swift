import Foundation

// The labels Settings › Troubleshooting prints, from the Bluetooth test screen that printed them on
// a ZD421 (branch ble-spike). Nothing here changes a saved printer setting: no ^MM, ^JUS, ~SD or
// any other command the printer keeps.

/// What the sample label's Code 128 encodes: 15 characters, so the symbol is 200 modules wide
/// (start 11 + 15 × 11 + check 11 + stop 13) in subset B.
let SAMPLE_BARCODE_DATA = "TEST-0123456789"
/// What the sample label's QR encodes: "MA,<37-character URL>" is a version 3 QR (29 × 29 modules)
/// at error correction M.
let SAMPLE_QR_URL = "https://serversherpa.com/printer-test"

private let SAMPLE_BARCODE_MODULES = 200
private let SAMPLE_QR_MODULES = 29

/// A sample label: "Printer test", the date and time, a Code 128 of `SAMPLE_BARCODE_DATA` and a QR
/// of `SAMPLE_QR_URL`, laid out to fit a `widthDots` × `heightDots` label at `dpi`. Plain ASCII,
/// so half its characters are half its bytes (the Cut-send test sends half of one).
func sampleTestLabel(widthDots: Int, heightDots: Int, dpi: Int, now: Date = Date()) -> String {
    // At least a dot each way (a sub-dot template size still makes a label).
    let w = max(1, widthDots)
    let h = max(1, heightDots)
    let m = max(10, dpi / 12)
    let titleH = max(16, min(dpi / 5, h / 7))
    let dateH = max(14, min(dpi / 8, h / 10))

    // ^BY2 when the barcode leaves room for a QR beside it, else ^BY1 (a 2x1 at 203 dpi).
    var module = 2
    if w - 3 * m - SAMPLE_BARCODE_MODULES * module < SAMPLE_QR_MODULES * 2 { module = 1 }
    let barcodeW = SAMPLE_BARCODE_MODULES * module
    let interpretationH = 12 * module + 6

    let titleY = m
    let dateY = titleY + titleH + m / 2
    let barcodeY = dateY + dateH + m / 2
    let barcodeH = max(20, min(Int(Double(dpi) * 0.4), h - barcodeY - m - interpretationH))

    // The QR sits top right, as big as fits beside the barcode (magnification 1–8). ^BQ prints
    // about 10 dots below its ^FO, so that's left free at the top.
    let qrRoomW = w - 3 * m - barcodeW
    let qrRoomH = h - 2 * m - 10
    let mag = max(1, min(8, min(qrRoomW, qrRoomH) / SAMPLE_QR_MODULES))
    let qrX = w - m - SAMPLE_QR_MODULES * mag

    return "^XA^CI28^PW\(w)^LL\(h)"
        + "^FO\(m),\(titleY)^A0N,\(titleH),\(titleH)^FDPrinter test^FS"
        + "^FO\(m),\(dateY)^A0N,\(dateH),\(dateH)^FD\(testLabelStamp(now))^FS"
        + "^FO\(m),\(barcodeY)^BY\(module)^BCN,\(barcodeH),Y,N,N^FD\(SAMPLE_BARCODE_DATA)^FS"
        + "^FO\(qrX),\(m)^BQN,2,\(mag)^FDMA,\(SAMPLE_QR_URL)^FS"
        + "^XZ"
}

/**
 A speed-test label `targetBytes` long (as UTF-8) for a `widthDots` × `heightDots` label: a caption
 "Run N · 10 KB · START" at the top, a comment that makes up the few bytes the picture's whole rows
 can't, an uncompressed ASCII-hex `^GFA` of diagonal stripes sized to make up the bytes, then "END"
 near the bottom of the label, the last thing before `^XZ`.

 How to read the result: `^GFA` is count-based. The printer takes exactly the byte count the header
 announces as picture data, then goes on parsing ZPL. If any chunk were lost on the way, the printer
 would swallow the bytes after the picture (the END caption, even the `^XZ`) as picture data; if
 chunks were reordered, the stripes would be torn and the tail would usually be swallowed too. So a
 label that prints END (with clean stripes) means every byte arrived, in order: nothing but END's
 box and caption follows the picture, so a lost last chunk can't hide behind padding. The picture
 may run past the label's length; the printer still parses every byte and just clips the picture.
 A white box is drawn under END so it reads even over the stripes. A size under a dot (a sub-dot
 template width, a printer that reported no resolution) is taken as one dot, one byte a row.
 */
func speedTestLabel(targetBytes: Int, widthDots: Int, heightDots: Int, run: Int) -> String {
    let w = max(1, widthDots)
    let h = max(1, heightDots)
    let m = max(10, min(w, h) / 24)
    let bytesPerRow = (w + 7) / 8
    let captionH = max(16, min(h / 8, w / 24))
    let endH = max(20, min(50, h / 5))
    let graphicY = m + captionH + m / 2
    let endY = max(graphicY, h - endH - 10)
    let caption = "Run \(run) · \(testLabelKb(targetBytes)) KB · START"

    func assemble(_ total: Int, hex: String, pad: String = "") -> String {
        "^XA^CI28^PW\(w)^LL\(h)"
            + "^FO\(m),\(m)^A0N,\(captionH),\(captionH)^FD\(caption)^FS"
            + pad
            + "^FO0,\(graphicY)^GFA,\(total),\(total),\(bytesPerRow),\(hex)^FS"
            + "^FO0,\(endY - 10)^GB\(w),\(endH + 20),\(endH + 20),W^FS"
            + "^FO\(m),\(endY)^A0N,\(endH),\(endH)^FDEND^FS"
    }

    // Everything but the hex, then as many whole rows as the rest of the budget holds (two hex
    // characters a byte; at least one row). A second pass settles the header's digit count.
    let close = "^XZ"
    var total = bytesPerRow
    for _ in 0..<2 {
        let overhead = assemble(total, hex: "").utf8.count + close.utf8.count
        let rows = max(1, (targetBytes - overhead) / 2 / bytesPerRow)
        total = rows * bytesPerRow
    }
    let stripes = testLabelStripes(rows: total / bytesPerRow, bytesPerRow: bytesPerRow)
    // A comment (`^FX…^FS`, which prints nothing) makes up what's left of the target, before the
    // picture: END stays the last thing the printer parses.
    let left = targetBytes - assemble(total, hex: stripes).utf8.count - close.utf8.count
    let pad = left >= 6 ? "^FX" + String(repeating: "-", count: left - 6) + "^FS" : ""
    return assemble(total, hex: stripes, pad: pad) + close
}

/// Uncompressed ASCII hex (0-9, A-F only: ZPL reads G–Z and g–z as repeat counts) of 45° stripes
/// 16 dots wide.
private func testLabelStripes(rows: Int, bytesPerRow: Int) -> String {
    let digits = Array("0123456789ABCDEF".utf8)
    var out = [UInt8]()
    out.reserveCapacity(rows * bytesPerRow * 2)
    for row in 0..<rows {
        for col in 0..<bytesPerRow {
            var byte: UInt8 = 0
            for bit in 0..<8 {
                let x = col * 8 + bit
                if ((x + row) / 16) % 2 == 0 { byte |= 0x80 >> UInt8(bit) }
            }
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0F)])
        }
    }
    return String(decoding: out, as: UTF8.self)
}

/// "10", "2.5": `bytes` in KB (1,024 bytes).
private func testLabelKb(_ bytes: Int) -> String {
    let kb = Double(bytes) / 1024
    return kb.rounded() == kb ? String(Int(kb)) : String(format: "%.1f", kb)
}

private func testLabelStamp(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f.string(from: date)
}
