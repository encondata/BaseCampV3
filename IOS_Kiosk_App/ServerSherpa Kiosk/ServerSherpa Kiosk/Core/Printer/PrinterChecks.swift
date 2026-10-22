import Foundation

// Mirrors Android's core/printer/PrinterChecks.kt.

/// What a `~HS` reply says to fix before printing: paper, head, pause. The words are the web
/// kiosk's (statusProblems in kiosk/src/lib/stationPrinter.ts).
func statusProblems(_ status: HostStatus) -> [String] {
    var problems: [String] = []
    if status.paperOut { problems.append("Paper out: load labels.") }
    if status.headOpen { problems.append("Head open: close the print head.") }
    if status.paused { problems.append("Paused: press Pause on the printer to resume.") }
    return problems
}

/// The `needed` fonts (upper-case printer object names) that aren't among the printer's
/// `onPrinter` objects, in `needed`'s order. A resident font counts too: it must be there, it is
/// just never installed (see `fontFixFor`).
func missingFonts(needed: [String], onPrinter: [String]) -> [String] {
    let present = Set(onPrinter.map { $0.uppercased() })
    return needed.filter { !present.contains($0.uppercased()) }
}

/// The `needed` fonts that are on the printer but whose size isn't the library's: a download that
/// was cut short leaves a smaller file under the right name. Upper-case names, in `needed`'s
/// order. A resident font (by name or the library's flag) is the printer's own, a font the
/// library doesn't have (or has at size 0, unknown) has nothing to compare with, and a font that
/// isn't there is `missingFonts`' to report.
func damagedFonts(needed: [String], library: [KioskLabelFont], onPrinter: [DirectoryEntry]) -> [String] {
    var printerSizes: [String: Int] = [:]
    for entry in onPrinter { printerSizes[entry.name.uppercased()] = entry.size }
    var librarySizes: [String: Int] = [:]
    var flaggedResident = Set<String>()
    for font in library {
        let name = font.name.uppercased()
        if librarySizes[name] == nil { librarySizes[name] = font.size }
        if font.resident { flaggedResident.insert(name) }
    }
    return needed.map { $0.uppercased() }.filter { name in
        guard let onPrinterSize = printerSizes[name], let librarySize = librarySizes[name], librarySize > 0,
              !isResidentFont(name, residentFlag: flaggedResident.contains(name))
        else { return false }
        return onPrinterSize != librarySize
    }
}

/// What to do about the fonts missing from the printer: install the library's (never a resident
/// one), say a built-in one is missing, and name the rest as not in the library.
struct FontFix: Equatable, Sendable {
    var installable: [KioskLabelFont]
    var builtIn: [String]
    var notInLibrary: [String]
}

/// Mirrors fontFixFor in kiosk/src/lib/stationPrinter.ts: `missing` holds upper-case names, and
/// `library` is the move's synced font rows. A font is resident by its name or by a library row's
/// `resident` flag.
func fontFixFor(missing: [String], library: [KioskLabelFont]) -> FontFix {
    func resident(_ name: String) -> Bool {
        let upper = name.uppercased()
        return isResidentFont(upper) || library.contains { $0.resident && $0.name.uppercased() == upper }
    }
    let builtIn = missing.filter(resident)
    let rest = missing.filter { !builtIn.contains($0) }
    let installable = library.filter { rest.contains($0.name.uppercased()) }
    let inLibrary = Set(installable.map { $0.name.uppercased() })
    return FontFix(installable: installable, builtIn: builtIn, notInLibrary: rest.filter { !inLibrary.contains($0) })
}

/// The Top fallback template every move has (kiosk/src/lib/stationPrinter.ts GENERIC_TEMPLATE_NAME).
let GENERIC_TEMPLATE_NAME = "Generic Rack and RU"

private func kindLabel(_ kind: LabelKind) -> String { kind == .front ? "Front" : "Top" }

/// "a", "a and b", "a, b and c" (`word` "or": "a, b or c").
private func joinWords(_ items: [String], _ word: String) -> String {
    guard items.count > 1 else { return items.joined() }
    return items.dropLast().joined(separator: ", ") + " \(word) " + items[items.count - 1]
}

/// What the DPI check says when the move has no `kind` template at `printerDpi`: activate one, or
/// the DPIs the move's template does print at (`available`, the plan's `availableDpis`). The web
/// kiosk's noTemplateText, with "sync this kiosk" for the laptop's "pick the move again".
func noTemplateText(kind: LabelKind, printerDpi: Int, available: [Int]) -> String {
    let k = kindLabel(kind)
    var unique: [Int] = []
    for dpi in available where !unique.contains(dpi) { unique.append(dpi) }
    let dpis = unique.filter { $0 != printerDpi }.sorted().map(String.init)
    if dpis.isEmpty {
        let fallback = kind == .top ? " (\(GENERIC_TEMPLATE_NAME) covers every move)" : ""
        return "No active \(k) template for this move. Someone with label access needs to activate one on "
            + "Labels › Templates in the portal\(fallback), then sync this kiosk."
    }
    return "This move's \(k) template prints at \(joinWords(dpis, "and")) DPI only; this printer is \(printerDpi) DPI. "
        + "Activate a \(printerDpi) DPI version on Labels › Templates, or use a \(joinWords(dpis, "or")) DPI printer."
}

/// A resident font the printer lacks (stationPrinter.ts builtInFontText).
func builtInFontText(_ names: [String]) -> String {
    names.count == 1
        ? "Printer is missing its built-in font \(names[0])."
        : "Printer is missing its built-in fonts \(names.joined(separator: ", "))."
}

/// A dotted IPv4 address, each part 0..255 without leading zeros (`010` could be read as octal).
func isIpv4(_ text: String) -> Bool {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return false }
    return parts.allSatisfy { part in
        (1...3).contains(part.unicodeScalars.count)
            && part.unicodeScalars.allSatisfy { ("0"..."9").contains($0) }
            && Int(part).map { $0 <= 255 } == true
            && (part.count == 1 || !part.hasPrefix("0"))
    }
}

// MARK: Local Network access (iOS only)

/// The scan's message when iOS keeps the kiosk off the local network.
let LOCAL_NETWORK_DENIED_TEXT = "Allow Local Network access for ServerSherpa Kiosk in Settings to find printers."

/// The same denial when reaching the chosen printer (choosing it, its checks, a test label, a
/// scanned label): iOS copy, no Android counterpart.
let LOCAL_NETWORK_PRINTER_DENIED_TEXT = "Allow Local Network access for ServerSherpa Kiosk in Settings to reach the printer."

/// How one scan probe ended.
enum ProbeEnding: Equatable, Sendable {
    /// Something took the connection on the printer port.
    case answered
    /// Nothing did (refused, failed, or no answer in time).
    case unanswered
    /// The connection waited out its time with iOS's policy denial (Local Network access off).
    case deniedByPolicy
}

/// Whether a scan should say Local Network access is off: only when EVERY probe that ended waited
/// with a policy denial. One answer or one plain miss means the network was reachable.
func scanWasDeniedLocalNetwork(_ endings: [ProbeEnding]) -> Bool {
    !endings.isEmpty && endings.allSatisfy { $0 == .deniedByPolicy }
}
