import Foundation

// Keeping secrets out of Settings › Troubleshooting's shared report: a port of Android's
// `redactSecrets`, `maskSecrets` and their helpers (ui/screens/settings/TroubleshootingModel.kt),
// case for case. The masker works on the line's UTF-16 code units, as Kotlin's `Char`s do, so
// every position, run and placeholder lines up with Android's.

/// What a line whose redaction failed becomes in the report: all of it goes.
let REDACTION_FAILED_TEXT = "[redacted: this line couldn't be checked for secrets]"

/// `text` (one line of the report) with secret-looking values masked by `mask` (`maskSecrets`). It
/// fails closed: if masking throws, the whole line is `REDACTION_FAILED_TEXT`, never the line as it
/// was, and never a crash. (Kotlin also catches a stack overflow or a bad index here; in Swift
/// those would trap, so the masker never recurses, and a read outside the line returns 0 and a
/// copy outside it returns nothing, each setting `Units.broken`; `maskSecrets` throws once all its
/// passes are done if any of them broke.)
///
/// A backstop, not the defense: the report is built from what the tab hears, which never includes
/// the app's own secrets (session, cookies, keys, move passwords). This catches the free text that
/// can hold one: what an admin types into the command box, what a printer sends back, and a
/// failure's own words.
func redactSecrets(_ text: String, mask: (String) throws -> String = maskSecrets) -> String {
    do {
        return try mask(text)
    } catch {
        return REDACTION_FAILED_TEXT
    }
}

/// `command` reads a setting whose name says it is a secret (`getvar "wlan.wpa.psk"`): its reply
/// is that secret.
func asksForASecret(_ command: String) -> Bool {
    let ns = command as NSString
    return GETVAR.matches(in: command, range: NSRange(location: 0, length: ns.length))
        .contains { isSecretName(ns.substring(with: $0.range(at: 1))) }
}

/// A reply to a command with `~HS` in it (alone, compound or in a format) with the printer's
/// front-panel password masked (on the tab and in the report).
func withoutPanelPassword(command: String, reply: String) -> String {
    guard command.range(of: ZebraCommands.hostStatus, options: .caseInsensitive) != nil else { return reply }
    return PANEL_PASSWORD.stringByReplacingMatches(in: reply, range: NSRange(location: 0, length: (reply as NSString).length),
                                                   withTemplate: "\u{02}****,$1\u{03}")
}

/// `name` says it is a secret's: it holds a secret word (`SECRET_WORDS`) anywhere, or a short one
/// (`SECRET_PARTS`) as a whole word part (`forEachWordPart`), in its own cases or lowercased (which
/// splits only at non-alphanumerics and letter-digit steps).
func isSecretName(_ name: String) -> Bool { isSecretName(units: Array(name.utf16)) }

// MARK: The masker

/// Words that make a name a secret's wherever they are in it, ignoring case
/// (`wlan.private_key_password`, `apiKey`).
private let SECRET_WORDS = Words([
    "password", "passwd", "passphrase", "psk", "token", "secret", "cookie", "authorization", "community",
    "apikey", "api_key", "api-key", "stationkey", "station_key", "station-key",
    "privatekey", "private_key", "private-key", "sessionid", "session_id", "session-id",
    "sessionkey", "session_key", "session-key", "wepkey", "wep_key", "wep.key", "wep-key",
])

/// Short words that make a name a secret's only as a whole word part (`bluetooth.bluetooth_pin`,
/// `userPin`, `pin2`, `pwd`), never inside another word (`spinning`, `mapping`, `ping`).
private let SECRET_PARTS = Words(["pin", "pwd"])

/// Words to look for in a name, as text and as UTF-16 code units.
private struct Words {
    let text: [String]
    let units: [[UInt16]]

    init(_ words: [String]) {
        text = words
        units = words.map { Array($0.utf16) }
    }
}

private let AUTHORIZATION = Array("authorization".utf16)

