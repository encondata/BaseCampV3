import Foundation
import Observation

// MARK: What the screens see

/// Whether the iPad can use Bluetooth right now.
enum BluetoothAvailability: Equatable, Sendable {
    case unknown, ready, poweredOff, unauthorized, unsupported
}

/// A named device a scan heard.
struct FoundBluetoothPrinter: Equatable, Sendable, Identifiable {
    /// The iPad's identifier for the device (iOS never shows its address).
    var id: UUID
    var name: String
    var rssi: Int
    /// It advertises Zebra's parser service or Zebra's company UUID (a ZD421 advertises neither).
    var advertisesZebra: Bool

    /// Flagged as a Zebra: it advertises Zebra, or its name is a Zebra serial (D9).
    var isZebra: Bool { advertisesZebra || ZebraBluetoothSpec.looksLikeZebraSerial(name) }
}

/// What the printer's Device Information service said when the link came up.
struct BluetoothPrinterInfo: Equatable, Sendable {
    var peripheralId: UUID
    var manufacturer: String?
    var model: String?
    var serial: String?
    var firmware: String?
    var linkOs: String?
}

/// The last time the link went down on its own (the printer, the radio, or a send that ran out of
/// time), and why.
struct BluetoothDrop: Equatable, Sendable {
    var at: Date
    var reason: String
}

/// The one Bluetooth link, for the connection details. `info` and `chunkBytes` stay from the last
/// link once it is down.
struct BluetoothLinkInfo: Equatable, Sendable {
    var connected = false
    var info: BluetoothPrinterInfo?
    var chunkBytes: Int?
    var connectedAt: Date?
    var lastActivity: Date?
    var lastDrop: BluetoothDrop?
}

/// The Bluetooth side as the screens use it (Printer Setup, Print Labels, Troubleshooting):
/// Bluetooth's state, the link, the scan, connecting to a printer, and letting it go.
/// `ZebraBluetooth` on the device.
@MainActor protocol BluetoothPrinting: AnyObject {
    var availability: BluetoothAvailability { get }
    var link: BluetoothLinkInfo { get }
    func scan() -> AsyncStream<[FoundBluetoothPrinter]>
    func stopScan()
    func connect(peripheralId: UUID?, serial: String?) async throws -> BluetoothPrinterInfo
    func close()
}

/// How long the Bluetooth link waits; the defaults are `ZebraBluetoothSpec`'s (a send's budget is
/// `ZebraBluetoothSpec.sendBudget(bytes:)`).
struct ZebraBluetoothTimeouts: Equatable, Sendable {
    var connectReady = ZebraBluetoothSpec.connectReady
    var queryIdle = ZebraBluetoothSpec.queryIdle
    var queryTotal = ZebraBluetoothSpec.queryTotal
    var drainQuiet = ZebraBluetoothSpec.drainQuiet
    var drainMax = ZebraBluetoothSpec.drainMax
    var reconnectSpacing = ZebraBluetoothSpec.reconnectSpacing
    var scanDuration = ZebraBluetoothSpec.scanDuration
}

/// Which printer a call is for: the iPad's identifier for it and/or its serial (its Bluetooth name).
struct BluetoothTarget: Equatable, Sendable {
    var peripheralId: UUID?
    var serial: String?
}

/**
 The app's Bluetooth LE side for Zebra printers: Bluetooth's availability, the scan, and the one
 link to a printer, which stays up while the app is in use (D4). Plain CoreBluetooth behind the
 `BluetoothCentralClient` seam, on the main queue; the sequencing is the spike's (branch ble-spike),
 which printed and queried a real ZD421.

 - The central is made by `start()` (or the first scan, connect or call), never at launch, so iOS
   asks for Bluetooth permission when Bluetooth is first picked (D11).
 - Connecting finds the printer by the iPad's identifier (`retrievePeripherals`), else by scanning
   for the name equal to its serial (D3); it is ready once Device Information is read and replies
   (indications on From Printer Data) are on, within `connectReady`. A device whose manufacturer
   isn't "Zebra Technologies" or that lacks the parser service is refused (`BluetoothNotZebra`), as
   is one whose serial isn't the expected one (`BluetoothSerialMismatch`). A link that is up serves
   every call for its serial, whichever identifier the call carries.
 - A first connect that fails (`didFailToConnect`, or no link within `connectReady`) fails at once:
   `BluetoothPairingLost` for CBError 14 / 15 (D10), else `PrinterUnreachable`. A link that
   connected and dropped before Ready is retried at most `reconnectTries` times, `reconnectSpacing`
   apart (a reconnect that fails counts as one of them), never after CBError 14 / 15. A drop after Ready
   fails the write or query in flight at once, is recorded as `link.lastDrop`, and nothing
   reconnects until the next call needs the printer (D4).
 - Writes and queries (`BluetoothZebra`) take turns: one at a time, in the order asked, each
   reconnecting first when the link is down. Writes go in `maximumWriteLength` chunks, each with a
   response, the next only after the printer acknowledges the last (D5), within the send budget
   (D7). Queries first drain late bytes of an earlier reply (D6). Neither sends anything of its own.
 - `close()` (background, sign-out, a printer change) ends the scan and the link and fails whatever
   was waiting on them.

 Every continuation is resumed once: it is taken out of its property before it is resumed, all on
 the main actor. Every timer runs on the injected `sleep`, and dates come from `now`.
 */
