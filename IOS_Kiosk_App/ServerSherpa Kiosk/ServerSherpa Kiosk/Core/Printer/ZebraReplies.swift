import Foundation

/// The commands the kiosk sends a Zebra, byte for byte as the web kiosk and the laptop edge send
/// them (portal/src/labels/zebraCommands.ts, kiosk/src/lib/stationPrinter.ts). Mirrors Android's
/// core/printer/ZebraReplies.kt.
enum ZebraCommands {
    static let hostIdentification = "~HI"
    static let hostStatus = "~HS"
    /// The E: drive listing: the fonts installed on the printer.
    static let fontDirectory = "^XA^HWE:*.*^XZ"
    /// Whether a peeler is fitted: `"Present"`, `"Not Present"`, or `"?"` when unknown.
    static let peelerPresent = "! U1 getvar \"sensor.peeler_present\"\r\n"
    /// The printer's serial number (`~HI` doesn't carry one).
    static let serialNumber = "! U1 getvar \"device.unique_id\"\r\n"

    /// `~DYE:NAME,B,T,<bytes>,,`: a binary TrueType download to E:; the font's bytes follow.
    static func downloadFontHeader(name: String, totalBytes: Int) -> String {
        "~DYE:\(name),B,T,\(totalBytes),,"
    }
}

/// `~HI`'s answer; `dpi` is the nominal value for `dotsPerMm`.
struct HostId: Equatable, Sendable {
    var model: String
    var firmware: String
    var dotsPerMm: Int
    var memory: String
    var dpi: Int
}

/// `~HS`'s answer (ZPL manual field order).
struct HostStatus: Equatable, Sendable {
    var paperOut: Bool
    var paused: Bool
    var labelLength: Int
    var formatsQueued: Int
    var bufferFull: Bool
    var partialFormat: Bool
    var corruptRam: Bool
    var underTemp: Bool
    var overTemp: Bool
    var headOpen: Bool
    var ribbonOut: Bool
    var thermalTransfer: Bool
    var printMode: String
    var labelWaiting: Bool
    var labelsRemaining: Int
}

private let STX = "\u{02}"
private let ETX = "\u{03}"
private let NOMINAL_DPI: [Int: Int] = [6: 150, 8: 203, 12: 300, 24: 600]

/// The DPI a dots-per-mm resolution is sold as; anything else is converted and rounded. Out of
/// Int32 range it clamps, as Kotlin's `Double.toInt()` does.
func dpiFromDotsPerMm(_ dotsPerMm: Int) -> Int {
    if let nominal = NOMINAL_DPI[dotsPerMm] { return nominal }
    let dpi = (Double(dotsPerMm) * 25.4 + 0.5).rounded(.down)
    return Int(min(max(dpi, Double(Int32.min)), Double(Int32.max)))
}

private func strip(_ text: String) -> String {
    text.replacingOccurrences(of: STX, with: "").replacingOccurrences(of: ETX, with: "")
}

/// Kotlin's `String.trim()`: `Char.isWhitespace` characters off both ends, by scalar (so `\r\n`
/// goes too).
private func trimmed(_ text: some StringProtocol) -> String {
    let string = String(text)
    let scalars = string.unicodeScalars
    guard let start = scalars.firstIndex(where: { !kotlinWhitespace.contains($0) }),
          let end = scalars.lastIndex(where: { !kotlinWhitespace.contains($0) })
    else { return "" }
    return String(scalars[start...end])
}

/// Kotlin's `Char.isWhitespace` (Java's `isWhitespace || isSpaceChar`), spelled out: U+0009–U+000D,
/// U+001C–U+001F, the space separators (no-break spaces included) and U+2028/U+2029. Not U+0085.
private let kotlinWhitespace: Set<Unicode.Scalar> = {
    var set = Set<Unicode.Scalar>()
    let ranges: [ClosedRange<UInt32>] = [
        0x09...0x0D, 0x1C...0x1F, 0x20...0x20, 0xA0...0xA0, 0x1680...0x1680, 0x2000...0x200A,
        0x2028...0x2029, 0x202F...0x202F, 0x205F...0x205F, 0x3000...0x3000,
    ]
    for range in ranges { for value in range { set.insert(Unicode.Scalar(value)!) } }
    return set
}()

