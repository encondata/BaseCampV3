import Testing
import Foundation
import SwiftData
@testable import ServerSherpa_Kiosk

/// The status snapshots the fake API takes while a sync runs.
private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: SyncStatus] = [:]
    func put(_ key: String, _ status: SyncStatus) { lock.withLock { values[key] = status } }
    subscript(_ key: String) -> SyncStatus? { lock.withLock { values[key] } }
}

/// Which fake API answers ran on the main thread.
private final class MainThreadLog: @unchecked Sendable {
    private let lock = NSLock()
    private var hits: [String: Bool] = [:]
    func mark(_ name: String) {
        let onMain = pthread_main_np() != 0
        lock.withLock { hits[name] = onMain }
    }
    var all: [String: Bool] { lock.withLock { hits } }
}

/// Built outside the main actor so the closures carry no isolation of their own: each runs
/// wherever the sync's call to the API runs.
private func installProbes(on api: FakeKioskApi, log: MainThreadLog, assets: String, templates: String) {
    api.assetsRaw = { log.mark("assets"); return assets }
    api.people = { log.mark("people"); return KioskPeopleSync(generatedAt: "now") }
    api.containers = { log.mark("containers"); return KioskContainersSync(initiativeId: "i1", generatedAt: "now") }
    api.trucks = { log.mark("trucks"); return KioskTrucksSync(initiativeId: "i1", generatedAt: "now") }
    api.templatesRaw = { log.mark("templates"); return templates }
    api.fonts = { log.mark("fonts"); return KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4)]) }
    api.fontContent = { _ in log.mark("fontContent"); return Data([1, 2, 3, 4]) }
}

extension KioskStore {
    /// Test-only: drops one meta row.
    func deleteMeta(_ key: String) throws {
        try modelContext.delete(model: MetaRecord.self, where: #Predicate { $0.key == key })
        try modelContext.save()
    }
}

/// Port of Android `SyncLabelsTest`.
@MainActor
final class SyncLabelsTests {
    private let api = FakeKioskApi()
    private let container: ModelContainer
    private let store: KioskStore
    private let root: URL
    private let fontsDir: URL

    init() throws {
        api.people = { KioskPeopleSync(generatedAt: "now") }
        api.containers = { KioskContainersSync(initiativeId: "i1", generatedAt: "now") }
        api.trucks = { KioskTrucksSync(initiativeId: "i1", generatedAt: "now") }
        api.assets = { KioskAssetsSync(initiativeId: "i1", initiativeName: "Move A", generatedAt: "now") }
        container = try KioskSchema.inMemoryContainer()
        store = KioskStore(modelContainer: container)
        root = FileManager.default.temporaryDirectory.appendingPathComponent("sync-labels-\(UUID().uuidString)")
        fontsDir = root.appendingPathComponent("label-fonts")
    }

    deinit { try? FileManager.default.removeItem(at: root) }

    private func sync(fontsDir: URL? = nil) -> Sync {
        Sync(api: api, store: store, clock: { 1_700_000_000_000 }, fontsDir: fontsDir ?? self.fontsDir)
    }

    // Number literals the generator must see exactly as the server sent them.
    private let asset1 = #"{"id":"a1","asset_id":"A-1","name":"Café ^~_ 😀","make_model":"X","label":{"asset_id":"A-1"},"#
        + #""raw_ft":{"RU":12.0,"Qty":7,"Tiny":1e-05,"Flag":true,"None":null},"source_ru_raw":"14.50"}"#
    private let asset2 = #"{"id":"a2","asset_id":"A-2","make_model":"Y","label":{},"raw_ft":{}}"#
    private let context = #"{"move_name":"Move A","move_code":"MA","move_day":"2026-10-05T00:00:00Z","source_site":"Origin","#
        + #""source_site_code":"OR","destination_site":"Dest","destination_site_code":"DE","catalog_keys":["RU"]}"#

    private func assetsBody(_ assets: String..., withContext: Bool = true) -> String {
        #"{"initiative_id":"i1","initiative_name":"Move A","generated_at":"now","assets":["# + assets.joined(separator: ",") + "]"
            + (withContext ? #","label_context":"# + context : "") + "}"
    }

    private let tplA = #"{"id":"t1","name":"Top","family":"vegas","label_type":"top","size_key":"4x6","dpi_key":"300","#
        + #""language_key":"zpl","version":3,"updated_at":"2026-10-01T00:00:00Z","kind":"design","design":{"schema":2.0,"lines":2.0}}"#
    private let tplB = #"{"id":"t0","name":"Front","family":"generic","label_type":"front","size_key":"2x1","dpi_key":"203","#
        + #""language_key":"zpl","version":1,"updated_at":"2026-09-01T00:00:00Z","kind":"code","code":"^XA^XZ","design":null}"#
    private func templatesBody(_ t: String...) -> String {
        #"{"initiative_id":"i1","generated_at":"now","templates":["# + t.joined(separator: ",") + "]}"
    }

    private let fontBytes = Data([1, 2, 3, 4])

    private func fontCalls() -> [String] { api.calls.filter { $0.hasPrefix("fontContent") } }
    private func fileExists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: fontsDir.appendingPathComponent(name).path) }

