import Foundation

/// One attr value of a wiki node: the JSON kinds the bundled guides use.
enum DocAttr: Equatable, Sendable, Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else { self = .null }   // an object or array attr: nothing the renderer reads
    }
}

/// A node's attrs (empty when the JSON has none), read by kind.
struct DocAttrs: Equatable, Sendable, Decodable {
    let values: [String: DocAttr]

    init(_ values: [String: DocAttr] = [:]) { self.values = values }

    init(from decoder: Decoder) throws {
        values = try decoder.singleValueContainer().decode([String: DocAttr].self)
    }

    func string(_ key: String) -> String? {
        if case .string(let s) = values[key] { return s }
        return nil
    }

    func number(_ key: String) -> Double? {
        if case .number(let n) = values[key] { return n }
        return nil
    }
}

/// A text run's mark (`bold` is the only one the guides use).
struct DocMark: Equatable, Sendable, Decodable {
    let type: String
}

/// One node of a wiki (ProseMirror) document, as the portal's wiki stores it
/// (Android `core/troubleshooting/DocNode`). Missing attrs, content and marks decode empty.
struct DocNode: Equatable, Sendable, Decodable {
    let type: String
    var attrs = DocAttrs()
    var content: [DocNode] = []
    var text: String?
    var marks: [DocMark] = []

    private enum CodingKeys: String, CodingKey { case type, attrs, content, text, marks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        attrs = try c.decodeIfPresent(DocAttrs.self, forKey: .attrs) ?? DocAttrs()
        content = try c.decodeIfPresent([DocNode].self, forKey: .content) ?? []
        text = try c.decodeIfPresent(String.self, forKey: .text)
        marks = try c.decodeIfPresent([DocMark].self, forKey: .marks) ?? []
    }
}

/// The bundled hardware guides (kiosk/src/troubleshooting, copied into Resources/Troubleshooting
/// by scripts/troubleshooting/sync.sh; the synchronized folder flattens them into the bundle's
/// root). A missing or unreadable file gives nothing, never a crash. Images: `image(named:)` in
/// the UI layer (Core stays Foundation-only).
enum TroubleshootingContent {
    /// One guide: its card on the Troubleshooting page and the document it opens.
    struct Topic: Equatable, Identifiable, Sendable, Decodable {
        let id: String
        let title: String
        let blurb: String
        /// The document's file name in the bundle.
        let doc: String
    }

    static func topics(bundle: Bundle = .main) -> [Topic] {
        guard let data = read("topics.json", bundle: bundle) else { return [] }
        return (try? JSONDecoder().decode([Topic].self, from: data)) ?? []
    }

    static func doc(for topic: Topic, bundle: Bundle = .main) -> DocNode? {
        guard let data = read(topic.doc, bundle: bundle) else { return nil }
        return try? JSONDecoder().decode(DocNode.self, from: data)
    }

    /// The bundled file's bytes; nil when the bundle has no such file.
    static func read(_ file: String, bundle: Bundle) -> Data? {
        guard let url = bundle.url(forResource: file, withExtension: nil) else { return nil }
        return try? Data(contentsOf: url)
    }
}

/// A barcode's drawn width: its own `width`, shrunk only to fit `available` less its panel's
/// 16 pt padding each side; never enlarged, never negative.
func topicImageSize(width: Double, available: Double) -> Double {
    max(0, min(width, available - 32))
}
