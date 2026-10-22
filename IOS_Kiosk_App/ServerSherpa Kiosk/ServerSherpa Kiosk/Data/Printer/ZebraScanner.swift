import Foundation
import Network

/// A host that took a connection on the printer port. `model`, `serial` and `dpi` are nil when it
/// wouldn't say what it is (it is still listed, as the laptop edge lists it).
struct FoundPrinter: Equatable, Sendable {
    var host: String
    var model: String?
    var serial: String?
    var dpi: Int?
}

/// The addresses to probe on one local network. (Android also carries the network's socket
/// factory; iOS routes a LAN address over the interface that holds its subnet by itself.)
struct ScanSubnet: Equatable, Sendable {
    var hosts: [String]
}

/// How one probe ended.
enum ScanProbe: Equatable, Sendable {
    /// Took the connection (with what it said it is, if anything).
    case found(FoundPrinter)
    /// Refused, failed, or nothing answered in time.
    case unanswered
    /// Waited out its time with iOS's Local Network policy denial.
    case deniedByPolicy

    var ending: ProbeEnding {
        switch self {
        case .found: return .answered
        case .unanswered: return .unanswered
        case .deniedByPolicy: return .deniedByPolicy
        }
    }
}

/// What a scan found, sorted by address, and whether iOS kept it off the local network.
struct ZebraScanResult: Equatable, Sendable {
    var printers: [FoundPrinter]
    var localNetworkDenied: Bool

    /// The scan's message when Local Network access is off; nil otherwise.
    var message: String? { localNetworkDenied ? LOCAL_NETWORK_DENIED_TEXT : nil }
}

/**
 Finds network Zebras on the device's Wi-Fi or Ethernet subnet: every address is probed on the
 printer port (64 at once, 0.5 s each), and each one that answers is asked `~HI` (1.5 s, read to
 its ETX) and, when that names a Zebra, its serial number. The whole scan ends within ~10 s with
 whatever it found, sorted by address. Sending `~HI` to everything on the port is the laptop
 edge's own scan (kiosk_laptop/edge/src/edge/printers.py). A host that fails in any way is just
 left out (one that took the connection stays listed), never the whole scan. Mirrors Android's
 data/printer/ZebraScanner.kt.

 Probes run in a task group with a sliding window of `concurrency`. Cancelling the scan's task
 starts no more probes, cancels the open connections, and throws `CancellationError`.
 */
final class ZebraScanner: Sendable {
    typealias Probe = @Sendable (_ host: String, _ subnet: ScanSubnet) async throws -> ScanProbe

    private let subnets: @Sendable () async -> [ScanSubnet]
    private let port: UInt16
    private let probeConnect: TimeInterval
    private let identify: TimeInterval
    private let budget: TimeInterval
    private let concurrency: Int
    private let parameters: NWParameters
    private let injectedProbe: Probe?

    /// The defaults scan the device's own Wi-Fi and Ethernet networks (`LocalNetworks.subnets`).
    init(
        subnets: @escaping @Sendable () async -> [ScanSubnet] = { LocalNetworks.subnets() },
        port: UInt16 = ZebraNetwork.port,
        probeConnect: TimeInterval = ZebraNetwork.probeConnect,
        identify: TimeInterval = ZebraNetwork.identify,
        budget: TimeInterval = ZebraNetwork.scanBudget,
        concurrency: Int = ZebraNetwork.scanConcurrency,
        parameters: NWParameters = .tcp,
        probe: Probe? = nil
    ) {
        self.subnets = subnets
        self.port = port
        self.probeConnect = probeConnect
        self.identify = identify
        self.budget = budget
        self.concurrency = max(1, concurrency)
        self.parameters = parameters
        self.injectedProbe = probe
    }

    func scan() async throws -> ZebraScanResult {
        let targets = await subnets()
        var seen = Set<String>()
        var work: [(host: String, subnet: ScanSubnet)] = []
        for subnet in targets {
            for host in subnet.hosts where seen.insert(host).inserted { work.append((host, subnet)) }
        }
        let tally = ScanTally()
        let budget = budget
        await withTaskGroup(of: Void.self) { race in
            race.addTask { await self.probeAll(work, into: tally) }
            race.addTask { try? await Task.sleep(nanoseconds: UInt64(max(0, budget) * 1_000_000_000)) }
            await race.next()
            race.cancelAll()
        }
        try Task.checkCancellation()
        return tally.result()
    }

    /// Every host, at most `concurrency` at once; a new probe starts as each one ends, until the
    /// work is done or the task is cancelled.
    private func probeAll(_ work: [(host: String, subnet: ScanSubnet)], into tally: ScanTally) async {
        await withTaskGroup(of: Void.self) { group in
            var next = 0
            func startNext() {
                guard next < work.count, !Task.isCancelled else { return }
                let (host, subnet) = work[next]
                next += 1
                group.addTask { await self.probeOne(host, subnet, into: tally) }
            }
            for _ in 0..<min(concurrency, work.count) { startNext() }
            while await group.next() != nil { startNext() }
        }
    }

    private func probeOne(_ host: String, _ subnet: ScanSubnet, into tally: ScanTally) async {
        let outcome: ScanProbe
        do {
            if let injectedProbe {
                outcome = try await injectedProbe(host, subnet)
            } else {
                outcome = try await identifyAt(host)
            }
        } catch {
            // a cancelled probe isn't counted; a network that vanished, a bad host: skip it
            if error is CancellationError || Task.isCancelled { return }
            outcome = .unanswered
        }
        tally.add(outcome)
    }

