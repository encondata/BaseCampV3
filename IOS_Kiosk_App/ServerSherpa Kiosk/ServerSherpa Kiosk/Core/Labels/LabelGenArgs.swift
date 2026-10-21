import Foundation

/// The label generator's JSON surface (kiosk/src/labelgen/index.ts), store-free: every call takes
/// one JSON object of arguments and answers one JSON object, or `{"error": "..."}`.
///
/// The generator reads the raw sync bodies, so they are rebuilt from the stored text exactly
/// (number literals intact): the asset payloads in stored order with the move's `label_context`,
/// and the templates in the server's order (template ties depend on it). The bodies are joined
/// as text and never parsed and re-serialized, which would turn `12.0` into `12`.
enum LabelGenArgs {
    /// The /kiosk/sync/assets body: `payloads` are the assets' stored JSON objects and
    /// `labelContext` the stored `label_context` text (`null` when the server sent none).
    static func assetsBody(initiativeId: String, payloads: [String], labelContext: String) -> String {
        let context = labelContext.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "null" : labelContext
        return "{\"initiative_id\":" + quote(initiativeId)
            + ",\"assets\":[" + payloads.joined(separator: ",")
            + "],\"label_context\":" + context + "}"
    }

    /// The /kiosk/sync/label-templates body from the stored template objects, in order.
    static func templatesBody(_ templates: [String]) -> String {
        "{\"templates\":[" + templates.joined(separator: ",") + "]}"
    }

    /// `buildPlan` arguments.
    static func plan(assetsJson: String, templatesJson: String, kind: LabelKind, dpi: Int) -> String {
        object([("assetsJson", quote(assetsJson)), ("templatesJson", quote(templatesJson)),
                ("kind", quote(kind.wire)), ("dpi", String(dpi))])
    }

    /// `renderLabels` arguments: the labels of `assetIds`, in that order.
    static func render(assetsJson: String, templatesJson: String, kind: LabelKind, dpi: Int, assetIds: [String]) -> String {
        object([("assetsJson", quote(assetsJson)), ("templatesJson", quote(templatesJson)),
                ("kind", quote(kind.wire)), ("dpi", String(dpi)),
                ("assetIds", "[" + assetIds.map(quote).joined(separator: ",") + "]")])
    }

    /// `applyPrintSettings` arguments: the saved offsets in dots (one copy, always).
    static func printSettings(zpl: String, offsetX: Int, offsetY: Int) -> String {
        object([("zpl", quote(zpl)), ("verticalOffset", String(offsetY)), ("horizontalOffset", String(offsetX))])
    }

    /// `withPrintMode` arguments: peel-off (`^MMP`) or tear-off (`^MMT`).
    static func printMode(zpl: String, peel: Bool) -> String {
        object([("zpl", quote(zpl)), ("peel", peel ? "true" : "false")])
    }

    /// `sampleLabel` arguments: the mock-data label of the template `kind` at `dpi` picks.
    static func sample(templatesJson: String, kind: LabelKind, dpi: Int) -> String {
        object([("templatesJson", quote(templatesJson)), ("kind", quote(kind.wire)), ("dpi", String(dpi))])
    }

    /// `alignmentTestZpl` arguments: the label's size in dots and its caption (`4x2`).
    static func alignment(widthDots: Int, heightDots: Int, sizeLabel: String, dpi: Int) -> String {
        object([("widthDots", String(widthDots)), ("heightDots", String(heightDots)),
                ("sizeLabel", quote(sizeLabel)), ("dpi", String(dpi))])
    }

    /// `text` as a JSON string literal, escaped as kotlinx.serialization writes it (and as
    /// JSON.stringify does): `"` and `\`, the short escapes for backspace, tab, newline, form
    /// feed and carriage return, `\u00XX` for the other control characters; everything else,
    /// `/` and non-ASCII included, as is.
    static func quote(_ text: String) -> String {
        var out = "\""
        out.unicodeScalars.reserveCapacity(text.unicodeScalars.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\t": out += "\\t"
            case "\n": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\r": out += "\\r"
            case _ where scalar.value < 0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
        return out
    }

    /// An object from members whose values are already JSON text, in the given order.
    private static func object(_ members: [(String, String)]) -> String {
        "{" + members.map { quote($0.0) + ":" + $0.1 }.joined(separator: ",") + "}"
    }
}

/// One asset's job in a plan: its label is current when the stored fingerprint matches.
struct LabelPlanJob: Codable, Equatable, Sendable {
    var assetId: String
    var fingerprint: String
}

/// What `buildPlan` answers: the picked template (or the DPIs that have one), the fonts it
/// prints with, and one job per asset. `hasAssetData` false means the body had no usable
/// asset data, so the empty `jobs` say nothing about the move and no label may be pruned.
struct LabelPlan: Codable, Equatable, Sendable {
    var templateId: String? = nil
    var templateFamily: String? = nil
    var notes: [String] = []
    var fonts: [String] = []
    var availableDpis: [Int] = []
    var hasAssetData: Bool = false
    var jobs: [LabelPlanJob] = []

