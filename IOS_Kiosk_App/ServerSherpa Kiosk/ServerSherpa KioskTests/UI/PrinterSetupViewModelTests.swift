import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The generator for Printer Setup (Android's `SetupEngine`): a plan per DPI (a "Vegas Top"
/// template at 203, none at 300), the test labels, and the two send-time helpers spelled out so a
/// test can see what went in. Main-actor state: tests set it up and read it between awaits.
@MainActor private final class SetupEngine: LabelEngine {
    struct Call {
        var fn: String
        var args: [String: Any]
    }

    private(set) var calls: [Call] = []
    var planFonts: [String] = []
    var planFails = false
    var unsupported = false
    /// Each named function times out this many times before it answers.
    var timeouts: [String: Int] = [:]
    /// Replaces sampleLabel's answer.
    var sampleAnswer: String?

    nonisolated init() {}

    nonisolated func isSupported() async -> Bool { await supportedNow() }

    nonisolated func call(_ fn: String, _ argsJson: String) async throws -> String { try await answer(fn, argsJson) }

    private func supportedNow() -> Bool { !unsupported }

    private func answer(_ fn: String, _ argsJson: String) throws -> String {
        if unsupported { throw LabelEngineError.unsupported }
        let a = FakeLabelEngine.object(argsJson)
        calls.append(Call(fn: fn, args: a))
        if let left = timeouts[fn], left > 0 {
            timeouts[fn] = left - 1
            throw LabelEngineError.timeout(fn)
        }
        func zplOut(_ z: String) -> String { FakeLabelEngine.text(["zpl": z]) }
        switch fn {
        case "buildPlan":
            if planFails { throw FakeEngineDied() }
            let picked = (a["dpi"] as? Int) == 203
            return FakeLabelEngine.text([
                "templateId": picked ? "t1" as Any : NSNull(),
                "templateFamily": picked ? "vegas" as Any : NSNull(),
                "notes": picked ? [String]() : ["Vegas Top is at 203 DPI only."],
                "fonts": picked ? planFonts : [String](),
                "availableDpis": picked ? [Int]() : [203],
                "hasAssetData": true,
                "jobs": [Any](),
            ])
        case "alignmentTestZpl":
            return zplOut("ALIGN \(a["widthDots"] as? Int ?? 0)x\(a["heightDots"] as? Int ?? 0) \(a["sizeLabel"] as? String ?? "") \(a["dpi"] as? Int ?? 0)")
        case "sampleLabel":
            if let sampleAnswer { return sampleAnswer }
            return FakeLabelEngine.text(["zpl": "SAMPLE \(a["kind"] as? String ?? "") \(a["dpi"] as? Int ?? 0)", "reason": NSNull()])
        case "applyPrintSettings":
            return zplOut("LT\(a["verticalOffset"] as? Int ?? 0)LS\(a["horizontalOffset"] as? Int ?? 0)|\(a["zpl"] as? String ?? "")")
        case "withPrintMode":
            return zplOut((a["zpl"] as? String ?? "") + ((a["peel"] as? Bool) == true ? "|MMP" : "|MMT"))
        default:
            throw LabelGenException("unexpected \(fn)")
        }
    }

    func count(_ fn: String) -> Int { calls.filter { $0.fn == fn }.count }
}

/// The printer's one network port: every connection to it, in the order they began, and how many
/// were open at once. A connection whose text contains `hold` stays open while `hold` is set.
@MainActor private final class FakeLine {
    private(set) var started: [String] = []
    private(set) var open = 0
    private(set) var maxOpen = 0
    var hold: String?
    private(set) var held = false

    func connect(_ what: String) async throws {
        started.append(what)
        open += 1
        maxOpen = max(maxOpen, open)
        defer { open -= 1 }
        while let hold, what.contains(hold) {
            held = true
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    func clearHeld() { held = false }
}

/// A Zebra at one host (Android's `FakeZebra`): what it says, and what it was sent.
@MainActor private final class FakeZebra: SetupZebra {
    nonisolated let host: String
    var answers = true
    var dpi = 203
    var model = "ZD421"
    var serialNo: String?
    var peeler: Bool?
    var paperOut = false
    /// While set, status() waits (after setting `inStatus`).
    var statusHold = false
    private(set) var inStatus = false
    /// Thrown by send() when set.
    var sendError: Error?
    /// When it doesn't answer, it's iOS's Local Network denial.
    var deniedLocalNetwork = false
    private(set) var onE: [String] = []
    private(set) var sent: [String] = []
    private(set) var installed: [(name: String, bytes: Data)] = []
    /// Every call, in order.
    private(set) var calls: [String] = []
    var line: FakeLine?

    nonisolated init(host: String) {
        self.host = host
        self.serialNo = "S-\(host)"
    }

    private func use(_ what: String, _ detail: String = "") async throws {
        calls.append(what)
        if !answers { throw PrinterUnreachable(host: host, localNetworkDenied: deniedLocalNetwork) }
        try await line?.connect("\(host) \(what)\(detail.isEmpty ? "" : " ")\(detail)")
    }

    nonisolated func identify() async throws -> HostId { try await identifyNow() }
    nonisolated func serial() async throws -> String? { try await serialNow() }
    nonisolated func status() async throws -> HostStatus { try await statusNow() }
    nonisolated func peelerPresent() async throws -> Bool? { await peelerNow() }
    nonisolated func fonts() async throws -> [String] { try await fontsNow() }
    nonisolated func send(_ zpl: String) async throws { try await sendNow(zpl) }
    nonisolated func installFont(name: String, bytes: Data) async throws { try await installNow(name, bytes) }

    private func identifyNow() async throws -> HostId {
        try await use("identify")
        return HostId(model: model, firmware: "V1", dotsPerMm: dpi == 300 ? 12 : 8, memory: "8192", dpi: dpi)
    }

    private func serialNow() async throws -> String? {
        try await use("serial")
        return serialNo
    }

    private func statusNow() async throws -> HostStatus {
        try await use("status")
        inStatus = true
        while statusHold { try await Task.sleep(for: .milliseconds(2)) }
        return HostStatus(paperOut: paperOut, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false, partialFormat: false,
                          corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false,
                          thermalTransfer: false, printMode: "0", labelWaiting: false, labelsRemaining: 0)
    }

    /// Like `NetworkZebra.peelerPresent`: nil, never an error, when nothing answers.
    private func peelerNow() async -> Bool? {
        calls.append("peeler")
        return answers ? peeler : nil
    }

    private func fontsNow() async throws -> [String] {
        try await use("fonts")
        return onE
    }

    private func sendNow(_ zpl: String) async throws {
        try await use("send", zpl)
        if let sendError { throw sendError }
        sent.append(zpl)
    }

    private func installNow(_ name: String, _ bytes: Data) async throws {
        try await use("installFont", name)
        installed.append((name, bytes))
        onE.append(name.uppercased())
    }
}

/// The network scan: answers each scan with the next result (the last one repeats), or throws.
@MainActor private final class FakeScanner {
    var results: [ZebraScanResult] = [ZebraScanResult(printers: [], localNetworkDenied: false)]
    var error: Error?
    private(set) var count = 0

    func scan() async throws -> ZebraScanResult {
        count += 1
        if let error { throw error }
        return results[min(count, results.count) - 1]
    }
}

private struct ScanBroke: Error {}

/// The fake Zebras by host, made on first use. The view models hold it, not the test: a view
/// model's task can outlive its test.
@MainActor private final class Zebras {
    private(set) var all: [String: FakeZebra] = [:]

    func at(_ host: String) -> FakeZebra {
        if let z = all[host] { return z }
        let z = FakeZebra(host: host)
        all[host] = z
        return z
    }
}

/// The view model's sleeps: what it asked for, each one 1 ms (or parked on a `TickGate` when gated).
private final class Sleeps: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [Duration] = []
    let gate: TickGate?

    init(gated: Bool = false) { gate = gated ? TickGate() : nil }

    var asked: [Duration] { lock.withLock { list } }

    func sleep(_ d: Duration) async throws {
        lock.withLock { list.append(d) }
        if let gate { try await gate.sleep(d) } else { try await Task.sleep(for: .milliseconds(1)) }
    }
}

/// Port of Android's PrinterSetupViewModelTest, plus the iOS rules: the app-wide printer lock
/// shared with Print Labels, the Local Network rescan, offsets, and nothing sent unasked.
@MainActor
final class PrinterSetupViewModelTests {
    private let saved = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "S1", dpi: 203)
    private let engine = SetupEngine()
    private let store: KioskStore
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let settings: LabelSettingsStore
    private let builder: LabelBuilder
    private let fontsDir: URL
    private let lock = PrinterLock()
    private let scanner = FakeScanner()
    private let sleeps = Sleeps()
    private let fakes = Zebras()
    nonisolated(unsafe) private var following: Task<Void, Never>?
    nonisolated(unsafe) private var feed: AsyncStream<SyncStatus>.Continuation?

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        settings = LabelSettingsStore(prefs: prefs)
        builder = LabelBuilder(store: store, engine: engine, settings: settings)
        fontsDir = FileManager.default.temporaryDirectory.appendingPathComponent("label-fonts-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fontsDir, withIntermediateDirectories: true)
    }

    deinit {
        following?.cancel()
        feed?.finish()
        try? FileManager.default.removeItem(at: fontsDir)
    }

    /// The synced move (a "Vegas Top" 4x2 template), its setup, the saved printer, and the label
    /// builder following a finished sync (Android's `setUp`).
    private func start() async throws {
        let meta = SyncMeta(initiativeId: "i1", initiativeName: "Move A", assets: 0, people: 0, containers: 0, trucks: 0,
                            syncedAt: "2026-10-21T00:00:00Z")
        try await store.replaceRoster(assets: [], people: [], containers: [], trucks: [], meta: meta,
                                      labelContext: #"{"move_name":"Move A","catalog_keys":[]}"#,
                                      templates: [LabelTemplateRow(id: "t1", json: #"{"id":"t1","name":"Vegas Top","width_in":4,"height_in":2.0}"#)])
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move", siteId: "s1", siteName: "Site",
                                                   siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        settings.setPrinter(saved)
        let (sync, feed) = AsyncStream.makeStream(of: SyncStatus.self)
        self.feed = feed
        feed.yield(SyncStatus(phase: .done))
        following = await builder.start(syncStatus: sync)
    }

    private func zebra(_ host: String) -> FakeZebra { fakes.at(host) }

    private var zebras: [String: FakeZebra] { fakes.all }

    private func vm(pickWait: Duration = .seconds(5), sleeps: Sleeps? = nil) -> PrinterSetupViewModel {
        let sleeper = sleeps ?? self.sleeps
        let scanner = self.scanner
        let fakes = self.fakes
        return PrinterSetupViewModel(
            settings: settings, build: builder.monitor, engine: engine, store: store, fontsDir: fontsDir,
            scanner: { try await scanner.scan() },
            zebraAt: { host in fakes.at(host) },
            printerLock: lock,
            sleep: { try await sleeper.sleep($0) },
            pickWait: pickWait)
    }

    /// Waits (real time: the store and the builder run on their own) for `cond`.
    private func eventually(_ what: String, _ cond: @MainActor @Sendable () -> Bool) async {
        let ok = await waitUntil(timeout: .seconds(8), cond)
        #expect(ok, "never: \(what)")
    }

    private func row(_ vm: PrinterSetupViewModel, _ key: CheckKey) -> CheckRow? { vm.ui.checks.first { $0.key == key } }

    /// Runs `start` and waits for the check run it starts to finish.
    private func checked(_ vm: PrinterSetupViewModel, _ start: () -> Void) async {
        let before = vm.ui.checkRuns
        start()
        await eventually("checks finished") { vm.ui.checkRuns > before && !vm.ui.checking }
    }

    private var current: LabelSettings { settings.current() }

    private func awaitPick203() async {
        await eventually("pick") { builder.monitor.pick?.dpi == 203 }
    }

    // MARK: Android's cases

    @Test func aScanListsTheFoundPrintersAndSavingOneWithANewDpiRebuildsTheLabels() async throws {
        try await start()
        let found = [FoundPrinter(host: "10.0.0.7", model: "ZT230", serial: "SER9", dpi: 300),
                     FoundPrinter(host: "10.0.0.8", model: nil, serial: nil, dpi: nil)]
        scanner.results = [ZebraScanResult(printers: found, localNetworkDenied: false)]
        let z7 = zebra("10.0.0.7")
        z7.dpi = 300; z7.model = "ZT230"; z7.serialNo = "SER9"
        let vm = vm()
        vm.scan()
        await eventually("scan done") { vm.ui.found == found && !vm.ui.scanning }
        #expect(vm.ui.scanMessage == nil)

        await checked(vm) { vm.choose(found[0]) }
        #expect(current.printer == SavedPrinter(host: "10.0.0.7", model: "ZT230", serial: "SER9", dpi: 300))
        // The scan said what it is: the first call to it is the checks' own.
        #expect(z7.calls.first == "identify")
        #expect(!z7.calls.contains("serial"))
        // the builder rebuilt by itself: a plan at the new DPI
        await eventually("plan at 300") { engine.calls.contains { $0.fn == "buildPlan" && ($0.args["dpi"] as? Int) == 300 } }
        #expect(row(vm, .answers)?.state == .ok)
        #expect(row(vm, .answers)?.detail == "ZT230 · 300 DPI")
        let dpi = try #require(row(vm, .dpi))
        #expect(dpi.state == .warn)
        #expect(dpi.detail == "This move's Top template prints at 203 DPI only; this printer is 300 DPI. "
            + "Activate a 300 DPI version on Labels › Templates, or use a 203 DPI printer.")
        #expect(dpi.notes == ["Vegas Top is at 203 DPI only."])

        // A printer the scan couldn't identify is asked before it's saved; no serial reads as "".
        zebra("10.0.0.8").serialNo = nil
        await checked(vm) { vm.choose(found[1]) }
        #expect(current.printer == SavedPrinter(host: "10.0.0.8", model: "ZD421", serial: "", dpi: 203))
        #expect(row(vm, .dpi)?.state == .ok)
        #expect(row(vm, .dpi)?.detail == "Vegas Top")
    }

    @Test func anEmptyScanSaysSo() async throws {
        let vm = vm()
        vm.scan()
        await eventually("scan done") { vm.ui.found != nil && !vm.ui.scanning }
        #expect(vm.ui.scanMessage == "No Zebra printers found on this network.")
        #expect(!vm.ui.scanError)
    }

    @Test func aTypedIpIsValidatedAndOneThatDoesNotAnswerIsNotSaved() async throws {
        try await start()
        let vm = vm()
        vm.setIpText("10.0.300.1")
        vm.useIp()
        #expect(vm.ui.chooseError == "That isn't a valid IP address.")
        vm.setIpText("010.0.0.1") // a leading zero could be read as octal
        vm.useIp()
        #expect(vm.ui.chooseError == "That isn't a valid IP address.")
        #expect(zebras.isEmpty)

        zebra("10.0.0.9").answers = false
        vm.setIpText(" 10.0.0.9 ")
        vm.useIp()
        await eventually("no answer") { vm.ui.chooseError != nil && vm.ui.choosing == nil }
        #expect(vm.ui.chooseError == "No Zebra printer answered at 10.0.0.9.")
        #expect(current.printer == saved)

        vm.setIpText("10.0.0.10")
        vm.useIp()
        await eventually("typed printer saved") { self.current.printer == SavedPrinter(host: "10.0.0.10", model: "ZD421", serial: "S-10.0.0.10", dpi: 203) }
        #expect(vm.ui.chooseError == nil)
    }

    @Test func missingFontsAreListedAndInstallSendsEachInstallableFontThenRechecksClean() async throws {
        try await start()
        engine.planFonts = ["ROBOTO.TTF", "LATO.TTF"]
        try Data([1, 2, 3]).write(to: fontsDir.appendingPathComponent("roboto.ttf"))
        try Data([4, 5]).write(to: fontsDir.appendingPathComponent("lato.ttf"))
        try await store.replaceLabelFonts([
            LabelFontRow(id: "f1", name: "Roboto.ttf", size: 3, resident: false, fileName: "roboto.ttf"),
            LabelFontRow(id: "f2", name: "LATO.TTF", size: 2, resident: false, fileName: "lato.ttf"),
        ])
        await builder.rebuild(reason: "fonts changed")
        await eventually("plan with fonts") { builder.monitor.pick?.fonts.count == 2 }
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        let fonts = try #require(row(vm, .fonts))
        #expect(fonts.state == .fail)
        #expect(fonts.detail == "Missing: ROBOTO.TTF, LATO.TTF.")
        #expect(vm.ui.fontFix?.installable.count == 2)

        await checked(vm) { vm.installFonts() }
        let z = zebra(saved.host)
        #expect(z.installed.map { $0.name.uppercased() } == ["ROBOTO.TTF", "LATO.TTF"])
        #expect(z.installed.first?.bytes == Data([1, 2, 3]))
        #expect(z.installed.last?.bytes == Data([4, 5]))
        #expect(vm.ui.fontMessage == "Fonts installed.")
        #expect(!vm.ui.fontError)
        #expect(row(vm, .fonts)?.state == .ok)
        #expect(vm.ui.fontFix == nil)
        // The printer got 500 ms to file the fonts before the re-check.
        #expect(sleeps.asked.contains(.milliseconds(500)))
        let firstInstall = try #require(z.calls.firstIndex(of: "installFont"))
        #expect(z.calls[firstInstall...].contains("fonts")) // re-checked after installing
    }

    @Test func aFontThatCannotBeInstalledSaysWhich() async throws {
        try await start()
        engine.planFonts = ["ROBOTO.TTF"]
        try await store.replaceLabelFonts([LabelFontRow(id: "f1", name: "ROBOTO.TTF", size: 3, resident: false, fileName: "gone.ttf")])
        await builder.rebuild(reason: "fonts changed")
        await eventually("plan with fonts") { builder.monitor.pick?.fonts.count == 1 }
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        vm.installFonts()
        await eventually("install finished") { vm.ui.fontMessage != nil && !vm.ui.installing }
        #expect(vm.ui.fontMessage == "Couldn't install ROBOTO.TTF.")
        #expect(vm.ui.fontError)
        #expect(zebra(saved.host).installed.isEmpty)
    }

    @Test func peelIsDisabledWhenThePrinterHasNoPeelerAndEnabledWhenItDoesNotSay() async throws {
        try await start()
        settings.setPeel(true)
        let z = zebra(saved.host)
        z.peeler = false
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        #expect(vm.ui.peeler == false)
        #expect(!vm.ui.peelAllowed)
        #expect(row(vm, .peeler)?.detail == "No peeler · printing in tear-off mode")
        // a peel setting the printer can't honor falls back to tear-off
        #expect(!current.peel)
        vm.setPeel(true)
        try await Task.sleep(for: .milliseconds(50))
        #expect(!current.peel)

        z.peeler = nil
        await checked(vm) { vm.checkAgain() }
        #expect(vm.ui.peeler == nil)
        #expect(vm.ui.peelAllowed)
        #expect(row(vm, .peeler)?.detail == "Printer doesn't report a peeler · printing in tear-off mode")
        vm.setPeel(true)
        await eventually("peel") { self.current.peel }
        await eventually("row says peel-off") { self.row(vm, .peeler)?.detail == "Printer doesn't report a peeler · printing in peel-off mode" }

        z.peeler = true
        await checked(vm) { vm.checkAgain() }
        #expect(row(vm, .peeler)?.detail == "Peeler detected · printing in peel-off mode")
    }

    @Test func anUnsyncedKioskSaysToSyncWithoutWaiting() async throws {
        try await start()
        await awaitPick203()
        try await store.deleteMeta(syncMetaKey)
        await builder.stop()
        await eventually("pick cleared") { builder.monitor.pick == nil }
        let vm = vm(pickWait: .seconds(60))
        let started = ContinuousClock.now
        await checked(vm) { vm.checkAgain() }
        #expect(ContinuousClock.now - started < .seconds(5))
        #expect(row(vm, .dpi)?.detail == "Sync this kiosk to check its label templates.")
        #expect(row(vm, .fonts)?.state == .warn)
        #expect(row(vm, .fonts)?.detail == "Fonts can't be checked until the move's label templates are known.")
    }

    @Test func aFailedBuildEndsTheWaitAtOnce() async throws {
        try await start()
        await awaitPick203()
        engine.planFails = true
        await builder.rebuild(reason: "templates changed")
        await eventually("failed pick") { builder.monitor.pick?.failed == true }
        let vm = vm(pickWait: .seconds(60))
        let started = ContinuousClock.now
        await checked(vm) { vm.checkAgain() }
        #expect(ContinuousClock.now - started < .seconds(5))
        #expect(row(vm, .dpi)?.detail == "Labels couldn't be made. Try syncing again.")
    }

    @Test func anUnsupportedDeviceEndsTheWaitAtOnce() async throws {
        try await start()
        await awaitPick203()
        engine.unsupported = true
        await builder.rebuild(reason: "engine broke")
        await eventually("unsupported") { builder.monitor.status.phase == .unsupportedDevice }
        // The pick at this DPI is still the old one: point the printer at another DPI so only the
        // unsupported phase can end the wait.
        settings.setPrinter(SavedPrinter(host: saved.host, model: "ZD421", serial: "S1", dpi: 300))
        zebra(saved.host).dpi = 300
        let vm = vm(pickWait: .seconds(60))
        let started = ContinuousClock.now
        await checked(vm) { vm.checkAgain() }
        #expect(ContinuousClock.now - started < .seconds(5))
        #expect(row(vm, .dpi)?.detail == DEVICE_UNSUPPORTED_TEXT)
    }

    @Test func aTestLabelWaitsForTheCheckThatIsTalkingToThePrinter() async throws {
        try await start()
        await awaitPick203()
        let z = zebra(saved.host)
        z.statusHold = true
        let vm = vm()
        vm.checkAgain()
        await eventually("in status") { z.inStatus }
        vm.printTest(.alignment)
        try await Task.sleep(for: .milliseconds(80))
        #expect(z.sent.isEmpty)
        #expect(vm.ui.testing)
        z.statusHold = false
        await eventually("sent after the status query") { z.sent.count == 1 && !vm.ui.testing }
    }

    @Test func checkAgainSavesTheModelSerialAndDpiOfAnotherPrinterAtTheSameAddress() async throws {
        try await start()
        let z = zebra(saved.host)
        z.model = "ZT230"; z.dpi = 300; z.serialNo = "NEW1"
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        #expect(current.printer == SavedPrinter(host: saved.host, model: "ZT230", serial: "NEW1", dpi: 300))

        z.model = "ZT410"; z.serialNo = nil
        await checked(vm) { vm.checkAgain() }
        #expect(current.printer == SavedPrinter(host: saved.host, model: "ZT410", serial: "", dpi: 300))
    }

    @Test func testLabelsAreSentWithTheCurrentOffsetsAndPrintMode() async throws {
        try await start()
        let vm = vm()
        await awaitPick203()
        vm.setOffsetX("12")
        vm.setOffsetY("-3")
        await eventually("offsets saved") { self.current.offsetX == 12 && self.current.offsetY == -3 }

        vm.printTest(.alignment)
        await eventually("alignment sent") { vm.ui.testMessage != nil && !vm.ui.testing }
        let z = zebra(saved.host)
        #expect(z.sent == ["LT-3LS12|ALIGN 812x406 4x2 203|MMT"])
        #expect(vm.ui.testMessage == "Alignment label (4x2) sent to the printer.")
        #expect(!vm.ui.testError)

        settings.setPeel(true)
        vm.setOffsetX("99999") // clamps
        vm.printTest(.sample)
        await eventually("sample sent") { z.sent.count == 2 && !vm.ui.testing }
        #expect(z.sent.last == "LT-3LS9999|SAMPLE top 203|MMP")
        #expect(vm.ui.testMessage == "Sample label (Vegas Top) sent to the printer.")
        let sample = try #require(engine.calls.first { $0.fn == "sampleLabel" })
        #expect(sample.args["templatesJson"] as? String == #"{"templates":[{"id":"t1","name":"Vegas Top","width_in":4,"height_in":2.0}]}"#)
        #expect(current.offsetX == 9999)
        // no build was started by offsets or peel
        try await Task.sleep(for: .milliseconds(50))
        #expect(engine.count("buildPlan") == 1)
        // A test label sends only the label: no status, peeler or other query on the print path.
        #expect(z.calls == ["send", "send"])
    }

    @Test func aTestLabelThePrinterDoesNotTakeSaysSo() async throws {
        try await start()
        let vm = vm()
        await awaitPick203()
        zebra(saved.host).answers = false
        vm.printTest(.alignment)
        await eventually("failed") { vm.ui.testMessage != nil && !vm.ui.testing }
        #expect(vm.ui.testMessage == "Can't reach the printer at 10.0.0.5.")
        #expect(vm.ui.testError)
    }

    @Test func theFrontKindDefaultsTheAlignmentLabelTo2x1WithoutATemplateSize() {
        #expect(alignmentSizeFor(kind: .front, dpi: 300, pick: nil) == AlignmentSize(widthIn: 2, heightIn: 1, dpi: 300))
        #expect(alignmentSizeFor(kind: .top, dpi: 203, pick: nil) == AlignmentSize(widthIn: 4, heightIn: 2, dpi: 203))
        #expect(AlignmentSize(widthIn: 2, heightIn: 1, dpi: 300).label == "2x1")
        #expect(AlignmentSize(widthIn: 2, heightIn: 1, dpi: 300).widthDots == 600)
        #expect(AlignmentSize(widthIn: 2.25, heightIn: 1.5, dpi: 203).label == "2.25x1.5")
        // Another kind's or DPI's pick doesn't size it.
        let pick = LabelPick(kind: .top, dpi: 203, synced: true, templateId: "t1", widthIn: 3, heightIn: 1)
        #expect(alignmentSizeFor(kind: .top, dpi: 203, pick: pick) == AlignmentSize(widthIn: 3, heightIn: 1, dpi: 203))
        #expect(alignmentSizeFor(kind: .top, dpi: 300, pick: pick) == AlignmentSize(widthIn: 4, heightIn: 2, dpi: 300))
        #expect(alignmentSizeFor(kind: .front, dpi: 203, pick: pick) == AlignmentSize(widthIn: 2, heightIn: 1, dpi: 203))
    }

    // MARK: One printer connection at a time, app-wide

    /// The container's lock is shared by Printer Setup and the Print Labels queue's send: a test
    /// label never opens a connection while a queued asset label is going out, nor the other way.
    @Test func aTestLabelAndAQueuedAssetLabelNeverOverlapOnThePrinter() async throws {
        try await start()
        await awaitPick203()
        let line = FakeLine()
        zebra(saved.host).line = line
        let settings = self.settings
        // The container's wiring of the queue's send (AppContainer: lockedSender(printerLock) { NetworkZebra }).
        let jobs = LabelPrintJobs(deps: PrintQueueDeps<PrintTarget>(
            settings: { await MainActor.run { settings.current() } },
            label: { _ in .ready("ASSET") },
            prepare: { zpl, _ in .ready(zpl) },
            send: lockedSender(lock) { host, zpl in try await line.connect("\(host) \(zpl)") },
            record: { _, _ in }))
        let target = PrintTarget(asset: KioskAssetRow(id: "a1", assetId: "A-1"), siteId: "s1", initiativeId: "i1")
        let vm = vm()

        // An asset label going out holds the printer: the test label waits its turn.
        line.hold = "ASSET"
        let first = Task { try await jobs.scan(target, scannedValue: "A-1") }
        await eventually("asset label on the printer") { line.held }
        vm.printTest(.alignment)
        try await Task.sleep(for: .milliseconds(60))
        #expect(line.started == ["10.0.0.5 ASSET"])
        #expect(vm.ui.testing)
        line.hold = nil
        #expect(try await first.value.state == .printed)
        await eventually("test label sent") { !vm.ui.testing }
        #expect(line.started.count == 2)
        #expect(line.started.last?.contains("ALIGN") == true)

        // And the other way: a test label going out holds the queued asset label.
        line.clearHeld()
        line.hold = "ALIGN"
        vm.printTest(.alignment)
        await eventually("test label on the printer") { line.held }
        let second = Task { try await jobs.scan(target, scannedValue: "A-1") }
        try await Task.sleep(for: .milliseconds(60))
        #expect(line.started.count == 3)
        line.hold = nil
        #expect(try await second.value.state == .printed)
        #expect(line.started.last == "10.0.0.5 ASSET")
        await eventually("test label done") { !vm.ui.testing }
        #expect(line.maxOpen == 1)
    }

    /// Checks hold the same lock: a queued asset label waits for the query in progress.
    @Test func aQueuedAssetLabelWaitsForACheckQuery() async throws {
        try await start()
        await awaitPick203()
        let line = FakeLine()
        let z = zebra(saved.host)
        z.line = line
        let jobs = LabelPrintJobs(deps: PrintQueueDeps<PrintTarget>(
            settings: { [settings] in await MainActor.run { settings.current() } },
            label: { _ in .ready("ASSET") },
            prepare: { zpl, _ in .ready(zpl) },
            send: lockedSender(lock) { host, zpl in try await line.connect("\(host) \(zpl)") },
            record: { _, _ in }))
        let vm = vm()
        line.hold = "status"
        vm.checkAgain()
        await eventually("status query open") { line.held }
        let job = Task { try await jobs.scan(PrintTarget(asset: KioskAssetRow(id: "a1", assetId: "A-1"), siteId: "s1", initiativeId: "i1"),
                                             scannedValue: "A-1") }
        try await Task.sleep(for: .milliseconds(60))
        #expect(!line.started.contains("10.0.0.5 ASSET"))
        line.hold = nil
        #expect(try await job.value.state == .printed)
        await eventually("checks finished") { !vm.ui.checking }
        #expect(line.maxOpen == 1)
    }

    // MARK: No unrequested checks

    @Test func nothingTalksToThePrinterUntilAskedAndAQueuedChangeNeverChecks() async throws {
        try await start()
        await awaitPick203()
        let vm = vm()
        try await Task.sleep(for: .milliseconds(60))
        #expect(zebras.isEmpty || zebra(saved.host).calls.isEmpty)
        // Offsets and peel change settings only.
        vm.setOffsetX("5")
        vm.setPeel(true)
        await eventually("saved") { self.current.offsetX == 5 && self.current.peel }
        #expect(zebras.isEmpty || zebra(saved.host).calls.isEmpty)
        #expect(vm.ui.checkRuns == 0)
        #expect(vm.ui.checks.isEmpty)
    }

    @Test func aSavedPrinterThatDoesNotAnswerStopsTheChecksThere() async throws {
        try await start()
        let z = zebra(saved.host)
        z.answers = false
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        #expect(vm.ui.checks.map(\.key) == [.answers])
        #expect(row(vm, .answers)?.state == .fail)
        #expect(row(vm, .answers)?.detail == "No Zebra printer answered at 10.0.0.5.")
        #expect(z.calls == ["identify"])
    }

    @Test func statusProblemsFailTheReadyRow() async throws {
        try await start()
        await awaitPick203()
        zebra(saved.host).paperOut = true
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        #expect(row(vm, .status)?.state == .fail)
        #expect(row(vm, .status)?.detail == "Paper out: load labels.")
        #expect(vm.ui.checks.map(\.key) == CheckKey.allCases)
    }

    // MARK: Local Network (iOS)

    @Test func aDeniedScanRescansOnceWhenTheAppComesBack() async throws {
        let gated = Sleeps(gated: true)
        let found = [FoundPrinter(host: "10.0.0.7", model: "ZT230", serial: "SER9", dpi: 300)]
        scanner.results = [ZebraScanResult(printers: [], localNetworkDenied: true), ZebraScanResult(printers: found, localNetworkDenied: false)]
        let vm = vm(sleeps: gated)
        vm.scan()
        #expect(await gated.gate!.waitForSleepers(1))
        #expect(gated.asked == [.seconds(2)])
        #expect(scanner.count == 1)
        #expect(vm.ui.scanning)
        #expect(vm.ui.scanMessage == nil)
        // The Local Network prompt (inactive), then Allow (active).
        vm.scenePhaseChanged(active: false)
        vm.scenePhaseChanged(active: true)
        await eventually("rescanned") { !vm.ui.scanning }
        #expect(scanner.count == 2)
        #expect(vm.ui.found == found)
        #expect(vm.ui.scanMessage == nil)
        #expect(!vm.ui.localNetworkDenied)
        // The 2 s fallback was dropped, not left to rescan again.
        #expect(await waitUntil { gated.gate!.waiterCount == 0 })
        try await Task.sleep(for: .milliseconds(30))
        #expect(scanner.count == 2)
    }

    @Test func aDeniedScanRescansAfterTwoSecondsAndOnlyThenSaysLocalNetworkIsOff() async throws {
        let gated = Sleeps(gated: true)
        scanner.results = [ZebraScanResult(printers: [], localNetworkDenied: true)]
        let vm = vm(sleeps: gated)
        vm.scan()
        #expect(await gated.gate!.waitForSleepers(1))
        #expect(vm.ui.scanMessage == nil)
        #expect(await gated.gate!.tick())
        await eventually("rescanned") { !vm.ui.scanning }
        #expect(scanner.count == 2)
        #expect(vm.ui.scanMessage == LOCAL_NETWORK_DENIED_TEXT)
        #expect(vm.ui.localNetworkDenied)
        #expect(vm.ui.scanError)
        // Staying in front starts nothing more.
        vm.scenePhaseChanged(active: true)
        try await Task.sleep(for: .milliseconds(30))
        #expect(scanner.count == 2)
        #expect(gated.asked == [.seconds(2)])
    }

    /// Ruling: with the denied message showing, coming back to the app (from Settings, Local
    /// Network turned on) scans once more, and that scan has no rescan of its own.
    @Test func comingBackWithTheDeniedMessageShowingScansOnceMore() async throws {
        let gated = Sleeps(gated: true)
        scanner.results = [ZebraScanResult(printers: [], localNetworkDenied: true)]
        let vm = vm(sleeps: gated)
        vm.scenePhaseChanged(active: true) // the first phase
        vm.scan()
        #expect(await gated.gate!.tick())
        await eventually("denied twice") { !vm.ui.scanning && vm.ui.scanMessage == LOCAL_NETWORK_DENIED_TEXT }
        #expect(scanner.count == 2)

        vm.scenePhaseChanged(active: false) // off to Settings
        try await Task.sleep(for: .milliseconds(20))
        #expect(scanner.count == 2)
        vm.scenePhaseChanged(active: true)  // back
        await eventually("scanned once more") { scanner.count == 3 && !vm.ui.scanning }
        #expect(vm.ui.scanMessage == LOCAL_NETWORK_DENIED_TEXT) // still off: says so at once
        #expect(gated.asked == [.seconds(2)])
        try await Task.sleep(for: .milliseconds(30))
        #expect(scanner.count == 3)

        // Allowed this time: the printers show.
        let found = [FoundPrinter(host: "10.0.0.7", model: "ZT230", serial: "SER9", dpi: 300)]
        scanner.results = [ZebraScanResult(printers: found, localNetworkDenied: false)]
        vm.scenePhaseChanged(active: false)
        vm.scenePhaseChanged(active: true)
        await eventually("found") { vm.ui.found == found && !vm.ui.scanning }
        #expect(vm.ui.scanMessage == nil)
        #expect(!vm.ui.localNetworkDenied)
    }

    /// The fallback ending under the system prompt (scene not active) doesn't use up the one
    /// rescan: it waits for the app to be in front.
    @Test func aFallbackThatEndsUnderThePromptWaitsForTheAppToBeInFront() async throws {
        let gated = Sleeps(gated: true)
        let found = [FoundPrinter(host: "10.0.0.7", model: "ZT230", serial: "SER9", dpi: 300)]
        scanner.results = [ZebraScanResult(printers: [], localNetworkDenied: true), ZebraScanResult(printers: found, localNetworkDenied: false)]
        let vm = vm(sleeps: gated)
        vm.scenePhaseChanged(active: true) // the first phase
        vm.scan()
        vm.scenePhaseChanged(active: false) // the Local Network prompt
        #expect(await gated.gate!.tick())
        try await Task.sleep(for: .milliseconds(40))
        #expect(scanner.count == 1)
        #expect(vm.ui.scanning)
        #expect(vm.ui.scanMessage == nil)
        vm.scenePhaseChanged(active: true) // Allow tapped
        await eventually("rescanned") { !vm.ui.scanning }
        #expect(scanner.count == 2)
        #expect(vm.ui.found == found)
        #expect(vm.ui.scanMessage == nil)
    }

    // MARK: Local Network denial outside the scan

    @Test func choosingAPrinterKeptOffTheLocalNetworkSaysToAllowIt() async throws {
        try await start()
        let z = zebra("10.0.0.9")
        z.answers = false
        z.deniedLocalNetwork = true
        let vm = vm()
        vm.setIpText("10.0.0.9")
        vm.useIp()
        await eventually("refused") { vm.ui.chooseError != nil && vm.ui.choosing == nil }
        #expect(vm.ui.chooseError == LOCAL_NETWORK_DENIED_TEXT)
        #expect(vm.ui.localNetworkDenied)
        #expect(current.printer == saved)
    }

    @Test func theAnswersCheckKeptOffTheLocalNetworkSaysToAllowIt() async throws {
        try await start()
        let z = zebra(saved.host)
        z.answers = false
        z.deniedLocalNetwork = true
        let vm = vm()
        await checked(vm) { vm.checkAgain() }
        #expect(row(vm, .answers)?.state == .fail)
        #expect(row(vm, .answers)?.detail == LOCAL_NETWORK_DENIED_TEXT)
        #expect(vm.ui.localNetworkDenied)
        // Allowed, checked again: the message and the Settings offer go.
        z.answers = true
        await checked(vm) { vm.checkAgain() }
        #expect(row(vm, .answers)?.state == .ok)
        #expect(!vm.ui.localNetworkDenied)
    }

    @Test func aTestLabelKeptOffTheLocalNetworkSaysToAllowIt() async throws {
        try await start()
        await awaitPick203()
        let z = zebra(saved.host)
        z.answers = false
        z.deniedLocalNetwork = true
        let vm = vm()
        vm.printTest(.alignment)
        await eventually("refused") { !vm.ui.testing && vm.ui.testMessage != nil }
        #expect(vm.ui.testMessage == LOCAL_NETWORK_DENIED_TEXT)
        #expect(vm.ui.testError)
        #expect(vm.ui.localNetworkDenied)
    }

    @Test func comingBackWithNoDeniedScanStartsNothingAndAFailedScanSaysSo() async throws {
        let vm = vm()
        vm.scenePhaseChanged(active: true)
        vm.scenePhaseChanged(active: false)
        vm.scenePhaseChanged(active: true)
        try await Task.sleep(for: .milliseconds(30))
        #expect(scanner.count == 0)
        scanner.error = ScanBroke()
        vm.scan()
        await eventually("scan done") { !vm.ui.scanning }
        #expect(vm.ui.scanMessage == "Couldn't scan the network.")
        #expect(vm.ui.scanError)
        #expect(vm.ui.found == [])
        #expect(scanner.count == 1)
    }

    // MARK: Offsets

    @Test func parseOffsetTakesWholeNumbersClampedToTheRange() {
        #expect(PrinterSetupViewModel.parseOffset("12") == 12)
        #expect(PrinterSetupViewModel.parseOffset(" -3 ") == -3)
        #expect(PrinterSetupViewModel.parseOffset("-0") == 0)
        #expect(PrinterSetupViewModel.parseOffset("99999") == 9999)
        #expect(PrinterSetupViewModel.parseOffset("-99999999999999999999999") == -9999)
        #expect(PrinterSetupViewModel.parseOffset("9999") == 9999)
        #expect(PrinterSetupViewModel.parseOffset("-9999") == -9999)
        // Kotlin's toBigIntegerOrNull: no plus sign, no lone minus, no fractions or spaces inside.
        #expect(PrinterSetupViewModel.parseOffset("+5") == nil)
        #expect(PrinterSetupViewModel.parseOffset("-") == nil)
        #expect(PrinterSetupViewModel.parseOffset("") == nil)
        #expect(PrinterSetupViewModel.parseOffset("1.5") == nil)
        #expect(PrinterSetupViewModel.parseOffset("1 2") == nil)
        #expect(PrinterSetupViewModel.parseOffset("--1") == nil)
        #expect(PrinterSetupViewModel.parseOffset("x") == nil)
    }

    @Test func offsetsSaveOnceTheTypingStopsAndTidyShowsWhatIsSaved() async throws {
        try await start()
        let gated = Sleeps(gated: true)
        let vm = vm(sleeps: gated)
        vm.setOffsetX("1")
        vm.setOffsetX("12")
        vm.setOffsetY("-")
        // Each edit restarts the 500 ms wait: one save, with the last values.
        #expect(await waitUntil { gated.gate!.waiterCount == 1 })
        try await Task.sleep(for: .milliseconds(20))
        #expect(gated.gate!.waiterCount == 1)
        #expect(gated.asked.allSatisfy { $0 == .milliseconds(500) })
        #expect(current.offsetX == 0)
        #expect(await gated.gate!.tick())
        await eventually("saved") { self.current.offsetX == 12 && self.current.offsetY == 0 }
        // Unreadable text keeps the saved value; tidying shows it.
        vm.tidyOffsets()
        #expect(vm.ui.offsetXText == "12")
        #expect(vm.ui.offsetYText == "0")

        vm.setOffsetY("-99999")
        // Closing the screen keeps an edit still waiting for its save.
        vm.close()
        #expect(await gated.gate!.tick())
        await eventually("clamped and saved") { self.current.offsetY == -9999 }
        vm.tidyOffsets()
        #expect(vm.ui.offsetYText == "-9999")
    }

    @Test func theFieldsStartWithTheSavedOffsets() async throws {
        try await start()
        settings.setOffsets(x: 7, y: -4)
        let vm = vm()
        #expect(vm.ui.offsetXText == "7")
        #expect(vm.ui.offsetYText == "-4")
    }

    // MARK: Test labels

    @Test func aHelperThatTimesOutIsAskedOnceMore() async throws {
        try await start()
        await awaitPick203()
        engine.timeouts = ["alignmentTestZpl": 1, "withPrintMode": 1]
        let vm = vm()
        vm.printTest(.alignment)
        await eventually("sent") { !vm.ui.testing && vm.ui.testMessage != nil }
        #expect(zebra(saved.host).sent == ["LT0LS0|ALIGN 812x406 4x2 203|MMT"])
        #expect(engine.count("alignmentTestZpl") == 2)
        #expect(engine.count("withPrintMode") == 2)

        engine.timeouts = ["alignmentTestZpl": 2]
        vm.printTest(.alignment)
        await eventually("failed") { !vm.ui.testing && vm.ui.testError }
        #expect(vm.ui.testMessage == "Couldn't make the test label. Try again.")
        #expect(zebra(saved.host).sent.count == 1)
    }

    @Test func anUnsupportedDeviceOrAPrinterTimeoutSaysSo() async throws {
        try await start()
        await awaitPick203()
        let vm = vm()
        engine.unsupported = true
        vm.printTest(.sample)
        await eventually("refused") { !vm.ui.testing && vm.ui.testMessage != nil }
        #expect(vm.ui.testMessage == DEVICE_UNSUPPORTED_TEXT)
        #expect(vm.ui.testError)

        engine.unsupported = false
        zebra(saved.host).sendError = PrinterTimeout(host: saved.host)
        vm.printTest(.alignment)
        await eventually("timed out") { !vm.ui.testing && vm.ui.testMessage == "The printer didn't take the test label in time." }
        #expect(vm.ui.testError)
    }

    @Test func aSampleTheGeneratorRefusesSaysWhyAndSendsNothing() async throws {
        try await start()
        await awaitPick203()
        engine.sampleAnswer = FakeLabelEngine.text(["zpl": NSNull(), "reason": NO_TEMPLATE_AT_DPI])
        let vm = vm()
        vm.printTest(.sample)
        await eventually("refused") { !vm.ui.testing && vm.ui.testMessage != nil }
        #expect(vm.ui.testMessage == "This move has no template at this printer's DPI.")
        #expect(vm.ui.testError)
        #expect(zebra(saved.host).sent.isEmpty)
        #expect(engine.count("applyPrintSettings") == 0)

        #expect(PrinterSetupViewModel.sampleRefusedText(TEMPLATE_FAILED) == "The label template couldn't be built.")
        #expect(PrinterSetupViewModel.sampleRefusedText(TEMPLATE_UNSUPPORTED) == NEEDS_UPDATE_TEXT)
        #expect(PrinterSetupViewModel.sampleRefusedText(nil) == "No sample label for this printer.")
        #expect(PrinterSetupViewModel.sampleRefusedText("") == "No sample label for this printer.")
        #expect(PrinterSetupViewModel.sampleRefusedText("Vegas Top is at 203 DPI only.") == "Vegas Top is at 203 DPI only.")
    }

    // MARK: Copy

    @Test func foundAndPeelerTextReadAsOnAndroid() {
        #expect(foundDetails(FoundPrinter(host: "h", model: "ZD421", serial: "XYZ", dpi: 203)) == "ZD421 · Serial XYZ · 203 DPI")
        #expect(foundDetails(FoundPrinter(host: "h", model: nil, serial: nil, dpi: 300)) == "300 DPI")
        #expect(foundDetails(FoundPrinter(host: "h", model: nil, serial: nil, dpi: nil)) == "Didn't say what it is")
        #expect(peelerDetail(present: true, peel: true) == "Peeler detected · printing in peel-off mode")
        #expect(peelerDetail(present: false, peel: false) == "No peeler · printing in tear-off mode")
        #expect(peelerDetail(present: nil, peel: false) == "Printer doesn't report a peeler · printing in tear-off mode")
        #expect(offsetHint(dpi: 203) == "8 dots ≈ 1 mm at 203 DPI.")
        #expect(offsetHint(dpi: 300) == "12 dots ≈ 1 mm at 300 DPI.")
        #expect(CheckKey.allCases.map(\.label) == ["Printer answers", "DPI matches the templates", "Ready to print", "Peeler", "Fonts installed"])
    }
}
