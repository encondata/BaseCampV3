import Foundation

/// Reads members of a JSON object as the exact text the server sent, never
/// re-serialized: the label generator must see `12.0`, `1e-05` and `7` as
/// written (Android keeps kotlinx's literal text for the same reason). A pure
/// scanner over the UTF-8 bytes that honors strings and their escapes.
enum RawJson {
    struct Malformed: Error, Equatable, Sendable {
        /// The byte offset where scanning stopped.
        let offset: Int
    }

    /// Each element's raw text from the top-level object's array member `key`,
    /// in order. Empty when the member is absent, `null` or not an array.
    static func arrayElements(of text: String, key: String) throws -> [String] {
        let bytes = Array(text.utf8)
        var scanner = Scanner(bytes: bytes)
        guard let range = try scanner.topLevelMember(key), bytes[range.lowerBound] == UInt8(ascii: "[") else { return [] }
        var inner = Scanner(bytes: bytes, at: range.lowerBound + 1)
        var elements: [String] = []
        inner.skipWhitespace()
        if inner.peek == UInt8(ascii: "]") { return [] }
        while true {
            inner.skipWhitespace()
            let start = inner.index
            try inner.skipValue()
            elements.append(String(decoding: bytes[start..<inner.index], as: UTF8.self))
            inner.skipWhitespace()
            switch inner.peek {
            case UInt8(ascii: ","): inner.index += 1
            case UInt8(ascii: "]"): return elements
            default: throw Malformed(offset: inner.index)
            }
        }
    }

    /// The raw text of the top-level object's member `key`; nil when absent or `null`.
    static func member(of text: String, key: String) throws -> String? {
        let bytes = Array(text.utf8)
        var scanner = Scanner(bytes: bytes)
        guard let range = try scanner.topLevelMember(key) else { return nil }
        let raw = String(decoding: bytes[range], as: UTF8.self)
        return raw == "null" ? nil : raw
    }

    private struct Scanner {
        let bytes: [UInt8]
        var index: Int

        init(bytes: [UInt8], at index: Int = 0) {
            self.bytes = bytes
            self.index = index
        }

        var peek: UInt8? { index < bytes.count ? bytes[index] : nil }

        mutating func skipWhitespace() {
            while let b = peek, b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D { index += 1 }
        }

        mutating func expect(_ ascii: Unicode.Scalar) throws {
            guard peek == UInt8(ascii: ascii) else { throw Malformed(offset: index) }
            index += 1
        }

        /// Scans the whole top-level object (so a malformed body always throws)
        /// and returns the byte range of member `key`'s value; the last one wins
        /// when a key repeats, as with JSONDecoder.
        mutating func topLevelMember(_ key: String) throws -> Range<Int>? {
            skipWhitespace()
            try expect("{")
            var found: Range<Int>?
            skipWhitespace()
            if peek == UInt8(ascii: "}") {
                index += 1
            } else {
                while true {
                    skipWhitespace()
                    let name = try readString()
                    skipWhitespace()
                    try expect(":")
                    skipWhitespace()
                    let start = index
                    try skipValue()
                    if name == key { found = start..<index }
                    skipWhitespace()
                    if peek == UInt8(ascii: ",") { index += 1; continue }
                    try expect("}")
                    break
                }
            }
            skipWhitespace()
            guard index == bytes.count else { throw Malformed(offset: index) }
            return found
        }

        /// Skips one value of any kind, leaving `index` just past it.
        mutating func skipValue() throws {
            guard let b = peek else { throw Malformed(offset: index) }
            switch b {
            case UInt8(ascii: "{"):
                index += 1
                skipWhitespace()
                if peek == UInt8(ascii: "}") { index += 1; return }
                while true {
                    skipWhitespace()
                    try skipString()
                    skipWhitespace()
                    try expect(":")
                    skipWhitespace()
                    try skipValue()
                    skipWhitespace()
                    if peek == UInt8(ascii: ",") { index += 1; continue }
                    try expect("}")
                    return
                }
            case UInt8(ascii: "["):
                index += 1
                skipWhitespace()
                if peek == UInt8(ascii: "]") { index += 1; return }
                while true {
                    skipWhitespace()
                    try skipValue()
                    skipWhitespace()
                    if peek == UInt8(ascii: ",") { index += 1; continue }
                    try expect("]")
                    return
                }
            case UInt8(ascii: "\""):
                try skipString()
            case UInt8(ascii: "t"): try literal("true")
            case UInt8(ascii: "f"): try literal("false")
            case UInt8(ascii: "n"): try literal("null")
            default:
                try skipNumber()
            }
        }

