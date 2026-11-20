import SwiftUI
import UIKit

// MARK: - The document as blocks (pure, tested)

/// A run of text; `bold` for a bold mark or a table header's text.
struct WikiRun: Equatable, Sendable {
    let text: String
    let bold: Bool
}

/// A `wikiImage`: a programming barcode bundled as `file`, drawn `width` pt wide when it fits.
struct WikiImage: Equatable, Sendable {
    let file: String
    let alt: String?
    let caption: String?
    let width: Double?
}

struct WikiCell: Equatable, Sendable {
    let header: Bool
    let blocks: [WikiBlock]
}

/// The portal banner's tones: info blue, tip green, warning amber, danger red.
enum CalloutVariant: String, Sendable {
    case info, tip, warning, danger

    var tone: ChipTone {
        switch self {
        case .info: .blue
        case .tip: .green
        case .warning: .amber
        case .danger: .red
        }
    }
}

/// What the renderer draws: one case per supported node (kiosk/src/troubleshooting/WikiDoc.tsx).
indirect enum WikiBlock: Equatable, Sendable {
    case heading(level: Int, runs: [WikiRun])
    case paragraph([WikiRun])
    case list(ordered: Bool, start: Int, items: [[WikiBlock]])
    case table([[WikiCell]])
    case callout(CalloutVariant, [WikiBlock])
    case image(WikiImage)
}

/// The doc's top-level blocks. Only the nodes the web guard test allows; an unknown node (and
/// anything inside it) gives no block, an unknown mark draws plain.
func wikiDocBlocks(_ doc: DocNode) -> [WikiBlock] {
    doc.content.flatMap { wikiBlocks($0) }
}

private func wikiBlocks(_ n: DocNode, bold: Bool = false) -> [WikiBlock] {
    switch n.type {
    case "paragraph": return [.paragraph(wikiRuns(n, bold: bold))]
    case "heading": return [.heading(level: n.attrs.number("level") == 3 ? 3 : 2, runs: wikiRuns(n))]
    case "bulletList", "orderedList":
        let items = n.content.filter { $0.type == "listItem" }.map { $0.content.flatMap { wikiBlocks($0, bold: bold) } }
        return [.list(ordered: n.type == "orderedList", start: Int(n.attrs.number("start") ?? 1), items: items)]
    case "listItem": return n.content.flatMap { wikiBlocks($0, bold: bold) }
    case "table":
        let rows = n.content.filter { $0.type == "tableRow" }.map { row in
            row.content.filter { $0.type == "tableHeader" || $0.type == "tableCell" }.map { cell in
                let header = cell.type == "tableHeader"
                return WikiCell(header: header, blocks: cell.content.flatMap { wikiBlocks($0, bold: header) })
            }
        }
        return [.table(rows)]
    case "callout":
        let variant = n.attrs.string("variant").flatMap(CalloutVariant.init(rawValue:)) ?? .info
        return [.callout(variant, n.content.flatMap { wikiBlocks($0, bold: bold) })]
    case "wikiImage":
        guard let file = n.attrs.string("assetId"), !file.isEmpty else { return [] }
        return [.image(WikiImage(file: file, alt: n.attrs.string("alt"), caption: n.attrs.string("caption"),
                                 width: n.attrs.number("width")))]
    default: return []
    }
}

private func wikiRuns(_ n: DocNode, bold: Bool = false) -> [WikiRun] {
    n.content.compactMap { t in
        guard t.type == "text", let text = t.text else { return nil }
        return WikiRun(text: text, bold: bold || t.marks.contains { $0.type == "bold" })
    }
}

// MARK: - Images (UI layer: Core stays Foundation-only)

extension TroubleshootingContent {
    /// A bundled barcode; nil when the bundle has no such image.
    static func image(named file: String, bundle: Bundle = .main) -> UIImage? {
        guard let url = bundle.url(forResource: file, withExtension: nil) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }
}

// MARK: - The renderer