@MainActor @Observable
final class ZebraBluetooth {
    private(set) var availability: BluetoothAvailability = .unknown
    private(set) var link = BluetoothLinkInfo()

    @ObservationIgnored private let client: any BluetoothCentralClient
    @ObservationIgnored private let timeouts: ZebraBluetoothTimeouts
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var central: (any BluetoothCentral)?
    @ObservationIgnored private var centralScanning = false

    // The screens' scan.
    @ObservationIgnored private var uiScan: UiScan?
    @ObservationIgnored private var nextScanId = 0

    // The link and the connect in progress.
    @ObservationIgnored private var phase = Phase.idle
    @ObservationIgnored private var peripheral: (any BluetoothPeripheral)?
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var target = BluetoothTarget()
    /// The name errors carry for the link (the serial, once known).
    @ObservationIgnored private var host = ""
    /// Tries used after the link dropped before Ready (a failed reconnect counts too).
    @ObservationIgnored private var retriesUsed = 0
    @ObservationIgnored private var pendingServices: Set<String> = []
    @ObservationIgnored private var pendingReads: Set<String> = []
    @ObservationIgnored private var deviceInfo: [String: String] = [:]
    /// Device Information characteristics whose read failed.
    @ObservationIgnored private var unreadInfo: Set<String> = []
    @ObservationIgnored private var readyWaiter: CheckedContinuation<BluetoothPrinterInfo, Error>?
    /// The connect deadline, or the wait before a retry.
    @ObservationIgnored private var attemptTimer: Task<Void, Never>?

    // Writes and queries.
    @ObservationIgnored private var turnTaken = false
    /// Counts `close()`s: a call queued before one fails when its turn comes.
    @ObservationIgnored private var closes = 0
    @ObservationIgnored private var turnWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var ackWaiter: CheckedContinuation<Void, Error>?
    @ObservationIgnored private var nextSendId = 0
    /// The send in flight, and the send whose budget ran out.
    @ObservationIgnored private var runningSend: Int?
    @ObservationIgnored private var expiredSend: Int?
    @ObservationIgnored private var drainWaiter: CheckedContinuation<Void, Error>?
    @ObservationIgnored private var drainTimer: Task<Void, Never>?
    /// Running while a byte arrived within the last `drainQuiet`.
    @ObservationIgnored private var quietTimer: Task<Void, Never>?
    @ObservationIgnored private var collecting = false
    @ObservationIgnored private var rx = Data()
    @ObservationIgnored private var reply: ReplyWait?

    init(client: any BluetoothCentralClient,
         timeouts: ZebraBluetoothTimeouts = ZebraBluetoothTimeouts(),
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.timeouts = timeouts
        self.sleep = sleep
        self.now = now
    }

    // MARK: Public

    /// Makes the central the first time (iOS asks for Bluetooth permission then); later calls do
    /// nothing.
    func start() {
        guard central == nil else { return }
        let made = client.makeCentral { [weak self] event in self?.handle(event) }
        central = made
        availability = Self.availability(for: made.state)
    }

