import Testing
import Foundation
@testable import ServerSherpa_Kiosk

private final class ReferenceFixtureBundle {}

/// Two cases copied from kiosk/src/labelgen/fixtures/reference.json (one top, one front).
private struct ReferenceCases: Decodable {
    struct Expected: Decodable {
        var asset_id: String
        var zpl: String?
        var error: String?
    }
    struct Plan: Decodable {
        var template_id: String?
        var notes: [String]
        var available_dpis: [Int]
        var has_asset_data: Bool
        var fonts: [String]
    }
    struct Case: Decodable {
        var name: String
        var assetsJson: String
        var templatesJson: String
        var kind: String
        var dpi: Int
        var plan: Plan
        var expected: [Expected]
    }
    var cases: [Case]

    static func load() throws -> ReferenceCases {
        let url = try #require(Bundle(for: ReferenceFixtureBundle.self).url(forResource: "LabelgenReferenceCases", withExtension: "json"))
        return try JSONDecoder().decode(ReferenceCases.self, from: Data(contentsOf: url))
    }
}

/// Counts reads of a bundle's source.
private final class Reads: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func bump() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

/// Completion order across concurrent calls.
private final class Order: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    func add(_ name: String) { lock.withLock { names.append(name) } }
    var all: [String] { lock.withLock { names } }
}

/// A script that outlasts every test time limit, yet ends (10 s), so its abandoned thread exits
/// instead of spinning a core for the rest of the test host. JavaScriptCore can't interrupt it.
private let boundedRunaway = "const t = Date.now(); while (Date.now() - t < 10000) {} 'late'"

private func bytes(_ text: String?) -> [UInt8]? { text.map { Array($0.utf8) } }

