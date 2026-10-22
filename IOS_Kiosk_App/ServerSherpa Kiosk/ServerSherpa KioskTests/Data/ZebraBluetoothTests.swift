import CoreBluetooth
import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// The Bluetooth link and transport over a fake central: every timer is a `ManualSleeper` the
/// test fires, so nothing here waits for real time.
@MainActor
struct ZebraBluetoothTests {
    private let serial = "D8J224508535"
    private let at = Date(timeIntervalSince1970: 1_792_660_000)

    // The timers by their (spec) durations.
    private let connectReady = Duration.seconds(ZebraBluetoothSpec.connectReady)
    private let idle = Duration.seconds(ZebraBluetoothSpec.queryIdle)
    private let total = Duration.seconds(ZebraBluetoothSpec.queryTotal)
    private let quiet = Duration.seconds(ZebraBluetoothSpec.drainQuiet)
    private let drainMax = Duration.seconds(ZebraBluetoothSpec.drainMax)
    private let spacing = Duration.seconds(ZebraBluetoothSpec.reconnectSpacing)
    private let scanFor = Duration.seconds(ZebraBluetoothSpec.scanDuration)

    /// The office ZD421-300dpi's `~HS` (82 bytes) and `~HI`.
    private let hs = "\u{02}030,0,0,0612,000,0,0,0,000,0,0,0\u{03}\r\n" +
        "\u{02}000,0,0,0,0,1,6,0,00000000,1,000\u{03}\r\n\u{02}0000,0\u{03}\r\n"
    private let hi = "\u{02}ZD421-300dpi,V93.21.38Z,12,8176KB\u{03}\r\n"

    private func make(state: BluetoothCentralState = .poweredOn) -> (ZebraBluetooth, FakeBluetoothClient, ManualSleeper) {
        let client = FakeBluetoothClient(state: state)
        let sleeper = ManualSleeper()
        let at = at
        let bluetooth = ZebraBluetooth(client: client, sleep: { try await sleeper.sleep($0) }, now: { at })
        return (bluetooth, client, sleeper)
    }

    /// A ZD421 iOS knows, connected and ready.
    private func connected(_ bluetooth: ZebraBluetooth, _ client: FakeBluetoothClient) async throws -> FakePeripheral {
        let p = FakePeripheral(serial: serial)
        client.central.known.append(p)
        _ = try await within { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
        return p
    }

    private func printer(_ p: FakePeripheral) -> SavedPrinter {
        SavedPrinter(connection: .bluetooth(serial: serial, peripheralId: p.identifier), model: "ZD421", serial: serial, dpi: 300)
    }

    private func frames(_ n: Int) -> @Sendable (Data) -> Bool { { replyHasFrames($0, n) } }

    /// The app's transport for `printer` (`zebraTransport`, its one factory), as the Bluetooth
    /// transport it is for a Bluetooth printer.
    private func transport(_ printer: SavedPrinter, _ bluetooth: ZebraBluetooth) throws -> BluetoothZebra {
        try #require(zebraTransport(for: printer, bluetooth: bluetooth) as? BluetoothZebra)
    }

    /// Awaits `task` for at most 3 s, so a regression fails the test instead of hanging the suite.
    private func finish<T: Sendable>(_ task: Task<T, Error>) async throws -> T {
        let outcome = Outcome<T>()
        Task { outcome.result = await task.result }
        try #require(await waitUntil { outcome.result != nil }, "the call never finished")
        return try #require(outcome.result).get()
    }

    private func finish<T: Sendable>(_ task: Task<T, Never>) async throws -> T {
        try await finish(Task<T, Error> { await task.value })
    }

    /// Runs `body`, bounded as `finish` is.
    private func within<T: Sendable>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
        try await finish(Task { try await body() })
    }

    // MARK: Writes

    @Test func writesInAckedChunks() async throws {
        let (bluetooth, client, _) = make()
        let p = try await connected(bluetooth, client)
        p.autoAck = false
        let progress = SentLog()
        let bytes = Data((0..<1000).map { UInt8($0 % 251) })
        let zebra = try transport(printer(p), bluetooth)
        let send = Task { try await zebra.write([bytes.prefix(600), bytes.suffix(400)], progress: progress.record) }

        for n in 1...5 {
            try #require(await waitUntil { p.writes.count == n })
            for _ in 0..<10 { await Task.yield() } // room for a write that doesn't wait for the ack
            #expect(p.writes.count == n)
            p.ack()
        }
        try await finish(send)

        #expect(p.writes.map(\.count) == [244, 244, 244, 244, 24])
        #expect(p.written == bytes)
        #expect(p.overlapping == 0)
        #expect(progress.sent == [0, 244, 488, 732, 976, 1000])
        #expect(progress.totals.allSatisfy { $0 == 1000 })
        #expect(bluetooth.link.chunkBytes == 244)
    }