/// JavaScript's `parseInt(v, 10)`: leading whitespace, an optional sign, then the leading ASCII
/// digits; nil when there are none. A value past Int32 clamps to it, as Android's does.
private func jsParseInt(_ value: String) -> Int? {
    var scalars = Substring(value).unicodeScalars.drop(while: { asciiWhitespace.contains($0) })
    var negative = false
    if let sign = scalars.first, sign == "+" || sign == "-" {
        negative = sign == "-"
        scalars = scalars.dropFirst()
    }
    let digits = scalars.prefix(while: { ("0"..."9").contains($0) })
    if digits.isEmpty { return nil }
    let limit = negative ? -Int64(Int32.min) : Int64(Int32.max)
    var magnitude: Int64 = 0
    for digit in digits {
        magnitude = min(magnitude * 10 + Int64(digit.value - 48), limit)
    }
    return Int(negative ? -magnitude : magnitude)
}

/// Java's `\s` (ASCII whitespace), for the ports of Android's regular expressions.
private let asciiWhitespace: Set<Unicode.Scalar> = [" ", "\t", "\n", "\u{0B}", "\u{0C}", "\r"]

/// `~HI` → `<STX>model,firmware,dotsPerMm,memory[,x]<ETX>`. A leftover frame from a prior query
/// can precede the real response, so the LAST `<STX>…<ETX>` frame is parsed; without an STX,
/// the whole stripped text. Mirrors parseHostIdentification in portal/src/labels/zebraUsb.ts.
func parseHostIdentification(_ text: String) -> HostId? {
    let frames = text.components(separatedBy: STX).dropFirst()
    let body: String
    if let last = frames.last {
        body = trimmed(last.components(separatedBy: ETX)[0])
    } else {
        body = trimmed(strip(text))
    }
    let parts = body.components(separatedBy: ",").map { trimmed($0) }
    guard parts.count >= 4, !parts[0].isEmpty, let dotsPerMm = jsParseInt(parts[2]) else { return nil }
    return HostId(model: parts[0], firmware: parts[1], dotsPerMm: dotsPerMm, memory: parts[3], dpi: dpiFromDotsPerMm(dotsPerMm))
}

/// `~HS` string 1 `aaa,b,c,dddd,eee,f,g,h,iii,j,k,l` and string 2 `mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www`
/// (string 3 is the password and isn't read). Both strings are required, and the last full pair
/// wins over leftover frames. Mirrors parseHostStatus in portal/src/labels/zebraUsb.ts.
func parseHostStatus(_ text: String) -> HostStatus? {
    let frames = text.components(separatedBy: STX).dropFirst()
        .map { $0.components(separatedBy: ETX)[0].components(separatedBy: ",") }
    guard let i = frames.indices.last(where: { k in
        frames[k].count >= 12 && (k + 1 < frames.count ? frames[k + 1].count : 0) >= 9
    }) else { return nil }
    let s1 = frames[i]
    let s2 = frames[i + 1]
    func flag(_ v: String) -> Bool { trimmed(v) == "1" }
    func int(_ v: String) -> Int { jsParseInt(v) ?? 0 }
    return HostStatus(
        paperOut: flag(s1[1]), paused: flag(s1[2]), labelLength: int(s1[3]), formatsQueued: int(s1[4]),
        bufferFull: flag(s1[5]), partialFormat: flag(s1[7]), corruptRam: flag(s1[9]),
        underTemp: flag(s1[10]), overTemp: flag(s1[11]),
        headOpen: flag(s2[2]), ribbonOut: flag(s2[3]), thermalTransfer: flag(s2[4]),
        printMode: trimmed(s2[5]), labelWaiting: flag(s2[7]), labelsRemaining: int(s2[8])
    )
}

