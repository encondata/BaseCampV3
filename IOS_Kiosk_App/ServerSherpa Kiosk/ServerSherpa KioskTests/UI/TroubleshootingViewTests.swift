import Foundation
import SwiftUI
import Testing
import UIKit
@testable import ServerSherpa_Kiosk

/// The Troubleshooting pages (web TroubleshootingTopic.test.tsx, Android WikiDocTest): the wiki
/// document as blocks, an unknown topic, the way back, and the barcodes black on a white panel
/// that fits a 360 pt phone in the dark theme.
@MainActor
struct TroubleshootingViewTests {
    private func scannerGuide() throws -> DocNode {
        let topic = try #require(TroubleshootingContent.topics().first)
        return try #require(TroubleshootingContent.doc(for: topic))
    }

    private func decode(_ json: String) throws -> DocNode {
        try JSONDecoder().decode(DocNode.self, from: Data(json.utf8))
    }

    /// Every block of the tree, depth first (list items, table cells and callouts opened).
    private func flat(_ blocks: [WikiBlock]) -> [WikiBlock] {
        blocks.flatMap { b -> [WikiBlock] in
            switch b {
            case .list(_, _, let items): [b] + flat(items.flatMap { $0 })
            case .table(let rows): [b] + flat(rows.flatMap { $0 }.flatMap(\.blocks))
            case .callout(_, let inner): [b] + flat(inner)
            default: [b]
            }
        }
    }

    private func text(_ runs: [WikiRun]) -> String { runs.map(\.text).joined() }

    // MARK: blocks