// The two token patterns run in linear time on long runs (a pasted ^GFA label, a 64 KB one-line
// reply): BEARER's parts can't overlap, and JWT starts only where a token starts (a one-character
// lookbehind) with possessive segments, which never backtrack. Names and values are found by
// maskSecrets' single scan, with no regex: no length limit, no backtracking, no recursion.
//
// NSRegularExpression is ICU, whose `\s` and `\d` are Unicode; Java's are ASCII. Each pattern here
// takes the wider reading, so it masks wherever Android's would: BEARER's word boundary is spelled
// as ASCII (`\b` in ICU, and in Java before 19, is Unicode, which finds fewer boundaries), and its
// space, GETVAR's and PANEL_PASSWORD's digits stay ICU's (a superset of Java's ASCII ones).
private let BEARER = try! NSRegularExpression(pattern: #"(?i)(?<![A-Za-z0-9_])bearer\s+[A-Za-z0-9._~+/=-]+"#)
private let JWT = try! NSRegularExpression(
    pattern: #"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}+\.[A-Za-z0-9_-]{5,}+\.[A-Za-z0-9_-]{5,}+"#)
private let GETVAR = try! NSRegularExpression(pattern: #"(?i)getvar\s+"([^"]*)""#)
/// `~HS`'s third string: the printer's front-panel password (4 digits), then a flag.
private let PANEL_PASSWORD = try! NSRegularExpression(pattern: #"\u0002\d{4},(\d)\u0003"#)

private let REDACTED = Array("[redacted]".utf16)
private let MASKED_DOUBLE = Array("\"[redacted]\"".utf16)
private let MASKED_SINGLE = Array("'[redacted]'".utf16)
private let MASKED_OBJECT = Array("{[redacted]}".utf16)
private let MASKED_ARRAY = Array("[[redacted]]".utf16)
private let URL_START = Array("://".utf16)

// The code units the masker reads.
private let QUOTE: UInt16 = 0x22 // "
private let APOSTROPHE: UInt16 = 0x27 // '
private let BACKSLASH: UInt16 = 0x5C
private let OPEN_BRACE: UInt16 = 0x7B
private let CLOSE_BRACE: UInt16 = 0x7D
private let OPEN_BRACKET: UInt16 = 0x5B
private let CLOSE_BRACKET: UInt16 = 0x5D
private let COLON: UInt16 = 0x3A
private let EQUALS: UInt16 = 0x3D
private let LESS: UInt16 = 0x3C
private let GREATER: UInt16 = 0x3E
private let LINE_FEED: UInt16 = 0x0A
private let SLASH: UInt16 = 0x2F
private let QUESTION: UInt16 = 0x3F
private let HASH: UInt16 = 0x23
private let AT: UInt16 = 0x40

/// The masker's read failed: the line is replaced whole.
private struct RedactionFailed: Error {}

/// One pass's line, as UTF-16 code units. A read or copy outside it (a bug Kotlin would throw
/// IndexOutOfBoundsException for) reads as 0 and marks it `broken`, and `maskSecrets` then throws,
/// so the whole line goes instead of the app crashing.
private final class Units {
    let units: [UInt16]
    let count: Int
    private(set) var broken = false

    init(_ units: [UInt16]) {
        self.units = units
        count = units.count
    }

    subscript(_ i: Int) -> UInt16 {
        if i >= 0 && i < count { return units[i] }
        broken = true
        return 0
    }

    /// `from..<to`, or nothing (and broken) when that isn't a range of the line.
    func slice(_ from: Int, _ to: Int) -> ArraySlice<UInt16> {
        if from >= 0 && from <= to && to <= count { return units[from..<to] }
        broken = true
        return []
    }
}

/**
 `text` with secrets masked, in linear passes over the line:
 1. bearer tokens and JSON web tokens;
 2. structured values of names that say they are secrets (`isSecretName`): a quoted one whole,
    spaces and all, up to its matching closing quote (a backslash escapes the next character; one
    that never closes runs to the end of the line), and an object or array up to its matching
    close (braces inside strings don't count; one that never closes runs to the end of the text).
    A quoted text masked here may have been a key's name (`pin<09>:"wlan.wpa.psk":x`), or held
    one whose quoted value runs on past the closing quote (`token:<09>"&session_id:"…`), so what
    pairs with it goes too (`maskChain`). An object or array may hold such a key as well
    (`psk={"password:"} …`): the text its value runs on over is noted (`reopenPast`) and masked at
    the end, so that pass 3 still reads the line as it would have;
 3. then their unquoted values, up to a space or a delimiter (so `password: a b c` loses only its
    first word), and anything glued to a masked object's close. After `Authorization`'s scheme
    (`Basic`, `Bearer`), the credential goes too, and a masked value that ends in a separator or
    where one starts takes the next value with it (`maskChain`);
 4. a URL's password (`https://admin:[redacted]@host`), last, so it can't hide a secret's name from
    passes 2 and 3;
 5. the text noted in passes 2 and 3 (`withSpans`).

 Quoted values go first, across the whole line, so an unquoted value masked in pass 3 can't swallow
 the next secret's name and leave its quoted value showing (`Cookie: session_id="…"`). A name is
 each maximal run of name characters, whatever its length. Separators are `=` or `:` (after a JSON
 key's closing quote, with spaces either side) or SGD's `" "`; a control byte shown as `<XX>`
 counts as the space it is when it's a tab or other space, and as part of a value otherwise.
 */
func maskSecrets(_ text: String) throws -> String {
    if text.isEmpty { return text }
    let tokens = replacing(JWT, in: replacing(BEARER, in: text, with: "Bearer [redacted]"), with: "[redacted]")
    var spans: [Int] = []
    let line = Units(Array(tokens.utf16))
    let quoted = Units(maskValues(line, structured: true, &spans))
    let bare = Units(maskValues(quoted, structured: false, &spans))
    let urls = Units(maskUrlPasswords(bare, &spans))
    let masked = withSpans(urls, spans)
    if line.broken || quoted.broken || bare.broken || urls.broken { throw RedactionFailed() }
    return String(decoding: masked, as: UTF16.self)
}

private func replacing(_ regex: NSRegularExpression, in text: String, with template: String) -> String {
    regex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: template)
}

/// One pass's output: `line` with values replaced by placeholders, built in order. It remembers
/// each replacement, so that a position in `line` can be found in the output once the pass is done
/// (`map`): the spans noted in one pass's coordinates follow the line through the next.
private final class Masker {
    private let line: Units
    private var out: [UInt16] = []
    /// Four entries per replacement: from and to in `line`, from and to in the output.
    private var edits: [Int] = []

    init(_ line: Units) {
        self.line = line
        out.reserveCapacity(line.count)
    }

    func copy(_ c: UInt16) { out.append(c) }
    func copy(_ from: Int, _ to: Int) { out.append(contentsOf: line.slice(from, to)) }

    func mask(_ from: Int, _ to: Int, _ placeholder: [UInt16]) {
        edits.append(from)
        edits.append(to)
        edits.append(out.count)
        out.append(contentsOf: placeholder)
        edits.append(out.count)
    }

    /// Where `at` in `line` is in the output: shifted by the replacements before it, or, when the
    /// text it was in was replaced, just after that placeholder.
    private func map(_ at: Int) -> Int {
        var lo = 0
        var hi = edits.count / 4
        while lo < hi {
            let mid = (lo + hi) >> 1
            if edits[mid * 4] <= at { lo = mid + 1 } else { hi = mid }
        }
        if lo == 0 { return at }
        let e = (lo - 1) * 4
        return at < edits[e + 1] ? edits[e + 3] : edits[e + 3] + (at - edits[e + 1])
    }

    /// The output, with `spans` (positions in `line`) moved to its coordinates.
    func finish(_ spans: inout [Int]) -> [UInt16] {
        for k in spans.indices { spans[k] = map(spans[k]) }
        return out
    }
}

/// `line` with each span of `spans` (pairs of start and end, overlapping maybe) replaced by
/// `[redacted]`.
private func withSpans(_ line: Units, _ spans: [Int]) -> [UInt16] {
    if spans.isEmpty { return line.units }
    let starts = stride(from: 0, to: spans.count, by: 2).filter { spans[$0 + 1] > spans[$0] }.sorted { spans[$0] < spans[$1] }
    guard let firstStart = starts.first else { return line.units }
    var out: [UInt16] = []
    out.reserveCapacity(line.count)
    var copied = 0
    var from = spans[firstStart]
    var to = spans[firstStart + 1]
    for k in starts.dropFirst() {
        if spans[k] <= to {
            to = max(to, spans[k + 1])
            continue
        }
        out.append(contentsOf: line.slice(copied, from))
        out.append(contentsOf: REDACTED)
        copied = to
        from = spans[k]
        to = spans[k + 1]
    }
    out.append(contentsOf: line.slice(copied, from))
    out.append(contentsOf: REDACTED)
    out.append(contentsOf: line.slice(to, line.count))
    return out
}

/// One pass over `line`: the structured (quoted, object, array) values of secrets' names when
/// `structured`, else their unquoted values. `spans` (pairs of positions in `line`) are the texts
/// noted so far as masked on top of this; they come out in the output's coordinates, with those
/// noted here.
private func maskValues(_ line: Units, structured: Bool, _ spans: inout [Int]) -> [UInt16] {
    let n = line.count
    let out = Masker(line)
    var i = 0
    while i < n {
        if !isNameChar(line[i]) {
            out.copy(line[i])
            i += 1
            continue
        }
        let nameStart = i
        while i < n && isNameChar(line[i]) { i += 1 }
        out.copy(nameStart, i)
        if !isSecretName(line, nameStart, i) { continue }
        let nameEnd = i
        let valueStart = separatorEnd(line, nameEnd)
        if valueStart < 0 || valueStart >= n { continue }
        let first = line[valueStart]
        if structured {
            let end = structuredEnd(line, valueStart)
            if end < 0 { continue }
            out.copy(nameEnd, valueStart)
            out.mask(valueStart, end, masked(first))
            if first == OPEN_BRACE || first == OPEN_BRACKET {
                // An object or array pairs with nothing itself: what is glued to its close and what
                // follows wait for pass 3, which reads the line with every quoted value masked. But
                // a key inside it may open a quoted value that runs on past its close
                // (`psk={"password:"} x`, `pin=["x","psk="] x`), as a key inside a quoted text may
                // (`token:<09>"&session_id:"x`): that text is noted, and the scan goes on from the
                // close as before, so pass 3 still finds what it would have.
                reopenPast(line, valueStart, end, &spans)
                i = end
            } else {
                // The quoted text is gone now, and it may have been a key's name (`pin<09>:"wlan.wpa.psk":x`)
                // or held one (`token:<09>"&session_id:"…`): the value paired with it goes too.
                i = maskChain(line, out, valueStart, end, &spans)
            }
        } else {
            // Quoted values went in pass 2; an object or array (masked then) also takes
            // anything glued to its close (`{[redacted]}x`), as an unquoted value would, but not a
            // parent's closing braces (`{"tokens":["x"]}` keeps its last `}`).
            if first == QUOTE || first == APOSTROPHE { continue }
            var end = bareEnd(line, valueStart)
            if end < 0 { continue }
            if first == OPEN_BRACE || first == OPEN_BRACKET { end = beforeClosers(line, valueStart + masked(first).count, end) }
            out.copy(nameEnd, valueStart)
            out.mask(valueStart, end, masked(first))
            i = end
            // After `Authorization: Basic` (or `Bearer`), the credential is the next word.
            if containsIgnoringCase(line, nameStart, nameEnd, AUTHORIZATION) {
                let next = skipSpaces(line, end)
                let credentialEnd = next > end && next < n ? bareEnd(line, next) : -1
                if credentialEnd > 0 {
                    out.copy(end, next)
                    out.mask(next, credentialEnd, REDACTED)
                    i = credentialEnd
                }
            }
            i = maskChain(line, out, valueStart, i, &spans, showClosers: true)
        }
    }
    return out.finish(&spans)
}

/**
 Masks on from the value just masked at `start` until `end`, whatever its text was hiding, and
 then from each value masked here, the same way. Returns where the masking stopped.
 - A quoted text may hold a key and separator whose own quoted value opens at its closing quote
   (`"&session_id:"c…`) or at a quote of the other kind inside it that never closes there
   (`'a token="b'c…`): that value runs on past the mask, so the mask runs on to its end
   (`reopenedQuote`). Else the text may have been a key's name (`"wlan.wpa.psk" c`, `"psk":c`),
   and the value paired with it goes (`keyValueStart`).
 - An unquoted value that ends in a separator or where one starts (`pin=key= c`, `pin:api_key":c`)
   held the next name, so that name's value goes, whatever the name was. When that name is
   `Authorization`'s (`pin:"a":Authorization: Basic cred`), its scheme's credential goes too, as
   it does when the scan finds the name (`credentialAfter`).
 - An object or array masked here also takes anything glued to its close, as a value in pass 3
   does: a name inside it may pair with a value running past the close. In pass 3
   (`showClosers`) a parent's closing braces glued there (`{"pin":a: {"c":1}}`) are shown, and
   the chain looks on from after them; pass 2 hides them as before, since pass 3 reads its output
   for structure, and a brace shown there could close an object early.
   A key inside it may open a quoted value running on past the close too: that text is noted
   (`reopenPast`) and the chain reads on from the close as before.
 */
private func maskChain(_ line: Units, _ out: Masker, _ start: Int, _ end: Int, _ spans: inout [Int],
                       showClosers: Bool = false) -> Int {
    let n = line.count
    var s = start
    var i = end
    var credential = credentialAfter(line, s, i)
    while true {
        let first = line[s]
        let quoted = first == QUOTE || first == APOSTROPHE
        let closedQuote = quoted && i - s > 1 && line[i - 1] == first
        if closedQuote {
            let reopened = reopenedQuote(line, s, i)
            let reopenedEnd = reopened < 0 ? -1 : quotedEnd(line, reopened)
            if reopenedEnd > i {
                out.mask(i, reopenedEnd, REDACTED)
                s = reopened
                i = reopenedEnd
                continue
            }
        } else if (first == OPEN_BRACE || first == OPEN_BRACKET) && i < n {
            reopenPast(line, s, i, &spans)
        }
        // A quoted value that never closed ends at its line break, maybe after spaces: what pairs
        // on is what comes before them (`'wlan.wpa.psk"  ⏎ x`, `'a psk= ⏎ x`), across the break.
        let k = spacesBack(line, i)
        let next: Int
        if closedQuote || line[k - 1] == QUOTE {
            next = keyValueStart(line, k)
        } else if line[k - 1] == COLON || line[k - 1] == EQUALS {
            next = skipSpaces(line, i)
        } else {
            next = separatorEnd(line, i)
        }
        // The credential follows `Authorization`'s scheme when nothing else pairs with it: the
        // next word is noted as masked, and the scan goes on from here as before.
        var credentialDue = false
        if credential > 0 {
            credential -= 1
            credentialDue = credential == 0
        }
        if next < 0 && credentialDue && !quoted {
            let word = skipSpaces(line, i)
            let wordEnd = word > i && word < n ? bareEnd(line, word) : -1
            if wordEnd > 0 {
                spans.append(word)
                spans.append(wordEnd)
            }
        }
        if next < 0 || next >= n { break }
        let structuredNext = structuredEnd(line, next)
        var nextEnd = max(structuredNext, bareEnd(line, next))
        if nextEnd < 0 { break }
        out.copy(i, next)
        if line[next] == OPEN_BRACE || line[next] == OPEN_BRACKET {
            nextEnd = max(nextEnd, bareEnd(line, nextEnd))
            let shown = showClosers ? beforeClosers(line, structuredNext, nextEnd) : nextEnd
            out.mask(next, shown, masked(line[next]))
            out.copy(shown, nextEnd)
        } else {
            out.mask(next, nextEnd, masked(line[next]))
        }
        let due = credentialAfter(line, next, nextEnd)
        if due > 0 { credential = due }
        s = next
        i = nextEnd
    }
    return i
}

/// When a key and separator inside the object or array at `start` until `end` open a quoted value
/// of their own that runs on past the close (`reopenedQuote`), notes the text from `end` to that
/// value's end in `spans`: it is masked at the end, on top of whatever the passes make of it, so
/// that they still read the line as if the value had closed where it did (pass 3 pairs what
/// follows the close, and finds the names after it, as before).
private func reopenPast(_ line: Units, _ start: Int, _ end: Int, _ spans: inout [Int]) {
    let reopened = reopenedQuote(line, start, end)
    if reopened < 0 { return }
    spans.append(end)
    spans.append(quotedEnd(line, reopened))
}

/// Where the text glued to a masked object or array, from `from` until `to`, ends once a parent's
/// closing braces at its end are left out (`{"tokens":["x"]}` keeps its last `}`).
private func beforeClosers(_ line: Units, _ from: Int, _ to: Int) -> Int {
    var end = to
    while end > from && (line[end - 1] == CLOSE_BRACE || line[end - 1] == CLOSE_BRACKET) { end -= 1 }
    return end
}

/// When the value at `at` until `end`, masked in a chain, is an `…authorization` name and its
/// separator (`Authorization:`, `Authorization=Basic`), or a quoted one with a `:` or `=` after its
/// closing quote (`"Authorization": Basic`, `'Authorization'=Basic`), how many values along the
/// chain its credential follows: 1 when its scheme is in this value, 2 when the scheme is the next
/// value. 0 for any other value (an object or array, a quoted text with no separator after it).
private func credentialAfter(_ line: Units, _ at: Int, _ end: Int) -> Int {
    let first = line[at]
    if first == OPEN_BRACE || first == OPEN_BRACKET { return 0 }
    let valueStart: Int
    if first == QUOTE || first == APOSTROPHE {
        // The name is the quoted text (read once, within this value): a separator must follow the
        // closing quote, as it must an unquoted name.
        let close = quotedEnd(line, at)
        if close > end || close - at < 3 || line[close - 1] != first { return 0 }
        if !containsIgnoringCase(line, at + 1, close - 1, AUTHORIZATION) { return 0 }
        let j = skipSpaces(line, close)
        if j >= line.count || (line[j] != COLON && line[j] != EQUALS) { return 0 }
        valueStart = skipSpaces(line, j + 1)
    } else {
        var nameEnd = at
        while nameEnd < end && isNameChar(line[nameEnd]) { nameEnd += 1 }
        if !containsIgnoringCase(line, at, nameEnd, AUTHORIZATION) { return 0 }
        valueStart = separatorEnd(line, nameEnd)
    }
    if valueStart < 0 { return 0 }
    return valueStart < end ? 1 : 2
}

/// In the structured value at `start` until `end` (quoted, object or array, closed, with text glued
/// to its close maybe), the quote at which a key and separator inside it (`keyEndsBefore`) open a
/// quoted value of their own that runs on past `end`; -1 when there is none. Only the last
/// unescaped quote of each kind can: an earlier one's value closes at the later quote. For a quoted
/// value that is its own closing quote (`"&session_id:"`) or the last quote of the other kind inside
/// it (`'a token="b'`); for an object or array the last of either kind (`{"password:"}`,
/// `['pin=']`). When both run on, the one that runs further wins.
private func reopenedQuote(_ line: Units, _ start: Int, _ end: Int) -> Int {
    var lastDouble = -1
    var lastSingle = -1
    var i = start + 1
    while i < end {
        let c = line[i]
        if c == BACKSLASH {
            i += 1
        } else if c == QUOTE {
            lastDouble = i
        } else if c == APOSTROPHE {
            lastSingle = i
        }
        i += 1
    }
    var reopened = -1
    var reopenedEnd = end
    for quote in [lastDouble, lastSingle] {
        if quote < 0 || !keyEndsBefore(line, quote) { continue }
        let valueEnd = quotedEnd(line, quote)
        if valueEnd > reopenedEnd {
            reopened = quote
            reopenedEnd = valueEnd
        }
    }
    return reopened
}

/// A key's name and its separator end just before `at`: a secret's name, then `:` or `=` with
/// spaces either side (after the name's closing quote, maybe), or the name's closing quote and SGD's
/// spaces.
private func keyEndsBefore(_ line: Units, _ at: Int) -> Bool {
    var k = spacesBack(line, at)
    if k > 0 && (line[k - 1] == COLON || line[k - 1] == EQUALS) {
        k = spacesBack(line, k - 1)
        if k > 0 && line[k - 1] == QUOTE { k -= 1 }
    } else if k >= 1 && k < at && line[k - 1] == QUOTE {
        k -= 1
    } else {
        return false
    }
    return isSecretName(line, trailingNameStart(line, k), k)
}

/// Where the value paired with the quoted text ending at `end` (its closing quote at `end - 1`)
/// starts, when that text was a key's name: after `:` or `=` with spaces either side (`"key": v`),
/// or after SGD's spaces when the text ends in a secret's name (`"wlan.wpa.psk" v`; `"a b c" next`
/// is no key, and `next` stays). -1 when it was no key.
private func keyValueStart(_ line: Units, _ end: Int) -> Int {
    let j = skipSpaces(line, end)
    if j < line.count && (line[j] == COLON || line[j] == EQUALS) { return skipSpaces(line, j + 1) }
    if j > end && line[end - 1] == QUOTE && isSecretName(line, trailingNameStart(line, end - 1), end - 1) { return j }
    return -1
}

/// Where the run of name characters ending just before `before` starts (`before` when there is none).
private func trailingNameStart(_ line: Units, _ before: Int) -> Int {
    var start = before
    while start > 0 && isNameChar(line[start - 1]) { start -= 1 }
    return start
}

/// Where the run of spaces ending just before `before` starts (`<09>`…`<0D>` included); `before`
/// itself when there is none.
private func spacesBack(_ line: Units, _ before: Int) -> Int {
    var k = before
    while k > 0 {
        if isSpaceChar(line[k - 1]) {
            k -= 1
        } else if k >= 4 && line[k - 1] == GREATER && isSpaceEscape(escapeAt(line, k - 4)) {
            k -= 4
        } else {
            return k
        }
    }
    return k
}

/// Just after the quoted, object or array value starting at `start`; -1 when it is none of those.
private func structuredEnd(_ line: Units, _ start: Int) -> Int {
    switch line[start] {
    case QUOTE, APOSTROPHE: quotedEnd(line, start)
    case OPEN_BRACE, OPEN_BRACKET: bracketEnd(line, start)
    default: -1
    }
}

/// What replaces a value that starts with `first`: `"[redacted]"`, `{[redacted]}`, `[[redacted]]`,
/// or `[redacted]`.
private func masked(_ first: UInt16) -> [UInt16] {
    switch first {
    case QUOTE: MASKED_DOUBLE
    case APOSTROPHE: MASKED_SINGLE
    case OPEN_BRACE: MASKED_OBJECT
    case OPEN_BRACKET: MASKED_ARRAY
    default: REDACTED
    }
}

/// Where the separator after a name ending at `nameEnd` ends (where the value starts): `=` or `:`,
/// maybe after a JSON key's closing quote, with spaces either side; or SGD's `"` and spaces. -1 when
/// there is none.
private func separatorEnd(_ line: Units, _ nameEnd: Int) -> Int {
    let n = line.count
    let keyQuote = nameEnd < n && line[nameEnd] == QUOTE
    let afterQuote = keyQuote ? nameEnd + 1 : nameEnd
    let j = skipSpaces(line, afterQuote)
    if j < n && (line[j] == COLON || line[j] == EQUALS) { return skipSpaces(line, j + 1) }
    if keyQuote && j > afterQuote { return j }
    return -1
}

private func skipSpaces(_ line: Units, _ from: Int) -> Int {
    var j = from
    while j < line.count {
        let step = spaceAt(line, j)
        if step == 0 { break }
        j += step
    }
    return j
}

/// How many characters of space start at `i`: 1 for a space, tab or line break; 4 for one shown as
/// `<09>`…`<0D>`; else 0.
private func spaceAt(_ line: Units, _ i: Int) -> Int {
    if isSpaceChar(line[i]) { return 1 }
    return isSpaceEscape(escapeAt(line, i)) ? 4 : 0
}

private func isSpaceChar(_ c: UInt16) -> Bool {
    c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D || c == 0x0B || c == 0x0C
}

/// An escape's byte (`escapeAt`) is a tab or other space: 0x09 to 0x0D.
private func isSpaceEscape(_ byte: Int) -> Bool { byte >= 0x09 && byte <= 0x0D }

/// The control byte shown as `<XX>` at `i` (two hex digits), or -1.
private func escapeAt(_ line: Units, _ i: Int) -> Int {
    if i + 3 >= line.count || line[i] != LESS || line[i + 3] != GREATER { return -1 }
    let hi = hexDigit(line[i + 1])
    let lo = hexDigit(line[i + 2])
    return hi < 0 || lo < 0 ? -1 : hi * 16 + lo
}

/// `c`'s value as a hex digit, as Java's `Character.digit(c, 16)` reads it (any Unicode decimal
/// digit, and the ASCII and fullwidth letters A to F); -1 when it is none.
private func hexDigit(_ c: UInt16) -> Int {
    switch c {
    case 0x30...0x39: return Int(c - 0x30)
    case 0x41...0x46: return Int(c - 0x41) + 10
    case 0x61...0x66: return Int(c - 0x61) + 10
    case 0xFF21...0xFF26: return Int(c - 0xFF21) + 10
    case 0xFF41...0xFF46: return Int(c - 0xFF41) + 10
    case 0..<0x80: return -1
    default:
        guard let scalar = Unicode.Scalar(c), scalar.properties.generalCategory == .decimalNumber,
              let value = scalar.properties.numericValue else { return -1 }
        return Int(value)
    }
}

/// Just after the quoted value starting at `start` (its matching closing quote; a backslash escapes
/// the next character), or at the end of the line when it never closes.
private func quotedEnd(_ line: Units, _ start: Int) -> Int {
    let n = line.count
    let quote = line[start]
    var i = start + 1
    while i < n {
        let c = line[i]
        if c == LINE_FEED { return i }
        if c == BACKSLASH {
            if i + 1 < n && line[i + 1] != LINE_FEED { i += 2 } else { return i + 1 }
        } else if c == quote {
            return i + 1
        } else {
            i += 1
        }
    }
    return n
}

/// Just after the object or array starting at `start` (its matching close; strings, double or
/// single quoted, are skipped whole), or at the end of the text when it never closes: not at a line
/// break, which would leave a name inside it paired with a value on the next line.
private func bracketEnd(_ line: Units, _ start: Int) -> Int {
    let n = line.count
    let open = line[start]
    let close = open == OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET
    var depth = 0
    var i = start
    while i < n {
        let c = line[i]
        if c == QUOTE || c == APOSTROPHE {
            i = quotedEnd(line, i)
            continue
        }
        if c == open {
            depth += 1
        } else if c == close {
            depth -= 1
            if depth == 0 { return i + 1 }
        }
        i += 1
    }
    return n
}

/// Just after the unquoted value starting at `start`: at a space (`<09>` and the like included) or
/// a delimiter; any other control byte shown as `<XX>` is part of it. -1 when there is none.
private func bareEnd(_ line: Units, _ start: Int) -> Int {
    let n = line.count
    var i = start
    while i < n {
        if spaceAt(line, i) > 0 { break }
        if escapeAt(line, i) >= 0 {
            i += 4
            continue
        }
        if isBareValueEnd(line[i]) { break }
        i += 1
    }
    return i > start ? i : -1
}

/// An unquoted value ends at a space or one of these: `"';,&␍␊␂␃<>`.
private func isBareValueEnd(_ c: UInt16) -> Bool {
    c == QUOTE || c == APOSTROPHE || c == 0x3B /* ; */ || c == 0x2C /* , */ || c == 0x26 /* & */ || c == LESS || c == GREATER
        || c == 0x240D /* ␍ */ || c == 0x240A /* ␊ */ || c == 0x2402 /* ␂ */ || c == 0x2403 /* ␃ */
}

/// A URL's password masked: `scheme://user:password@host` keeps the user and host. Each URL's
/// authority is read once, so it stays linear. `spans` follow the line through, as in `maskValues`.
private func maskUrlPasswords(_ line: Units, _ spans: inout [Int]) -> [UInt16] {
    var at = indexOf(line, URL_START, from: 0)
    if at < 0 { return line.units }
    let out = Masker(line)
    var copied = 0
    while at >= 0 {
        let start = at + 3
        var end = start
        var lastAt = -1
        var firstColon = -1
        while end < line.count {
            let c = line[end]
            if c == SLASH || c == QUESTION || c == HASH || c == QUOTE || c == APOSTROPHE || c == LESS || c == GREATER
                || spaceAt(line, end) > 0 { break }
            if c == AT { lastAt = end }
            if c == COLON && firstColon < 0 { firstColon = end }
            end += 1
        }
        if lastAt > 0 && firstColon >= start && firstColon < lastAt - 1 {
            out.copy(copied, firstColon + 1)
            out.mask(firstColon + 1, lastAt, REDACTED)
            copied = lastAt
        }
        // The next `://` can begin at the last character read as this authority's: the `:` of
        // `https://` in `http://h,https://u:p@h`.
        at = indexOf(line, URL_START, from: max(end - 1, start))
    }
    out.copy(copied, line.count)
    return out.finish(&spans)
}

/// Where `needle` first appears in `line` at or after `from`; -1 when it doesn't.
private func indexOf(_ line: Units, _ needle: [UInt16], from: Int) -> Int {
    let last = line.count - needle.count
    var i = max(from, 0)
    while i <= last {
        var k = 0
        while k < needle.count && line[i + k] == needle[k] { k += 1 }
        if k == needle.count { return i }
        i += 1
    }
    return -1
}

/// The characters names are made of (an SGD setting, a JSON key, a query parameter).
private func isNameChar(_ c: UInt16) -> Bool {
    (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39) || c == 0x5F || c == 0x2E || c == 0x2D
}

// MARK: Secrets' names

/// The name at `from..<to` in `line` says it is a secret's (see `isSecretName(_:)`). A short one
/// (most are) is read where it is, lowercased as it goes (a name the masker finds is ASCII,
/// `isNameChar`), and its word parts only when `pin` or `pwd` is in it at all.
private func isSecretName(_ line: Units, _ from: Int, _ to: Int) -> Bool {
    // Shorter than every word and part (`psk`, `pin`): it can hold none of them.
    if to - from < SHORTEST_WORD { return false }
    if to - from <= SHORT_NAME {
        for word in SECRET_WORDS.units where holdsLowercased(line, from, to, word) { return true }
        var holdsPart = false
        for part in SECRET_PARTS.units where holdsLowercased(line, from, to, part) { holdsPart = true }
        if !holdsPart { return false }
    }
    return isSecretName(units: Array(line.slice(from, to)))
}

private let SHORTEST_WORD = (SECRET_WORDS.units + SECRET_PARTS.units).map(\.count).min() ?? 0

/// `line[from..<to]` (ASCII), lowercased, holds `word`.
private func holdsLowercased(_ line: Units, _ from: Int, _ to: Int, _ word: [UInt16]) -> Bool {
    let last = to - word.count
    var i = from
    while i <= last {
        var k = 0
        while k < word.count {
            let c = line[i + k]
            if (isAsciiUpper(c) ? c + 0x20 : c) != word[k] { break }
            k += 1
        }
        if k == word.count { return true }
        i += 1
    }
    return false
}

/// `name` (its UTF-16 code units) says it is a secret's (see `isSecretName(_:)`).
private func isSecretName(units name: [UInt16]) -> Bool {
    let lower = lowercased(name)
    if holdsAny(lower, SECRET_WORDS) { return true }
    // A part that is `pin` or `pwd`, in whatever cases, shows in the lowercased name too: only then
    // are the parts read.
    if !holdsAny(lower, SECRET_PARTS) { return false }
    // In the name's own cases, each part lowercased (`userPin`), and in any mix of cases (`pIn`,
    // `PiN`): the lowercased name split only where case can't matter.
    var found = false
    forEachWordPart(name, 0, name.count) { found = isSecretPart(name, $0, $1, lowercasing: true); return found }
    if found { return true }
    forEachWordPart(lower, 0, lower.count) { found = isSecretPart(lower, $0, $1, lowercasing: false); return found }
    return found
}

/// A name is short past this many code units (a 100 KB run of hex, or a quoted value read back as
/// a key's name, is long): a long one is lowercased and searched by Foundation, which stays quick
/// on it where this file's own loops, unoptimized in a debug build, do not.
private let SHORT_NAME = 256

/// `name` lowercased as Kotlin's `lowercase(Locale.ROOT)` does: Unicode's case mapping, no
/// language's rules. A name the masker finds is ASCII (`isNameChar`).
private func lowercased(_ name: [UInt16]) -> [UInt16] {
    if name.count <= SHORT_NAME && name.allSatisfy({ $0 < 0x80 }) {
        return name.map { isAsciiUpper($0) ? $0 + 0x20 : $0 }
    }
    let lower = NSString(characters: name, length: name.count).lowercased as NSString
    var units = [UInt16](repeating: 0, count: lower.length)
    lower.getCharacters(&units, range: NSRange(location: 0, length: lower.length))
    return units
}

/// `text` holds one of `words`, code unit for code unit.
private func holdsAny(_ text: [UInt16], _ words: Words) -> Bool {
    if text.count <= SHORT_NAME { return words.units.contains { contains(text, $0) } }
    let long = NSString(characters: text, length: text.count)
    return words.text.contains { long.range(of: $0, options: .literal).location != NSNotFound }
}

/// `name[from..<to]` (ASCII letters and digits) is `pin` or `pwd`, lowercased first when `lowercasing`.
private func isSecretPart(_ name: [UInt16], _ from: Int, _ to: Int, lowercasing: Bool) -> Bool {
    guard to - from == 3 else { return false }
    return SECRET_PARTS.units.contains { part in
        (0..<3).allSatisfy { k in
            let c = name[from + k]
            return (lowercasing && c >= 0x41 && c <= 0x5A ? c + 0x20 : c) == part[k]
        }
    }
}

/// Calls `part` with the range of each of `name[from..<to]`'s word parts (Android's `wordParts`),
/// stopping once it returns true. A part is split at anything that isn't a letter or digit, at a
/// lowercase-to-uppercase step (`userPin`), before an acronym's last capital when lowercase follows
/// (`PINCode`), and between letters and digits (`pin2`).
private func forEachWordPart(_ name: [UInt16], _ from: Int, _ to: Int, _ part: (Int, Int) -> Bool) {
    var start = -1
    var i = from
    while i < to {
        let c = name[i]
        if !isAsciiLetterOrDigit(c) {
            if start >= 0 && part(start, i) { return }
            start = -1
            i += 1
            continue
        }
        if start < 0 {
            start = i
            i += 1
            continue
        }
        let before = name[i - 1]
        let split = (isAsciiLower(before) && isAsciiUpper(c))
            || (isAsciiDigit(before) != isAsciiDigit(c))
            || (isAsciiUpper(before) && isAsciiUpper(c) && i + 1 < to && isLowercase(name[i + 1]))
        if split {
            if part(start, i) { return }
            start = i
        }
        i += 1
    }
    if start >= 0 { _ = part(start, to) }
}

private func isAsciiLetterOrDigit(_ c: UInt16) -> Bool { isAsciiLower(c) || isAsciiUpper(c) || isAsciiDigit(c) }
private func isAsciiLower(_ c: UInt16) -> Bool { c >= 0x61 && c <= 0x7A }
private func isAsciiUpper(_ c: UInt16) -> Bool { c >= 0x41 && c <= 0x5A }
private func isAsciiDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }

/// `c` is a lowercase letter, as Kotlin's `Char.isLowerCase()` reads it (any script).
private func isLowercase(_ c: UInt16) -> Bool {
    if c < 0x80 { return isAsciiLower(c) }
    return Unicode.Scalar(c)?.properties.isLowercase ?? false
}

/// `haystack` holds `needle` (code unit for code unit).
private func contains(_ haystack: [UInt16], _ needle: [UInt16]) -> Bool {
    let last = haystack.count - needle.count
    if last < 0 { return false }
    var i = 0
    while i <= last {
        var k = 0
        while k < needle.count && haystack[i + k] == needle[k] { k += 1 }
        if k == needle.count { return true }
        i += 1
    }
    return false
}

/// `line[from..<to]` holds `needle` (ASCII lowercase) ignoring case, as Kotlin's
/// `contains(…, ignoreCase = true)` compares: each character folded to the ASCII letter its case
/// maps to (`İ` and `ı` are `i`, `K` (Kelvin) `k`, `ſ` `s`).
private func containsIgnoringCase(_ line: Units, _ from: Int, _ to: Int, _ needle: [UInt16]) -> Bool {
    let last = to - needle.count
    var i = from
    while i <= last {
        var k = 0
        while k < needle.count && foldedToAscii(line[i + k]) == needle[k] { k += 1 }
        if k == needle.count { return true }
        i += 1
    }
    return false
}

private func foldedToAscii(_ c: UInt16) -> UInt16 {
    if c < 0x80 { return isAsciiUpper(c) ? c + 0x20 : c }
    if c == 0x130 || c == 0x131 { return 0x69 } // İ ı
    if c == 0x212A { return 0x6B } // Kelvin sign
    if c == 0x17F { return 0x73 } // long s
    return c
}