    @Test func writeReportsZeroOnlyOnceItsBytesStartGoingOut() async throws {
        // Bluetooth is off: nothing went out, nothing is reported.
        let (off, offClient, _) = make(state: .poweredOff)
        let refused = SentLog()
        let offPrinter = FakePeripheral(serial: serial)
        offClient.central.known = [offPrinter]
        await #expect(throws: BluetoothUnavailable.self) {
            try await within { try await transport(printer(offPrinter), off).write([Data(count: 10)], progress: refused.record) }
        }
        #expect(refused.sent.isEmpty)

        // The printer never answers the connect: nothing is reported either.
        let (bluetooth, client, sleeper) = make()
        let p = FakePeripheral(serial: serial)
        p.connectBehavior = .silent
        client.central.known = [p]
        let zebra = try transport(printer(p), bluetooth)
        let unanswered = SentLog()
        let failing = Task { try await zebra.write([Data(count: 10)], progress: unanswered.record) }
        try #require(await waitUntil { sleeper.pending(connectReady) == 1 })
        sleeper.fire(connectReady)
        await #expect(throws: PrinterUnreachable.self) { try await finish(failing) }
        #expect(unanswered.sent.isEmpty)

        // Connected: (0, total) is heard before the first chunk is written.
        p.connectBehavior = .answer
        p.autoAck = false
        let started = SentLog()
        let send = Task { try await zebra.write([Data(count: 300)], progress: started.record) }
        try #require(await waitUntil { p.writes.count == 1 })
        #expect(started.sent == [0])
        p.ack()
        try #require(await waitUntil { p.writes.count == 2 })
        p.ack()
        try await finish(send)
        #expect(started.sent == [0, 244, 300])
    }

    @Test func sendBudgetEndsAStalledWrite() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        p.autoAck = false
        let zebra = try transport(printer(p), bluetooth)
        let budget = Duration.seconds(ZebraBluetoothSpec.sendBudget(bytes: 1000))

        // The acknowledgment never comes.
        let stalled = Task { try await zebra.write([Data(count: 1000)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 1 && sleeper.pending(budget) == 1 })
        sleeper.fire(budget)
        await #expect(throws: PrinterTimeout.self) { try await finish(stalled) }
        #expect(!bluetooth.link.connected)
        #expect(bluetooth.link.lastDrop?.at == at)
        #expect(client.central.cancels == [p.identifier])
        p.ack() // a late acknowledgment changes nothing
        for _ in 0..<10 { await Task.yield() }
        #expect(p.writes.count == 1)

        // The budget runs out just as a chunk is acknowledged: the rest of the send is still cut.
        let racing = Task { try await zebra.write([Data(count: 1000)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 2 && sleeper.pending(budget) == 1 })
        p.ack()
        sleeper.fire(budget)
        await #expect(throws: PrinterTimeout.self) { try await finish(racing) }
        let written = p.writes.count
        for _ in 0..<10 { await Task.yield() }
        #expect(p.writes.count == written)
        #expect(!bluetooth.link.connected)
    }

    @Test func failedWriteIsUnreachable() async throws {
        let (bluetooth, client, _) = make()
        let p = try await connected(bluetooth, client)
        p.autoAck = false
        let send = Task { try await transport(printer(p), bluetooth).write([Data(count: 600)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 1 })
        p.ack(error: NSError(domain: CBATTErrorDomain, code: 3)) // writeNotPermitted
        do {
            try await finish(send)
            Issue.record("a write the printer refused must fail")
        } catch let error as PrinterUnreachable {
            #expect(error.host == serial)
        }
        #expect(p.writes.count == 1)
    }

    @Test func closeFailsQueuedCalls() async throws {
        let (bluetooth, client, _) = make()
        let p = try await connected(bluetooth, client)
        p.autoAck = false
        let zebra = try transport(printer(p), bluetooth)
        let inFlight = Task { try await zebra.write([Data(count: 10)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 1 })
        let queuedSend = Task { try await zebra.send("^XA^FDB^FS^XZ") }
        let queuedQuery = Task { try await zebra.query(ZebraCommands.hostStatus, complete: frames(3)) }
        try #require(await waitUntil { bluetooth.waitingCalls == 2 })

        bluetooth.close()

        await #expect(throws: PrinterUnreachable.self) { try await finish(inFlight) }
        await #expect(throws: PrinterUnreachable.self) { try await finish(queuedSend) }
        await #expect(throws: PrinterUnreachable.self) { try await finish(queuedQuery) }
        for _ in 0..<10 { await Task.yield() }
        #expect(client.central.connects.count == 1)
        #expect(p.writes.count == 1)

        // A call made after close() reconnects; a queued call whose task is cancelled never runs.
        let next = Task { try await zebra.write([Data(count: 10)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 2 })
        let cancelled = Task { try await zebra.send("^XA^FDC^FS^XZ") }
        try #require(await waitUntil { bluetooth.waitingCalls == 1 })
        cancelled.cancel()
        p.ack()
        try await finish(next)
        await #expect(throws: CancellationError.self) { try await finish(cancelled) }
        #expect(client.central.connects.count == 2)
        #expect(p.writes.count == 2)
    }

    @Test func backgroundCloseFailsPendingSend() async throws {
        let (bluetooth, client, _) = make()
        let p = try await connected(bluetooth, client)
        p.autoAck = false
        let zebra = try transport(printer(p), bluetooth)
        let send = Task { try await zebra.write([Data(count: 1000)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 1 })

        bluetooth.close()

        await #expect(throws: PrinterUnreachable.self) { try await finish(send) }
        #expect(client.central.cancels == [p.identifier])
        #expect(!bluetooth.link.connected)
        p.ack() // a late acknowledgment changes nothing
        for _ in 0..<10 { await Task.yield() }
        #expect(p.writes.count == 1)
    }

    // MARK: Queries

    @Test func queryWaitsForCompleteReply() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        let zebra = try transport(printer(p), bluetooth)
        let ask = Task { try await zebra.query(ZebraCommands.hostStatus, complete: frames(3)) }
        try #require(await waitUntil { p.writes.count == 1 && sleeper.pending(idle) == 1 })
        #expect(p.written == Data("~HS".utf8))

        let bytes = Array(hs)
        p.indicate(String(bytes[0..<20]))
        p.indicate(String(bytes[20..<60]))
        p.indicate(String(bytes[60...]))

        let reply = try await finish(ask)
        #expect(reply == hs)
        #expect(reply.utf8.count == 82)
        #expect(parseHostStatus(reply) != nil)
        #expect(sleeper.pending(idle) == 0)
        #expect(sleeper.pending(total) == 0)
    }

    @Test func queryDrainsLateBytes() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        let zebra = try transport(printer(p), bluetooth)
        p.indicate("\u{02}LATE\u{03}") // the end of an earlier reply
        try #require(await waitUntil { sleeper.pending(quiet) == 1 })

        let ask = Task { try await zebra.query(ZebraCommands.hostIdentification, complete: frames(1)) }
        try #require(await waitUntil { sleeper.pending(drainMax) == 1 })
        p.indicate("\r\n") // still arriving: the quiet clock starts over
        try #require(await waitUntil { sleeper.started(quiet) == 2 && sleeper.pending(quiet) == 1 })
        #expect(p.writes.isEmpty)

        sleeper.fire(quiet)
        try #require(await waitUntil { p.writes.count == 1 })
        p.indicate(hi)
        #expect(try await finish(ask) == hi)
        #expect(sleeper.pending(drainMax) == 0)

        // A line that never goes quiet holds a query back at most drainMax.
        sleeper.fire(quiet)
        p.indicate("\u{02}JUNK")
        try #require(await waitUntil { sleeper.pending(quiet) == 1 })
        let second = Task { try await zebra.query(ZebraCommands.hostIdentification, complete: frames(1)) }
        try #require(await waitUntil { sleeper.pending(drainMax) == 1 })
        #expect(p.writes.count == 1)
        sleeper.fire(drainMax)
        try #require(await waitUntil { p.writes.count == 2 })
        p.indicate(hi)
        #expect(try await finish(second) == hi)
    }

    @Test func queryEndsOnIdleAndTotal() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        let zebra = try transport(printer(p), bluetooth)

        // No ETX: the reply ends queryIdle after its last byte.
        let partial = Task { try await zebra.query(ZebraCommands.hostIdentification, complete: frames(1)) }
        try #require(await waitUntil { p.writes.count == 1 && sleeper.pending(idle) == 1 })
        p.indicate("\u{02}ZD421")
        try #require(await waitUntil { sleeper.started(idle) == 2 && sleeper.pending(idle) == 1 })
        sleeper.fire(idle)
        #expect(try await finish(partial) == "\u{02}ZD421")
        #expect(sleeper.pending(total) == 0)

        // An endless trickle: each byte holds the idle wait off, so queryTotal ends it.
        sleeper.fire(quiet)
        let trickle = Task { try await zebra.query(ZebraCommands.hostIdentification, complete: frames(1)) }
        try #require(await waitUntil { p.writes.count == 2 && sleeper.pending(idle) == 1 && sleeper.pending(total) == 1 })
        let idles = sleeper.started(idle)
        for text in ["a", "b", "c"] { p.indicate(text) }
        try #require(await waitUntil { sleeper.started(idle) == idles + 3 })
        sleeper.fire(total)
        #expect(try await finish(trickle) == "abc")
        #expect(sleeper.pending(idle) == 0)
    }

    @Test func silentPrinterIsNoReply() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        let zebra = try transport(printer(p), bluetooth)
        let ask = Task { try await zebra.query(ZebraCommands.hostStatus, complete: frames(3)) }
        try #require(await waitUntil { sleeper.pending(idle) == 1 })
        sleeper.fire(idle)
        do {
            _ = try await finish(ask)
            Issue.record("a query nobody answers must throw")
        } catch let error as PrinterNoReply {
            #expect(error.host == serial)
        }
    }

    @Test func dropDuringQueryFailsIt() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        let zebra = try transport(printer(p), bluetooth)

        // Waiting for the reply.
        let waiting = Task { try await zebra.query(ZebraCommands.hostStatus, complete: frames(3)) }
        try #require(await waitUntil { sleeper.pending(idle) == 1 })
        p.drop(cbError(7))
        await #expect(throws: PrinterUnreachable.self) { try await finish(waiting) }
        #expect(sleeper.pending(idle) == 0)

        // Dropped just as the command was acknowledged: no wait for a reply that can't come.
        p.autoAck = false
        let acked = Task { try await zebra.query(ZebraCommands.hostStatus, complete: frames(3)) }
        try #require(await waitUntil { p.writes.count == 2 })
        p.ack()
        p.drop(cbError(7))
        await #expect(throws: PrinterUnreachable.self) { try await finish(acked) }
        #expect(client.central.connects.count == 2)
    }

    // MARK: Connecting

    @Test func centralIsMadeOnFirstUseOnly() {
        let (bluetooth, client, _) = make()
        #expect(client.made == 0)
        #expect(bluetooth.availability == .unknown)
        bluetooth.start()
        bluetooth.start()
        #expect(client.made == 1)
        #expect(bluetooth.availability == .ready)
    }

    @Test func connectByIdentifierThenBySerial() async throws {
        let (bluetooth, client, _) = make()
        let known = FakePeripheral(serial: serial)
        client.central.known = [known]
        let info = try await within { try await bluetooth.connect(peripheralId: known.identifier, serial: serial) }
        #expect(info == BluetoothPrinterInfo(peripheralId: known.identifier, manufacturer: "Zebra Technologies", model: "ZD421",
                                             serial: serial, firmware: "V93.21.38Z", linkOs: "7.3"))
        #expect(client.central.scans == 0)
        #expect(bluetooth.link.connected)
        #expect(bluetooth.link.info == info)
        #expect(bluetooth.link.connectedAt == at)
        #expect(known.notifying)
        bluetooth.close()

        // iOS no longer knows the identifier: scan for the device named the serial.
        client.central.known = []
        let laptop = FakePeripheral(name: "James’s Mac mini", serial: "C02XL0GQJGH5")
        let zd421 = FakePeripheral(serial: serial)
        let connecting = Task { try await bluetooth.connect(peripheralId: UUID(), serial: serial) }
        try #require(await waitUntil { client.central.scanning })
        client.central.advertise(laptop, rssi: -40)
        client.central.advertise(zd421, rssi: -62)
        let found = try await finish(connecting)
        #expect(found.peripheralId == zd421.identifier)
        #expect(client.central.connects == [known.identifier, zd421.identifier])
        #expect(!client.central.scanning)

        // The saved printer still carries the identifier iOS forgot: the link found by its serial
        // serves it, with no reconnect per label.
        let stale = SavedPrinter(connection: .bluetooth(serial: serial, peripheralId: UUID()), model: "ZD421", serial: serial, dpi: 300)
        try await within { try await transport(stale, bluetooth).send("^XA^XZ") }
        #expect(client.central.connects.count == 2)
        #expect(zd421.written == Data("^XA^XZ".utf8))
    }

    @Test func serialMismatchIsRefused() async throws {
        let (bluetooth, client, _) = make()
        let other = FakePeripheral(serial: "D8J231701234") // another ZD421 answers to the saved identifier
        client.central.known = [other]
        do {
            _ = try await within { try await bluetooth.connect(peripheralId: other.identifier, serial: serial) }
            Issue.record("another printer's serial must be refused")
        } catch let error as BluetoothSerialMismatch {
            #expect(error.host == serial)
        }
        #expect(client.central.cancels == [other.identifier])
        #expect(!other.notifying)
        #expect(!bluetooth.link.connected)

        // The print path refuses it the same way, before a byte is written.
        let saved = SavedPrinter(connection: .bluetooth(serial: serial, peripheralId: other.identifier), model: "ZD421", serial: serial, dpi: 300)
        await #expect(throws: BluetoothSerialMismatch.self) { try await within { try await transport(saved, bluetooth).send("^XA^XZ") } }
        #expect(other.writes.isEmpty)
    }

    @Test func nonZebraIsRefused() async throws {
        let (bluetooth, client, _) = make()
        let speaker = FakePeripheral(serial: serial, manufacturer: "Bose Corporation")
        let noParser = FakePeripheral(serial: serial)
        noParser.hasZebraService = false
        client.central.known = [speaker, noParser]

        for device in [speaker, noParser] {
            await #expect(throws: BluetoothNotZebra.self) {
                _ = try await within { try await bluetooth.connect(peripheralId: device.identifier, serial: nil) }
            }
            #expect(client.central.cancels.last == device.identifier)
            #expect(!device.notifying)
        }
        #expect(!bluetooth.link.connected)

        // A manufacturer that can't be read says nothing about the device: it's unreachable, not
        // "not a Zebra".
        let unread = FakePeripheral(serial: serial)
        unread.failingReads = [ZebraBluetoothSpec.manufacturerUUID]
        client.central.known.append(unread)
        await #expect(throws: PrinterUnreachable.self) {
            _ = try await within { try await bluetooth.connect(peripheralId: unread.identifier, serial: serial) }
        }
        #expect(!unread.notifying)
    }

    @Test func connectTimesOutWithinBudget() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = FakePeripheral(serial: serial)
        p.connectBehavior = .silent // off, or out of range
        client.central.known = [p]
        let saved = printer(p)
        let zebra = try transport(saved, bluetooth)

        let send = Task { try await zebra.send("^XA^FDA^FS^XZ") }
        try #require(await waitUntil { client.central.connects.count == 1 && sleeper.pending(connectReady) == 1 })
        sleeper.fire(connectReady)
        do {
            try await finish(send)
            Issue.record("a printer that never answers must be unreachable")
        } catch let error as PrinterUnreachable {
            #expect(error.host == serial)
        }
        #expect(printerUnreachableText(saved) == "Can't reach the printer D8J224508535 over Bluetooth.")
        #expect(client.central.cancels == [p.identifier])
        #expect(p.writes.isEmpty)

        // Back in range: Retry goes out.
        p.connectBehavior = .answer
        try await within { try await zebra.send("^XA^FDA^FS^XZ") }
        #expect(p.written == Data("^XA^FDA^FS^XZ".utf8))
    }

    @Test func pairingLostStopsRetries() async throws {
        for code in [14, 15] {
            let (bluetooth, client, sleeper) = make()
            let p = FakePeripheral(serial: serial)
            p.dropsOnDiscover = [cbError(code), cbError(code)]
            client.central.known = [p]
            do {
                _ = try await within { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
                Issue.record("CBError \(code) must stop the connect")
            } catch let error as BluetoothPairingLost {
                #expect(error.host == serial)
                #expect(error.localizedDescription == pairingLostText(serial: serial))
            }
            for _ in 0..<10 { await Task.yield() }
            #expect(client.central.connects.count == 1)
            #expect(sleeper.started(spacing) == 0)
        }

        // The pairing goes while a label is going out: the send fails with the recovery, and
        // nothing reconnects.
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        p.autoAck = false
        let send = Task { try await transport(printer(p), bluetooth).write([Data(count: 600)], progress: nil) }
        try #require(await waitUntil { p.writes.count == 1 })
        p.drop(cbError(14))
        await #expect(throws: BluetoothPairingLost.self) { try await finish(send) }
        for _ in 0..<10 { await Task.yield() }
        #expect(client.central.connects.count == 1)
        #expect(sleeper.started(spacing) == 0)
    }

    @Test func failedFirstConnectIsNotRetried() async throws {
        // CBError 10 (connectionFailed): nothing was ever up, so no retry and no drop.
        let (bluetooth, client, sleeper) = make()
        let p = FakePeripheral(serial: serial)
        p.connectBehavior = .fail(cbError(10))
        client.central.known = [p]
        await #expect(throws: PrinterUnreachable.self) {
            _ = try await within { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
        }
        for _ in 0..<10 { await Task.yield() }
        #expect(client.central.connects.count == 1)
        #expect(sleeper.started(spacing) == 0)
        #expect(bluetooth.link.lastDrop == nil)

        // The printer forgot this iPad: the recovery, after one connect.
        for code in [14, 15] {
            let (bluetooth, client, sleeper) = make()
            let p = FakePeripheral(serial: serial)
            p.connectBehavior = .fail(cbError(code))
            client.central.known = [p]
            await #expect(throws: BluetoothPairingLost.self) {
                _ = try await within { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
            }
            for _ in 0..<10 { await Task.yield() }
            #expect(client.central.connects.count == 1)
            #expect(sleeper.started(spacing) == 0)
            #expect(bluetooth.link.lastDrop == nil)
        }
    }

    @Test func failedReconnectCountsAsATry() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = FakePeripheral(serial: serial)
        p.dropsOnDiscover = [cbError(7)]
        client.central.known = [p]
        let connecting = Task { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
        try #require(await waitUntil { sleeper.pending(spacing) == 1 })
        p.connectBehavior = .fail(cbError(10)) // the reconnects never connect

        for retry in 1...3 {
            try #require(await waitUntil { sleeper.started(spacing) == retry && sleeper.pending(spacing) == 1 })
            sleeper.fire(spacing)
        }
        await #expect(throws: PrinterUnreachable.self) { try await finish(connecting) }
        #expect(client.central.connects.count == 4)
        #expect(sleeper.started(spacing) == 3)
        #expect(bluetooth.link.lastDrop?.reason == describeBluetoothError(cbError(7))) // the drop, not the failed reconnects
    }

    @Test func dropBeforeReadyRetriesThreeTimes() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = FakePeripheral(serial: serial)
        p.dropsOnDiscover = Array(repeating: cbError(7), count: 4)
        client.central.known = [p]
        let connecting = Task { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }

        for retry in 1...3 {
            try #require(await waitUntil { sleeper.pending(spacing) == 1 })
            #expect(client.central.connects.count == retry)
            sleeper.fire(spacing)
        }
        await #expect(throws: PrinterUnreachable.self) { try await finish(connecting) }
        #expect(client.central.connects.count == 4)
        #expect(sleeper.started(spacing) == 3)
        #expect(bluetooth.link.lastDrop?.at == at)

        // Two drops, then the link comes up: the connect succeeds.
        p.dropsOnDiscover = [cbError(7), cbError(7)]
        let recovering = Task { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
        for _ in 1...2 {
            try #require(await waitUntil { sleeper.pending(spacing) == 1 })
            sleeper.fire(spacing)
        }
        #expect(try await finish(recovering).serial == serial)
        #expect(client.central.connects.count == 7)
    }

    @Test func idleDropDoesNotReconnectUntilUsed() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = try await connected(bluetooth, client)
        p.drop(cbError(7))
        try #require(await waitUntil { !bluetooth.link.connected })
        #expect(bluetooth.link.lastDrop?.at == at)
        #expect(bluetooth.link.lastDrop?.reason.isEmpty == false)

        for _ in 0..<20 { await Task.yield() }
        #expect(client.central.connects.count == 1)
        #expect(sleeper.started(spacing) == 0)

        try await within { try await transport(printer(p), bluetooth).send("^XA^XZ") }
        #expect(client.central.connects.count == 2)
        #expect(p.written == Data("^XA^XZ".utf8))
        #expect(bluetooth.link.connected)
    }

    @Test func availabilityMapsStates() async throws {
        let cases: [(BluetoothCentralState, BluetoothAvailability)] = [
            (.poweredOff, .poweredOff), (.unauthorized, .unauthorized), (.unsupported, .unsupported),
        ]
        for (state, expected) in cases {
            let (bluetooth, client, _) = make(state: state)
            let p = FakePeripheral(serial: serial)
            client.central.known = [p]
            do {
                _ = try await within { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
                Issue.record("\(state) must refuse the connect")
            } catch let error as BluetoothUnavailable {
                #expect(error.availability == expected)
                #expect(error.host == serial)
            }
            await #expect(throws: BluetoothUnavailable.self) { try await within { try await transport(printer(p), bluetooth).send("^XA^XZ") } }
            #expect(bluetooth.availability == expected)
            #expect(client.central.retrieved.isEmpty)
            #expect(client.central.connects.isEmpty)
        }
        #expect(BluetoothUnavailable(host: serial, availability: .poweredOff).localizedDescription == BLUETOOTH_OFF_TEXT)
        #expect(BluetoothUnavailable(host: serial, availability: .unauthorized).localizedDescription == BLUETOOTH_DENIED_TEXT)

        // A new central reports its state a moment later: a connect waits for it. Turning
        // Bluetooth off drops the link.
        let (bluetooth, client, _) = make(state: .unknown)
        let p = FakePeripheral(serial: serial)
        client.central.known = [p]
        let connecting = Task { try await bluetooth.connect(peripheralId: p.identifier, serial: serial) }
        try #require(await waitUntil { client.made == 1 })
        #expect(bluetooth.availability == .unknown)
        client.central.report(.poweredOn)
        _ = try await finish(connecting)
        #expect(bluetooth.availability == .ready)
        client.central.report(.poweredOff)
        try #require(await waitUntil { bluetooth.availability == .poweredOff })
        #expect(!bluetooth.link.connected)
    }

    /// iOS forgot the identifier and the printer is heard late in the search for its serial: the
    /// connect itself still gets the full `connectReady` from the sighting (D7's 10 s count from
    /// the connect), and stays bounded by it.
    @Test func aPrinterFoundLateGetsTheFullConnectTime() async throws {
        let (bluetooth, client, sleeper) = make()
        let p = FakePeripheral(serial: serial)
        p.connectBehavior = .silent
        let connecting = Task { try await bluetooth.connect(peripheralId: UUID(), serial: serial) }
        try #require(await waitUntil { client.central.scanning && sleeper.pending(connectReady) == 1 })
        client.central.advertise(p, rssi: -60)
        try #require(await waitUntil { client.central.connects == [p.identifier] })
        #expect(await waitUntil { sleeper.started(connectReady) == 2 && sleeper.pending(connectReady) == 1 })
        sleeper.fire(connectReady)
        await #expect(throws: PrinterUnreachable.self) { try await finish(connecting) }
        #expect(client.central.cancels == [p.identifier])
    }

    // MARK: Scanning

    @Test func scanListsNamedDevicesStrongestFirst() async throws {
        let (bluetooth, client, sleeper) = make()
        let latest = Latest()
        let stream = bluetooth.scan()
        let listening = Task {
            for await list in stream { latest.list = list }
            latest.ended = true
        }
        try #require(await waitUntil { client.central.scanning })

        client.central.advertise(FakePeripheral(serial: serial), rssi: -70)
        client.central.advertise(FakePeripheral(name: "James’s Mac mini", serial: "C02XL0GQJGH5"), rssi: -40)
        client.central.advertise(FakePeripheral(name: "ZQ630", serial: "XXZQJ1234567"), rssi: -55, advertisesZebra: true)
        let unnamed = FakePeripheral(serial: "unused")
        unnamed.name = nil
        client.central.advertise(unnamed, rssi: -30)
        try #require(await waitUntil { latest.list.count == 3 })
        #expect(latest.list.map(\.name) == ["James’s Mac mini", "ZQ630", serial])
        #expect(latest.list.map(\.isZebra) == [false, true, true])
        #expect(latest.list.map(\.rssi) == [-40, -55, -70])

        sleeper.fire(scanFor)
        try #require(await waitUntil { latest.ended })
        try await finish(listening)
        #expect(!client.central.scanning)

        // stopScan ends a scan early.
        let again = bluetooth.scan()
        let stopped = Task { for await _ in again {} }
        try #require(await waitUntil { client.central.scanning })
        bluetooth.stopScan()
        try await finish(stopped)
        #expect(!client.central.scanning)
    }

    /// D9's 30 s scan counts once Bluetooth is ready and the radio scans: the first scan on a new
    /// iPad waits behind iOS's permission prompt without losing any of it, and a reset mid-scan
    /// starts the 30 s over once Bluetooth is back.
    @Test func theScanClockStartsOnceBluetoothIsReady() async throws {
        let (bluetooth, client, sleeper) = make(state: .unknown)
        let latest = Latest()
        let stream = bluetooth.scan()
        let listening = Task {
            for await list in stream { latest.list = list }
            latest.ended = true
        }
        try #require(await waitUntil { client.made == 1 })
        for _ in 0..<10 { await Task.yield() }
        #expect(sleeper.started(scanFor) == 0) // the prompt is still up
        #expect(!client.central.scanning)
        client.central.report(.poweredOn)
        try #require(await waitUntil { client.central.scanning })
        #expect(sleeper.started(scanFor) == 1)

        client.central.report(.resetting)
        try #require(await waitUntil { sleeper.pending(scanFor) == 0 })
        #expect(!latest.ended)
        client.central.report(.poweredOn)
        try #require(await waitUntil { sleeper.started(scanFor) == 2 && sleeper.pending(scanFor) == 1 })
        sleeper.fire(scanFor)
        try await finish(listening)
        #expect(latest.ended)
        #expect(bluetooth.lastScanEnd == .finished)
    }

    /// How a scan ended, for the screens' words: its full 30 s, Stop, a connect, write or query
    /// taking the radio, `close()`, Bluetooth refused, or a newer scan.
    @Test func theScanSaysHowItEnded() async throws {
        let (bluetooth, client, _) = make()
        let p = FakePeripheral(serial: serial)
        client.central.known = [p]
        let zebra = try transport(printer(p), bluetooth)

        var stream = bluetooth.scan()
        var listening = Task { for await _ in stream {} }
        try #require(await waitUntil { client.central.scanning })
        bluetooth.stopScan()
        try await finish(listening)
        #expect(bluetooth.lastScanEnd == .stopped)

        // A connect (the label's own) takes the radio, and so does a write on a link that is up.
        for _ in 0..<2 {
            stream = bluetooth.scan()
            listening = Task { for await _ in stream {} }
            try #require(await waitUntil { client.central.scanning })
            try await within { try await zebra.send("^XA^XZ") }
            try await finish(listening)
            #expect(bluetooth.lastScanEnd == .interrupted)
        }

        stream = bluetooth.scan()
        listening = Task { for await _ in stream {} }
        try #require(await waitUntil { client.central.scanning })
        let newer = bluetooth.scan()
        let listeningNewer = Task { for await _ in newer {} }
        try await finish(listening)
        #expect(bluetooth.lastScanEnd == .replaced)
        bluetooth.close()
        try await finish(listeningNewer)
        #expect(bluetooth.lastScanEnd == .closed)

        let (off, _, _) = make(state: .poweredOff)
        let refused = off.scan()
        try await finish(Task { for await _ in refused {} })
        #expect(off.lastScanEnd == .refused)
    }
}

/// The newest list a scan yielded, and whether its stream ended.
@MainActor
private final class Latest {
    var list: [FoundBluetoothPrinter] = []
    var ended = false
}

/// What a write reported, in order.
private final class SentLog: @unchecked Sendable {
    private let lock = NSLock()
    private var reports: [(sent: Int, total: Int)] = []

    var sent: [Int] { lock.withLock { reports.map(\.sent) } }
    var totals: [Int] { lock.withLock { reports.map(\.total) } }

    var record: @Sendable (_ sent: Int, _ total: Int) -> Void {
        { [self] sent, total in lock.withLock { reports.append((sent, total)) } }
    }
}

/// How a task ended, once it has.
@MainActor
private final class Outcome<T: Sendable> {
    var result: Result<T, Error>?
}