    init(templateId: String? = nil, templateFamily: String? = nil, notes: [String] = [], fonts: [String] = [],
         availableDpis: [Int] = [], hasAssetData: Bool = false, jobs: [LabelPlanJob] = []) {
        self.templateId = templateId
        self.templateFamily = templateFamily
        self.notes = notes
        self.fonts = fonts
        self.availableDpis = availableDpis
        self.hasAssetData = hasAssetData
        self.jobs = jobs
    }

    /// Android's decoder: a missing member takes its default; a `null` is only allowed for the
    /// optional ones.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        templateId = try c.decodeIfPresent(String.self, forKey: .templateId)
        templateFamily = try c.decodeIfPresent(String.self, forKey: .templateFamily)
        notes = c.contains(.notes) ? try c.decode([String].self, forKey: .notes) : []
        fonts = c.contains(.fonts) ? try c.decode([String].self, forKey: .fonts) : []
        availableDpis = c.contains(.availableDpis) ? try c.decode([Int].self, forKey: .availableDpis) : []
        hasAssetData = c.contains(.hasAssetData) ? try c.decode(Bool.self, forKey: .hasAssetData) : false
        jobs = c.contains(.jobs) ? try c.decode([LabelPlanJob].self, forKey: .jobs) : []
    }
}

/// One label from `renderLabels`: `zpl` when `outcome` is `ok`, else nil.
struct RenderedLabel: Codable, Equatable, Sendable {
    var assetId: String
    var zpl: String? = nil
    var outcome: String
    var fingerprint: String
}

private struct RenderedLabels: Decodable {
    var results: [RenderedLabel]
}

/// The generator answered `{"error": ...}`, or something that isn't its answer.
struct LabelGenException: Error, Equatable, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}

/// `combinePlans` was given no plan at all (a caller's mistake, Android's `require`).
struct NoPlanToCombine: Error, Equatable, CustomStringConvertible {
    var description: String { "no plan to combine" }
}

/// The answer as an object, or `LabelGenException` for an error answer or anything malformed.
private func answer(_ json: String) throws -> [String: Any] {
    let parsed: Any
    do {
        parsed = try JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
    } catch {
        throw LabelGenException("the label generator's answer is not JSON")
    }
    guard let obj = parsed as? [String: Any] else {
        throw LabelGenException("the label generator's answer is not an object")
    }
    if let error = obj["error"] {
        throw LabelGenException(errorText(error))
    }
    return obj
}

/// An error member's text: a string's content, else the value as JSON (`null`, `5`, `{...}`).
private func errorText(_ value: Any) -> String {
    if let s = value as? String { return s }
    if value is NSNull { return "null" }
    if let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]),
       let text = String(data: data, encoding: .utf8) {
        return text
    }
    return String(describing: value)
}

private func decoding<T>(_ block: () throws -> T) throws -> T {
    do {
        return try block()
    } catch let e as LabelGenException {
        throw e
    } catch {
        throw LabelGenException("the label generator's answer is malformed: \(error)")
    }
}

/// A string member's content; nil when it is missing, `null` or not a string.
private func text(_ obj: [String: Any], _ key: String) -> String? {
    obj[key] as? String
}

func parsePlan(_ json: String) throws -> LabelPlan {
    try decoding {
        _ = try answer(json)
        return try JSONDecoder().decode(LabelPlan.self, from: Data(json.utf8))
    }
}

/// One plan from the plans of a move's assets in chunks, in order. The template pick, its notes
/// and fonts, the DPIs and whether there is asset data depend on the templates and the label
/// context alone, never on which assets a chunk holds, so every chunk must agree on them
/// (`LabelGenException` if not); a job depends on its own asset, so the jobs follow one another.
func combinePlans(_ chunks: [LabelPlan]) throws -> LabelPlan {
    guard let first = chunks.first else { throw NoPlanToCombine() }
    var head = first
    head.jobs = []
    for chunk in chunks {
        var bare = chunk
        bare.jobs = []
        if bare != head { throw LabelGenException("the label generator planned the move's chunks differently") }
    }
    head.jobs = chunks.flatMap(\.jobs)
    return head
}

func parseRendered(_ json: String) throws -> [RenderedLabel] {
    try decoding {
        _ = try answer(json)
        return try JSONDecoder().decode(RenderedLabels.self, from: Data(json.utf8)).results
    }
}

/// `sampleLabel`'s answer: `zpl`, or nil with `reason` (the pick's notes or an outcome code).
struct SampleLabel: Equatable, Sendable {
    var zpl: String?
    var reason: String?
}

func parseSample(_ json: String) throws -> SampleLabel {
    try decoding {
        let obj = try answer(json)
        let zpl = text(obj, "zpl")
        if zpl == nil && text(obj, "reason") == nil {
            throw LabelGenException("the label generator's answer has neither zpl nor reason")
        }
        return SampleLabel(zpl: zpl, reason: zpl == nil ? text(obj, "reason") : nil)
    }
}

/// The `{zpl}` answer of `applyPrintSettings`, `withPrintMode` and `alignmentTestZpl`.
func parseZpl(_ json: String) throws -> String {
    try decoding {
        guard let zpl = text(try answer(json), "zpl") else {
            throw LabelGenException("the label generator's answer has no zpl")
        }
        return zpl
    }
}
