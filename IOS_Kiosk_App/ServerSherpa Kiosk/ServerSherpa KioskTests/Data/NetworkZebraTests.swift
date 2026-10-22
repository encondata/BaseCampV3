import Testing
import Foundation
import Network
@testable import ServerSherpa_Kiosk

/// A fake printer: an `NWListener` on 127.0.0.1 with an ephemeral port. It answers each command
/// it recognizes with its reply and keeps the connection open (a Zebra answers in ~30 ms and never
/// closes first), and records every byte each connection sent once that connection ends. With
/// `serve: false` it accepts and then never reads, so a large write fills the buffers and blocks.
private final class FakePrinter: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "test.fake-zebra")
    private let replies: [(command: String, reply: String)]
    private let serve: Bool
    private let lock = NSLock()
    private var finished: [Data] = []
    private var accepted: [NWConnection] = []
    private(set) var port: UInt16 = 0

    private init(replies: [(String, String)], serve: Bool) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.replies = replies.map { (command: $0.0, reply: $0.1) }
        self.serve = serve
    }

    static func start(_ replies: [(String, String)] = [], serve: Bool = true) async throws -> FakePrinter {
        let fake = try FakePrinter(replies: replies, serve: serve)
        try await fake.listen()
        return fake
    }

    private func listen() async throws {
        listener.newConnectionHandler = { [self] connection in
            lock.withLock { accepted.append(connection) }
            guard serve else { return } // accepted by the kernel, never read
            connection.start(queue: queue)
            receive(connection, got: Data())
        }
        let once = ZebraOnce<UInt16>()
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            once.install(continuation)
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready: once.resume(.success(listener.port?.rawValue ?? 0))
                case .failed(let error): once.resume(.failure(error))
                case .cancelled: once.resume(.failure(CancellationError()))
                default: break
                }
            }
            listener.start(queue: queue)
        }
        self.port = port
    }

    private func receive(_ connection: NWConnection, got: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, isComplete, error in
            var got = got
            if let data { got.append(data) }
            if let data, !data.isEmpty {
                let text = String(data: got, encoding: .isoLatin1) ?? ""
                if let match = replies.first(where: { text.hasSuffix($0.command) }) {
                    connection.send(content: match.reply.data(using: .isoLatin1), completion: .idempotent)
                }
            }
            if isComplete || error != nil {
                lock.withLock { finished.append(got) }
                connection.cancel()
            } else {
                receive(connection, got: got)
            }
        }
    }

    /// Connections the listener accepted so far.
    var acceptedCount: Int { lock.withLock { accepted.count } }

    /// Connections that ended, without waiting.
    var connections: [Data] { lock.withLock { finished } }

    /// Waits (at most 5 s) for `count` connections to end and returns what each one sent.
    func received(_ count: Int = 1) async -> [Data] {
        let until = Date().addingTimeInterval(5)
        while connections.count < count, Date() < until {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return connections
    }

    func close() {
        listener.cancel()
        for connection in lock.withLock({ accepted }) { connection.cancel() }
    }
}

/// A port nothing listens on: a listener's ephemeral port, closed again.
private func closedPort() async throws -> UInt16 {
    let fake = try await FakePrinter.start()
    let port = fake.port
    fake.close()
    try await Task.sleep(nanoseconds: 50_000_000)
    return port
}

private func elapsed(since start: Date) -> TimeInterval { Date().timeIntervalSince(start) }

private func ascii(_ data: Data?) -> String? { data.flatMap { String(data: $0, encoding: .isoLatin1) } }

/// NetworkZebra and ZebraScanner against the fake printer. Ported from Android's NetworkZebraTest,
/// plus the iOS-only cases: a connection that sits in `.waiting`, scan cancellation, and the
/// Local Network permission decision. Nothing here touches a real network or printer.
@Suite(.serialized, .timeLimit(.minutes(1)))
struct NetworkZebraTests {
    private let fast = ZebraTimeouts(connect: 1, idle: 0.3, total: 2, send: 5)
    private func zebra(_ p: FakePrinter) -> NetworkZebra { NetworkZebra(host: "127.0.0.1", port: p.port, timeouts: fast) }