    /// Every named device nearby, strongest first, refreshed as the scan hears them. The stream
    /// ends after `scanDuration`, on `stopScan()`, when a new scan starts, when Bluetooth goes
    /// away, or when a connect, write or query starts (a scan shares the radio with the link).
    func scan() -> AsyncStream<[FoundBluetoothPrinter]> {
        start()
        endUiScan()
        nextScanId += 1
        let id = nextScanId
        let (stream, continuation) = AsyncStream.makeStream(of: [FoundBluetoothPrinter].self, bufferingPolicy: .bufferingNewest(1))
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.uiScanAbandoned(id) }
        }
        var scan = UiScan(id: id, continuation: continuation)
        scan.timer = after(timeouts.scanDuration) { [weak self] in
            if self?.uiScan?.id == id { self?.stopScan() }
        }
        uiScan = scan
        if Self.isRefusal(availability) { endUiScan() } else { updateScanning() }
        return stream
    }

    func stopScan() { endUiScan() }

    /// Connects to the printer (by identifier, else by serial), or returns the link already up to
    /// it. Throws `BluetoothUnavailable`, `BluetoothPrinterNotFound`, `BluetoothNotZebra`,
    /// `BluetoothSerialMismatch`, `BluetoothPairingLost` or `PrinterUnreachable`.
    func connect(peripheralId: UUID?, serial: String?) async throws -> BluetoothPrinterInfo {
        try Task.checkCancellation()
        return try await withTurn(host: serial) { try await ensureReady(BluetoothTarget(peripheralId: peripheralId, serial: serial)) }
    }

    /// Ends the scan and the link (the app went to the background, signed out, or the saved
    /// printer changed): the connect, write or query in flight fails with `PrinterUnreachable`, and
    /// so does every call already waiting for its turn (none of them reconnects).
    func close() {
        closes += 1
        endUiScan()
        let error = PrinterUnreachable(host: host)
        switch phase {
        case .idle: break
        case .ready: endLink(failing: error)
        default: failAttempt(error)
        }
    }

    // MARK: Calls (BluetoothZebra)

    /// Writes `parts` as one job to the printer, reconnecting first when the link is down.
    /// `progress` hears `(0, total)` once the link is up and the first chunk is going out, then the
    /// bytes acknowledged so far; nothing when nothing was sent.
    func write(_ parts: [Data], on target: BluetoothTarget, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        try Task.checkCancellation()
        try await withTurn(host: target.serial) {
            _ = try await ensureReady(target)
            endUiScan()
            try await send(parts.reduce(into: Data()) { $0.append($1) }, progress: progress)
        }
    }

    /// Sends `command` and reads the reply until `complete` says it is whole, `queryIdle` after
    /// the last byte (or the write), or `queryTotal` after the write; Latin-1. Throws
    /// `PrinterNoReply` when nothing came back.
    func query(_ command: String, on target: BluetoothTarget, complete: @escaping @Sendable (Data) -> Bool) async throws -> String {
        try Task.checkCancellation()
        return try await withTurn(host: target.serial) {
            _ = try await ensureReady(target)
            endUiScan()
            try await drain()
            rx = Data()
            collecting = true
            defer { collecting = false }
            try await send(Data(command.utf8), progress: nil)
            let answer = try await collectReply(complete)
            if answer.isEmpty { throw PrinterNoReply(host: host) }
            return String(data: answer, encoding: .isoLatin1) ?? "" // Latin-1 decodes any bytes
        }
    }

    // MARK: Turns

    /// Calls waiting for their turn behind the one in flight.
    var waitingCalls: Int { turnWaiters.count }

    /// Runs `body` once every earlier call's body has finished (in the order asked). A call that
    /// waited through a `close()` fails as the call in flight did (`PrinterUnreachable`, `host` its
    /// serial), and one whose task was cancelled while it waited throws `CancellationError`:
    /// neither reconnects.
    private func withTurn<T>(host serial: String?, _ body: () async throws -> T) async throws -> T {
        let closesBefore = closes
        if turnTaken {
            await withCheckedContinuation { turnWaiters.append($0) }
        } else {
            turnTaken = true
        }
        defer {
            if turnWaiters.isEmpty { turnTaken = false } else { turnWaiters.removeFirst().resume() }
        }
        guard closes == closesBefore else { throw PrinterUnreachable(host: serial ?? host) }
        try Task.checkCancellation()
        return try await body()
    }

    // MARK: Connecting

    private func ensureReady(_ target: BluetoothTarget) async throws -> BluetoothPrinterInfo {
        if phase == .ready, let info = link.info, Self.matches(info, target) { return info }
        if phase == .ready { endLink(failing: PrinterUnreachable(host: host)) } // one link at a time
        start()
        return try await withCheckedThrowingContinuation { continuation in
            readyWaiter = continuation
            attempt += 1
            self.target = target
            host = target.serial ?? ""
            retriesUsed = 0
            phase = .waitingForBluetooth
            armDeadline()
            proceed()
        }
    }

    /// Bluetooth's state decides whether a connect waiting for it goes on.
    private func proceed() {
        guard phase == .waitingForBluetooth else { return }
        switch availability {
        case .unknown: return // the state arrives in a moment
        case .ready: locate()
        case .poweredOff, .unauthorized, .unsupported: failAttempt(BluetoothUnavailable(host: host, availability: availability))
        }
    }

    /// The saved identifier, then the one the last link to this serial used, then a scan for the
    /// serial.
    private func locate() {
        for id in [target.peripheralId, knownPeripheralId(forSerial: target.serial)].compactMap({ $0 }) {
            if let found = central?.retrievePeripherals(withIdentifiers: [id]).first { return connectTo(found) }
        }
        guard let serial = target.serial, !serial.isEmpty else {
            failAttempt(BluetoothPrinterNotFound(host: host))
            return
        }
        phase = .finding
        updateScanning()
    }

    private func connectTo(_ found: any BluetoothPeripheral) {
        endUiScan()
        peripheral = found
        if target.serial == nil, let name = found.name { host = name }
        pendingServices = []
        pendingReads = []
        deviceInfo = [:]
        unreadInfo = []
        phase = .connecting
        updateScanning() // a scan for the serial ends once the printer is found
        central?.connect(found)
    }

    /// `connectReady` for this try, from now.
    private func armDeadline() {
        attemptTimer?.cancel()
        let mine = attempt
        attemptTimer = after(timeouts.connectReady) { [weak self] in
            guard let self, self.attempt == mine else { return }
            self.deadlinePassed()
        }
    }

    private func deadlinePassed() {
        let error: Error
        switch phase {
        case .idle, .ready, .retrying: return
        case .waitingForBluetooth: error = BluetoothUnavailable(host: host, availability: availability)
        case .finding: error = BluetoothPrinterNotFound(host: host)
        case .connecting, .discovering, .reading, .subscribing: error = PrinterUnreachable(host: host)
        }
        failAttempt(error)
    }

    private func didConnect(_ p: any BluetoothPeripheral) {
        phase = .discovering
        p.discoverServices([Self.parserService, Self.deviceInfoService])
    }

    private func didDiscoverServices(_ p: any BluetoothPeripheral, _ error: Error?) {
        guard error == nil else { return failAttempt(PrinterUnreachable(host: host)) }
        let services = Set(p.serviceUUIDs)
        guard services.contains(Self.parserService) else { return failAttempt(BluetoothNotZebra(host: host)) }
        let wanted = [Self.parserService, Self.deviceInfoService].filter(services.contains)
        pendingServices = Set(wanted)
        for service in wanted { p.discoverCharacteristics(ofService: service) }
    }

    private func didDiscoverCharacteristics(_ p: any BluetoothPeripheral, _ service: String, _ error: Error?) {
        guard error == nil else { return failAttempt(PrinterUnreachable(host: host)) }
        guard pendingServices.remove(service) != nil, pendingServices.isEmpty else { return }
        let parser = Set(p.characteristicUUIDs(ofService: Self.parserService))
        guard parser.contains(Self.toPrinter), parser.contains(Self.fromPrinter) else {
            return failAttempt(BluetoothNotZebra(host: host))
        }
        let present = Set(p.characteristicUUIDs(ofService: Self.deviceInfoService))
        let reads = Self.infoCharacteristics.filter(present.contains)
        pendingReads = Set(reads)
        phase = .reading
        if reads.isEmpty { return verifyAndSubscribe(p) }
        for characteristic in reads { p.readValue(service: Self.deviceInfoService, characteristic: characteristic) }
    }

    private func didRead(_ p: any BluetoothPeripheral, _ characteristic: String, _ value: Data?, _ error: Error?) {
        guard pendingReads.remove(characteristic) != nil else { return }
        if error != nil {
            unreadInfo.insert(characteristic)
        } else if let text = Self.decode(value) {
            deviceInfo[characteristic] = text
        }
        if pendingReads.isEmpty { verifyAndSubscribe(p) }
    }

    /// Refuses a device that isn't the Zebra asked for; else turns its replies on. A manufacturer
    /// (or expected serial) that couldn't be read says nothing about the device: unreachable.
    private func verifyAndSubscribe(_ p: any BluetoothPeripheral) {
        var identity: Set = [ZebraBluetoothSpec.manufacturerUUID]
        if target.serial != nil { identity.insert(ZebraBluetoothSpec.serialUUID) }
        guard unreadInfo.isDisjoint(with: identity) else { return failAttempt(PrinterUnreachable(host: host)) }
        let info = currentInfo(p)
        guard info.manufacturer == Self.zebraManufacturer else { return failAttempt(BluetoothNotZebra(host: host)) }
        if let expected = target.serial {
            guard Self.sameSerial(info.serial, expected) else {
                return failAttempt(BluetoothSerialMismatch(host: expected, found: info.serial))
            }
        } else if let serial = info.serial {
            host = serial
        }
        phase = .subscribing
        p.setNotify(true, service: Self.parserService, characteristic: Self.fromPrinter)
    }

    private func didUpdateNotificationState(_ p: any BluetoothPeripheral, isNotifying: Bool, _ error: Error?) {
        guard error == nil else { return failAttempt(PrinterUnreachable(host: host)) }
        guard isNotifying else { return }
        attemptTimer?.cancel()
        attemptTimer = nil
        phase = .ready
        let info = currentInfo(p)
        let at = now()
        // The idle clock starts here: time spent connecting isn't idle time on a working link.
        link.connected = true
        link.info = info
        link.chunkBytes = p.maximumWriteLength
        link.connectedAt = at
        link.lastActivity = at
        if let waiter = readyWaiter {
            readyWaiter = nil
            waiter.resume(returning: info)
        }
    }

    /// A link that connected dropped before Ready: the drop is recorded and the link is tried
    /// again (`retry()`), unless the printer forgot this iPad (CBError 14 / 15).
    private func droppedBeforeReady(_ error: Error?) {
        attemptTimer?.cancel()
        attemptTimer = nil
        phase = .retrying // the link is gone: nothing to cancel
        link.lastDrop = BluetoothDrop(at: now(), reason: describeBluetoothError(error))
        if isBluetoothPairingLost(error) { return failAttempt(BluetoothPairingLost(host: host)) }
        retry()
    }

    /// A connect that never connected (`didFailToConnect`). Nothing was up, so no drop is
    /// recorded. A first try fails at once; one made after a drop before Ready counts as one of
    /// that drop's tries.
    private func connectFailed(_ error: Error?) {
        attemptTimer?.cancel()
        attemptTimer = nil
        phase = .retrying // no connection: nothing to cancel
        if isBluetoothPairingLost(error) { return failAttempt(BluetoothPairingLost(host: host)) }
        guard retriesUsed > 0 else { return failAttempt(PrinterUnreachable(host: host)) }
        retry()
    }

    /// Connects again after `reconnectSpacing`, at most `reconnectTries` times after the drop.
    private func retry() {
        retriesUsed += 1
        guard retriesUsed <= ZebraBluetoothSpec.reconnectTries else { return failAttempt(PrinterUnreachable(host: host)) }
        let mine = attempt
        attemptTimer = after(timeouts.reconnectSpacing) { [weak self] in
            guard let self, self.attempt == mine, self.phase == .retrying, let p = self.peripheral else { return }
            self.armDeadline()
            self.connectTo(p)
        }
    }

    /// The connect in progress failed: its connection (if any) is cancelled.
    private func failAttempt(_ error: Error) {
        attemptTimer?.cancel()
        attemptTimer = nil
        if phase.hasConnection { cancelConnection() }
        peripheral = nil
        phase = .idle
        updateScanning()
        if let waiter = readyWaiter {
            readyWaiter = nil
            waiter.resume(throwing: error)
        }
    }

    /// The ready link ends: the call in flight fails with `error`. Nothing reconnects.
    private func endLink(failing error: Error) {
        cancelConnection()
        peripheral = nil
        phase = .idle
        link.connected = false
        link.connectedAt = nil
        failCalls(error)
    }

    /// CoreBluetooth accepts commands only while Bluetooth is on (it drops every link itself
    /// when it goes off).
    private func cancelConnection() {
        guard availability == .ready, let peripheral else { return }
        central?.cancelConnection(peripheral)
    }

    private func knownPeripheralId(forSerial serial: String?) -> UUID? {
        guard let serial, let info = link.info, Self.sameSerial(info.serial, serial) else { return nil }
        return info.peripheralId
    }

    private func currentInfo(_ p: any BluetoothPeripheral) -> BluetoothPrinterInfo {
        BluetoothPrinterInfo(
            peripheralId: p.identifier,
            manufacturer: deviceInfo[ZebraBluetoothSpec.manufacturerUUID],
            model: deviceInfo[ZebraBluetoothSpec.modelUUID],
            serial: deviceInfo[ZebraBluetoothSpec.serialUUID],
            firmware: deviceInfo[ZebraBluetoothSpec.firmwareUUID],
            linkOs: deviceInfo[ZebraBluetoothSpec.linkOsUUID])
    }

    // MARK: Writing and reading

    /// Writes `bytes` in acknowledged chunks within the send budget. A budget that runs out while
    /// the send is still running (waiting for an acknowledgment or between chunks) ends it with
    /// `PrinterTimeout` and ends the link (a late acknowledgment must not be taken for the next
    /// write's).
    private func send(_ bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        let total = bytes.count
        let onLink = attempt
        nextSendId += 1
        let mine = nextSendId
        runningSend = mine
        let budget = after(ZebraBluetoothSpec.sendBudget(bytes: total)) { [weak self] in
            guard let self, self.runningSend == mine, self.phase == .ready, self.attempt == onLink else { return }
            self.expiredSend = mine
            self.link.lastDrop = BluetoothDrop(at: self.now(), reason: "A send ran past its time limit")
            self.endLink(failing: PrinterTimeout(host: self.host))
        }
        defer {
            budget.cancel()
            if runningSend == mine { runningSend = nil }
            if expiredSend == mine { expiredSend = nil }
        }
        var sent = 0
        repeat {
            if expiredSend == mine { throw PrinterTimeout(host: host) }
            guard phase == .ready, attempt == onLink, let p = peripheral else { throw PrinterUnreachable(host: host) }
            if sent == 0 { progress?(0, total) }
            guard sent < total else { return }
            let end = min(sent + max(Self.minimumChunk, p.maximumWriteLength), total)
            let chunk = bytes.subdata(in: sent..<end)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                ackWaiter = continuation
                p.writeWithResponse(chunk, service: Self.parserService, characteristic: Self.toPrinter)
            }
            sent = end
            link.lastActivity = now()
            progress?(sent, total)
        } while sent < total
    }

    private func didWrite(_ error: Error?) {
        guard let waiter = ackWaiter else { return }
        ackWaiter = nil
        if error == nil { waiter.resume() } else { waiter.resume(throwing: PrinterUnreachable(host: host)) }
    }

    /// Waits until no byte has arrived for `drainQuiet` (at most `drainMax`), so the rest of an
    /// earlier reply isn't taken for this one's.
    private func drain() async throws {
        guard quietTimer != nil else { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            drainWaiter = continuation
            drainTimer = after(timeouts.drainMax) { [weak self] in self?.endDrain() }
        }
    }

    private func endDrain() {
        drainTimer?.cancel()
        drainTimer = nil
        if let waiter = drainWaiter {
            drainWaiter = nil
            waiter.resume()
        }
    }

    private func collectReply(_ complete: @escaping @Sendable (Data) -> Bool) async throws -> Data {
        if Self.isWhole(rx, complete) { return rx }
        guard phase == .ready else { throw PrinterUnreachable(host: host) } // dropped as the write ended
        return try await withCheckedThrowingContinuation { continuation in
            var wait = ReplyWait(continuation: continuation, complete: complete)
            wait.total = after(timeouts.queryTotal) { [weak self] in self?.finishReply() }
            reply = wait
            restartIdle()
        }
    }

    private func received(_ bytes: Data) {
        link.lastActivity = now()
        quietTimer?.cancel()
        quietTimer = after(timeouts.drainQuiet) { [weak self] in
            self?.quietTimer = nil
            self?.endDrain()
        }
        guard collecting else { return } // a late byte of an earlier reply
        rx.append(bytes.prefix(max(0, ZebraNetwork.maxReply - rx.count)))
        guard let reply else { return } // the command is still being written
        if Self.isWhole(rx, reply.complete) { finishReply() } else { restartIdle() }
    }

    private func restartIdle() {
        guard reply != nil else { return }
        reply?.idle?.cancel()
        reply?.idle = after(timeouts.queryIdle) { [weak self] in self?.finishReply() }
    }

    private func finishReply() {
        guard let wait = reply else { return }
        reply = nil
        wait.idle?.cancel()
        wait.total?.cancel()
        wait.continuation.resume(returning: rx)
    }

    /// The write, drain or reply in flight fails with `error`.
    private func failCalls(_ error: Error) {
        if let waiter = ackWaiter {
            ackWaiter = nil
            waiter.resume(throwing: error)
        }
        if let waiter = drainWaiter {
            drainWaiter = nil
            drainTimer?.cancel()
            drainTimer = nil
            waiter.resume(throwing: error)
        }
        if let wait = reply {
            reply = nil
            wait.idle?.cancel()
            wait.total?.cancel()
            wait.continuation.resume(throwing: error)
        }
    }

    // MARK: Scanning

    /// The central scans while a screen's scan or a connect's search for a serial wants it.
    private func updateScanning() {
        guard let central else { return }
        let wanted = availability == .ready && (uiScan != nil || phase == .finding)
        if wanted, !centralScanning {
            centralScanning = true
            central.scan()
        } else if !wanted, centralScanning {
            centralScanning = false
            central.stopScan()
        }
    }

    private func discovered(_ p: any BluetoothPeripheral, name: String?, rssi: Int, advertisesZebra: Bool) {
        if phase == .finding, let serial = target.serial, let name, Self.sameSerial(name, serial) {
            connectTo(p)
        }
        guard var scan = uiScan, let name, !name.isEmpty else { return }
        let old = scan.seen[p.identifier]
        let isNew = old?.name != name
        scan.seen[p.identifier] = FoundBluetoothPrinter(
            id: p.identifier, name: name,
            rssi: rssi == Self.rssiUnavailable ? (old?.rssi ?? -127) : rssi,
            advertisesZebra: advertisesZebra || (old?.advertisesZebra ?? false))
        // Advertisements come many times a second: a new device shows at once, signal changes at
        // most every `scanRefresh`.
        let at = now()
        if isNew || scan.lastYield.map({ at.timeIntervalSince($0) >= Self.scanRefresh }) ?? true {
            scan.lastYield = at
            scan.unpublished = false
            scan.continuation.yield(Self.sorted(scan.seen))
        } else {
            scan.unpublished = true
        }
        uiScan = scan
    }

    private func endUiScan() {
        guard let scan = uiScan else { return }
        uiScan = nil
        scan.timer?.cancel()
        if scan.unpublished { scan.continuation.yield(Self.sorted(scan.seen)) }
        scan.continuation.finish()
        updateScanning()
    }

    /// The screen stopped listening to its scan.
    private func uiScanAbandoned(_ id: Int) {
        guard let scan = uiScan, scan.id == id else { return }
        uiScan = nil
        scan.timer?.cancel()
        updateScanning()
    }

    // MARK: Events

    private func handle(_ event: BluetoothCentralEvent) {
        switch event {
        case .stateChanged(let state):
            stateChanged(state)
        case .discovered(let p, let name, let rssi, let advertisesZebra):
            discovered(p, name: name, rssi: rssi, advertisesZebra: advertisesZebra)
        case .connected(let p):
            if isLink(p), phase == .connecting { didConnect(p) }
        case .failedToConnect(let p, let error):
            if isLink(p), phase == .connecting { connectFailed(error) }
        case .disconnected(let p, let error):
            guard isLink(p) else { return }
            switch phase {
            case .ready:
                link.lastDrop = BluetoothDrop(at: now(), reason: describeBluetoothError(error))
                endLink(failing: isBluetoothPairingLost(error) ? BluetoothPairingLost(host: host) : PrinterUnreachable(host: host))
            case .discovering, .reading, .subscribing:
                droppedBeforeReady(error)
            case .idle, .waitingForBluetooth, .finding, .connecting, .retrying:
                break // a link that was cancelled, or a connect that never completed
            }
        case .discoveredServices(let p, let error):
            if isLink(p), phase == .discovering { didDiscoverServices(p, error) }
        case .discoveredCharacteristics(let p, let service, let error):
            if isLink(p), phase == .discovering { didDiscoverCharacteristics(p, service, error) }
        case .updatedValue(let p, let characteristic, let value, let error):
            guard isLink(p) else { return }
            if characteristic == Self.fromPrinter {
                if phase == .ready, error == nil, let value, !value.isEmpty { received(value) }
            } else if phase == .reading {
                didRead(p, characteristic, value, error)
            }
        case .wroteValue(let p, let characteristic, let error):
            if isLink(p), characteristic == Self.toPrinter { didWrite(error) }
        case .updatedNotificationState(let p, let characteristic, let isNotifying, let error):
            if isLink(p), phase == .subscribing, characteristic == Self.fromPrinter {
                didUpdateNotificationState(p, isNotifying: isNotifying, error)
            }
        }
    }

    private func stateChanged(_ state: BluetoothCentralState) {
        availability = Self.availability(for: state)
        if availability == .ready {
            proceed()
            updateScanning() // a scan asked for before Bluetooth was on starts now
            return
        }
        centralScanning = false // CoreBluetooth ends scans and links itself
        if Self.isRefusal(availability) { endUiScan() } // through a reset, a scan keeps waiting
        let error = BluetoothUnavailable(host: host, availability: availability)
        switch phase {
        case .idle: break
        case .waitingForBluetooth: proceed()
        case .ready:
            link.lastDrop = BluetoothDrop(at: now(), reason: "Bluetooth stopped (\(state))")
            endLink(failing: error)
        case .finding, .connecting, .discovering, .reading, .subscribing, .retrying:
            failAttempt(error)
        }
    }

    private func isLink(_ p: any BluetoothPeripheral) -> Bool { peripheral?.identifier == p.identifier }

    // MARK: Helpers

    /// Runs `fire` on the main actor `seconds` from now, unless the returned task is cancelled first.
    private func after(_ seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        let sleep = self.sleep
        return Task { @MainActor in
            do { try await sleep(.seconds(seconds)) } catch { return }
            guard !Task.isCancelled else { return }
            fire()
        }
    }

    private static let parserService = ZebraBluetoothSpec.serviceUUID
    private static let toPrinter = ZebraBluetoothSpec.toPrinterUUID
    private static let fromPrinter = ZebraBluetoothSpec.fromPrinterUUID
    private static let deviceInfoService = ZebraBluetoothSpec.deviceInfoUUID
    private static let infoCharacteristics = [
        ZebraBluetoothSpec.manufacturerUUID, ZebraBluetoothSpec.modelUUID, ZebraBluetoothSpec.serialUUID,
        ZebraBluetoothSpec.firmwareUUID, ZebraBluetoothSpec.linkOsUUID,
    ]
    private static let zebraManufacturer = "Zebra Technologies"
    /// The smallest ATT payload: a guard against a peripheral reporting 0.
    private static let minimumChunk = 20
    /// CoreBluetooth's "no signal reading".
    private static let rssiUnavailable = 127
    private static let scanRefresh: TimeInterval = 0.5

    private static func availability(for state: BluetoothCentralState) -> BluetoothAvailability {
        switch state {
        case .poweredOn: .ready
        case .poweredOff: .poweredOff
        case .unauthorized: .unauthorized
        case .unsupported: .unsupported
        case .unknown, .resetting: .unknown
        }
    }

    /// Bluetooth is off, not allowed, or missing: nothing is tried until that changes.
    private static func isRefusal(_ availability: BluetoothAvailability) -> Bool {
        availability == .poweredOff || availability == .unauthorized || availability == .unsupported
    }

    /// Whether the ready link is the printer asked for: by its confirmed serial when the target
    /// names one (an identifier is only how a printer is found, and iOS can forget it), else by
    /// identifier.
    private static func matches(_ info: BluetoothPrinterInfo, _ target: BluetoothTarget) -> Bool {
        if let serial = target.serial { return sameSerial(info.serial, serial) }
        if let id = target.peripheralId { return id == info.peripheralId }
        return true
    }

    private static func sameSerial(_ found: String?, _ expected: String) -> Bool {
        found?.uppercased() == expected.uppercased()
    }

    private static func isWhole(_ reply: Data, _ complete: (Data) -> Bool) -> Bool {
        !reply.isEmpty && (reply.count >= ZebraNetwork.maxReply || complete(reply))
    }

    /// A Device Information value: UTF-8 without padding NULs or spaces; nil when empty.
    private static func decode(_ value: Data?) -> String? {
        guard let value, let text = String(data: value, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: CharacterSet(charactersIn: "\0").union(.whitespacesAndNewlines))
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func sorted(_ seen: [UUID: FoundBluetoothPrinter]) -> [FoundBluetoothPrinter] {
        seen.values.sorted { $0.rssi != $1.rssi ? $0.rssi > $1.rssi : $0.name < $1.name }
    }
}

