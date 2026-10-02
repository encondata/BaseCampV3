import Testing
@testable import ServerSherpa_Kiosk

/// Android KioskShellTest.kt as model cases, with the footer the spec (and the
/// web kiosk's KioskShell.tsx) describes: Mode · Version · Move · Site · Scan · Data Sync · Dev mode.
@MainActor
struct ShellModelTests {
    private let selection = KioskSetupSelection(initiativeId: "i", initiativeName: "Move A", siteId: "s", siteName: "Dock 4",
                                                siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")

    @Test func footerShowsTheMoveContext() {
        let items = footerItems(selection: selection, sync: SyncStatus(), devMode: false, version: "1.2.0")
        #expect(items.map(\.label) == ["Mode", "Version", "Move", "Site", "Scan", "Data Sync"])
        #expect(items.map(\.value) == ["iOS", "1.2.0", "Move A", "Dock 4", "Pre-stage", nil])
    }

    @Test func footerWithoutASetupShowsNoMoveSiteOrScan() {
        let items = footerItems(selection: nil, sync: SyncStatus(), devMode: false, version: "1.2.0")
        #expect(items.map(\.label) == ["Mode", "Version", "Data Sync"])
    }

    @Test func aMoveSessionNamesTheMoveBeforeSetup() {
        let items = footerItems(selection: nil, sync: SyncStatus(), devMode: false, version: "1",
                                kioskMove: KioskMove(initiativeId: "i", name: "Move B"))
        #expect(items.first { $0.label == "Move" }?.value == "Move B")
    }

    @Test func dataSyncIsGoodOnlyWhenDone() {
        var sync = SyncStatus()
        #expect(footerItems(selection: nil, sync: sync, devMode: false, version: "1").last?.status == .bad)
        #expect(footerItems(selection: nil, sync: sync, devMode: false, version: "1").last?.detail == "No move data on this kiosk — sync it from Kiosk Setup")
        sync.phase = .running
        #expect(footerItems(selection: nil, sync: sync, devMode: false, version: "1").last?.detail == "Downloading move data…")
        sync.phase = .error
        sync.error = "network"
        #expect(footerItems(selection: nil, sync: sync, devMode: false, version: "1").last?.detail == "Last sync failed (network) — re-sync from Kiosk Setup")
        sync = SyncStatus(phase: .done, assets: 12, people: 3, containers: nil, trucks: 2, syncedAt: "2026-09-30T14:05:00Z")
        let done = footerItems(selection: nil, sync: sync, devMode: false, version: "1").last
        #expect(done?.status == .good)
        #expect(done?.detail == "12 assets · 3 people · 0 containers · 2 trucks · synced \(Sync.formatSyncedAt("2026-09-30T14:05:00Z"))")
    }

    @Test func devModeIsLast() {
        let items = footerItems(selection: selection, sync: SyncStatus(), devMode: true, version: "1")
        #expect(items.last?.label == "Dev mode")
        #expect(items.last?.value == "On")
        #expect(items.last?.accent == true)
    }

    @Test func personLabelNamesTheMoveForAMoveSession() {
        #expect(personLabel(fakeSession()) == fakeSession().person.displayName)
        #expect(personLabel(fakeSession(kioskMove: KioskMove(initiativeId: "i", name: "Move A"))) == "Kiosk · Move A")
    }

    /// A stray tap must not end the shift: Sign out asks, and says when scans are still waiting.
    @Test func signOutAsksAndCountsWaitingScans() {
        #expect(signOutMessage(waiting: 0) == "Whoever uses this kiosk next has to sign in again.")
        #expect(signOutMessage(waiting: 1) == "Whoever uses this kiosk next has to sign in again. One scan here hasn't reached the portal yet; it waits on this kiosk until someone signs in.")
        #expect(signOutMessage(waiting: 3) == "Whoever uses this kiosk next has to sign in again. 3 scans here haven't reached the portal yet; they wait on this kiosk until someone signs in.")
    }

    @Test func modeChipFollowsTheDevice() {
        #expect(modeChipText(isPad: true) == "KIOSK · IPAD")
        #expect(modeChipText(isPad: false) == "KIOSK · IPHONE")
    }
}
