import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// The JSON the generator's surface takes and returns (kiosk/src/labelgen/index.ts), without the engine.
struct LabelGenArgsTests {
    // Number literals and text the generator must see exactly as stored.
    let p1 = #"{"id":"a1","raw_ft":{"RU":12.0,"Qty":7,"Tiny":1e-05},"name":"Café ^~_ 😀 \"q\" \\"}"#
    let p2 = #"{"id":"a2","raw_ft":{}}"#
    let context = #"{"move_name":"Move A","catalog_keys":["RU"]}"#

    func object(_ json: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    /// A string as JSON.stringify writes it (Foundation's encoder, independent of `LabelGenArgs.quote`).
    func jsonString(_ s: String) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    @Test func assetsBodyIsTheSyncBodyRebuiltFromStoredText() throws {
        let body = LabelGenArgs.assetsBody(initiativeId: "i\"1", payloads: [p1, p2], labelContext: context)
        #expect(body == #"{"initiative_id":"i\"1","assets":["# + p1 + "," + p2 + #"],"label_context":"# + context + "}")
        // Valid JSON, with the stored payloads intact.
        let parsed = try object(body)
        #expect((parsed["assets"] as? [Any])?.count == 2)
        #expect(LabelGenArgs.assetsBody(initiativeId: "i1", payloads: [], labelContext: "null") == #"{"initiative_id":"i1","assets":[],"label_context":null}"#)
        #expect(LabelGenArgs.assetsBody(initiativeId: "i1", payloads: [], labelContext: " ") == #"{"initiative_id":"i1","assets":[],"label_context":null}"#)
        #expect(LabelGenArgs.assetsBody(initiativeId: "i1", payloads: [], labelContext: "") == #"{"initiative_id":"i1","assets":[],"label_context":null}"#)
    }

    @Test func templatesBodyKeepsTheStoredOrder() {
        let t1 = #"{"id":"t1","design":{"schema":2.0}}"#
        let t0 = #"{"id":"t0","version":1}"#
        #expect(LabelGenArgs.templatesBody([t1, t0]) == #"{"templates":["# + t1 + "," + t0 + "]}")
        #expect(LabelGenArgs.templatesBody([]) == #"{"templates":[]}"#)
    }

    @Test func planAndRenderArgsCarryTheBodiesAsText() throws {
        let assets = LabelGenArgs.assetsBody(initiativeId: "i1", payloads: [p1, p2], labelContext: context)
        let templates = LabelGenArgs.templatesBody([#"{"id":"t1"}"#])
        let planArgs = LabelGenArgs.plan(assetsJson: assets, templatesJson: templates, kind: .front, dpi: 300)
        let plan = try object(planArgs)
        #expect(Set(plan.keys) == ["assetsJson", "templatesJson", "kind", "dpi"])
        // The bodies come back byte for byte once the surface's JSON.parse reads the args.
        #expect(plan["assetsJson"] as? String == assets)
        #expect(plan["templatesJson"] as? String == templates)
        #expect(plan["kind"] as? String == "front")
        #expect(plan["dpi"] as? Int == 300)
        // The number literals survive inside the text, and the members come in Android's order.
        #expect((plan["assetsJson"] as? String)?.contains(#""RU":12.0,"Qty":7,"Tiny":1e-05"#) == true)
        #expect(planArgs == #"{"assetsJson":"# + (try jsonString(assets)) + #","templatesJson":"# + (try jsonString(templates))
            + #","kind":"front","dpi":300}"#)

        let render = try object(LabelGenArgs.render(assetsJson: assets, templatesJson: templates, kind: .top, dpi: 203, assetIds: ["a2", "a1"]))
        #expect(render["kind"] as? String == "top")
        #expect(render["assetIds"] as? [String] == ["a2", "a1"])
        #expect(render["assetsJson"] as? String == assets)
        #expect(render["dpi"] as? Int == 203)
    }

    @Test func sampleAndAlignmentArgs() throws {
        let sample = try object(LabelGenArgs.sample(templatesJson: #"{"templates":[]}"#, kind: .front, dpi: 600))
        #expect(Set(sample.keys) == ["templatesJson", "kind", "dpi"])
        #expect(sample["templatesJson"] as? String == #"{"templates":[]}"#)
        #expect(sample["kind"] as? String == "front")
        #expect(sample["dpi"] as? Int == 600)
        #expect(LabelGenArgs.alignment(widthDots: 812, heightDots: 406, sizeLabel: "4x2", dpi: 203)
            == #"{"widthDots":812,"heightDots":406,"sizeLabel":"4x2","dpi":203}"#)
    }

    /// The literal encoder writes what kotlinx.serialization writes.
    @Test func quoteEscapesOnlyWhatJsonNeeds() throws {
        let controls = String(decoding: [0x08, 0x09, 0x0A, 0x0C, 0x0D, 0x00, 0x1F, 0x7F], as: UTF8.self)
        let back = String(decoding: [0x5C], as: UTF8.self)
        let expected = "\"" + back + "b" + back + "t" + back + "n" + back + "f" + back + "r"
            + back + "u0000" + back + "u001f" + String(decoding: [0x7F], as: UTF8.self) + "\""
        #expect(LabelGenArgs.quote(controls) == expected)
        #expect(LabelGenArgs.quote(#"a"b\c/d"#) == #""a\"b\\c/d""#)
        #expect(LabelGenArgs.quote("Café 😀 ^~_") == "\"Café 😀 ^~_\"")
        #expect(LabelGenArgs.quote("") == "\"\"")
        // Every string round-trips through a JSON parser.
        for s in [controls, p1, "Café 😀", #"\u00e9"#, "line\nbreak"] {
            let parsed = try JSONSerialization.jsonObject(with: Data(LabelGenArgs.quote(s).utf8), options: .fragmentsAllowed)
            #expect(parsed as? String == s)
        }
    }

    @Test func parsesAPlan() throws {
        let plan = try parsePlan(
            #"{"templateId":"t1","templateFamily":"vegas","notes":["n1"],"fonts":["ROBOTO.TTF"],"availableDpis":[],"#
                + #""hasAssetData":true,"jobs":[{"assetId":"a1","fingerprint":"00abc"},{"assetId":"a2","fingerprint":"00def"}]}"#
        )
        #expect(plan.templateId == "t1")
        #expect(plan.notes == ["n1"])
        #expect(plan.fonts == ["ROBOTO.TTF"])
        #expect(plan.hasAssetData)
        #expect(plan.jobs == [LabelPlanJob(assetId: "a1", fingerprint: "00abc"), LabelPlanJob(assetId: "a2", fingerprint: "00def")])

        let none = try parsePlan(#"{"templateId":null,"templateFamily":null,"notes":[],"fonts":[],"availableDpis":[203,600],"hasAssetData":false,"jobs":[]}"#)
        #expect(none.templateId == nil)
        #expect(none.availableDpis == [203, 600])
        #expect(!none.hasAssetData)

        // Missing members take their defaults; unknown members are ignored.
        #expect(try parsePlan(#"{"extra":1}"#) == LabelPlan())
        // A null list is not a list.
        #expect(throws: LabelGenException.self) { try parsePlan(#"{"notes":null}"#) }
    }

    @Test func aPlanInChunksIsTheWholePlan() throws {
        let head = LabelPlan(templateId: "t1", templateFamily: "vegas", notes: ["n1"], fonts: ["ROBOTO.TTF"], availableDpis: [], hasAssetData: true)
        var a = head
        a.jobs = [LabelPlanJob(assetId: "a1", fingerprint: "f1"), LabelPlanJob(assetId: "a2", fingerprint: "f2")]
        var b = head
        b.jobs = [LabelPlanJob(assetId: "a3", fingerprint: "f3")]
        var whole = head
        whole.jobs = a.jobs + b.jobs
        #expect(try combinePlans([a, b]) == whole)
        #expect(try combinePlans([a]) == a)
        // Without asset data every chunk says so; the jobs stay empty.
        var none = head
        none.hasAssetData = false
        #expect(try combinePlans([none, none]) == none)
    }

    @Test func chunksThatDisagreeOnTheTemplateAreAnError() {
        let a = LabelPlan(templateId: "t1", templateFamily: "vegas", hasAssetData: true, jobs: [LabelPlanJob(assetId: "a1", fingerprint: "f1")])
        var t2 = a
        t2.templateId = "t2"
        var otherFonts = a
        otherFonts.fonts = ["X.TTF"]
        var noData = a
        noData.hasAssetData = false
        #expect(throws: LabelGenException.self) { try combinePlans([a, t2]) }
        #expect(throws: LabelGenException.self) { try combinePlans([a, otherFonts]) }
        #expect(throws: LabelGenException.self) { try combinePlans([a, noData]) }
        #expect(throws: NoPlanToCombine.self) { try combinePlans([]) }
    }

    @Test func parsesRenderedLabelsWithTheirZplIntact() throws {
        let zpl = #"^XA^FO10,10^FH^FDCaf_c3_a9 \& "x"^FS^XZ"#
        // The label as JSON.stringify writes it: quotes and backslashes escaped.
        let json = #"{"results":[{"assetId":"a1","zpl":"# + (try jsonString(zpl)) + #","outcome":"ok","fingerprint":"f1"},"#
            + #"{"assetId":"a2","zpl":null,"outcome":"no_template_at_dpi","fingerprint":"f2"}]}"#
        let results = try parseRendered(json)
        #expect(results == [RenderedLabel(assetId: "a1", zpl: zpl, outcome: "ok", fingerprint: "f1"),
                            RenderedLabel(assetId: "a2", zpl: nil, outcome: NO_TEMPLATE_AT_DPI, fingerprint: "f2")])
    }

    @Test func anErrorResultThrows() {
        #expect(throws: LabelGenException("bad printer DPI: 0")) { try parsePlan(#"{"error":"bad printer DPI: 0"}"#) }
        #expect(throws: LabelGenException.self) { try parseRendered(#"{"error":"assetIds must be a list of strings"}"#) }
        #expect(throws: LabelGenException("the label generator's answer is not JSON")) { try parseRendered("not json") }
        #expect(throws: LabelGenException("the label generator's answer is not an object")) { try parsePlan("[]") }
        #expect(throws: LabelGenException("null")) { try parseZpl(#"{"error":null}"#) }
        #expect(throws: LabelGenException.self) { try parseRendered(#"{"results":[{"assetId":"a1"}]}"#) }
    }

    @Test func parsesASample() throws {
        #expect(try parseSample(#"{"zpl":"^XA^XZ","reason":null}"#) == SampleLabel(zpl: "^XA^XZ", reason: nil))
        #expect(try parseSample(#"{"zpl":null,"reason":"no_template_at_dpi"}"#) == SampleLabel(zpl: nil, reason: "no_template_at_dpi"))
        // A zpl wins over a reason.
        #expect(try parseSample(#"{"zpl":"^XA^XZ","reason":"x"}"#) == SampleLabel(zpl: "^XA^XZ", reason: nil))
        #expect(throws: LabelGenException("the label generator's answer has neither zpl nor reason")) { try parseSample(#"{"zpl":null}"#) }
        #expect(throws: LabelGenException.self) { try parseSample(#"{"zpl":5}"#) }
    }

    /// The send-time helpers' argument names (index.ts `applyPrintSettings` / `withPrintMode`).
    @Test func printHelperArgsAndTheirAnswer() throws {
        let settings = try object(LabelGenArgs.printSettings(zpl: "^XA^XZ", offsetX: 12, offsetY: -3))
        #expect(settings["zpl"] as? String == "^XA^XZ")
        #expect(settings["verticalOffset"] as? Int == -3)
        #expect(settings["horizontalOffset"] as? Int == 12)
        let modeText = LabelGenArgs.printMode(zpl: "^XA^XZ", peel: true)
        #expect(modeText == #"{"zpl":"^XA^XZ","peel":true}"#)
        #expect(LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false) == #"{"zpl":"^XA^XZ","peel":false}"#)
        #expect(try parseZpl(#"{"zpl":"^XA^MMP^XZ"}"#) == "^XA^MMP^XZ")
        #expect(throws: LabelGenException.self) { try parseZpl(#"{"error":"peel must be a boolean"}"#) }
        #expect(throws: LabelGenException("the label generator's answer has no zpl")) { try parseZpl(#"{"zpl":null}"#) }
    }
}