/// A bundled guide's wiki document. Everything follows the theme except the barcodes, which sit
/// on a white panel in both themes. Tables split the width evenly and wrap, so nothing scrolls
/// sideways on a narrow phone.
struct WikiDocView: View {
    let blocks: [WikiBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(blocks.indices, id: \.self) { WikiBlockView(block: blocks[$0]) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WikiBlockView: View {
    let block: WikiBlock
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        switch block {
        case .paragraph(let runs):
            WikiText(runs: runs, font: KioskType.bodyMedium).padding(.vertical, 4)
        case .heading(let level, let runs):
            WikiText(runs: runs, font: level == 3 ? KioskType.titleMedium : KioskType.titleLarge)
                .padding(.top, level == 3 ? 12 : 20).padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(items.indices, id: \.self) { i in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text(ordered ? "\(start + i)." : "•").font(KioskType.bodyMedium).foregroundStyle(palette.text)
                            .frame(width: 24, alignment: .leading)
                        WikiDocView(blocks: items[i])
                    }
                }
            }
            .padding(.vertical, 4)
        case .table(let rows):
            WikiTable(rows: rows).padding(.vertical, 8)
        case .callout(let variant, let inner):
            WikiDocView(blocks: inner)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(variant.tone.bg, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(variant.tone.border, lineWidth: 1))
                .padding(.vertical, 8)
        case .image(let image):
            BarcodeBlock(image: image).padding(.vertical, 8)
        }
    }
}

/// A block's runs as one wrapping text, bold where marked.
private struct WikiText: View {
    let runs: [WikiRun]
    let font: Font
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        Text(runs.reduce(into: AttributedString()) { out, run in
            var part = AttributedString(run.text)
            part.font = run.bold ? font.bold() : font
            out += part
        })
        .foregroundStyle(palette.text)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Equal-width columns whose text wraps; every cell in a row takes the row's height.
private struct WikiTable: View {
    let rows: [[WikiCell]]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { r in
                if r > 0 { palette.paperLine.frame(height: 1) }
                HStack(spacing: 0) {
                    ForEach(rows[r].indices, id: \.self) { c in
                        if c > 0 { palette.paperLine.frame(width: 1) }
                        let cell = rows[r][c]
                        WikiDocView(blocks: cell.blocks)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .background(cell.header ? palette.paper2 : Color.clear)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
    }
}

/// A programming barcode: black on a white panel with a 16 pt quiet zone in either theme, drawn
/// at its `width` pt and shrunk only to fit (`topicImageSize`); the caption below it in the muted
/// color. Smooth (`.high`) interpolation on purpose: the 400 dpi source is always shrunk, and
/// nearest-neighbor would drop or double pixel columns and make the bars uneven, while a smooth
/// downscale keeps each bar edge where it belongs, which scanners decode reliably.
struct BarcodeBlock: View {
    let image: WikiImage
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        if let ui = TroubleshootingContent.image(named: image.file), ui.size.width > 0 {
            VStack(alignment: .leading, spacing: 6) {
                BarcodeFit(width: image.width ?? Double(ui.size.width), aspect: Double(ui.size.height / ui.size.width)) {
                    Image(uiImage: ui).resizable().interpolation(.high).scaledToFit()
                        .accessibilityLabel(image.alt ?? image.caption ?? "")
                        .padding(16)
                        .background(Color.white)
                }
                .accessibilityIdentifier("barcode-\(image.file)")
                if let caption = image.caption, !caption.isEmpty {
                    Text(caption).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Sizes its one subview (the padded panel) to a `topicImageSize` wide image of the given
/// height/width `aspect`, plus the panel's 16 pt padding each side.
private struct BarcodeFit: Layout {
    let width: Double
    let aspect: Double

    private func size(_ proposal: ProposedViewSize) -> CGSize {
        let available = proposal.width.map(Double.init).flatMap { $0.isFinite ? $0 : nil } ?? width + 32
        let w = topicImageSize(width: width, available: available)
        return CGSize(width: w + 32, height: w * aspect + 32)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { size(proposal) }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