        mutating func literal(_ word: String) throws {
            for scalar in word.utf8 {
                guard peek == scalar else { throw Malformed(offset: index) }
                index += 1
            }
        }

        /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`
        mutating func skipNumber() throws {
            func isDigit(_ b: UInt8?) -> Bool { b.map { $0 >= 0x30 && $0 <= 0x39 } ?? false }
            if peek == UInt8(ascii: "-") { index += 1 }
            if peek == UInt8(ascii: "0") {
                index += 1
            } else {
                guard isDigit(peek) else { throw Malformed(offset: index) }
                while isDigit(peek) { index += 1 }
            }
            if peek == UInt8(ascii: ".") {
                index += 1
                guard isDigit(peek) else { throw Malformed(offset: index) }
                while isDigit(peek) { index += 1 }
            }
            if peek == UInt8(ascii: "e") || peek == UInt8(ascii: "E") {
                index += 1
                if peek == UInt8(ascii: "+") || peek == UInt8(ascii: "-") { index += 1 }
                guard isDigit(peek) else { throw Malformed(offset: index) }
                while isDigit(peek) { index += 1 }
            }
        }

        /// Skips a string, honoring escapes (an escaped quote never ends it).
        mutating func skipString() throws {
            try expect("\"")
            while let b = peek {
                index += 1
                switch b {
                case UInt8(ascii: "\""): return
                case UInt8(ascii: "\\"):
                    guard let e = peek else { throw Malformed(offset: index) }
                    index += 1
                    if e == UInt8(ascii: "u") {
                        for _ in 0..<4 {
                            guard let h = peek, Self.hexValue(h) != nil else { throw Malformed(offset: index) }
                            index += 1
                        }
                    } else if !"\"\\/bfnrt".utf8.contains(e) {
                        throw Malformed(offset: index - 1)
                    }
                case 0x00..<0x20:
                    throw Malformed(offset: index - 1)   // a raw control character
                default:
                    break
                }
            }
            throw Malformed(offset: index)
        }

        /// A member name, unescaped, to compare with the key asked for.
        mutating func readString() throws -> String {
            let start = index
            try skipString()
            let body = bytes[(start + 1)..<(index - 1)]
            guard body.contains(UInt8(ascii: "\\")) else { return String(decoding: body, as: UTF8.self) }
            var units: [UInt16] = []
            var i = body.startIndex
            while i < body.endIndex {
                let b = body[i]
                if b != UInt8(ascii: "\\") {
                    // Copy the UTF-8 run up to the next escape as UTF-16.
                    var j = i
                    while j < body.endIndex, body[j] != UInt8(ascii: "\\") { j += 1 }
                    units.append(contentsOf: String(decoding: body[i..<j], as: UTF8.self).utf16)
                    i = j
                    continue
                }
                let e = body[i + 1]
                i += 2
                switch e {
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "u"):
                    var value: UInt16 = 0
                    for k in 0..<4 { value = value << 4 | UInt16(Self.hexValue(body[i + k]) ?? 0) }
                    units.append(value)
                    i += 4
                default: units.append(UInt16(e))   // \" \\ \/
                }
            }
            return String(decoding: units, as: UTF16.self)
        }

        static func hexValue(_ b: UInt8) -> UInt8? {
            switch b {
            case 0x30...0x39: return b - 0x30
            case 0x41...0x46: return b - 0x41 + 10
            case 0x61...0x66: return b - 0x61 + 10
            default: return nil
            }
        }
    }
}
