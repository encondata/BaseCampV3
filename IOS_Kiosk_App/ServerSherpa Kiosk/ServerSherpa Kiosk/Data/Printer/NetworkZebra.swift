import Foundation
import Network

/// A network Zebra's raw port and the laptop edge's limits (kiosk_laptop/edge/src/edge/printers.py).
/// Mirrors Android's data/printer/NetworkZebra.kt; times are in seconds.
enum ZebraNetwork {
    static let port: UInt16 = 9100
    static let scanConcurrency = 64
    static let probeConnect: TimeInterval = 0.5  // the scan's probe of one address
    static let identify: TimeInterval = 1.5      // the scan's `~HI` to a host that answered
    static let identifyMax = 512                 // ... read to its ETX, at most this many bytes
    static let scanBudget: TimeInterval = 10     // the whole scan
    static let connect: TimeInterval = 3         // a query or send to a chosen printer
    static let idle: TimeInterval = 2            // a query ends after this long without new bytes
    static let total: TimeInterval = 5           // ... or this long in all
    static let send: TimeInterval = 30           // writing a job (a font can be a few MB)
    static let maxReply = 65_536                 // a query's reply, at most
}

/// How long `NetworkZebra` waits; the defaults are `ZebraNetwork`'s.
struct ZebraTimeouts: Equatable, Sendable {
    var connect: TimeInterval = ZebraNetwork.connect
    var idle: TimeInterval = ZebraNetwork.idle
    var total: TimeInterval = ZebraNetwork.total
    var send: TimeInterval = ZebraNetwork.send
}

/**
 A Zebra on the LAN, spoken to over its raw port: one connection per command, as the laptop edge
 does. Queries read the reply until it is whole (the printer keeps the connection open), the idle
 wait, the total wait or 64 KB; writes write and close. What is asked and sent is
 `ZebraTransport`'s (identify, status, fonts, sends, font installs).

 Nothing is sent on its own: each call sends exactly its command. `parameters` is copied for each
 connection (tests pass ones that can't be satisfied). By default a host inside one of the device's
 Wi-Fi or Ethernet subnets is never reached over cellular, as Android binds such a connection to
 the LAN network's socket factory; any other host uses plain TCP (`zebraParameters(forHost:lan:)`). Every call but the font guard can throw
 `CancellationError` when its task is cancelled; the connection is closed on every exit.
 */
struct NetworkZebra: ZebraTransport {
    let host: String
    let port: UInt16
    let timeouts: ZebraTimeouts
    let parameters: NWParameters

    init(host: String, port: UInt16 = ZebraNetwork.port, timeouts: ZebraTimeouts = ZebraTimeouts(), parameters: NWParameters? = nil) {
        self.host = host
        self.port = port
        self.timeouts = timeouts
        self.parameters = parameters ?? zebraParameters(forHost: host, lan: LocalNetworks.lanAddresses())
    }

    var address: String { host }

    func query(_ command: String, complete: @escaping @Sendable (Data) -> Bool) async throws -> String {
        let timeouts = timeouts
        let reply = try await zebraSession(
            host: host, port: port, parameters: parameters,
            connect: timeouts.connect, deadline: timeouts.total + Self.writeSlack
        ) { link in
            try await link.write(Data(command.utf8))
            return try await readReply(link, idle: timeouts.idle, total: timeouts.total, maxBytes: ZebraNetwork.maxReply, complete: complete)
        }
        if reply.isEmpty { throw PrinterNoReply(host: host) }
        return String(data: reply, encoding: .isoLatin1) ?? "" // Latin-1 decodes any bytes
    }

    /// One connection for the whole job: each part as Network.framework takes it (`progress` hears
    /// each), then a FIN.
    func write(_ parts: [Data], progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        let total = parts.reduce(0) { $0 + $1.count }
        try await zebraSession(host: host, port: port, parameters: parameters, connect: timeouts.connect, deadline: timeouts.send) { link in
            var sent = 0
            for part in parts {
                try await link.write(part)
                sent += part.count
                progress?(sent, total)
            }
            try await link.finishWriting()
        }
    }

