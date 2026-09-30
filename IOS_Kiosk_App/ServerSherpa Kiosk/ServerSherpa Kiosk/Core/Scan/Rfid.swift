import Foundation

/// The house RFID format: 24 characters, zero-padded on the left. The
/// server normalizes independently (`normalize_rfid` in routes/kiosk.py);
/// the kiosk pads so the operator sees what will be stored.
let RFID_LENGTH = 24

enum RfidProblem: Sendable { case empty, notAlphanumeric, tooLong }

struct PaddedRfid: Equatable, Sendable {
    var tag: String?
    var problem: RfidProblem?
}

func padRfid(_ raw: String) -> PaddedRfid {
    let tag = raw.split(whereSeparator: { $0.isWhitespace }).joined().uppercased()
    if tag.isEmpty { return PaddedRfid(tag: nil, problem: .empty) }
    // ASCII [0-9A-Z] only, exactly as the Android regex.
    if !tag.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) }) {
        return PaddedRfid(tag: nil, problem: .notAlphanumeric)
    }
    if tag.count > RFID_LENGTH { return PaddedRfid(tag: nil, problem: .tooLong) }
    return PaddedRfid(tag: String(repeating: "0", count: RFID_LENGTH - tag.count) + tag, problem: nil)
}

func rfidProblemText(_ problem: RfidProblem) -> String {
    switch problem {
    case .empty: return "Scan the RFID tag."
    case .tooLong: return "That tag is longer than \(RFID_LENGTH) characters."
    case .notAlphanumeric: return "That tag has characters we can't store — letters and numbers only."
    }
}

/// portal/src/lib/format.ts: leading zeros stripped for display; a
/// missing tag renders as an em dash.
func displayRfid(_ tag: String?) -> String {
    guard let tag, !tag.isEmpty else { return "—" }
    var chars = Substring(tag)
    while chars.count > 1, chars.first == "0" { chars = chars.dropFirst() }
    return String(chars)
}
