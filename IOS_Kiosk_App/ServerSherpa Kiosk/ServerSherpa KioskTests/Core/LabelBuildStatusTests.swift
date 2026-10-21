import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct LabelBuildStatusTests {
    @Test func idleByDefault() {
        let s = LabelBuildStatus()
        #expect(s.phase == .idle)
        #expect(s.done == 0)
        #expect(s.total == 0)
        #expect(s.ready == 0)
        #expect(s.problems == [:])
        #expect(s.notes == [])
        #expect(s.needs == nil)
    }

    @Test func tallyCountsReadyAndProblemsByOutcome() {
        let t = tallyOutcomes(["ok", NO_TEMPLATE_AT_DPI, "ok", TEMPLATE_FAILED, NO_TEMPLATE_AT_DPI, "ok"])
        #expect(t.ready == 3)
        #expect(t.problems == [NO_TEMPLATE_AT_DPI: 2, TEMPLATE_FAILED: 1])
        #expect(tallyOutcomes([String]()) == LabelTally(ready: 0, problems: [:]))
    }

    @Test func progressIsDoneOverTotal() {
        #expect(LabelBuildStatus(phase: .running, done: 0, total: 4).progress == 0)
        #expect(LabelBuildStatus(phase: .running, done: 2, total: 4).progress == 0.5)
        #expect(LabelBuildStatus(phase: .running, done: 4, total: 4).progress == 1)
        // Out of range counts are clamped.
        #expect(LabelBuildStatus(phase: .running, done: 9, total: 4).progress == 1)
        #expect(LabelBuildStatus(phase: .running, done: -1, total: 4).progress == 0)
        // Nothing to render: a finished build is complete, a starting one is not.
        #expect(LabelBuildStatus(phase: .done).progress == 1)
        #expect(LabelBuildStatus(phase: .running).progress == 0)
    }

    @Test func kindWireValues() {
        #expect(LabelKind.top.wire == "top")
        #expect(LabelKind.front.wire == "front")
        #expect(LabelKind.fromWire("front") == .front)
        // Anything unknown (a selection saved before kinds existed) reads as Top.
        #expect(LabelKind.fromWire(nil) == .top)
        #expect(LabelKind.fromWire("side") == .top)
        #expect(LabelSettings().kind == .top)
    }

    @Test func aPickDefaultsToNotFailed() {
        let pick = LabelPick(kind: .front, dpi: 300, synced: true)
        #expect(!pick.failed)
        #expect(pick.templateId == nil)
        #expect(pick.widthIn == nil)
        #expect(LabelPick(kind: .top, dpi: 203, synced: true, failed: true).failed)
    }

    @Test func labelOptionsRoundTripAndMissingMembersTakeDefaults() throws {
        let options = LabelOptions(printer: SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203), offsetX: -4, offsetY: 7, peel: true)
        let back = try JSONDecoder().decode(LabelOptions.self, from: JSONEncoder().encode(options))
        #expect(back == options)
        #expect(try JSONDecoder().decode(LabelOptions.self, from: Data("{}".utf8)) == LabelOptions())
        #expect(try JSONDecoder().decode(LabelOptions.self, from: Data(#"{"printer":null,"peel":true}"#.utf8)) == LabelOptions(peel: true))
        let printer = try JSONDecoder().decode(SavedPrinter.self, from: Data(#"{"host":"h","model":"m","serial":"s","dpi":300}"#.utf8))
        #expect(printer == SavedPrinter(host: "h", model: "m", serial: "s", dpi: 300))
    }
}
