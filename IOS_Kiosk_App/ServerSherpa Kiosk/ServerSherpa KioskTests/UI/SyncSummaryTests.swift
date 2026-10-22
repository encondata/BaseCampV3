import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// Android SyncSummaryTest. The rendering cases there are ported as `SyncSummary.content`
/// checks: what the summary shows for each phase.
@MainActor
struct SyncSummaryTests {
    private func parts(_ states: [String: SyncPart] = [:]) -> [SyncPart] {
        SyncPart.names.map { states[$0] ?? SyncPart(name: $0, state: .waiting) }
    }

    private func done(templates: Int? = 4, fonts: Int? = 2, templatesState: PartState = .done, fontsState: PartState = .done) -> SyncStatus {
        SyncStatus(phase: .done, assets: 10, people: 3, containers: 2, trucks: 1, syncedAt: "2026-10-21T14:14:00Z",
                   parts: parts([
                       "assets": SyncPart(name: "assets", state: .done, count: 10),
                       "people": SyncPart(name: "people", state: .done, count: 3),
                       "containers": SyncPart(name: "containers", state: .done, count: 2),
                       "trucks": SyncPart(name: "trucks", state: .done, count: 1),
                       "templates": SyncPart(name: "templates", state: templatesState, count: templatesState == .done ? templates : nil),
                       "fonts": SyncPart(name: "fonts", state: fontsState, count: fontsState == .done ? fonts : nil),
                   ]))
    }

    private func beforeSynced(_ line: String) -> String {
        line.components(separatedBy: " · synced").first ?? line
    }

    @Test func localDataLineAddsTemplatesAndFontsWhenSynced() {
        let line = SyncSummary.localDataLine(done())
        #expect(beforeSynced(line) == "Local data: 10 assets · 3 people · 2 containers · 1 truck · 4 label templates · 2 fonts")
        #expect(line.contains(" · synced "))
    }

    @Test func localDataLineSaysSingularAndSkipsPartsThatAreNotDone() {
        let one = beforeSynced(SyncSummary.localDataLine(done(templates: 1, fonts: 1)))
        #expect(one == "Local data: 10 assets · 3 people · 2 containers · 1 truck · 1 label template · 1 font")
        let ones = beforeSynced(SyncSummary.localDataLine(SyncStatus(phase: .done, assets: 1, people: 1, containers: 1, trucks: 1)))
        #expect(ones == "Local data: 1 asset · 1 person · 1 container · 1 truck")
        // Never synced (after the version 2 upgrade) or failed: no label counts at all.
        let waiting = beforeSynced(SyncSummary.localDataLine(done(templatesState: .waiting, fontsState: .waiting)))
        #expect(waiting == "Local data: 10 assets · 3 people · 2 containers · 1 truck")
        let failed = beforeSynced(SyncSummary.localDataLine(done(templatesState: .failed, fontsState: .failed)))
        #expect(failed == "Local data: 10 assets · 3 people · 2 containers · 1 truck")
    }

    @Test func localDataLineCountsMissingNumbersAsZeroAndEndsWithTheSyncTime() {
        #expect(SyncSummary.localDataLine(SyncStatus(phase: .done)) == "Local data: 0 assets · 0 people · 0 containers · 0 trucks")
        let line = SyncSummary.localDataLine(done())
        #expect(line.hasSuffix(" · synced \(Sync.formatSyncedAt("2026-10-21T14:14:00Z"))"))
    }

    @Test func partLinesCoverEveryPartInOrderWithItsState() {
        let running = SyncStatus(phase: .running, parts: parts([
            "assets": SyncPart(name: "assets", state: .done, count: 10),
            "people": SyncPart(name: "people", state: .running),
            "containers": SyncPart(name: "containers", state: .failed),
        ]))
        let lines = SyncSummary.partLines(running)
        #expect(lines.map(\.text) == ["Assets · done (10)", "People · downloading…", "Containers · failed", "Trucks · waiting", "Label templates · waiting", "Fonts · waiting"])
        #expect(lines.map(\.label) == ["Assets", "People", "Containers", "Trucks", "Label templates", "Fonts"])
        #expect(lines.map(\.state) == [.done, .running, .failed, .waiting, .waiting, .waiting])
    }