    private static let writeSlack: TimeInterval = 1
}

/// TCP that never leaves over cellular: Wi-Fi, Ethernet (USB-C adapters included) and the rest
/// stay admitted. A printer on the LAN must not be reached over a carrier's 10.x or CGNAT.
func lanParameters() -> NWParameters {
    let parameters = NWParameters.tcp.copy()
    parameters.prohibitedInterfaceTypes = [.cellular]
    return parameters
}

/// The parameters for a printer at `host`: `lanParameters()` when it lies inside one of the
/// device's Wi-Fi or Ethernet subnets (`lan`), else plain TCP. Android's socketFactoryFor (the LAN
/// network's factory, else the default one).
func zebraParameters(forHost host: String, lan: [LanAddress]) -> NWParameters {
    lan.contains { sameSubnet($0.address, host, prefixLength: $0.prefixLength) } ? lanParameters() : .tcp
}

// MARK: one connection

/**
 Opens a connection (at most `connect`) and runs `body` on it. The connection is cancelled when
 `body` ends, when the task is cancelled, and `deadline` after `connect` (a blocked write can't
 time out by itself), so nothing hangs past the deadline. A connection that fails, is refused, or
 is still not ready (`.waiting` included) at `connect` is `PrinterUnreachable`; an I/O failure in
 `body` is `PrinterUnreachable`, or `PrinterTimeout` when the deadline cut it off; a cancellation
 stays a `CancellationError`. Mirrors Android's zebraSession.
 */
func zebraSession<T>(
    host: String,
    port: UInt16,
    parameters: NWParameters,
    connect: TimeInterval,
    deadline: TimeInterval,
    body: (ZebraLink) async throws -> T
) async throws -> T {
    try Task.checkCancellation()
    guard port != 0, let nwPort = NWEndpoint.Port(rawValue: port) else { throw PrinterUnreachable(host: host) }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: parameters.copy())
    let link = ZebraLink(connection: connection, host: host)
    defer { link.close() }
    link.armDeadline(after: connect + deadline)
    try await link.open(timeout: connect)
    do {
        let value = try await body(link)
        try Task.checkCancellation()
        return value
    } catch {
        if error is CancellationError || Task.isCancelled { throw CancellationError() }
        if error is ZebraLinkClosed {
            if link.timedOut { throw PrinterTimeout(host: host) }
            throw PrinterUnreachable(host: host)
        }
        throw error
    }
}

/// Reads a reply: until `complete` says it is whole, EOF, `maxBytes`, `idle` without new bytes,
/// or `total` in all. A read error ends it with what arrived.
func readReply(
    _ link: ZebraLink,
    idle: TimeInterval,
    total: TimeInterval,
    maxBytes: Int,
    complete: (Data) -> Bool
) async throws -> Data {
    var out = Data()
    let deadline = Date().addingTimeInterval(total)
    while out.count < maxBytes {
        let left = deadline.timeIntervalSinceNow
        if left <= 0 { break }
        guard let chunk = try await link.read(max: min(8192, maxBytes - out.count), timeout: min(idle, left)) else { break }
        out.append(chunk)
        if complete(out) { break }
    }
    return out
}

/// The connection ended (closed, failed, or cut off at the deadline) under a read or write.
struct ZebraLinkClosed: Error {}

/// Whether a connection's wait is iOS keeping the app off the local network: the Local Network
/// path reason, DNS-SD's policy denial (`kDNSServiceErr_PolicyDenied`), or `ENETDOWN`.
func isLocalNetworkDenial(error: NWError?, unsatisfiedReason: NWPath.UnsatisfiedReason?) -> Bool {
    if unsatisfiedReason == .localNetworkDenied { return true }
    switch error {
    case .posix(.ENETDOWN): return true
    case .dns(let code): return code == dnsPolicyDenied
    default: return false
    }
}