    @Test func theScannerGuideBecomesBlocks() throws {
        let blocks = flat(wikiDocBlocks(try scannerGuide()))
        let headings = blocks.compactMap { if case .heading(let level, let runs) = $0 { (level, text(runs)) } else { nil } }
        #expect(headings.contains { $0 == (2, "Appendix: programming barcodes") })
        #expect(headings.contains { $0 == (3, "A1 Factory reset (both models)") })

        let images = blocks.compactMap { if case .image(let i) = $0 { i } else { nil } }
        #expect(images.map(\.file) == ["factory-defaults.png", "ds2208-usb-keyboard-hid.png", "ds2278-hid-bluetooth-classic.png",
                                       "ds2278-unpairing.png", "add-enter-key.png"])
        #expect(images.map(\.caption) == ["Set Factory Defaults", "DS2208: USB Keyboard HID",
                                          "DS2278: HID Bluetooth Classic (also makes it ready to pair)", "DS2278: Unpairing",
                                          "Add Enter Key (Carriage Return/Line Feed)"])
        #expect(images.map(\.width) == [190, 350, 360, 410, 470])

        #expect(blocks.contains { if case .paragraph(let runs) = $0 { runs.contains { $0.bold && $0.text == "Appendix" } } else { false } })
        #expect(blocks.contains { if case .callout(.warning, _) = $0 { true } else { false } })
        #expect(blocks.filter { if case .list(true, _, _) = $0 { true } else { false } }.count == 3)
        let tables = blocks.compactMap { if case .table(let rows) = $0 { rows } else { nil } }
        #expect(tables.count == 3)
        // a header row's text is bold
        let header = try #require(tables.first?.first { $0.contains(where: \.header) })
        #expect(header.allSatisfy { cell in flat(cell.blocks).allSatisfy { if case .paragraph(let runs) = $0 { runs.allSatisfy(\.bold) } else { true } } })
    }

    @Test func eachSupportedNodeBecomesItsBlock() throws {
        let doc = try decode(#"""
        {"type":"doc","content":[
          {"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Sub"}]},
          {"type":"paragraph","content":[{"type":"text","text":"Plain "},{"type":"text","text":"strong","marks":[{"type":"bold"}]}]},
          {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"One"}]}]}]},
          {"type":"orderedList","attrs":{"start":4},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Four"}]}]}]},
          {"type":"table","content":[{"type":"tableRow","content":[
            {"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"H"}]}]},
            {"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"C"}]}]}]}]},
          {"type":"callout","attrs":{"variant":"tip"},"content":[{"type":"paragraph","content":[{"type":"text","text":"Tip"}]}]},
          {"type":"callout","content":[{"type":"paragraph","content":[{"type":"text","text":"Info"}]}]},
          {"type":"wikiImage","attrs":{"assetId":"a.png","alt":"A","caption":"Cap","width":200}}
        ]}
        """#)
        #expect(wikiDocBlocks(doc) == [
            .heading(level: 3, runs: [WikiRun(text: "Sub", bold: false)]),
            .paragraph([WikiRun(text: "Plain ", bold: false), WikiRun(text: "strong", bold: true)]),
            .list(ordered: false, start: 1, items: [[.paragraph([WikiRun(text: "One", bold: false)])]]),
            .list(ordered: true, start: 4, items: [[.paragraph([WikiRun(text: "Four", bold: false)])]]),
            .table([[WikiCell(header: true, blocks: [.paragraph([WikiRun(text: "H", bold: true)])]),
                     WikiCell(header: false, blocks: [.paragraph([WikiRun(text: "C", bold: false)])])]]),
            .callout(.tip, [.paragraph([WikiRun(text: "Tip", bold: false)])]),
            .callout(.info, [.paragraph([WikiRun(text: "Info", bold: false)])]),
            .image(WikiImage(file: "a.png", alt: "A", caption: "Cap", width: 200)),
        ])
    }

    /// An unknown node (block or inline) and an unknown mark render nothing extra.
    @Test func anUnknownNodeYieldsNoBlock() throws {
        let doc = try decode(#"""
        {"type":"doc","content":[
          {"type":"mystery","content":[{"type":"paragraph","content":[{"type":"text","text":"hidden"}]}]},
          {"type":"paragraph","content":[{"type":"text","text":"Hi"},{"type":"hardBreak"},{"type":"text","text":" there","marks":[{"type":"italic"}]}]},
          {"type":"wikiImage","attrs":{"caption":"no file"}}
        ]}
        """#)
        #expect(wikiDocBlocks(doc) == [.paragraph([WikiRun(text: "Hi", bold: false), WikiRun(text: " there", bold: false)])])
    }

    // MARK: the topic page

    @Test func anUnknownTopicIsNotAvailable() {
        #expect(troubleshootingTopicState("nope") == .unavailable)
        #expect(TOPIC_UNAVAILABLE == "This topic isn't available.")
        guard case .loaded(let topic, let blocks) = troubleshootingTopicState("zebra-ds22") else {
            Issue.record("the scanner guide should load"); return
        }
        #expect(topic.title == "Zebra Scanner Troubleshooting")
        #expect(!blocks.isEmpty)
    }

    /// Back to Troubleshooting: to the list underneath, or the list in this page's place.
    @Test func backGoesToTheList() {
        #expect(backToTroubleshooting([.troubleshooting, .troubleshootingTopic("nope")]) == [.troubleshooting])
        #expect(backToTroubleshooting([.troubleshootingTopic("nope")]) == [.troubleshooting])
        #expect(backToTroubleshooting([.settings(nil), .troubleshootingTopic("nope")]) == [.settings(nil), .troubleshooting])
    }

    // MARK: rendering

    private func render<V: View>(_ view: V, width: CGFloat, scale: CGFloat = 1) throws -> CGImage {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark).environment(\.kioskPalette, .dark))
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        renderer.scale = scale
        return try #require(renderer.cgImage)
    }

    /// The RGBA of one pixel of `image`.
    private func pixel(_ image: CGImage, x: Int, y: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &out, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return out
    }

    /// Dark theme, 360 pt: the 470 pt Enter-key barcode shrinks to 328 pt inside its 16 pt white
    /// panel, which stays opaque white.
    @Test func aBarcodeSitsOnWhiteAndShrinksToANarrowPhone() throws {
        let image = WikiImage(file: "add-enter-key.png", alt: "Add Enter Key", caption: nil, width: 470)
        let cg = try render(BarcodeBlock(image: image), width: 360)
        #expect(cg.width == 360)
        for (x, y) in [(2, 2), (357, 2), (8, cg.height - 9), (180, 4)] {
            #expect(pixel(cg, x: x, y: y) == [255, 255, 255, 255], "(\(x), \(y))")
        }
        // the bars themselves are drawn: something dark inside the panel
        let middle = (16..<344).map { pixel(cg, x: $0, y: cg.height / 2) }
        #expect(middle.contains { $0[0] < 64 && $0[1] < 64 && $0[2] < 64 })
    }

    /// A barcode narrower than the space is drawn at its own width, never enlarged.
    @Test func aBarcodeIsNeverEnlarged() throws {
        let image = WikiImage(file: "factory-defaults.png", alt: nil, caption: nil, width: 190)
        let cg = try render(BarcodeBlock(image: image), width: 1000)
        #expect(cg.width == 190 + 32)
    }

    /// The whole guide fits a 360 pt phone: nothing (tables, barcodes) is wider than the screen.
    /// At a phone's 2x (at 1x, a two-column table's 179.5 pt cells round up a point).
    @Test func theGuideFitsANarrowPhone() throws {
        let cg = try render(WikiDocView(blocks: wikiDocBlocks(try scannerGuide())), width: 360, scale: 2)
        #expect(cg.width <= 720)
        #expect(cg.height > 2000)
    }
}