    @Test func aDonePartWithoutACountSaysDone() {
        let st = SyncStatus(phase: .running, parts: parts(["fonts": SyncPart(name: "fonts", state: .done)]))
        #expect(SyncSummary.partLines(st).last?.text == "Fonts · done")
    }

    @Test func labelsWarningNamesTheStepThatFailed() {
        #expect(SyncSummary.labelsWarning(done()) == nil)
        var t = done(templatesState: .failed); t.labelsError = "network"
        #expect(SyncSummary.labelsWarning(t) == "Label templates couldn't be downloaded. Labels may be out of date.")
        var f = done(fontsState: .failed); f.labelsError = "network"
        #expect(SyncSummary.labelsWarning(f) == "Fonts couldn't be downloaded. Labels may be out of date.")
        var both = done(templatesState: .failed, fontsState: .failed); both.labelsError = "network"
        #expect(SyncSummary.labelsWarning(both) == "Label templates and fonts couldn't be downloaded. Labels may be out of date.")
        // An error code with no failed part still warns.
        var code = done(); code.labelsError = "x"
        #expect(SyncSummary.labelsWarning(code) == "Label data couldn't be downloaded. Labels may be out of date.")
    }

    // Android runningShowsEachPartsState
    @Test func runningShowsEachPartsState() {
        let st = SyncStatus(phase: .running, parts: parts([
            "assets": SyncPart(name: "assets", state: .done, count: 10),
            "people": SyncPart(name: "people", state: .running),
        ]))
        guard case .running(let lines) = SyncSummary.content(st) else { Issue.record("not running"); return }
        #expect(SyncSummary.runningTitle == "Downloading move data…")
        #expect(SyncSummary.content(st).button == nil)   // no button while it runs
        let texts = lines.map(\.text)
        #expect(texts.contains("Assets · done (10)"))
        #expect(texts.contains("People · downloading…"))
        #expect(texts.contains("Fonts · waiting"))
    }

    // Android doneShowsTheCountsAndTheLabelsWarning
    @Test func doneShowsTheCountsAndTheLabelsWarning() {
        var st = done(templatesState: .failed); st.labelsError = "network"
        guard case .done(let line, let warning) = SyncSummary.content(st) else { Issue.record("not done"); return }
        #expect(line.hasPrefix("Local data: 10 assets"))
        #expect(line.contains("2 fonts"))
        #expect(warning == "Label templates couldn't be downloaded. Labels may be out of date.")
        #expect(SyncSummary.content(done()) == .done(line: SyncSummary.localDataLine(done()), warning: nil))
        #expect(SyncSummary.content(st).button == "Sync again")
    }

    // Android idleAndErrorKeepTheirButtons
    @Test func idleAndErrorKeepTheirButtons() {
        #expect(SyncSummary.content(SyncStatus()) == .idle)
        #expect(SyncSummary.idleText == "No move data on this kiosk yet.")
        #expect(SyncSummary.content(SyncStatus()).button == "Sync now")
        #expect(SyncSummary.content(SyncStatus(phase: .error)).button == "Try again")
        #expect(SyncSummary.content(SyncStatus(phase: .error, error: "network")) == .error("Couldn't download move data (network)."))
        #expect(SyncSummary.content(SyncStatus(phase: .error)) == .error("Couldn't download move data (unknown_error)."))
        // The labels warning shows only once the sync is done.
        var failed = SyncStatus(phase: .error, error: "network"); failed.labelsError = "network"
        #expect(SyncSummary.content(failed) == .error("Couldn't download move data (network)."))
    }
}
