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
}