extension ZebraBluetooth: BluetoothPrinting {}

/// `printer` with the identifier the link found it under, when the link is up to it (its serial)
/// under another identifier than the saved one: iOS forgot the saved one, so the link found the
/// printer by its serial, and the next connect can go straight to it. Nil when nothing changes.
func adoptingLinkedIdentifier(_ printer: SavedPrinter?, linked info: BluetoothPrinterInfo?) -> SavedPrinter? {
    guard var printer, case .bluetooth(let serial, let saved) = printer.connection, let info, let linked = info.serial,
          linked.uppercased() == serial.uppercased(), info.peripheralId != saved else { return nil }
    printer.connection = .bluetooth(serial: serial, peripheralId: info.peripheralId)
    return printer
}

private enum Phase: Equatable {
    case idle
    /// A new central hasn't reported its state yet.
    case waitingForBluetooth
    /// Scanning for the name equal to the serial.
    case finding
    case connecting
    case discovering
    case reading
    case subscribing
    /// The link is down between tries (waiting `reconnectSpacing` after a drop before Ready).
    case retrying
    case ready

    /// A connection is up or being made: `cancelConnection` closes it.
    var hasConnection: Bool {
        switch self {
        case .connecting, .discovering, .reading, .subscribing, .ready: true
        case .idle, .waitingForBluetooth, .finding, .retrying: false
        }
    }
}

/// A query reading its reply.
private struct ReplyWait {
    var continuation: CheckedContinuation<Data, Error>
    var complete: @Sendable (Data) -> Bool
    var idle: Task<Void, Never>?
    var total: Task<Void, Never>?
}

/// A screen's scan: what it heard and when the list was last sent.
private struct UiScan {
    var id: Int
    var continuation: AsyncStream<[FoundBluetoothPrinter]>.Continuation
    var timer: Task<Void, Never>?
    var seen: [UUID: FoundBluetoothPrinter] = [:]
    var lastYield: Date?
    var unpublished = false
}
