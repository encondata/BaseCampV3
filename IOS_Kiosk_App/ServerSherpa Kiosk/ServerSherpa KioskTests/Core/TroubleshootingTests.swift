import Foundation
import Testing
import UIKit
@testable import ServerSherpa_Kiosk

/// A bundle that holds none of the guides: the test bundle itself.
private final class TestBundleToken {}

/// The bundled guides (Resources/Troubleshooting, flattened into the app bundle): the topic list,
/// its wiki document and the five programming barcodes, all read from the app's own bundle.
struct TroubleshootingTests {
    private static let barcodes = ["factory-defaults.png", "ds2208-usb-keyboard-hid.png", "ds2278-hid-bluetooth-classic.png",
                                   "ds2278-unpairing.png", "add-enter-key.png"]

    /// Every node of the tree, depth first.
    private func nodes(_ n: DocNode) -> [DocNode] { [n] + n.content.flatMap(nodes) }

    @Test func topicsIsTheScannerGuide() {
        #expect(TroubleshootingContent.topics() == [
            TroubleshootingContent.Topic(id: "zebra-ds22", title: "Zebra Scanner Troubleshooting",
                                         blurb: "Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.",
                                         doc: "zebra-ds22.json"),
        ])
    }

    @Test func theScannerGuideDecodes() throws {
        let topic = try #require(TroubleshootingContent.topics().first)
        let doc = try #require(TroubleshootingContent.doc(for: topic))
        #expect(doc.type == "doc")
        #expect(!doc.content.isEmpty)
        let all = nodes(doc)
        let images = all.filter { $0.type == "wikiImage" }
        #expect(images.compactMap { $0.attrs.string("assetId") } == Self.barcodes)
        #expect(images.first?.attrs.number("width") == 190)
        #expect(images.first?.attrs.string("caption") == "Set Factory Defaults")
        #expect(all.first { $0.type == "heading" }?.attrs.number("level") == 2)
        #expect(all.first { $0.type == "callout" }?.attrs.string("variant") == "warning")
        #expect(all.first { $0.type == "text" && $0.text == "Appendix" }?.marks.map(\.type) == ["bold"])
    }

    @Test func everyBarcodeLoads() {
        for name in Self.barcodes {
            let image = TroubleshootingContent.image(named: name)
            #expect(image != nil, "\(name)")
            #expect((image?.size.width ?? 0) > 0, "\(name)")
        }
    }

    /// A bundle without the guides gives no topics, no document and no images, never a crash.
    @Test func aBundleWithoutTheGuidesGivesNothing() {
        let empty = Bundle(for: TestBundleToken.self)
        #expect(TroubleshootingContent.topics(bundle: empty).isEmpty)
        let topic = TroubleshootingContent.Topic(id: "zebra-ds22", title: "T", blurb: "B", doc: "zebra-ds22.json")
        #expect(TroubleshootingContent.doc(for: topic, bundle: empty) == nil)
        #expect(TroubleshootingContent.image(named: "add-enter-key.png", bundle: empty) == nil)
        #expect(TroubleshootingContent.doc(for: TroubleshootingContent.Topic(id: "x", title: "", blurb: "", doc: "missing.json")) == nil)
    }

    /// Attrs of any JSON kind decode; a node with no content or marks has empty ones.
    @Test func nodesDecodeEveryAttrKind() throws {
        let json = #"{"type":"wikiImage","attrs":{"assetId":"a.png","width":470,"ratio":1.5,"inline":true,"alt":null}}"#
        let n = try JSONDecoder().decode(DocNode.self, from: Data(json.utf8))
        #expect(n.type == "wikiImage")
        #expect(n.attrs.string("assetId") == "a.png")
        #expect(n.attrs.number("width") == 470)
        #expect(n.attrs.number("ratio") == 1.5)
        #expect(n.attrs.string("width") == nil)
        #expect(n.attrs.number("assetId") == nil)
        #expect(n.attrs.string("alt") == nil)
        #expect(n.content.isEmpty && n.marks.isEmpty && n.text == nil)
    }

    /// A barcode is drawn at its `width` and shrunk only to fit inside its 16 pt panel padding.
    @Test func barcodesShrinkOnlyToFit() {
        #expect(topicImageSize(width: 470, available: 360) == 328)
        #expect(topicImageSize(width: 190, available: 1000) == 190)
        #expect(topicImageSize(width: 470, available: 502) == 470)
        #expect(topicImageSize(width: 470, available: 20) == 0)
    }
}
