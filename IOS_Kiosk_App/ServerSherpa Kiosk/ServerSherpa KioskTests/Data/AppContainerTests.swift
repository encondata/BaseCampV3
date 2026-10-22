import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct AppContainerTests {
    /// Scans flush only while the app is in front AND someone is signed in.
    @Test func outboxRunsOnlyWhileActiveAndSignedIn() async throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"   // nothing listens: a stray heartbeat fails at once
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking())
        c.onActive()
        #expect(!c.outbox.isRunning)                 // in front, signed out
        await c.auth.completePair(fakeSession())
        c.authChanged()
        #expect(c.outbox.isRunning)                  // in front, signed in
        c.onBackground()
        #expect(!c.outbox.isRunning)                 // backgrounded
        c.onActive()
        #expect(c.outbox.isRunning)
        c.auth.endSession()
        c.authChanged()
        #expect(!c.outbox.isRunning)                 // signed out again
        c.onBackground()
    }

    /// The builder exists from the start but builds nothing until `launch()` starts it; the
    /// settings it reads are the container's prefs.
    @Test func theLabelBuilderWaitsForLaunch() async throws {
        let engine = FakeLabelEngine()
        let c = AppContainer(defaults: freshDefaults(), secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: engine)
        try await Task.sleep(for: .milliseconds(100))
        #expect(c.labelBuilder.monitor.status == LabelBuildStatus())
        #expect(c.labelBuilder.monitor.pick == nil)
        #expect(engine.calls.isEmpty)
        c.labelSettings.setPeel(true)
        #expect(c.prefs.labels.peel)
    }

    /// The Rolodex's offline list (names, job titles, companies) leaves the kiosk with the
    /// admin: a sign-out, a session that ends underneath the kiosk (or while the app was closed),
    /// and Reset app delete it and forget the list on screen.
    @Test func theRolodexListGoesOnSignOutSessionEndAndReset() async throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"   // nothing listens
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: FakeLabelEngine())
        func cacheGone() async -> Bool { await waitUntilAsync { ((try? await c.store.rolodexCache()) ?? nil) == nil } }

        try await c.store.storeRolodexCache(#"{"workers":[]}"#)
        c.auth.onLogout?()
        #expect(await cacheGone())

        try await c.store.storeRolodexCache(#"{"workers":[]}"#)
        c.auth.endSession()
        #expect(await cacheGone())

        // a session that ended while the app was closed (the launch restore finds none)
        try await c.store.storeRolodexCache(#"{"workers":[]}"#)
        await c.auth.restore()
        #expect(c.auth.state == .anon)
        #expect(await cacheGone())

        try await c.store.storeRolodexCache(#"{"workers":[]}"#)
        await c.rolodex.select("p1")
        #expect(c.rolodex.selectedId == "p1")
        try await c.resetApp()
        #expect(try await c.store.rolodexCache() == nil)
        #expect(c.rolodex.selectedId == nil)
    }

    /// One no-match entry on the print jobs' list (no printer, no network, no engine); waits
    /// until the list shows it and returns its value.
    @discardableResult
    private func listOne(_ c: AppContainer) async -> String {
        let value = "X-\(UUID().uuidString.prefix(8))"
        _ = try? await c.printJobs.scan(nil, scannedValue: value)
        await waitUntil { c.printJobs.entries.contains { $0.scannedValue == value } }
        return value
    }

    /// Whether the list has dropped `value` (a list delivered in order: once a newer list
    /// without it shows, a reset ran).
    private func cleared(_ c: AppContainer, _ value: String) async -> Bool {
        await waitUntil { !c.printJobs.entries.contains { $0.scannedValue == value } }
    }

    /// Print Labels' list belongs to one session on one move: a sign-out, a session that ends
    /// underneath the kiosk, and a change of the saved move or site each clear it.
    @Test func thePrintJobsResetOnSignOutSessionEndAndMoveChange() async throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: FakeLabelEngine())

        // logout() runs this hook first (logout itself would tell the portal over the network).
        var v = await listOne(c)
        c.auth.onLogout?()
        #expect(await cleared(c, v))

        v = await listOne(c)
        c.auth.endSession()
        #expect(await cleared(c, v))

        // Kiosk Setup saves a move.
        v = await listOne(c)
        c.prefs.setupSelection = testSelection(initiativeId: "i1")
        #expect(await cleared(c, v))

        // Another site on the same move.
        v = await listOne(c)
        var other = testSelection(initiativeId: "i1")
        other.siteId = "s9"
        c.prefs.setupSelection = other
        #expect(await cleared(c, v))

        // Another move, then a clear.
        v = await listOne(c)
        c.prefs.setupSelection = testSelection(initiativeId: "i2")
        #expect(await cleared(c, v))
        v = await listOne(c)
        c.prefs.setupSelection = nil
        #expect(await cleared(c, v))

        // The same move and site saved again (a renamed move) keeps the list.
        v = await listOne(c)
        c.prefs.setupSelection = testSelection(initiativeId: "i1")
        #expect(await cleared(c, v))
        v = await listOne(c)
        var renamed = testSelection(initiativeId: "i1")
        renamed.initiativeName = "Renamed"
        c.prefs.setupSelection = renamed
        try await Task.sleep(for: .milliseconds(100))
        #expect(c.printJobs.entries.map(\.scannedValue) == [v])
    }

    /// Settings › Developer › Reset app: a fresh setup, nothing about the move or the printer
    /// remembered; unsent scans, the sign-in, the URLs and the preferences stay.
    @Test func resetAppStartsAFreshSetupAndKeepsScansAndTheSignIn() async throws {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"   // nothing listens
        let engine = FakeLabelEngine()
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: engine)
        await c.auth.completePair(fakeSession())
        c.prefs.portalUrl = "https://portal.example"
        c.prefs.devMode = true
        c.prefs.setupState = .complete
        c.prefs.setupSelection = testSelection(initiativeId: "i1")
        c.labelSettings.setPrinter(SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203))
        c.labelSettings.setOffsets(x: 12, y: -3)
        c.labelSettings.setPeel(true)
        let meta = SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 1, people: 0, containers: 0, trucks: 0, syncedAt: "now")
        try await c.store.replaceRoster(assets: [KioskAssetRow(id: "a1", assetId: "A-1")], people: [], containers: [], trucks: [], meta: meta,
                                        payloads: [#"{"id":"a1","asset_id":"A-1"}"#], labelContext: #"{"move_name":"Move"}"#,
                                        templates: [LabelTemplateRow(id: "t1", json: #"{"id":"t1"}"#)])
        try await c.store.replaceLabelFonts([LabelFontRow(id: "f1", name: "ROBOTO.TTF", size: 3, resident: false, fileName: nil)])
        let following = await c.labelBuilder.start(syncStatus: c.sync.statusUpdates())
        defer { following.cancel() }
        await c.labelBuilder.buildNow("test")
        #expect(c.labelBuilder.monitor.pick?.templateId == "t1")
        #expect(try await c.store.storedLabel(assetId: "a1") != nil)
        let scan = await c.outbox.enqueue(EnqueueInput(scannedValue: "A-1", scanType: "barcode", asset: nil, siteId: "s1",
                                                       initiativeId: "i1", scanStatus: "pre_stage"))
        #expect(scan != nil)
        let outboxBefore = try await c.store.outboxAll()
        #expect(outboxBefore.count == 1)
        let job = await listOne(c)
        #expect(c.printJobs.entries.map(\.scannedValue) == [job])

        try await c.resetApp()

        // Cleared.
        #expect(c.prefs.setupSelection == nil)
        #expect(c.prefs.setupState == .incomplete)
        #expect(c.labelSettings.current() == LabelSettings())
        #expect(c.prefs.labels == LabelOptions())
        #expect(try await c.store.assets().isEmpty)
        #expect(try await c.store.labelTemplates().isEmpty)
        #expect(try await c.store.labelFonts().isEmpty)
        #expect(try await c.store.storedLabel(assetId: "a1") == nil)
        #expect(try await c.store.meta() == nil)
        #expect(try await c.store.labelContext() == nil)
        #expect(await cleared(c, job))
        #expect(c.printJobs.entries.isEmpty)
        // The builder ends waiting for a sync, nothing running and nothing picked, and stays so.
        let builder = c.labelBuilder.monitor
        #expect(await waitUntil { builder.status.needs == .sync && builder.status.phase != .running && builder.pick == nil })
        let plans = engine.count("buildPlan")
        try await Task.sleep(for: .milliseconds(100))
        #expect(builder.status.needs == .sync)
        #expect(builder.status.phase != .running)
        #expect(builder.pick == nil)
        #expect(engine.count("buildPlan") == plans)
        // Kept.
        #expect(try await c.store.outboxAll() == outboxBefore)
        guard case .authed = c.auth.state else { Issue.record("signed out by the reset"); return }
        #expect(c.prefs.apiUrl == "http://127.0.0.1:9")
        #expect(c.prefs.portalUrl == "https://portal.example")
        #expect(c.prefs.devMode)
    }
}