    private let hi = "\u{02}ZD421-300dpi,V93.21.38Z,12,8176KB\u{03}\r\n"
    private let hs = "\u{02}030,0,0,0612,000,0,0,0,000,0,0,0\u{03}\r\n" +
        "\u{02}000,0,1,0,0,1,6,0,00000000,1,000\u{03}\r\n\u{02}0000,0\u{03}\r\n"
    private let serialQuery = "! U1 getvar \"device.unique_id\"\r\n"
    private let peelerQuery = "! U1 getvar \"sensor.peeler_present\"\r\n"

    @Test func sendDeliversTheExactUtf8Bytes() async throws {
        let p = try await FakePrinter.start()
        defer { p.close() }
        let zpl = "^XA^CI28^FO50,50^A0N,30,30^FDCafé ✓^FS^XZ"
        try await zebra(p).send(zpl)
        #expect(await p.received() == [Data(zpl.utf8)])
    }

    @Test func identifyParsesTheHostIdentificationReply() async throws {
        let p = try await FakePrinter.start([("~HI", hi)])
        defer { p.close() }
        let started = Date()
        // the reply is whole at its ETX: no waiting out the (2 s) idle time on an open connection
        let id = try await NetworkZebra(host: "127.0.0.1", port: p.port).identify()
        #expect(id == HostId(model: "ZD421-300dpi", firmware: "V93.21.38Z", dotsPerMm: 12, memory: "8176KB", dpi: 300))
        #expect(elapsed(since: started) < 1)
        #expect(await p.received().map(ascii) == ["~HI"])
    }

    @Test func statusReadsAllThreeFrames() async throws {
        let p = try await FakePrinter.start([("~HS", hs)])
        defer { p.close() }
        let s = try await zebra(p).status()
        #expect(s.headOpen)
        #expect(s.labelLength == 612)
    }

    @Test func peelerPresentReadsTheGetvar() async throws {
        var fakes: [FakePrinter] = []
        defer { fakes.forEach { $0.close() } }
        func fake(_ replies: [(String, String)] = []) async throws -> FakePrinter {
            let p = try await FakePrinter.start(replies)
            fakes.append(p)
            return p
        }
        #expect(try await zebra(fake([(peelerQuery, "\"Present\"")])).peelerPresent() == true)
        #expect(try await zebra(fake([(peelerQuery, "\"Not Present\"")])).peelerPresent() == false)
        #expect(try await zebra(fake([(peelerQuery, "\"?\"")])).peelerPresent() == nil)
        #expect(try await zebra(fake()).peelerPresent() == nil) // no answer
        #expect(try await NetworkZebra(host: "127.0.0.1", port: closedPort(), timeouts: fast).peelerPresent() == nil)
    }

    @Test func serialReadsTheUniqueId() async throws {
        let p = try await FakePrinter.start([(serialQuery, "\"D2J123456789\"")])
        let silent = try await FakePrinter.start()
        defer { p.close(); silent.close() }
        #expect(try await zebra(p).serial() == "D2J123456789")
        #expect(try await zebra(silent).serial() == nil)
    }

    @Test func fontsListsTheEDrive() async throws {
        let listing = "\u{02}\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960 \r\n* E:TT0003M_.TTF    160676       K  \r\n" +
            "\r\n-  32346624 bytes free E: ONBOARD FLASH \r\n\u{03}"
        let p = try await FakePrinter.start([("^XA^HWE:*.*^XZ", listing)])
        let garbage = try await FakePrinter.start([("^XA^HWE:*.*^XZ", "\u{02}nope\u{03}")])
        defer { p.close(); garbage.close() }
        #expect(try await zebra(p).fonts() == ["85620388.TTF", "TT0003M_.TTF"])
        await #expect(throws: PrinterBadReply.self) { try await zebra(garbage).fonts() }
    }

    @Test func installFontSendsTheHeaderThenTheBytes() async throws {
        let p = try await FakePrinter.start()
        defer { p.close() }
        let bytes = Data((0..<70_000).map { UInt8($0 % 251) })
        try await zebra(p).installFont(name: "roboto_r.ttf", bytes: bytes)
        let header = Data("~DYE:ROBOTO_R.TTF,B,T,70000,,".utf8)
        #expect(await p.received() == [header + bytes])
    }

