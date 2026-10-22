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

    // MARK: Bluetooth printers

    private let serial = "D8J224508535"

    /// A container on a fake Bluetooth central (no radio), with the office ZD421 known to iOS and
    /// `saved` saved before it starts (saving one later is a change the container acts on).
    private func bluetoothContainer(saved: (FakePeripheral) -> SavedPrinter) throws -> (AppContainer, FakeBluetoothClient, FakePeripheral) {
        let defaults = freshDefaults()
        KioskPrefs(defaults: defaults).apiUrl = "http://127.0.0.1:9"   // nothing listens
        let client = FakeBluetoothClient()
        let p = FakePeripheral(serial: serial)
        client.central.known.append(p)
        LabelSettingsStore(prefs: KioskPrefs(defaults: defaults)).setPrinter(saved(p))
        let c = AppContainer(defaults: defaults, secrets: MemorySecretStore(),
                             modelContainer: try KioskSchema.inMemoryContainer(), backgroundTask: NoBackgroundTasking(),
                             labelEngine: FakeLabelEngine(), bluetoothClient: client)
        return (c, client, p)
    }

    private func bluetoothPrinter(_ id: UUID?) -> SavedPrinter {
        SavedPrinter(connection: .bluetooth(serial: serial, peripheralId: id), model: "ZD421", serial: serial, dpi: 300)
    }

    /// Connects the container's link to `p` (bounded: a regression fails instead of hanging).
    private func linkUp(_ c: AppContainer, _ p: FakePeripheral) async throws {
        let bluetooth = c.bluetooth
        let serial = self.serial
        let task = Task { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
        try #require(await waitUntil { bluetooth.link.connected }, "the link never came up")
        _ = try await task.value
    }

    /// The one factory the Print Labels sender and Printer Setup use: a network printer is the
    /// `NetworkZebra` at its host, and a Bluetooth printer goes over the container's one link,
    /// with its serial and identifier. Making either one starts no Bluetooth (no permission prompt).
    @Test func containerPicksTransportByConnection() throws {
        let client = FakeBluetoothClient()
        let bluetooth = ZebraBluetooth(client: client)
        let network = try #require(zebraTransport(for: SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203),
                                                  bluetooth: bluetooth) as? NetworkZebra)
        #expect(network.host == "10.0.0.5")
        #expect(network.port == ZebraNetwork.port)
        let id = UUID()
        let overBluetooth = try #require(zebraTransport(for: bluetoothPrinter(id), bluetooth: bluetooth) as? BluetoothZebra)
        #expect(overBluetooth.serial == serial)
        #expect(overBluetooth.peripheralId == id)
        #expect(overBluetooth.bluetooth === bluetooth)
        #expect(client.made == 0)
    }

    /// D4: the link closes when the app goes to the background, on sign-out, when the session
    /// ends, and when another printer is saved; nothing reconnects by itself.
    @Test func theBluetoothLinkClosesOnBackgroundSignOutSessionEndAndAnotherPrinter() async throws {
        let (c, client, p) = try bluetoothContainer { self.bluetoothPrinter($0.identifier) }
        // Nothing used Bluetooth yet: going to the background starts nothing (no permission prompt).
        c.onBackground()
        c.onActive()
        #expect(client.made == 0)
        try await linkUp(c, p)
        c.onBackground()
        #expect(!c.bluetooth.link.connected)
        #expect(client.central.cancels == [p.identifier])

        try await linkUp(c, p)
        c.auth.onLogout?()
        #expect(!c.bluetooth.link.connected)

        try await linkUp(c, p)
        c.auth.endSession()
        #expect(!c.bluetooth.link.connected)

        try await linkUp(c, p)
        c.labelSettings.setPrinter(SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203))
        #expect(await waitUntil { !c.bluetooth.link.connected })
        #expect(client.central.cancels == Array(repeating: p.identifier, count: 4))
        try await Task.sleep(for: .milliseconds(50))
        #expect(client.central.connects.count == 4)
    }

    /// Saving the printer the link is already up to (Printer Setup connected it to choose it)
    /// keeps that link: only a link to a printer no longer saved closes.
    @Test func savingThePrinterTheLinkIsUpToKeepsTheLink() async throws {
        let (c, client, p) = try bluetoothContainer { _ in SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203) }
        try await linkUp(c, p)
        c.labelSettings.setPrinter(bluetoothPrinter(p.identifier))
        try await Task.sleep(for: .milliseconds(100))
        #expect(c.bluetooth.link.connected)
        #expect(client.central.cancels.isEmpty)
    }

    /// iOS forgot the saved identifier, so the link found the printer by its serial: the saved
    /// printer takes the new identifier (the next connect goes straight to it), and as the same
    /// printer it keeps its link and its marks (Ruling 7).
    @Test func aPrinterFoundBySerialIsSavedAgainWithItsNewIdentifier() async throws {
        let stale = bluetoothPrinter(UUID())
        let (c, client, p) = try bluetoothContainer { _ in stale }
        client.central.known = []
        await c.printerGuard.markSendFailed(for: stale.connection)
        let zebra = c.zebra(for: stale)
        let send = Task { try await zebra.send("^XA^XZ") }
        try #require(await waitUntil { client.central.scanning }, "never scanned for the serial")
        client.central.advertise(p, rssi: -50)
        try await send.value
        #expect(p.written == Data("^XA^XZ".utf8))
        let adopted = bluetoothPrinter(p.identifier)
        #expect(await waitUntil { c.labelSettings.current().printer == adopted })
        try await Task.sleep(for: .milliseconds(100))
        #expect(c.bluetooth.link.connected)
        #expect(client.central.cancels.isEmpty)
        #expect(await c.printerGuard.state(for: adopted.connection) == .needsClear)

        // Saved again with the old identifier (a check that read the printer first): taken back.
        c.labelSettings.setPrinter(stale)
        #expect(await waitUntil { c.labelSettings.current().printer == adopted })
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
