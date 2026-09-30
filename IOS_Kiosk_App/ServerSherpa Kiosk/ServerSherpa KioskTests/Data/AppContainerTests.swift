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
                             modelContainer: try KioskSchema.container(inMemory: true), backgroundTask: NoBackgroundTasking())
        c.onActive()
        #expect(!c.outbox.isRunning)                 // in front, signed out
        c.auth.completePair(fakeSession())
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
}