    @Test func installFontRefusesAResidentFontOrABadName() async throws {
        let p = try await FakePrinter.start()
        defer { p.close() }
        let z = zebra(p)
        await #expect(throws: FontInstallRefused.self) { try await z.installFont(name: "TT0003M_.TTF", bytes: Data([1])) }
        await #expect(throws: FontInstallRefused.self) { try await z.installFont(name: "A,B.TTF", bytes: Data([1])) }
        await #expect(throws: FontInstallRefused.self) { try await z.installFont(name: "X.TTF^XA", bytes: Data([1])) }
        await #expect(throws: FontInstallRefused.self) { try await z.installFont(name: "EMPTY.TTF", bytes: Data()) }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(p.acceptedCount == 0)
        #expect(p.connections.isEmpty)
    }

    @Test func aClosedPortIsUnreachable() async throws {
        // a refused connection ends at once (as Android's refused connect), not at the connect budget
        let z = NetworkZebra(host: "127.0.0.1", port: try await closedPort(), timeouts: ZebraTimeouts(connect: 10, idle: 0.3, total: 2, send: 5))
        let started = Date()
        let error = await #expect(throws: PrinterUnreachable.self) { try await z.identify() }
        #expect(error?.host == "127.0.0.1")
        #expect(error?.localNetworkDenied == false)
        await #expect(throws: PrinterUnreachable.self) { try await z.send("^XA^XZ") }
        #expect(elapsed(since: started) < 2)
    }

    /// Android's "a socket that can't be created" (its network is gone) is, on iOS, a connection
    /// whose path can't be satisfied: it sits in `.waiting` and must end at the connect budget.
    @Test func aConnectionThatWaitsIsUnreachableWithinItsBudget() async throws {
        let p = try await FakePrinter.start([("~HI", hi)])
        defer { p.close() }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .cellular // no such path to 127.0.0.1
        let z = NetworkZebra(host: "127.0.0.1", port: p.port, timeouts: ZebraTimeouts(connect: 0.5, idle: 0.3, total: 2, send: 5), parameters: parameters)
        var started = Date()
        await #expect(throws: PrinterUnreachable.self) { try await z.identify() }
        #expect(elapsed(since: started) < 2)
        started = Date()
        await #expect(throws: PrinterUnreachable.self) { try await z.send("^XA^XZ") }
        #expect(elapsed(since: started) < 2)
        #expect(p.acceptedCount == 0)
    }

