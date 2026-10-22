import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// What a settings stream has given so far.
@MainActor private final class Collected {
    var values: [LabelSettings] = []
}

/// Port of Android `LabelSettingsStoreTest`.
@MainActor
struct LabelSettingsStoreTests {
    private let defaults = freshDefaults()
    private let prefs: KioskPrefs
    private let store: LabelSettingsStore
    private let printer = SavedPrinter(host: "10.0.0.7", model: "ZD421", serial: "D4J123456", dpi: 203)

    init() {
        prefs = KioskPrefs(defaults: defaults)
        store = LabelSettingsStore(prefs: prefs)
    }

    private func selection(_ kind: String? = nil) -> KioskSetupSelection {
        guard let kind else {
            return KioskSetupSelection(initiativeId: "i", initiativeName: "Move", siteId: "s", siteName: "Site", siteRole: "source",
                                       scanStatus: "pre_stage", scanLabel: "Pre-stage")
        }
        return KioskSetupSelection(initiativeId: "i", initiativeName: "Move", siteId: "s", siteName: "Site", siteRole: "source",
                                   scanStatus: "pre_stage", scanLabel: "Pre-stage", labelKind: kind)
    }

    @Test func defaultsWhenNothingIsSaved() {
        #expect(store.current() == LabelSettings())
    }

    @Test func roundTripsPrinterOffsetsAndPeel() {
        store.setPrinter(printer)
        store.setOffsets(x: -12, y: 30)
        store.setPeel(true)
        #expect(store.current() == LabelSettings(kind: .top, printer: printer, offsetX: -12, offsetY: 30, peel: true))
        store.setPrinter(nil)
        #expect(store.current() == LabelSettings(kind: .top, printer: nil, offsetX: -12, offsetY: 30, peel: true))
        // And from a fresh read of the same defaults.
        #expect(LabelSettingsStore(prefs: KioskPrefs(defaults: defaults)).current()
            == LabelSettings(kind: .top, printer: nil, offsetX: -12, offsetY: 30, peel: true))
    }

    @Test func eachSetterKeepsTheOtherFields() {
        store.setPrinter(printer); store.setPeel(true); store.setOffsets(x: 5, y: 6)
        let s = store.current()
        #expect(s.printer == printer); #expect(s.peel == true); #expect(s.offsetX == 5 && s.offsetY == 6)
    }

    @Test func theKindComesFromTheSetupSelection() {
        prefs.setupSelection = selection("front")
        #expect(store.current().kind == .front)
        prefs.setupSelection = selection("top")
        #expect(store.current().kind == .top)
    }

    @Test func noSelectionReadsAsTop() {
        prefs.setupSelection = selection("front"); prefs.setupSelection = nil
        #expect(store.current().kind == .top)
    }

    @Test func theFirstValueIsTheStoredOneNotTheDefaults() async {
        prefs.setupSelection = selection("front"); store.setPrinter(printer)
        // A fresh store over the same defaults: the first value already carries everything.
        var updates = LabelSettingsStore(prefs: KioskPrefs(defaults: defaults)).updates().makeAsyncIterator()
        #expect(await updates.next() == LabelSettings(kind: .front, printer: printer))
    }

    @Test func unrelatedWritesDoNotRepeatTheSettings() async throws {
        let seen = Collected()
        let stream = store.updates()
        let job = Task { @MainActor in for await s in stream { seen.values.append(s) } }
        defer { job.cancel() }
        func waitFor(_ n: Int) async throws {
            let end = ContinuousClock.now + .seconds(5)
            while seen.values.count < n && ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(10)) }
        }
        try await waitFor(1)
        store.setPeel(true); try await waitFor(2)
        prefs.devMode = true; prefs.kioskName = "Dock 4"
        prefs.setupSelection = selection("top")   // another selection, the same kind
        store.setPeel(false); try await waitFor(3)
        try await Task.sleep(for: .milliseconds(200))
        #expect(seen.values == [LabelSettings(), LabelSettings(peel: true), LabelSettings()])
    }

    @Test func eachChangeArrivesInOrder() async {
        var updates = store.updates().makeAsyncIterator()
        #expect(await updates.next() == LabelSettings())
        prefs.setupSelection = selection("front")
        #expect(await updates.next() == LabelSettings(kind: .front))
        store.setPrinter(printer)
        #expect(await updates.next() == LabelSettings(kind: .front, printer: printer))
    }
}