private let dnsPolicyDenied: Int32 = -65570 // kDNSServiceErr_PolicyDenied

/**
 One open TCP connection to a printer. All of its state lives on its own serial queue, where
 Network.framework calls back too. Each read or write resolves exactly once (the first of its
 answer, its timer, the close and a task cancellation); bytes that arrive after a read gave up
 stay buffered for the next one.
 */
final class ZebraLink: @unchecked Sendable {
    private let connection: NWConnection
    private let host: String
    private let queue = DispatchQueue(label: "com.serversherpa.kiosk.zebra-link")

    // queue-confined
    private var buffer = Data()
    private var ended = false
    private var receiving = false
    private var closed = false
    private var opener: ZebraOnce<Void>?
    private var lastWait: (error: NWError, reason: NWPath.UnsatisfiedReason?)?
    private var reader: (once: ZebraOnce<Data?>, max: Int)?
    private var writers: [ObjectIdentifier: ZebraOnce<Void>] = [:]
    private var didTimeOut = false

    init(connection: NWConnection, host: String) {
        self.connection = connection
        self.host = host
    }

    /// Whether the deadline closed the connection.
    var timedOut: Bool { queue.sync { didTimeOut } }

    /// Closes the connection `seconds` from now.
    func armDeadline(after seconds: TimeInterval) {
        queue.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, !self.closed else { return }
            self.didTimeOut = true
            self.closeOnQueue()
        }
    }

    /// Starts the connection and waits until it is ready: at most `timeout`, failing at once when
    /// it fails or is refused.
    func open(timeout: TimeInterval) async throws {
        let once = ZebraOnce<Void>()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                once.install(continuation)
                queue.async { [self] in
                    // cancelled (or closed) before it started: never start the connection
                    guard !once.isResolved else { return }
                    guard !closed else {
                        once.resume(.failure(PrinterUnreachable(host: host)))
                        return
                    }
                    opener = once
                    connection.stateUpdateHandler = { [weak self] state in self?.handle(state) }
                    connection.start(queue: queue)
                    queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                        guard let self, let opener = self.opener, opener === once else { return }
                        self.opener = nil
                        let denied = self.lastWait.map { isLocalNetworkDenial(error: $0.error, unsatisfiedReason: $0.reason) } ?? false
                        opener.resume(.failure(PrinterUnreachable(host: self.host, localNetworkDenied: denied)))
                    }
                }
            }
        } onCancel: {
            once.resume(.failure(CancellationError()))
        }
    }

    private func handle(_ state: NWConnection.State) {
        switch state {
        case .ready:
            if let opener {
                self.opener = nil
                opener.resume(.success(()))
            }
        case .waiting(let error):
            let reason = connection.currentPath.flatMap { $0.status == .unsatisfied ? $0.unsatisfiedReason : nil }
            lastWait = (error, reason)
            if error == .posix(.ECONNREFUSED), let opener {
                // nothing listens on the port: as unreachable as Android's refused connect
                self.opener = nil
                opener.resume(.failure(PrinterUnreachable(host: host)))
            }
        case .failed(let error):
            let reason = connection.currentPath.flatMap { $0.status == .unsatisfied ? $0.unsatisfiedReason : nil }
            if let opener {
                self.opener = nil
                opener.resume(.failure(PrinterUnreachable(host: host, localNetworkDenied: isLocalNetworkDenial(error: error, unsatisfiedReason: reason))))
            }
            endStream()
        case .cancelled:
            if let opener {
                self.opener = nil
                opener.resume(.failure(PrinterUnreachable(host: host)))
            }
            endStream()
        default:
            break
        }
    }

    /// Writes `data`; returns once Network.framework has taken it.
    func write(_ data: Data) async throws {
        try await send(data, final: false)
    }

    /// Ends the write side (a FIN), as Android's `shutdownOutput`.
    func finishWriting() async throws {
        try await send(nil, final: true)
    }

    private func send(_ data: Data?, final: Bool) async throws {
        let once = ZebraOnce<Void>()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                once.install(continuation)
                queue.async { [self] in
                    guard !closed, !ended else {
                        once.resume(.failure(ZebraLinkClosed()))
                        return
                    }
                    let id = ObjectIdentifier(once)
                    writers[id] = once
                    connection.send(
                        content: data,
                        contentContext: final ? .finalMessage : .defaultMessage,
                        isComplete: true,
                        completion: .contentProcessed { [weak self] error in
                            self?.writers[id] = nil
                            once.resume(error == nil ? .success(()) : .failure(ZebraLinkClosed()))
                        }
                    )
                }
            }
        } onCancel: {
            once.resume(.failure(CancellationError()))
        }
    }

    /// The next bytes (at most `max`), or nil at `timeout` without any, at the end of the stream,
    /// or once the connection is closed.
    func read(max: Int, timeout: TimeInterval) async throws -> Data? {
        let once = ZebraOnce<Data?>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data?, Error>) in
                once.install(continuation)
                queue.async { [self] in
                    if let chunk = take(max) { return once.resume(.success(chunk)) }
                    if ended || closed { return once.resume(.success(nil)) }
                    reader?.once.resume(.success(nil)) // one reader at a time
                    reader = (once, max)
                    receiveIfNeeded()
                    queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                        if let self, self.reader?.once === once { self.reader = nil }
                        once.resume(.success(nil))
                    }
                }
            }
        } onCancel: {
            once.resume(.failure(CancellationError()))
        }
    }

    private func take(_ max: Int) -> Data? {
        guard !buffer.isEmpty else { return nil }
        let chunk = Data(buffer.prefix(max))
        buffer.removeFirst(chunk.count)
        return chunk
    }

    private func receiveIfNeeded() {
        guard !receiving, !ended, !closed else { return }
        receiving = true
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            self.receiving = false
            if let data, !data.isEmpty { self.buffer.append(data) }
            if isComplete || error != nil { self.ended = true }
            guard let pending = self.reader else { return }
            let once = pending.once
            if let chunk = self.take(pending.max) {
                self.reader = nil
                once.resume(.success(chunk))
            } else if self.ended {
                self.reader = nil
                once.resume(.success(nil))
            } else {
                self.receiveIfNeeded()
            }
        }
    }

    /// The stream is over: pending reads get what is buffered (or nil), pending writes fail.
    private func endStream() {
        ended = true
        if let pending = reader {
            reader = nil
            pending.once.resume(.success(take(pending.max)))
        }
        let pending = writers.values
        writers.removeAll()
        for writer in pending { writer.resume(.failure(ZebraLinkClosed())) }
    }

    private func closeOnQueue() {
        guard !closed else { return }
        closed = true
        if let opener {
            self.opener = nil
            opener.resume(.failure(PrinterUnreachable(host: host)))
        }
        endStream()
        connection.stateUpdateHandler = nil
        connection.cancel()
    }

    /// Cancels the connection (Network.framework closes it gracefully, so bytes it took still go).
    func close() {
        queue.async { [self] in closeOnQueue() }
    }
}

/// One call's answer: the first resume wins and the rest are dropped; a resume before the
/// continuation is installed is kept for it (as JavaScriptLabelEngine's OnceAnswer).
final class ZebraOnce<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var early: Result<Value, Error>?
    private var done = false

    /// Whether the call has its answer already.
    var isResolved: Bool { lock.withLock { done } }

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        let ready: Result<Value, Error>? = lock.withLock {
            if let early {
                self.early = nil
                return early
            }
            self.continuation = continuation
            return nil
        }
        if let ready { continuation.resume(with: ready) }
    }

    func resume(_ result: Result<Value, Error>) {
        let waiting: CheckedContinuation<Value, Error>? = lock.withLock {
            guard !done else { return nil }
            done = true
            guard let continuation else {
                early = result
                return nil
            }
            self.continuation = nil
            return continuation
        }
        waiting?.resume(with: result)
    }
}