    @Test func aSendPastItsBudgetIsATimeout() async throws {
        // accepts, never reads: the write blocks once the buffers fill
        let silent = try await FakePrinter.start(serve: false)
        defer { silent.close() }
        let z = NetworkZebra(host: "127.0.0.1", port: silent.port, timeouts: ZebraTimeouts(connect: 1, send: 0.3))
        let started = Date()
        let error = await #expect(throws: PrinterTimeout.self) {
            try await z.installFont(name: "BIG.TTF", bytes: Data(count: 64 << 20))
        }
        #expect(error?.host == "127.0.0.1")
        #expect(elapsed(since: started) < 5)
    }

    @Test func anEmptyReplyIsNoReply() async throws {
        let p = try await FakePrinter.start()
        defer { p.close() }
        let started = Date()
        let z = NetworkZebra(host: "127.0.0.1", port: p.port, timeouts: ZebraTimeouts(idle: 0.3, total: 10))
        await #expect(throws: PrinterNoReply.self) { try await z.identify() }
        // ended at the idle wait, not the total
        #expect(elapsed(since: started) < 5)
    }

    @Test func aCancelledQueryStopsAtOnceAndStaysACancellation() async throws {
        let p = try await FakePrinter.start()
        defer { p.close() }
        let slow = NetworkZebra(host: "127.0.0.1", port: p.port, timeouts: ZebraTimeouts(idle: 15, total: 15))
        let started = Date()
        let task = Task { try await slow.identify() }
        try await Task.sleep(nanoseconds: 200_000_000)
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(elapsed(since: started) < 5)
        // the connection was closed, not left open for the 15 s read
        #expect(await p.received().count == 1)
        #expect(elapsed(since: started) < 5)
    }

    @Test func aCancelledConnectStaysACancellation() async throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .cellular
        let z = NetworkZebra(host: "127.0.0.1", port: 9, timeouts: ZebraTimeouts(connect: 15), parameters: parameters)
        let started = Date()
        let task = Task { try await z.identify() }
        try await Task.sleep(nanoseconds: 200_000_000)
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(elapsed(since: started) < 5)
    }

    @Test func anUnreadableReplyIsABadReply() async throws {
        let p = try await FakePrinter.start([("~HS", "\u{02}030,0\u{03}\u{02}x\u{03}\u{02}y\u{03}")])
        defer { p.close() }
        await #expect(throws: PrinterBadReply.self) { try await zebra(p).status() }
    }

    // MARK: the subnet scan

    @Test func theScanListsZebrasWithModelSerialAndDpi() async throws {
        let p = try await FakePrinter.start([("~HI", hi), (serialQuery, "\"D2J123\"")])
        defer { p.close() }
        let scanner = ZebraScanner(subnets: { [ScanSubnet(hosts: ["127.0.0.1"])] }, port: p.port)
        let result = try await scanner.scan()
        #expect(result.printers == [FoundPrinter(host: "127.0.0.1", model: "ZD421-300dpi", serial: "D2J123", dpi: 300)])
        #expect(!result.localNetworkDenied)
        #expect(result.message == nil)
        // ~HI, then the serial getvar, on one connection; nothing else
        #expect(await p.received().map(ascii) == ["~HI" + serialQuery])
    }

    @Test func theScanKeepsAResponderThatWontSayWhatItIs() async throws {
        // silent, an unreadable answer, and an answer without the STX frame a network Zebra sends
        let cases: [[(String, String)]] = [[], [("~HI", "\u{02}nope\u{03}")], [("~HI", "ZD421-300dpi,V93.21.38Z,12,8176KB\r\n")]]
        for replies in cases {
            let p = try await FakePrinter.start(replies)
            defer { p.close() }
            let scanner = ZebraScanner(subnets: { [ScanSubnet(hosts: ["127.0.0.1"])] }, port: p.port, identify: 0.3)
            #expect(try await scanner.scan().printers == [FoundPrinter(host: "127.0.0.1", model: nil, serial: nil, dpi: nil)])
            // asked ~HI and nothing else: the serial getvar goes only to a Zebra
            #expect(await p.received().map(ascii) == ["~HI"])
        }
    }

    @Test func aHostThatFailsDoesntFailTheScan() async throws {
        struct Gone: Error {}
        let scanner = ZebraScanner(
            subnets: { [ScanSubnet(hosts: ["10.0.0.1", "10.0.0.2", "10.0.0.3"])] },
            probe: { host, _ in
                switch host {
                case "10.0.0.1": throw Gone()
                case "10.0.0.2": throw URLError(.notConnectedToInternet)
                default: return .found(FoundPrinter(host: host, model: "ZD421", serial: nil, dpi: 203))
                }
            }
        )
        let result = try await scanner.scan()
        #expect(result.printers == [FoundPrinter(host: "10.0.0.3", model: "ZD421", serial: nil, dpi: 203)])
        #expect(!result.localNetworkDenied)
    }

    /// Android's probes block threads, so its scan runs on its own threads. iOS probes never block
    /// (NWConnection is callback based); this checks a full window of waiting probes leaves the
    /// cooperative pool free for other work.
    @Test func aScanLeavesOtherWorkFree() async throws {
        let started = Counter()
        let scanner = ZebraScanner(
            subnets: { [ScanSubnet(hosts: (1...128).map { "10.0.0.\($0)" })] },
            probe: { _, _ in
                started.bump()
                try await Task.sleep(nanoseconds: 1_000_000_000)
                return .unanswered
            }
        )
        let scan = Task { try await scanner.scan() }
        let until = Date().addingTimeInterval(5)
        while started.value < 64, Date() < until { try await Task.sleep(nanoseconds: 5_000_000) }
        #expect(started.value == 64)
        let t0 = Date()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<64 { group.addTask { try? await Task.sleep(nanoseconds: 10_000_000) } }
        }
        #expect(elapsed(since: t0) < 0.8)
        _ = try await scan.value
    }

    @Test func theScanSkipsHostsThatDontAnswer() async throws {
        let scanner = ZebraScanner(subnets: { [ScanSubnet(hosts: ["127.0.0.1"])] }, port: try await closedPort())
        let started = Date()
        let result = try await scanner.scan()
        #expect(result.printers == [])
        #expect(!result.localNetworkDenied)
        #expect(elapsed(since: started) < 2) // a refused connection ends at once, not at the budget
    }

    @Test func theScanProbesSixtyFourHostsAtOnce() async throws {
        let probed = Counter()
        let open = Counter()
        let peak = Counter()
        let scanner = ZebraScanner(
            subnets: { [ScanSubnet(hosts: (1...254).map { "10.0.0.\($0)" })] },
            probe: { _, _ in
                peak.raise(to: open.bump())
                try await Task.sleep(nanoseconds: 50_000_000)
                open.drop()
                probed.bump()
                return .unanswered
            }
        )
        #expect(try await scanner.scan().printers == [])
        #expect(probed.value == 254)
        #expect(peak.value == 64)
    }

    @Test func theScanStopsAtItsBudgetWithWhatItFound() async throws {
        let scanner = ZebraScanner(
            subnets: { [ScanSubnet(hosts: ["10.0.0.1", "10.0.0.2"])] },
            budget: 0.3,
            probe: { host, _ in
                if host == "10.0.0.2" { try await Task.sleep(nanoseconds: 30_000_000_000) }
                return .found(FoundPrinter(host: host, model: "ZD421", serial: nil, dpi: 203))
            }
        )
        let started = Date()
        #expect(try await scanner.scan().printers == [FoundPrinter(host: "10.0.0.1", model: "ZD421", serial: nil, dpi: 203)])
        #expect(elapsed(since: started) < 5)
    }

    @Test func theScanSortsByAddressAndProbesEachHostOnce() async throws {
        let probed = Counter()
        let scanner = ZebraScanner(
            subnets: { [ScanSubnet(hosts: ["10.0.0.20", "10.0.0.3"]), ScanSubnet(hosts: ["10.0.0.3", "10.0.0.100"])] },
            probe: { host, _ in
                probed.bump()
                return .found(FoundPrinter(host: host, model: nil, serial: nil, dpi: nil))
            }
        )
        #expect(try await scanner.scan().printers.map(\.host) == ["10.0.0.3", "10.0.0.20", "10.0.0.100"])
        #expect(probed.value == 3)
    }

    @Test func cancellingTheScanStopsNewProbes() async throws {
        let started = Counter()
        let scanner = ZebraScanner(
            subnets: { [ScanSubnet(hosts: (1...254).map { "10.0.0.\($0)" })] },
            probe: { _, _ in
                started.bump()
                try await Task.sleep(nanoseconds: 30_000_000_000)
                return .unanswered
            }
        )
        let scan = Task { try await scanner.scan() }
        let until = Date().addingTimeInterval(5)
        while started.value < 64, Date() < until { try await Task.sleep(nanoseconds: 5_000_000) }
        let t0 = Date()
        scan.cancel()
        await #expect(throws: CancellationError.self) { try await scan.value }
        #expect(elapsed(since: t0) < 2)
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(started.value == 64)
    }

    @Test func cancellingTheScanClosesItsOpenConnections() async throws {
        let p = try await FakePrinter.start() // takes the connection, never answers ~HI
        defer { p.close() }
        let scanner = ZebraScanner(subnets: { [ScanSubnet(hosts: ["127.0.0.1"])] }, port: p.port, identify: 15, budget: 30)
        let scan = Task { try await scanner.scan() }
        let until = Date().addingTimeInterval(5)
        while p.acceptedCount < 1, Date() < until { try await Task.sleep(nanoseconds: 5_000_000) }
        try await Task.sleep(nanoseconds: 100_000_000) // ~HI is out, its read is waiting
        let t0 = Date()
        scan.cancel()
        await #expect(throws: CancellationError.self) { try await scan.value }
        #expect(await p.received().map(ascii) == ["~HI"])
        #expect(elapsed(since: t0) < 2)
    }

    @Test func theScanSaysLocalNetworkIsOffOnlyWhenEveryProbeWasDenied() async throws {
        let denied = ZebraScanner(
            subnets: { [ScanSubnet(hosts: ["10.0.0.1", "10.0.0.2"])] },
            probe: { _, _ in .deniedByPolicy }
        )
        let off = try await denied.scan()
        #expect(off.localNetworkDenied)
        #expect(off.printers == [])
        #expect(off.message == "Allow Local Network access for ServerSherpa Kiosk in Settings to find printers.")

        let mixed = ZebraScanner(
            subnets: { [ScanSubnet(hosts: ["10.0.0.1", "10.0.0.2"])] },
            probe: { host, _ in host == "10.0.0.1" ? .deniedByPolicy : .unanswered }
        )
        #expect(try await mixed.scan().localNetworkDenied == false)

        let nothing = ZebraScanner(subnets: { [] })
        let empty = try await nothing.scan()
        #expect(!empty.localNetworkDenied)
        #expect(empty.printers == [])
    }

    @Test func aPolicyDenialIsLocalNetworkOffOrItsPathReason() {
        #expect(isLocalNetworkDenial(error: .posix(.ENETDOWN), unsatisfiedReason: nil))
        #expect(isLocalNetworkDenial(error: .dns(-65570), unsatisfiedReason: nil)) // kDNSServiceErr_PolicyDenied
        #expect(isLocalNetworkDenial(error: .posix(.ETIMEDOUT), unsatisfiedReason: .localNetworkDenied))
        #expect(isLocalNetworkDenial(error: nil, unsatisfiedReason: .localNetworkDenied))
        #expect(!isLocalNetworkDenial(error: .posix(.ECONNREFUSED), unsatisfiedReason: nil))
        #expect(!isLocalNetworkDenial(error: .posix(.EHOSTUNREACH), unsatisfiedReason: .notAvailable))
        #expect(!isLocalNetworkDenial(error: .dns(-65537), unsatisfiedReason: nil))
        #expect(!isLocalNetworkDenial(error: nil, unsatisfiedReason: nil))
    }

    // MARK: the device's networks

    @Test func scanTargetsAreTheDevicesPrivateSlash24() {
        let t = scanTargets(address: "192.168.1.37", prefixLength: 24)
        #expect(t.count == 253) // .1–.254 without the device itself
        #expect(t.first == "192.168.1.1"); #expect(t.last == "192.168.1.254")
        #expect(!t.contains("192.168.1.37"))
        // a larger subnet still scans only the device's /24
        #expect(scanTargets(address: "10.20.30.40", prefixLength: 16) == scanTargets(address: "10.20.30.40", prefixLength: 24))
        // a smaller one scans just itself
        #expect(scanTargets(address: "172.16.5.130", prefixLength: 29)
            == ["172.16.5.129", "172.16.5.131", "172.16.5.132", "172.16.5.133", "172.16.5.134"])
        // public, loopback and link-local addresses are never scanned
        #expect(scanTargets(address: "8.8.8.8", prefixLength: 24) == [])
        #expect(scanTargets(address: "127.0.0.1", prefixLength: 8) == [])
        #expect(scanTargets(address: "169.254.3.4", prefixLength: 16) == [])
        #expect(scanTargets(address: "not an ip", prefixLength: 24) == [])
        #expect(scanTargets(address: "172.32.0.5", prefixLength: 24) == []) // just past 172.16/12
        #expect(scanTargets(address: "10.0.0.1", prefixLength: 31) == [])
    }

    @Test func onlyWiFiAndEthernetInterfacesAreScanned() {
        #expect(isScannableInterface("en0"))
        #expect(isScannableInterface("en12"))
        for name in ["utun0", "utun3", "ipsec0", "pdp_ip0", "lo0", "awdl0", "llw0", "bridge100", "anpi0", "enc0", "en"] {
            #expect(!isScannableInterface(name), "\(name)")
        }
        #expect(prefixLength(netmask: 0xFFFF_FF00) == 24)
        #expect(prefixLength(netmask: 0xFFFF_0000) == 16)
        #expect(prefixLength(netmask: 0xFFFF_FFF8) == 29)
        #expect(prefixLength(netmask: 0) == 0)
    }

    /// Reads this machine's interfaces (getifaddrs only; nothing is sent): whatever it finds is
    /// private, at most a /24, and never the device's own address.
    @Test func theDevicesSubnetsArePrivateSlash24sAtMost() {
        for subnet in LocalNetworks.subnets() {
            #expect(!subnet.hosts.isEmpty)
            #expect(subnet.hosts.count <= 254)
            #expect(subnet.hosts.allSatisfy { $0.hasPrefix("10.") || $0.hasPrefix("192.168.") || $0.hasPrefix("172.") })
        }
    }
}

/// A thread-safe counter for probe tallies.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    @discardableResult func bump() -> Int { lock.withLock { count += 1; return count } }
    func drop() { lock.withLock { count -= 1 } }
    func raise(to value: Int) { lock.withLock { count = max(count, value) } }
    var value: Int { lock.withLock { count } }
}