/// The label generator in JavaScriptCore, running the real bundle the app ships (the test host
/// is the app, so `Bundle.main` holds Resources/labelgen.js). Port of Android `LabelGeneratorTest`
/// where it applies (the sandbox connect and dead-sandbox cases have no JavaScriptCore analog).
/// Serialized: several tests spin a core in JavaScript (abandoned runaways for 10 s after their
/// test ends), and running them side by side starved timing-sensitive suites running in parallel
/// (the `StubURLProtocol` redirect tests failed under that load).
@Suite(.serialized)
final class JavaScriptLabelEngineTests {
    @Test func theAppShipsTheBundle() throws {
        let url = try #require(Bundle.main.url(forResource: "labelgen", withExtension: "js"))
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.contains("globalThis.labelgen"))
    }

    @Test func theReferenceCasesPrintByteForByte() async throws {
        let engine = JavaScriptLabelEngine()
        let reference = try ReferenceCases.load()
        #expect(reference.cases.map(\.kind).sorted() == ["front", "top"])
        for c in reference.cases {
            let kind: LabelKind = c.kind == "front" ? .front : .top
            let plan = try parsePlan(try await engine.call("buildPlan",
                LabelGenArgs.plan(assetsJson: c.assetsJson, templatesJson: c.templatesJson, kind: kind, dpi: c.dpi)))
            #expect(plan.templateId == c.plan.template_id, "\(c.name)")
            #expect(plan.notes == c.plan.notes, "\(c.name)")
            #expect(plan.availableDpis == c.plan.available_dpis, "\(c.name)")
            #expect(plan.hasAssetData == c.plan.has_asset_data, "\(c.name)")
            #expect(plan.fonts == c.plan.fonts, "\(c.name)")
            let ids = plan.jobs.map(\.assetId)
            #expect(ids == c.expected.map(\.asset_id), "\(c.name)")

            let labels = try parseRendered(try await engine.call("renderLabels",
                LabelGenArgs.render(assetsJson: c.assetsJson, templatesJson: c.templatesJson, kind: kind, dpi: c.dpi, assetIds: ids)))
            #expect(labels.map(\.fingerprint) == plan.jobs.map(\.fingerprint), "\(c.name)")
            #expect(labels.map(\.assetId) == c.expected.map(\.asset_id), "\(c.name)")
            for (label, want) in zip(labels, c.expected) {
                // Bytes, not String ==: Swift compares strings by canonical equivalence.
                #expect(bytes(label.zpl) == bytes(want.zpl), "\(c.name) \(want.asset_id)")
                #expect((label.outcome == OUTCOME_OK ? nil : label.outcome) == want.error, "\(c.name) \(want.asset_id)")
                #expect(want.zpl != nil)
            }
        }
    }

    @Test func thePrintHelpersRunOnTheRealBundle() async throws {
        let engine = JavaScriptLabelEngine()
        let peeled = try parseZpl(try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^FDx^FS^XZ", peel: true)))
        #expect(peeled.contains("^MMP"))
        let error = try await engine.call("withPrintMode", "{}")
        #expect(throws: LabelGenException.self) { try parseZpl(error) }
    }

    @Test func aDisallowedFunctionThrowsWithoutStartingTheEngine() async throws {
        let reads = Reads()
        let engine = JavaScriptLabelEngine(bundleSource: { reads.bump(); return nil })
        for fn in ["eval", "version", "constructor", "__proto__", "labelgen.buildPlan", "", "_evaluateForTesting"] {
            await #expect(throws: LabelEngineError.notAllowed(fn)) { try await engine.call(fn, "{}") }
        }
        #expect(reads.value == 0)
        #expect(LabelEngineError.notAllowed("eval").description == "not a label generator function: eval")
    }

    @Test func argumentsTravelAsAStringValueNotAsSource() async throws {
        // An echo surface: whatever text arrives comes back.
        let engine = JavaScriptLabelEngine(bundleSource: {
            "globalThis.labelgen = { version: '1', withPrintMode: function (a) { return a; } };"
        })
        let tricky = "{\"zpl\":\"a \\\" quote, a \\\\ backslash, \u{1F600} \u{1F1FA}\u{1F1F8} \u{2028}\u{2029} '); while(true){} ('\",\"peel\":true}"
        let echoed = try await engine.call("withPrintMode", tricky)
        #expect(Array(echoed.utf8) == Array(tricky.utf8))
    }

    @Test func trickyTextRoundTripsThroughTheRealBundle() async throws {
        let engine = JavaScriptLabelEngine()
        let zpl = "^XA^FDquote \" backslash \\ emoji \u{1F600}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} line\u{2028}sep^FS^XZ"
        let out = try parseZpl(try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: zpl, peel: false)))
        #expect(out.contains("quote \" backslash \\ emoji \u{1F600}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} line\u{2028}sep"))
        #expect(out.contains("^MMT"))
    }

    @Test func startsOnceLoadsTheBundleOnceAndChecksItsVersion() async throws {
        let reads = Reads()
        let real = try String(contentsOf: try #require(Bundle.main.url(forResource: "labelgen", withExtension: "js")), encoding: .utf8)
        let engine = JavaScriptLabelEngine(bundleSource: { reads.bump(); return real })
        #expect(reads.value == 0) // lazy: nothing until the first call
        _ = try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false))
        _ = try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: true))
        #expect(await engine.isSupported())
        #expect(reads.value == 1)
        #expect(LabelScripts.version == "1")
        #expect(LabelScripts.versionScript == "String(globalThis.labelgen && labelgen.version)")
    }

    @Test func aMissingBrokenOrWrongVersionBundleIsUnsupported() async throws {
        let bundles: [String?] = [
            nil,
            "this is not JavaScript (",
            "throw new Error('no');",
            "globalThis.labelgen = { version: '2', withPrintMode: function (a) { return a; } };",
            "var nothing = 1;",
        ]
        for bundle in bundles {
            let engine = JavaScriptLabelEngine(bundleSource: { bundle })
            #expect(await engine.isSupported() == false, "\(bundle ?? "nil")")
            await #expect(throws: LabelEngineError.unsupported, "\(bundle ?? "nil")") {
                try await engine.call("withPrintMode", "{}")
            }
        }
        #expect(LabelEngineError.isUnsupported(LabelEngineError.unsupported))
        #expect(!LabelEngineError.isUnsupported(LabelEngineError.timeout("buildPlan")))
        #expect(LabelEngineError.unsupported.description == "label generation isn't supported on this device")
    }

    @Test func theRealBundleIsSupported() async {
        #expect(await JavaScriptLabelEngine().isSupported())
    }

    @Test func aJavaScriptExceptionOrANonStringResultFailsTheCallAndTheNextCallWorks() async throws {
        let engine = JavaScriptLabelEngine(bundleSource: {
            """
            globalThis.labelgen = {
              version: '1',
              withPrintMode: function (a) { if (a === 'boom') throw new Error('boom'); return a; },
              renderLabels: function () { return 5; },
            };
            """
        })
        await #expect {
            try await engine.call("withPrintMode", "boom")
        } throws: { error in
            guard case .evaluationFailed(let message) = error as? LabelEngineError else { return false }
            return message.contains("boom")
        }
        #expect(try await engine.call("withPrintMode", "fine") == "fine")
        await #expect {
            try await engine.call("renderLabels", "{}")
        } throws: { error in
            if case .evaluationFailed = error as? LabelEngineError { return true }
            return false
        }
        #expect(try await engine.call("withPrintMode", "again") == "again")
    }

    @Test(.timeLimit(.minutes(1)))
    func aScriptThatNeverReturnsTimesOutAndTheNextCallRunsOnAFreshContext() async throws {
        let engine = JavaScriptLabelEngine(timeoutSeconds: { _ in 0.5 })
        #expect(try await engine._evaluateForTesting("globalThis.__mark = 'old'; String(__mark)") == "old")

        let started = Date()
        await #expect(throws: LabelEngineError.timeout("_evaluateForTesting")) {
            try await engine._evaluateForTesting(boundedRunaway)
        }
        let waited = Date().timeIntervalSince(started)
        #expect(waited >= 0.4 && waited < 3, "timed out after \(waited) s")

        // The runaway is still spinning on the abandoned context's thread for seconds yet
        // (JavaScriptCore can't interrupt it); this call starts a fresh context with the bundle loaded.
        #expect(try await engine._evaluateForTesting("typeof globalThis.__mark") == "undefined")
        let mode = try parseZpl(try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: true)))
        #expect(mode.contains("^MMP"))
        #expect(LabelEngineError.isTimeout(LabelEngineError.timeout("buildPlan")))
        #expect(!LabelEngineError.isTimeout(LabelEngineError.unsupported))
        #expect(LabelEngineError.timeout("buildPlan").description == "the label generator took too long (buildPlan)")
    }

    @Test(.timeLimit(.minutes(1)))
    func aCallWaitingBehindARunawayRunsOnTheFreshContextNotTheAbandonedOne() async throws {
        let engine = JavaScriptLabelEngine(timeoutSeconds: { _ in 1 })
        _ = try await engine._evaluateForTesting("String(1)")
        let runaway = Task { try await engine._evaluateForTesting(boundedRunaway) }
        try await Task.sleep(for: .milliseconds(200))
        // Waits its turn in the gate, never on the runaway's thread: once the runaway times out
        // this runs on a fresh context, with its own full time limit.
        let mode = try parseZpl(try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: true)))
        #expect(mode.contains("^MMP"))
        await #expect(throws: LabelEngineError.timeout("_evaluateForTesting")) { try await runaway.value }
    }

    @Test(.timeLimit(.minutes(1)))
    func aRunawaysLateResultNeverAnswersALaterCall() async throws {
        let engine = JavaScriptLabelEngine(timeoutSeconds: { _ in 0.5 })
        await #expect(throws: LabelEngineError.timeout("_evaluateForTesting")) {
            try await engine._evaluateForTesting("const t = Date.now(); while (Date.now() - t < 1500) {} 'late'")
        }
        // While the runaway still spins, and again once it has finished: each call gets its own answer.
        #expect(try await engine._evaluateForTesting("'during'") == "during")
        try await Task.sleep(for: .milliseconds(1500))
        #expect(try await engine._evaluateForTesting("'after'") == "after")
        let mode = try parseZpl(try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: true)))
        #expect(mode.contains("^MMP"))
    }

    @Test(.timeLimit(.minutes(1)))
    func aCallCancelledWhileRunningRetiresItsContextAndFreesTheGate() async throws {
        let engine = JavaScriptLabelEngine()
        #expect(try await engine._evaluateForTesting("globalThis.__mark = 'old'; String(__mark)") == "old")
        let running = Task { try await engine._evaluateForTesting("const t = Date.now(); while (Date.now() - t < 3000) {} 'late'") }
        try await Task.sleep(for: .milliseconds(200))
        let cancelled = Date()
        running.cancel()
        await #expect(throws: CancellationError.self) { try await running.value }
        #expect(Date().timeIntervalSince(cancelled) < 1)

        // The gate is free at once (the spin has seconds to go) and the call runs on a fresh context.
        let started = Date()
        #expect(try await engine._evaluateForTesting("typeof globalThis.__mark") == "undefined")
        let mode = try parseZpl(try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false)))
        #expect(mode.contains("^MMT"))
        #expect(Date().timeIntervalSince(started) < 2, "the next call waited \(Date().timeIntervalSince(started)) s")
    }

    @Test(.timeLimit(.minutes(1)))
    func aStartThatRunsPastItsLimitTimesOut() async throws {
        let real = try String(contentsOf: try #require(Bundle.main.url(forResource: "labelgen", withExtension: "js")), encoding: .utf8)
        let engine = JavaScriptLabelEngine(startTimeoutSeconds: 0.3, bundleSource: {
            Thread.sleep(forTimeInterval: 2)
            return real
        })
        let started = Date()
        await #expect(throws: LabelEngineError.timeout("withPrintMode")) {
            try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false))
        }
        #expect(Date().timeIntervalSince(started) < 1.5)
    }

    @Test(.timeLimit(.minutes(1)))
    func callsRunOneAtATimeSoAPrintHelperWaitsForTheBatchInProgress() async throws {
        let engine = JavaScriptLabelEngine()
        let order = Order()
        _ = try await engine._evaluateForTesting("String(1)") // started, so the batch below is all spin
        let batch = Task {
            let out = try await engine._evaluateForTesting("var end = Date.now() + 700; while (Date.now() < end) {} 'batch'")
            order.add(out)
        }
        try await Task.sleep(for: .milliseconds(150))
        let started = Date()
        _ = try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false))
        order.add("print")
        let waited = Date().timeIntervalSince(started)
        try await batch.value
        #expect(order.all == ["batch", "print"])
        #expect(waited > 0.3, "the print helper waited \(waited) s")
    }

    @Test func aCallerCancelledWhileWaitingItsTurnStopsWaiting() async throws {
        let engine = JavaScriptLabelEngine()
        _ = try await engine._evaluateForTesting("String(1)")
        let batch = Task { try await engine._evaluateForTesting("var end = Date.now() + 1500; while (Date.now() < end) {} 'batch'") }
        try await Task.sleep(for: .milliseconds(150))
        let waiter = Task { try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false)) }
        try await Task.sleep(for: .milliseconds(100))
        let started = Date()
        waiter.cancel()
        await #expect(throws: CancellationError.self) { try await waiter.value }
        #expect(Date().timeIntervalSince(started) < 1)
        #expect(try await batch.value == "batch")
        // The gate is free again.
        _ = try await engine.call("withPrintMode", LabelGenArgs.printMode(zpl: "^XA^XZ", peel: false))
    }

    @Test func printHelpersGetShortTimeoutsAndTheBuildGenerousOnes() {
        #expect(LabelScripts.defaultTimeoutSeconds("withPrintMode") == 5)
        #expect(LabelScripts.defaultTimeoutSeconds("applyPrintSettings") == 5)
        #expect(LabelScripts.defaultTimeoutSeconds("sampleLabel") == 5)
        #expect(LabelScripts.defaultTimeoutSeconds("alignmentTestZpl") == 5)
        #expect(LabelScripts.defaultTimeoutSeconds("renderLabels") == 60)
        #expect(LabelScripts.defaultTimeoutSeconds("buildPlan") == 120)
        #expect(LabelScripts.functions == ["buildPlan", "renderLabels", "sampleLabel", "applyPrintSettings", "withPrintMode", "alignmentTestZpl"])
    }
}