// Android's patterns with Java's ASCII classes spelled out (ICU's `\s`, `\d` and `\w` are Unicode).
private let WS = "[ \\t\\n\\x0B\\f\\r]"
private let DIR_HEADER = try! NSRegularExpression(pattern: "DIR\(WS)+[A-Za-z0-9_]:", options: [.caseInsensitive])

// A size may be followed by attribute columns: a ZT220 lists a stored font as
// `E:TT0003M_.TTF  160676  K`, and a ZD421 lists a ROM font as `Z:0.TTF    125904  P    0`.
private let DIR_ROW = try! NSRegularExpression(
    pattern: "^\(WS)*\\*?\(WS)*(?:[A-Z]:)?([A-Z0-9_]{1,8}\\.[A-Z0-9]{1,3})\(WS)+([0-9]+)(?:\(WS)+[A-Z0-9]+)*\(WS)*$",
    options: [.caseInsensitive]
)
private let LINE_BREAK = try! NSRegularExpression(pattern: "\\r?\\n")

private func nsRange(_ text: String) -> NSRange { NSRange(text.startIndex..., in: text) }

/// Whether a reply is a `^HW` listing at all (a `DIR x:` header), so an unreadable reply isn't
/// taken for an empty drive.
func isDirectoryListing(_ text: String) -> Bool {
    let full = strip(text)
    return DIR_HEADER.firstMatch(in: full, range: nsRange(full)) != nil
}

/// `^HW` → `- DIR E:*.*` header, `* NAME.EXT <bytes>` rows, `-<n> bytes free` trailer: the object
/// names, upper-cased; empty when the reply isn't a listing (see `isDirectoryListing`). A straggling
/// earlier listing can precede the fresh one, so only the last `DIR x:` block counts, and a repeated
/// name keeps its last row's place. Mirrors parseDirectory in portal/src/labels/zebraUsb.ts.
func parseDirectory(_ text: String) -> [String] {
    let full = strip(text) as NSString
    guard let header = DIR_HEADER.matches(in: full as String, range: NSRange(location: 0, length: full.length)).last else {
        return []
    }
    let block = full.substring(from: header.range.location)
    var lines: [String] = []
    var start = 0
    let blockNS = block as NSString
    for brk in LINE_BREAK.matches(in: block, range: NSRange(location: 0, length: blockNS.length)) {
        lines.append(blockNS.substring(with: NSRange(location: start, length: brk.range.location - start)))
        start = brk.range.location + brk.range.length
    }
    lines.append(blockNS.substring(from: start))
    var names: [String] = []
    for line in lines {
        let range = NSRange(location: 0, length: (line as NSString).length)
        guard let row = DIR_ROW.firstMatch(in: line, options: [.anchored], range: range), row.range == range else { continue }
        let name = (line as NSString).substring(with: row.range(at: 1)).uppercased()
        names.removeAll { $0 == name }
        names.append(name)
    }
    return names
}

/// An SGD getvar reply's value: surrounding whitespace and double quotes stripped; `"?"` (unknown
/// variable) and an empty reply are nil. Mirrors parseGetvar in kiosk/src/lib/stationPrinter.ts.
func parseGetvar(_ text: String) -> String? {
    var v = trimmed(text)
    let scalars = v.unicodeScalars
    if scalars.count >= 2, scalars.first == "\"", scalars.last == "\"" {
        v = trimmed(String(scalars.dropFirst().dropLast()))
    }
    return v.isEmpty || v == "?" ? nil : v
}

/// `~HI` over the network, as the laptop edge reads it: the reply must carry an STX frame.
func parseNetworkHostIdentification(_ text: String) -> HostId? {
    text.contains(STX) ? parseHostIdentification(text) : nil
}