    /// One connection: the probe, then `~HI` and the serial on it. A host that took the
    /// connection is listed even if it won't say what it is.
    private func identifyAt(_ host: String) async throws -> ScanProbe {
        let identify = identify
        do {
            return .found(try await zebraSession(
                host: host, port: port, parameters: parameters,
                connect: probeConnect, deadline: 2 * identify + 0.5
            ) { link in
                let id = try await ask(link, ZebraCommands.hostIdentification, identify: identify) { $0.contains(0x03) }
                    .flatMap(parseNetworkHostIdentification)
                var serial: String?
                if id != nil {
                    serial = try await ask(link, ZebraCommands.serialNumber, identify: identify) { reply in
                        reply.reduce(0) { $0 + ($1 == UInt8(ascii: "\"") ? 1 : 0) } >= 2
                    }.flatMap(parseGetvar)
                }
                return FoundPrinter(host: host, model: id?.model, serial: serial, dpi: id?.dpi)
            })
        } catch let error as PrinterUnreachable {
            return error.localNetworkDenied ? .deniedByPolicy : .unanswered
        } catch is PrinterError {
            return .unanswered
        }
    }

    /// A short query on an open connection; nil when it can't be written. Throws only
    /// `CancellationError`.
    private func ask(_ link: ZebraLink, _ command: String, identify: TimeInterval, complete: (Data) -> Bool) async throws -> String? {
        do {
            try await link.write(Data(command.utf8))
        } catch is ZebraLinkClosed {
            return nil
        }
        let reply = try await readReply(link, idle: identify, total: identify, maxBytes: ZebraNetwork.identifyMax, complete: complete)
        return String(data: reply, encoding: .isoLatin1)
    }
}

/// Found printers and probe endings, from many probes at once.
private final class ScanTally: @unchecked Sendable {
    private let lock = NSLock()
    private var found: [FoundPrinter] = []
    private var endings: [ProbeEnding] = []

    func add(_ outcome: ScanProbe) {
        lock.withLock {
            if case .found(let printer) = outcome { found.append(printer) }
            endings.append(outcome.ending)
        }
    }

    func result() -> ZebraScanResult {
        lock.withLock {
            ZebraScanResult(
                printers: found.sorted { ipv4Key($0.host) < ipv4Key($1.host) },
                localNetworkDenied: scanWasDeniedLocalNetwork(endings)
            )
        }
    }
}

/// The device's Wi-Fi and Ethernet networks, from `getifaddrs` (no permission needed). Only
/// `en*` interfaces count: VPN tunnels (`utun*`, `ipsec*`), cellular (`pdp_ip*`), loopback and
/// AWDL are never scanned.
enum LocalNetworks {
    /// Each LAN interface's IPv4 scan targets (`scanTargets`).
    static func subnets() -> [ScanSubnet] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }
        var out: [ScanSubnet] = []
        var seen = Set<[String]>()
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = entry.pointee
            let flags = Int32(ifa.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_RUNNING) != 0, (flags & IFF_LOOPBACK) == 0,
                  isScannableInterface(String(cString: ifa.ifa_name)),
                  let address = ifa.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET),
                  let netmask = ifa.ifa_netmask
            else { continue }
            let ip = ipv4(address)
            let hosts = scanTargets(address: formatIpv4(ip), prefixLength: prefixLength(netmask: ipv4(netmask)))
            if !hosts.isEmpty, seen.insert(hosts).inserted { out.append(ScanSubnet(hosts: hosts)) }
        }
        return out
    }

    /// An IPv4 `sockaddr`'s address in host byte order.
    private static func ipv4(_ address: UnsafeMutablePointer<sockaddr>) -> UInt32 {
        address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
    }
}

/// Wi-Fi or Ethernet: `en` and a number.
func isScannableInterface(_ name: String) -> Bool {
    guard name.hasPrefix("en") else { return false }
    let unit = name.dropFirst(2)
    return !unit.isEmpty && unit.allSatisfy { ("0"..."9").contains($0) }
}

/// A netmask's prefix length (its set bits).
func prefixLength(netmask: UInt32) -> Int { netmask.nonzeroBitCount }

/// The addresses a scan probes from the device's `address`: its subnet when that is a /24 or
/// smaller, else just the device's /24; never the network, broadcast or device's own address. Only
/// private (RFC 1918) addresses are scanned, as on the laptop.
func scanTargets(address: String, prefixLength: Int) -> [String] {
    guard let ip = parseIpv4(address), isPrivateIpv4(ip), prefixLength <= 30 else { return [] }
    let prefix = max(prefixLength, 24)
    let mask = UInt32.max << UInt32(32 - prefix)
    let network = ip & mask
    let broadcast = network | ~mask
    guard broadcast > network + 1 else { return [] }
    return ((network + 1)..<broadcast).filter { $0 != ip }.map(formatIpv4)
}

private func parseIpv4(_ text: String) -> UInt32? {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var ip: UInt32 = 0
    for part in parts {
        guard (1...3).contains(part.count), part.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) }),
              let octet = UInt32(part), octet <= 255 else { return nil }
        ip = ip << 8 | octet
    }
    return ip
}

private func formatIpv4(_ ip: UInt32) -> String {
    (0..<4).reversed().map { String((ip >> (8 * UInt32($0))) & 0xFF) }.joined(separator: ".")
}

private func isPrivateIpv4(_ ip: UInt32) -> Bool {
    let a = (ip >> 24) & 0xFF
    let b = (ip >> 16) & 0xFF
    return a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
}

private func ipv4Key(_ host: String) -> UInt64 { parseIpv4(host).map(UInt64.init) ?? UInt64.max }
