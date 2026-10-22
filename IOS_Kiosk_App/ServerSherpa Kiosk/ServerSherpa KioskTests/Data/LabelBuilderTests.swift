import Testing
import Foundation
import Observation
import SwiftData
@testable import ServerSherpa_Kiosk

/// Label settings a test changes by hand (Android's `MutableStateFlow` source).
@MainActor @Observable final class FakeLabelSettings: LabelSettingsSource {
    var value: LabelSettings

    init(_ value: LabelSettings) { self.value = value }

    func current() -> LabelSettings { value }
    func updates() -> AsyncStream<LabelSettings> { observationStream { [unowned self] in self.value } }
}

/// The warnings the builder logs.
private final class Warnings: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ line: String) { lock.withLock { lines.append(line) } }
    var all: [String] { lock.withLock { lines } }
}

extension KioskStore {
    /// Test-only: writes one meta row.
    func putMeta(_ key: String, _ value: String) throws {
        try modelContext.delete(model: MetaRecord.self, where: #Predicate { $0.key == key })
        modelContext.insert(MetaRecord(key: key, value: value))
        try modelContext.save()
    }

    /// Test-only: inserts generated labels as they are.
    func insertGeneratedLabels(_ rows: [GeneratedLabelRow]) throws {
        for r in rows {
            modelContext.insert(GeneratedLabelRecord(assetId: r.assetId, zpl: r.zpl, outcome: r.outcome,
                                                     fingerprint: r.fingerprint, templateId: r.templateId))
        }
        try modelContext.save()
    }

    /// Test-only: every generated label by asset id.
    func allGeneratedLabels() throws -> [String: GeneratedLabelRow] {
        var out: [String: GeneratedLabelRow] = [:]
        for r in try modelContext.fetch(FetchDescriptor<GeneratedLabelRecord>()) {
            out[r.assetId] = GeneratedLabelRow(assetId: r.assetId, zpl: r.zpl, outcome: r.outcome, fingerprint: r.fingerprint,
                                               templateId: r.templateId)
        }
        return out
    }

    func deleteAllGeneratedLabels() throws {
        try modelContext.delete(model: GeneratedLabelRecord.self)
        try modelContext.save()
    }
}

/// Port of Android `LabelBuilderTest`.
@MainActor
final class LabelBuilderTests {
    private let engine = FakeLabelEngine()
    private let printer = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "XYZ1", dpi: 203)
    private let settings: FakeLabelSettings
    private let store: KioskStore
    nonisolated private static let context = #"{"move_name":"Move A","catalog_keys":["RU"]}"#
    nonisolated private static let templates = [LabelTemplateRow(id: "t1", json: #"{"id":"t1","design":{"schema":2.0}}"#),
                                    LabelTemplateRow(id: "t0", json: #"{"id":"t0"}"#)]

    init() throws {
        settings = FakeLabelSettings(LabelSettings(kind: .top, printer: printer))
        store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
    }

    private func builder(batch: Int = 2, planChunk: Int = LabelBuilder.planChunk,
                         warn: @escaping @Sendable (String) -> Void = { _ in }) -> LabelBuilder {
        LabelBuilder(store: store, engine: engine, settings: settings, batchSize: batch, planChunk: planChunk, warn: warn)
    }

    nonisolated private func payload(_ id: String, _ extra: String = "") -> String {
        #"{"id":"\#(id)","asset_id":"A-\#(id)","raw_ft":{"RU":12.0}\#(extra)}"#
    }

    private func seed(_ ids: [String], context: String? = LabelBuilderTests.context, payloads: [String: String] = [:],
                      templates: [LabelTemplateRow] = LabelBuilderTests.templates) async throws {
        let meta = SyncMeta(initiativeId: "i1", initiativeName: "Move A", assets: ids.count, people: 0, containers: 0, trucks: 0,
                            syncedAt: "2026-10-21T00:00:00Z")
        try await store.replaceRoster(assets: ids.map { KioskAssetRow(id: $0, assetId: "A-\($0)") }, people: [], containers: [],
                                      trucks: [], meta: meta, payloads: ids.map { payloads[$0] ?? payload($0) },
                                      labelContext: context, templates: templates)
        if context == nil { try await store.deleteMeta(labelContextMetaKey) }
    }

    private func stored() async throws -> [String: GeneratedLabelRow] { try await store.allGeneratedLabels() }

    private func waitFor(_ what: String, _ check: () async throws -> Bool) async throws {
        let end = ContinuousClock.now + .seconds(5)
        while try await !check() {
            if ContinuousClock.now > end { Issue.record("timed out waiting for \(what)"); return }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    @Test func firstBuildRendersAllInBatchesStoresThemAndReportsProgress() async throws {
        try await seed(["a1", "a2", "a3", "a4", "a5"], payloads: ["a4": payload("a4", #","outcome":"no_template_at_dpi""#)])
        let b = builder(batch: 2)
        var seen: [LabelBuildStatus] = []
        engine.onRender = { seen.append(b.monitor.status) }

        await b.buildNow("sync")

        #expect(engine.calls.map(\.fn) == ["buildPlan", "renderLabels", "renderLabels", "renderLabels"])
        // Progress as each batch starts, then complete.
        #expect(seen.map(\.done) == [0, 2, 4])
        #expect(seen.allSatisfy { $0.phase == .running && $0.total == 5 })
        let s = b.monitor.status
        #expect(s.phase == .done)
        #expect(s.done == 5); #expect(s.total == 5)
        #expect(s.ready == 4)
        #expect(s.problems == [OutcomeCount(code: NO_TEMPLATE_AT_DPI, count: 1)])
        #expect(s.notes == ["a pick note"])
        #expect(s.templateId == "t1")
        #expect(s.fonts == ["ROBOTO.TTF"])
        #expect(s.needs == nil)

        let rows = try await stored()
        #expect(Set(rows.keys) == ["a1", "a2", "a3", "a4", "a5"])
        #expect(rows["a1"]?.zpl == "^XA^FDa1 top 203^FS^XZ")
        #expect(rows["a1"]?.outcome == "ok")
        #expect(rows["a1"]?.templateId == "t1")
        #expect(rows["a4"]?.zpl == nil)
        #expect(rows["a4"]?.outcome == NO_TEMPLATE_AT_DPI)
        // Stored fingerprints are the plan's.
        let planned = try parsePlan(try #require(engine.lastPlan)).jobs
        #expect(Dictionary(uniqueKeysWithValues: planned.map { ($0.assetId, $0.fingerprint) }) == rows.mapValues(\.fingerprint))
        let plan = try #require(engine.calls.first)
        #expect(plan.string("kind") == "top")
        #expect(plan.args["dpi"] as? Int == 203)
    }

    @Test func theBodiesAreRebuiltFromStoredRowsAndEachBatchCarriesOnlyItsAssets() async throws {
        try await seed(["a1", "a2", "a3"])
        await builder(batch: 2).buildNow("sync")

        let planArgs = engine.calls[0]
        #expect(planArgs.string("assetsJson")
            == #"{"initiative_id":"i1","assets":["# + [payload("a1"), payload("a2"), payload("a3")].joined(separator: ",")
            + #"],"label_context":"# + Self.context + "}")
        #expect(planArgs.string("templatesJson") == #"{"templates":[{"id":"t1","design":{"schema":2.0}},{"id":"t0"}]}"#)
        let second = engine.calls[2]
        #expect(second.assetIds == ["a3"])
        #expect(second.string("assetsJson") == #"{"initiative_id":"i1","assets":["# + payload("a3") + #"],"label_context":"# + Self.context + "}")
    }

    /// A large move's plan never crosses in one call: each `buildPlan` carries one chunk of
    /// assets, and the plan they make together is the one a single call makes.
    @Test func thePlanGoesInChunksAndEqualsTheWholeMovesPlan() async throws {
        try await seed(["a1", "a2", "a3", "a4", "a5"], payloads: ["a4": payload("a4", #","outcome":"no_template_at_dpi""#)])
        let whole = builder(batch: 2, planChunk: 100)
        await whole.buildNow("sync")
        let wholeBody = try #require(engine.calls.first { $0.fn == "buildPlan" }).string("assetsJson")
        #expect(engine.count("buildPlan") == 1)
        let wholeStatus = whole.monitor.status
        let wholeRows = try await stored()

        try await store.deleteAllGeneratedLabels()
        engine.clearCalls()
        let chunked = builder(batch: 2, planChunk: 2)
        await chunked.buildNow("sync")

        let plans = engine.calls.filter { $0.fn == "buildPlan" }.map { $0.string("assetsJson") }
        let perCall = plans.map(FakeLabelEngine.object)
        #expect(perCall.map { ($0["assets"] as? [[String: Any]] ?? []).map { $0["id"] as? String ?? "" } }
            == [["a1", "a2"], ["a3", "a4"], ["a5"]])
        #expect(perCall.allSatisfy { $0["label_context"] is [String: Any] })
        #expect(plans.allSatisfy { $0.count < wholeBody.count })
        #expect(chunked.monitor.status == wholeStatus)
        #expect(try await stored() == wholeRows)
    }

    @Test func anEmptyMoveStillPlansOnceAndPrunesEverything() async throws {
        try await seed([])
        try await store.insertGeneratedLabels([GeneratedLabelRow(assetId: "gone", zpl: "^XA^XZ", outcome: "ok", fingerprint: "old", templateId: "t1")])
        let b = builder(planChunk: 2)
        await b.buildNow("sync")
        #expect(engine.count("buildPlan") == 1)
        #expect(b.monitor.status.phase == .done)
        #expect(try await stored().isEmpty)
    }

    /// A sync lands between two reads only if they are separate: the move, its label context, its
    /// payloads and the templates are one store read. Syncs of two moves race the reads; every
    /// read must see one move whole (Android checks the SQL log for one transaction).
    @Test func theBuildReadsTheMoveAndTheTemplatesInOneRead() async throws {
        let moves = [("i1", ["a1", "a2"], "tA"), ("i2", ["b1", "b2", "b3"], "tB")]
        func write(_ i: Int) async throws {
            let (initiative, ids, template) = moves[i % 2]
            let meta = SyncMeta(initiativeId: initiative, initiativeName: initiative, assets: ids.count, people: 0, containers: 0,
                                trucks: 0, syncedAt: "2026-10-21T00:00:00Z")
            try await store.replaceRoster(assets: ids.map { KioskAssetRow(id: $0) }, people: [], containers: [], trucks: [], meta: meta,
                                          payloads: ids.map { payload($0) }, labelContext: #"{"move":"\#(initiative)"}"#,
                                          templates: [LabelTemplateRow(id: template, json: #"{"id":"\#(template)"}"#)])
        }
        try await write(0)
        let reader = self.store
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { for i in 1...40 { try await write(i) } }
            group.addTask {
                for _ in 1...40 {
                    let s = try await reader.labelBuildSnapshot(withRows: true)
                    let meta = try #require(s.meta)
                    let expected = meta.initiativeId == "i1" ? moves[0] : moves[1]
                    #expect(s.payloads.map(\.id) == expected.1)
                    #expect(s.templates.map(\.id) == [expected.2])
                    #expect(s.labelContext == #"{"move":"\#(meta.initiativeId)"}"#)
                }
            }
            try await group.waitForAll()
        }
    }

    @Test func anUnchangedSecondBuildRendersNothing() async throws {
        try await seed(["a1", "a2", "a3"])
        let b = builder()
        await b.buildNow("sync")
        engine.clearCalls()

        await b.buildNow("sync")

        #expect(engine.calls.map(\.fn) == ["buildPlan"])
        let s = b.monitor.status
        #expect(s.phase == .done)
        #expect(s.total == 0); #expect(s.done == 0)
        #expect(s.ready == 3)
    }

    @Test func onlyChangedAssetsRenderAndGoneAssetsArePruned() async throws {
        try await seed(["a1", "a2", "a3"])
        let b = builder()
        await b.buildNow("sync")
        engine.clearCalls()

        try await seed(["a1", "a2", "a4"], payloads: ["a2": payload("a2", #","name":"renamed""#)])
        await b.buildNow("sync")

        #expect(engine.renderedIds() == ["a2", "a4"])
        #expect(Set(try await stored().keys) == ["a1", "a2", "a4"])
        #expect(b.monitor.status.total == 2)
        #expect(b.monitor.status.ready == 3)
    }

    @Test func aKindChangeRendersEverythingAgain() async throws {
        try await seed(["a1", "a2", "a3"])
        let b = builder()
        await b.buildNow("sync")
        engine.clearCalls()

        settings.value.kind = .front
        await b.buildNow("setup")

        #expect(engine.renderedIds() == ["a1", "a2", "a3"])
        #expect(try await stored()["a1"]?.zpl == "^XA^FDa1 front 203^FS^XZ")
        #expect(b.monitor.status.total == 3)
    }

    @Test func aDpiChangeRendersEverythingAgain() async throws {
        try await seed(["a1", "a2"])
        let b = builder()
        await b.buildNow("sync")
        engine.clearCalls()

        settings.value.printer?.dpi = 300
        await b.buildNow("printer")

        #expect(engine.renderedIds() == ["a1", "a2"])
        #expect(try await stored()["a1"]?.zpl == "^XA^FDa1 top 300^FS^XZ")
    }

    @Test func noPrinterSavedIsDoneWithNothingToBuildAndSaysAPrinterIsNeeded() async throws {
        try await seed(["a1", "a2"])
        try await store.insertGeneratedLabels([GeneratedLabelRow(assetId: "a1", zpl: "^XA^XZ", outcome: "ok", fingerprint: "old", templateId: "t1")])
        settings.value = LabelSettings(kind: .top, printer: nil)
        let b = builder()

        await b.buildNow("sync")

        let s = b.monitor.status
        #expect(s.phase == .done)
        #expect(s.total == 0)
        #expect(s.needs == .printer)
        #expect(engine.calls.isEmpty)
        #expect(Set(try await stored().keys) == ["a1"])
    }

    @Test func unsupportedDevice() async throws {
        try await seed(["a1"])
        engine.supported = false
        let b = builder()
        await b.buildNow("start")
        #expect(b.monitor.status.phase == .unsupportedDevice)
        #expect(engine.calls.isEmpty)

        // The engine may also find out only when it connects.
        engine.supported = true
        engine.unsupportedOnCall = true
        await b.buildNow("start")
        #expect(b.monitor.status.phase == .unsupportedDevice)
    }

    @Test func aBatchThrowingIsAnErrorAndKeepsEarlierLabels() async throws {
        try await seed(["a0"])
        let b = builder(batch: 2)
        await b.buildNow("sync")
        engine.clearCalls()

        try await seed(["a1", "a2", "a3", "a4", "a5"])
        engine.failRender = engine.renders + 2
        await b.buildNow("sync")

        let s = b.monitor.status
        #expect(s.phase == .error)
        #expect(s.done == 2); #expect(s.total == 5); #expect(s.ready == 2)
        #expect(s.error == "isolate died")
        // The first batch's labels are stored; nothing was pruned (a0 left the move but stays until a good build).
        #expect(Set(try await stored().keys) == ["a0", "a1", "a2"])
    }

    @Test func aPlanErrorIsAnErrorAndKeepsStoredLabels() async throws {
        try await seed(["a1"])
        try await store.insertGeneratedLabels([GeneratedLabelRow(assetId: "gone", zpl: "^XA^XZ", outcome: "ok", fingerprint: "old", templateId: "t1")])
        engine.planAnswer = { #"{"error":"bad printer DPI: 0"}"# }
        let b = builder()

        await b.buildNow("sync")

        #expect(b.monitor.status.phase == .error)
        #expect(b.monitor.status.error == "bad printer DPI: 0")
        #expect(Set(try await stored().keys) == ["gone"])
        #expect(engine.count("renderLabels") == 0)
        // Printer Setup's checks stop waiting for this kind and DPI's pick.
        #expect(b.monitor.pick == LabelPick(kind: .top, dpi: 203, synced: true, failed: true))
    }

    @Test func aRenderErrorAnswerIsAnError() async throws {
        try await seed(["a1"])
        engine.renderAnswer = { #"{"error":"assetIds must be a list of strings"}"# }
        let b = builder()
        await b.buildNow("sync")
        #expect(b.monitor.status.phase == .error)
        #expect(try await stored().isEmpty)
    }

    @Test func withoutAssetDataNothingIsPrunedAndASyncIsNeeded() async throws {
        // Right after the version 2 upgrade: payloads are {} and there is no label_context row.
        try await seed(["a1", "a2"], context: nil, payloads: ["a1": "{}", "a2": "{}"])
        try await store.insertGeneratedLabels([GeneratedLabelRow(assetId: "a1", zpl: "^XA^XZ", outcome: "ok", fingerprint: "old", templateId: "t1")])
        let b = builder()

        await b.buildNow("start")

        #expect(b.monitor.status.phase == .done)
        #expect(b.monitor.status.needs == .sync)
        #expect(Set(try await stored().keys) == ["a1"])
        #expect(engine.count("renderLabels") == 0)

        // A context the server sent as null: the plan says it has no asset data.
        try await seed(["a1", "a2"], context: "null")
        await b.buildNow("sync")
        #expect(engine.count("buildPlan") == 1)
        #expect(b.monitor.status.phase == .done)
        #expect(b.monitor.status.needs == .sync)
        #expect(Set(try await stored().keys) == ["a1"])
        #expect(engine.count("renderLabels") == 0)
    }

    @Test func neverSyncedNeedsASync() async throws {
        let b = builder()
        await b.buildNow("start")
        #expect(b.monitor.status.phase == .done)
        #expect(b.monitor.status.needs == .sync)
        #expect(engine.calls.isEmpty)
    }

    @Test func aFinishedSyncTriggersABuildAndClearingResetsTheStatus() async throws {
        try await seed(["a1", "a2"])
        let b = builder()
        let (sync, feed) = AsyncStream.makeStream(of: SyncStatus.self)
        feed.yield(SyncStatus(phase: .running))
        let following = await b.start(syncStatus: sync)
        defer { following.cancel() }

        feed.yield(SyncStatus(phase: .done))
        try await waitFor("the build") { b.monitor.status.phase == .done }
        #expect(b.monitor.status.ready == 2)
        #expect(Set(try await stored().keys) == ["a1", "a2"])

        // "Clear local data" puts the sync back to idle.
        feed.yield(SyncStatus())
        try await waitFor("idle") { b.monitor.status.phase == .idle }
    }

    @Test func rebuildRunsInTheBackgroundAndALaterRequestWins() async throws {
        try await seed(["a1", "a2", "a3"])
        let b = builder(batch: 1)
        await b.rebuild(reason: "sync")
        settings.value.kind = .front
        await b.rebuild(reason: "setup")
        try await waitFor("the front build") {
            let rows = try await stored()
            return b.monitor.status.phase == .done && rows.count == 3 && rows.values.allSatisfy { $0.zpl?.contains("front") == true }
        }
    }

    @Test func aKindOrDpiChangeAfterStartRebuildsOnItsOwn() async throws {
        try await seed(["a1", "a2"])
        let b = builder()
        let (sync, feed) = AsyncStream.makeStream(of: SyncStatus.self)
        feed.yield(SyncStatus(phase: .running))
        let following = await b.start(syncStatus: sync)
        defer { following.cancel() }
        // Following alone builds nothing: the settings' value at the start is not a change.
        try await Task.sleep(for: .milliseconds(200))
        #expect(engine.calls.isEmpty)
        feed.yield(SyncStatus(phase: .done))
        try await waitFor("the first build") { try await stored().count == 2 && b.monitor.status.phase == .done }
        // The settings' current value is not a change: one build so far.
        try await Task.sleep(for: .milliseconds(200))
        #expect(engine.count("buildPlan") == 1)

        settings.value.kind = .front
        try await waitFor("a front build") {
            try await stored().values.allSatisfy { $0.zpl?.contains("front") == true } && b.monitor.status.phase == .done
        }

        settings.value.printer?.dpi = 300
        try await waitFor("a 300 dpi build") {
            try await stored().values.allSatisfy { $0.zpl?.contains("300") == true } && b.monitor.status.phase == .done
        }

        // Offsets and peel never rebuild.
        let plans = engine.count("buildPlan")
        settings.value.offsetX = 12
        settings.value.peel = true
        try await Task.sleep(for: .milliseconds(200))
        #expect(engine.count("buildPlan") == plans)
    }

    @Test func clearingLocalDataMidBuildWritesNothing() async throws {
        try await seed(["a1", "a2", "a3"])
        let store = self.store
        engine.onRender = {
            try? await store.deleteMeta(syncMetaKey)
            try? await store.deleteMeta(labelContextMetaKey)
        }
        let b = builder(batch: 2)

        await b.buildNow("sync")

        #expect(try await stored().isEmpty)
        #expect(engine.count("renderLabels") == 1)
        #expect(b.monitor.status.phase == .idle)
    }

    @Test func aMoveChangeMidBuildWritesNothingAndPrunesNothing() async throws {
        try await seed(["a1"])
        try await store.insertGeneratedLabels([GeneratedLabelRow(assetId: "other-move", zpl: "^XA^XZ", outcome: "ok", fingerprint: "x", templateId: "t9")])
        let store = self.store
        engine.onRender = {
            let meta = SyncMeta(initiativeId: "i2", initiativeName: "Move B", assets: 1, people: 0, containers: 0, trucks: 0,
                                syncedAt: "2026-10-21T01:00:00Z")
            try? await store.putMeta(syncMetaKey, String(decoding: try! KioskJSON.encoder.encode(meta), as: UTF8.self))
        }
        await builder().buildNow("sync")
        #expect(Set(try await stored().keys) == ["other-move"])
    }

    @Test func aNewRequestCancelsTheRunningBuildAndAnyWaitingOne() async throws {
        try await seed(["a1", "a2", "a3"])
        let b = builder(batch: 1)
        engine.gate = true
        await b.rebuild(reason: "A")
        try await waitFor("the gate") { engine.atGate }

        settings.value.kind = .front
        await b.rebuild(reason: "B")
        await b.rebuild(reason: "C")

        try await waitFor("the front build") {
            let rows = try await stored()
            return b.monitor.status.phase == .done && rows.count == 3 && rows.values.allSatisfy { $0.zpl?.contains("front") == true }
        }
        // A was cancelled while rendering: its batch never finished or stored.
        #expect(engine.gatePassed == 0)
        // A and C planned; B was cancelled before it began.
        #expect(engine.count("buildPlan") == 2)
    }

    @Test func stopCancelsTheBuildAndItWritesNothingAfter() async throws {
        try await seed(["a1", "a2"])
        let b = builder(batch: 1)
        engine.gate = true
        await b.rebuild(reason: "sync")
        try await waitFor("the gate") { engine.atGate }

        await b.stop()

        try await waitFor("idle") { b.monitor.status.phase == .idle }
        try await Task.sleep(for: .milliseconds(200))
        #expect(b.monitor.status.phase == .idle)
        #expect(try await stored().isEmpty)
        #expect(engine.gatePassed == 0)
    }

    @Test func missingAndMismatchedResultsAreCountedInTheLog() async throws {
        try await seed(["a1", "a2"])
        engine.mutateResults = { list in
            list.dropFirst().map { var r = $0; r["fingerprint"] = "other"; return r }
        }
        let warnings = Warnings()
        await builder(warn: { warnings.add($0) }).buildNow("sync")
        #expect(warnings.all.contains { $0.contains("1 labels missing") && $0.contains("1 with a fingerprint unlike the plan's") },
                "\(warnings.all)")
    }

    @Test func thePickNamesTheTemplateWithItsSizeForPrinterSetup() async throws {
        try await seed(["a1"], templates: [LabelTemplateRow(id: "t1", json: #"{"id":"t1","name":"Vegas Top","width_in":4,"height_in":2.5,"design":{"schema":2.0}}"#),
                                           LabelTemplateRow(id: "t0", json: #"{"id":"t0"}"#)])
        let b = builder()
        await b.buildNow("sync")
        let pick = try #require(b.monitor.pick)
        #expect(pick.kind == .top); #expect(pick.dpi == 203); #expect(pick.synced)
        #expect(pick.templateId == "t1"); #expect(pick.templateName == "Vegas Top")
        #expect(pick.fonts == ["ROBOTO.TTF"]); #expect(pick.notes == ["a pick note"])
        #expect(pick.widthIn == 4.0); #expect(pick.heightIn == 2.5)
        #expect(!pick.failed)
    }

    @Test func neverSyncedPicksNothingAndStopClearsThePick() async throws {
        let b = builder()
        await b.buildNow("sync")
        #expect(b.monitor.pick == LabelPick(kind: .top, dpi: 203, synced: false))
        try await seed(["a1"])
        await b.buildNow("sync")
        #expect(b.monitor.pick?.synced == true)
        await b.stop()
        try await waitFor("idle") { b.monitor.status.phase == .idle }
        #expect(b.monitor.pick == nil)
    }
}