    @Test func storesRawPayloadsContextTemplatesAndFontsWithProgress() async throws {
        let s = sync()
        #expect(s.status.parts.map(\.name) == ["assets", "people", "containers", "trucks", "templates", "fonts"])
        #expect(s.status.parts.allSatisfy { $0.state == .waiting })
        let seen = Seen()
        let (asset1, asset2, tplA, tplB, fontBytes) = (self.asset1, self.asset2, self.tplA, self.tplB, self.fontBytes)
        let body = assetsBody(asset1, asset2)
        api.assetsRaw = { seen.put("assets", await MainActor.run { s.status }); return body }
        let templates = templatesBody(tplA, tplB)
        api.templatesRaw = { seen.put("templates", await MainActor.run { s.status }); return templates }
        api.fonts = {
            seen.put("fonts", await MainActor.run { s.status })
            return KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4),
                                           KioskLabelFont(id: "f2", name: "TT0003M_.TTF", size: 100, resident: true)],
                                   missing: ["NOPE.TTF"])
        }
        api.fontContent = { id in #expect(id == "f1"); return fontBytes }

        await s.runNow(initiativeId: "i1", initiativeName: "Move A")

        // While the move tables download, each fetch is running and fonts still waiting.
        let atAssets = try #require(seen["assets"])
        #expect(atAssets.part("assets").state == .running)
        #expect(atAssets.part("fonts").state == .waiting)
        #expect(try #require(seen["templates"]).part("templates").state == .running)
        // Fonts run after the move is stored.
        let atFonts = try #require(seen["fonts"])
        #expect(atFonts.part("fonts").state == .running)
        for n in ["assets", "people", "containers", "trucks", "templates"] { #expect(atFonts.part(n).state == .done, "\(n)") }

        let st = s.status
        #expect(st.phase == .done); #expect(st.error == nil); #expect(st.labelsError == nil)
        #expect(st.parts.allSatisfy { $0.state == .done })
        #expect(Dictionary(uniqueKeysWithValues: st.parts.map { ($0.name, $0.count) })
            == ["assets": 2, "people": 0, "containers": 0, "trucks": 0, "templates": 2, "fonts": 2])

        // Every asset's raw JSON text, byte for byte, beside the typed columns, in the server's order.
        let payloads = try await store.assetPayloads()
        #expect(payloads.map(\.id) == ["a1", "a2"])
        #expect(payloads.map(\.json) == [asset1, asset2])
        #expect(payloads[0].json.contains(#""RU":12.0,"Qty":7,"Tiny":1e-05"#))
        let typed = try await store.assets()
        #expect(typed.map(\.id) == ["a1", "a2"])
        #expect(typed[0].label["asset_id"] == "A-1"); #expect(typed[0].makeModel == "X"); #expect(typed[0].name == "Café ^~_ 😀")
        #expect(try await store.labelContext() == context)

        // Templates as received, in the server's order.
        let stored = try await store.labelTemplates()
        #expect(stored.map(\.id) == ["t1", "t0"])
        #expect(stored.map(\.json) == [tplA, tplB])

        // Font metadata; only the non-resident font is downloaded, to a file.
        let fonts = Dictionary(uniqueKeysWithValues: try await store.labelFonts().map { ($0.id, $0) })
        #expect(fonts["f1"] == LabelFontRow(id: "f1", name: "ROBOTO.TTF", size: 4, resident: false, fileName: "f1.ttf"))
        #expect(fonts["f2"] == LabelFontRow(id: "f2", name: "TT0003M_.TTF", size: 100, resident: true, fileName: nil))
        #expect(try Data(contentsOf: fontsDir.appendingPathComponent("f1.ttf")) == fontBytes)
        #expect(fontCalls() == ["fontContent:f1"])
    }

    @Test func aMissingLabelContextIsStoredAsNull() async throws {
        let body = assetsBody(asset2, withContext: false)
        api.assetsRaw = { body }
        await sync().runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(try await store.labelContext() == "null")
        // An explicit null reads the same.
        let explicit = #"{"initiative_id":"i1","initiative_name":"Move A","generated_at":"now","assets":[],"label_context":null}"#
        api.assetsRaw = { explicit }
        await sync().runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(try await store.labelContext() == "null")
    }

    @Test func aTemplatesFailureKeepsOldTemplatesAndFinishesTheMove() async throws {
        let first = assetsBody(asset1), second = assetsBody(asset2), templates = templatesBody(tplA, tplB)
        api.assetsRaw = { first }
        api.templatesRaw = { templates }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")

        api.assetsRaw = { second }
        api.templatesRaw = { throw ApiError(status: 500, code: "unknown_error") }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")

        let st = s.status
        #expect(st.phase == .done); #expect(st.error == nil)
        #expect(st.labelsError == "unknown_error")
        #expect(st.part("templates").state == .failed)
        #expect(st.part("assets").state == .done); #expect(st.part("fonts").state == .done)
        #expect(try await store.assets().map(\.id) == ["a2"])
        #expect(try await store.labelTemplates().map(\.json) == [tplA, tplB])
    }

    @Test func aFontFailureKeepsOldFontsAndFinishesTheMove() async throws {
        let fontBytes = self.fontBytes
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4)]) }
        api.fontContent = { _ in fontBytes }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(fontCalls().count == 1)

        // An unchanged font already on disk is not downloaded again.
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(fontCalls().count == 1)

        // A new font that fails to download fails only the fonts part.
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4), KioskLabelFont(id: "f3", name: "OPEN.TTF", size: 9)]) }
        api.fontContent = { _ in throw ApiError(status: 0, code: "network") }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let st = s.status
        #expect(st.phase == .done); #expect(st.error == nil); #expect(st.labelsError == "network")
        #expect(st.part("fonts").state == .failed); #expect(st.part("templates").state == .done)
        #expect(try await store.labelFonts().map(\.id) == ["f1"])
        #expect(fileExists("f1.ttf"))

        // A font dropped from the move loses its row and its file.
        api.fonts = { KioskLabelFonts(fonts: []) }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(try await store.labelFonts().isEmpty)
        #expect(!fileExists("f1.ttf"))
    }

    @Test func aFileOfTheWrongSizeIsDownloadedAgain() async throws {
        try FileManager.default.createDirectory(at: fontsDir, withIntermediateDirectories: true)
        try Data([9]).write(to: fontsDir.appendingPathComponent("f1.ttf"))
        let fontBytes = self.fontBytes
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4)]) }
        api.fontContent = { _ in fontBytes }
        await sync().runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(fontCalls() == ["fontContent:f1"])
        #expect(try Data(contentsOf: fontsDir.appendingPathComponent("f1.ttf")) == fontBytes)
    }

    @Test func residentFontsAreNeverDownloadedByNameOrServerRefusal() async throws {
        // Flag false, but the name is Zebra's resident object; a second font the server refuses.
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f2", name: "tt0003m_.ttf", size: 100), KioskLabelFont(id: "f5", name: "OTHER.TTF", size: 7)]) }
        api.fontContent = { id in
            #expect(id == "f5")
            throw ApiError(status: 403, code: "font_not_servable")
        }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let st = s.status
        #expect(st.part("fonts").state == .done); #expect(st.part("fonts").count == 2); #expect(st.labelsError == nil)
        #expect(fontCalls() == ["fontContent:f5"])
        let fonts = Dictionary(uniqueKeysWithValues: try await store.labelFonts().map { ($0.id, $0) })
        #expect(fonts["f2"]?.resident == true); #expect(fonts["f2"]?.fileName == nil)
        #expect(fonts["f5"]?.resident == true); #expect(fonts["f5"]?.fileName == nil)
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: fontsDir.path)) ?? []).isEmpty)
        #expect(isResidentFont("TT0003M_.TTF"))
        #expect(!isResidentFont("ROBOTO.TTF"))
        #expect(isResidentFont("ROBOTO.TTF", residentFlag: true))
    }

    @Test func anotherForbiddenFontFailsTheFontsPart() async throws {
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f5", name: "OTHER.TTF", size: 7)]) }
        api.fontContent = { _ in throw ApiError(status: 403, code: "forbidden") }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.phase == .done); #expect(s.status.labelsError == "forbidden")
        #expect(s.status.part("fonts").state == .failed)
    }

    @Test func anUnsafeFontIdIsNeverUsedAsAFileName() async throws {
        for bad in ["../evil", "a/b", "", String(repeating: "a", count: 65), "f1.ttf", "é"] {
            api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: bad, name: "ROBOTO.TTF", size: 4)]) }
            api.fontContent = { _ in Data([1]) }
            let s = sync()
            await s.runNow(initiativeId: "i1", initiativeName: "Move A")
            #expect(s.status.phase == .done, "\(bad)"); #expect(s.status.part("fonts").state == .failed, "\(bad)")
            #expect(s.status.labelsError == "unknown_error", "\(bad)")
        }
        #expect(fontCalls().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("evil").path))
        // The longest safe id is fine, and a resident font needs no file name at all.
        let longest = String(repeating: "A", count: 63) + "-"
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: longest, name: "ROBOTO.TTF", size: 1), KioskLabelFont(id: "../x", name: "TT0003M_.TTF", size: 1)]) }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.part("fonts").state == .done)
        #expect(fileExists("\(longest).ttf"))
    }

    @Test func failedLabelsAreKeptForTheSameMoveButClearedOnAMoveChange() async throws {
        let body = assetsBody(asset1), templates = templatesBody(tplA), fontBytes = self.fontBytes
        api.assetsRaw = { body }
        api.templatesRaw = { templates }
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4)]) }
        api.fontContent = { _ in fontBytes }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")

        // Same move, both label steps fail: the previous rows stay.
        api.templatesRaw = { throw ApiError(status: 500, code: "unknown_error") }
        api.fonts = { throw ApiError(status: 0, code: "network") }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.phase == .done); #expect(s.status.labelsError == "unknown_error")
        #expect(try await store.labelTemplates().map(\.json) == [tplA])
        #expect(try await store.labelFonts().map(\.id) == ["f1"])
        #expect(fileExists("f1.ttf"))

        // Another move, both fail: the old move's templates and fonts must not drive this one.
        await s.runNow(initiativeId: "i2", initiativeName: "Move B")
        let st = s.status
        #expect(st.phase == .done); #expect(st.error == nil); #expect(st.labelsError == "unknown_error")
        #expect(st.part("templates").state == .failed); #expect(st.part("fonts").state == .failed)
        #expect(try await store.labelCounts() == LabelCounts(templates: 0, fonts: 0))
        #expect(!fileExists("f1.ttf"))
        #expect(try await store.meta()?.initiativeId == "i2")
    }

    @Test func hydrateShowsLabelsWaitingWhenNeverSynced() async throws {
        await sync().runNow(initiativeId: "i1", initiativeName: "Move A")
        // As after the version 2 upgrade: a synced move but no label data yet.
        try await store.deleteMeta(labelContextMetaKey)
        let fresh = sync()
        await fresh.hydrate()
        let st = fresh.status
        #expect(st.phase == .done)
        for n in ["assets", "people", "containers", "trucks"] { #expect(st.part(n).state == .done, "\(n)") }
        #expect(st.part("templates").state == .waiting); #expect(st.part("templates").count == nil)
        #expect(st.part("fonts").state == .waiting)
    }

    @Test func aMoveFailureMarksItsPartAndKeepsEverything() async throws {
        let body = assetsBody(asset1), first = templatesBody(tplA), second = templatesBody(tplB)
        api.assetsRaw = { body }
        api.templatesRaw = { first }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        api.trucks = { throw ApiError(status: 0, code: "network") }
        api.templatesRaw = { second }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let st = s.status
        #expect(st.phase == .error); #expect(st.error == "network")
        #expect(st.part("trucks").state == .failed)
        #expect(!st.parts.contains { $0.state == .running })
        #expect(try await store.labelTemplates().map(\.json) == [tplA])
        #expect(try await store.counts().assets == 1)
    }

    @Test func anUnreadableAssetsBodyFailsTheAssetsPart() async throws {
        api.assetsRaw = { #"{"initiative_id":"i1","assets":[{"id":"a1"},]}"# }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.phase == .error); #expect(s.status.error == "unknown_error")
        #expect(s.status.part("assets").state == .failed)
        #expect(!s.status.parts.contains { $0.state == .running })
        #expect(try await store.meta() == nil)
    }

    @Test func hydrateAndClearCoverTheLabelData() async throws {
        let body = assetsBody(asset1), templates = templatesBody(tplA), fontBytes = self.fontBytes
        api.assetsRaw = { body }
        api.templatesRaw = { templates }
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4)]) }
        api.fontContent = { _ in fontBytes }
        await sync().runNow(initiativeId: "i1", initiativeName: "Move A")
        let context = ModelContext(container)
        context.insert(GeneratedLabelRecord(assetId: "a1", zpl: "^XA^XZ", outcome: "ok", fingerprint: "fp", templateId: "t1"))
        try context.save()

        let fresh = sync()
        await fresh.hydrate()
        #expect(fresh.status.part("templates").count == 1)
        #expect(fresh.status.part("fonts").count == 1)
        #expect(fresh.status.parts.allSatisfy { $0.state == .done })

        try await fresh.clearLocalData()
        #expect(try await store.labelCounts() == LabelCounts(templates: 0, fonts: 0))
        #expect(try ModelContext(container).fetchCount(FetchDescriptor<GeneratedLabelRecord>()) == 0)
        #expect(try await store.labelContext() == nil)
        #expect(!fileExists("f1.ttf"))
        #expect(fresh.status.parts.allSatisfy { $0.state == .waiting })
    }

    @Test func downloadsAndDecodingRunOffTheMainThread() async throws {
        let log = MainThreadLog()
        installProbes(on: api, log: log, assets: assetsBody(asset1), templates: templatesBody(tplA))
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.phase == .done); #expect(s.status.labelsError == nil)
        #expect(log.all == ["assets": false, "people": false, "containers": false, "trucks": false,
                            "templates": false, "fonts": false, "fontContent": false])
        // The API members themselves (where the real client decodes) ran off the main thread.
        #expect(Set(api.calls) == ["syncAssets", "syncPeople", "syncContainers", "syncTrucks", "labelTemplates", "labelFonts", "fontContent:f1"])
        #expect(api.mainThreadCalls == [])
        #expect(fileExists("f1.ttf"))
    }

    @Test func templatesThatAreNotObjectsOrLackAStringIdAreSkipped() async throws {
        let body = templatesBody("7", #""t9""#, "null", "[]", #"{"id":5,"name":"N"}"#, #"{"name":"no id"}"#, #"{"id":null}"#, tplA, tplB)
        api.templatesRaw = { body }
        let s = sync()
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.part("templates").state == .done); #expect(s.status.part("templates").count == 2)
        #expect(try await store.labelTemplates() == [LabelTemplateRow(id: "t1", json: tplA), LabelTemplateRow(id: "t0", json: tplB)])
    }

    @Test func aFontCleanupFailureAfterTheSwapKeepsTheNewRows() async throws {
        // A move change (no stored move yet) with only resident fonts: nothing is written, the
        // rows are swapped, then the folder cannot be listed. The new rows must stay.
        let s = sync(fontsDir: try brokenFontsDir())
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f2", name: "TT0003M_.TTF", size: 9)]) }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        #expect(s.status.phase == .done); #expect(s.status.labelsError == nil)
        #expect(s.status.part("fonts").state == .done)
        #expect(try await store.labelFonts().map(\.id) == ["f2"])
        // Clearing local data still succeeds when the folder cannot be cleaned.
        try await s.clearLocalData()
        #expect(try await store.labelFonts().isEmpty)
        #expect(s.status == SyncStatus())
    }

    /// A fonts "directory" that is really a file: listing and writing fail, like a read-only
    /// or vanished volume.
    private func brokenFontsDir() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("not-a-dir")
        try Data([0]).write(to: file)
        return file
    }

    @Test func aThrowingFontCleanupEndsTheSyncDoneWithALabelsError() async throws {
        // A move change makes a failed font step clear the fonts; that cleanup throws too.
        let s = sync(fontsDir: try brokenFontsDir())
        api.fonts = { throw ApiError(status: 0, code: "network") }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let st = s.status
        #expect(st.phase == .done); #expect(st.error == nil)
        #expect(st.labelsError == "network")
        #expect(st.part("fonts").state == .failed)
        #expect(!st.parts.contains { $0.state == .running })
        #expect(try await store.meta()?.initiativeId == "i1")
    }

    @Test func aFontFileThatCannotBeWrittenEndsTheSyncDone() async throws {
        let s = sync(fontsDir: try brokenFontsDir())
        api.fonts = { KioskLabelFonts(fonts: [KioskLabelFont(id: "f1", name: "ROBOTO.TTF", size: 4)]) }
        api.fontContent = { _ in Data([1, 2, 3, 4]) }
        await s.runNow(initiativeId: "i1", initiativeName: "Move A")
        let st = s.status
        #expect(st.phase == .done); #expect(st.error == nil)
        #expect(st.labelsError == "unknown_error")
        #expect(st.part("fonts").state == .failed)
        #expect(!st.parts.contains { $0.state == .running })
        #expect(try await store.labelFonts().isEmpty)
    }
}

extension SyncStatus {
    func part(_ name: String) -> SyncPart { parts.first { $0.name == name }! }
}
