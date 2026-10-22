import Foundation

/**
 How bytes reach one Zebra and its replies come back: a network printer (`NetworkZebra`, one TCP
 connection per command) or a Bluetooth one. Everything the kiosk asks or sends is built once on
 top of it (the extension below, the web kiosk's `fromTransport` in kiosk/src/lib/stationPrinter.ts),
 so both send exactly the same bytes and parse the same replies.

 A transport sends nothing on its own: each call sends exactly what it is given.
 */
protocol ZebraTransport: Sendable {
    /// The printer's address as its errors carry it (`PrinterError.host`).
    var address: String { get }
    /// Sends `command` and reads the reply until `complete` says it is whole (or the transport's
    /// quiet and total limits), as Latin-1; throws `PrinterNoReply` when nothing came back.
    func query(_ command: String, complete: @escaping @Sendable (Data) -> Bool) async throws -> String
    /// Writes `parts` in order as one job. `progress`, when given, hears `(0, total)` once the
    /// bytes start going out (the printer is connected), then the bytes written so far: no report
    /// means nothing was sent (`PrinterGuard` tells a cut font from one that never started by it).
    func write(_ parts: [Data], progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws
}

/// How Print Labels and Printer Setup reach `printer`, by its connection: a network printer is the
/// `NetworkZebra` at its host (one TCP connection per command, as before Bluetooth); a Bluetooth
/// printer goes over `bluetooth`, the app's one link (which starts Bluetooth only once a call is
/// made). The container's sender and `zebra(for:)` both use it.
func zebraTransport(for printer: SavedPrinter, bluetooth: ZebraBluetooth) -> SetupZebra {
    switch printer.connection {
    case .network(let host): NetworkZebra(host: host)
    case .bluetooth(let serial, let peripheralId): BluetoothZebra(bluetooth: bluetooth, serial: serial, peripheralId: peripheralId)
    }
}

/// The commands and their replies, the same over every transport. Replies are read as Latin-1,
/// ZPL is sent as UTF-8 (labels carry `^CI28`), and a font's bytes go raw after its ASCII header.
extension ZebraTransport {
    /// `~HI`: model, firmware, resolution.
    func identify() async throws -> HostId {
        guard let id = parseNetworkHostIdentification(try await query(ZebraCommands.hostIdentification, complete: frames(1))) else {
            throw PrinterBadReply(host: address, what: "identification")
        }
        return id
    }

    /// `~HS`: paper, head, pause and the rest (three frames).
    func status() async throws -> HostStatus {
        guard let status = parseHostStatus(try await query(ZebraCommands.hostStatus, complete: frames(3))) else {
            throw PrinterBadReply(host: address, what: "status")
        }
        return status
    }

    /// Whether a peeler is fitted; nil when the printer doesn't say (an unknown variable, no or an
    /// unreadable answer, or no printer at all). Throws only `CancellationError`.
    func peelerPresent() async throws -> Bool? {
        switch try await getvar(ZebraCommands.peelerPresent)?.lowercased() {
        case "present": return true
        case "not present": return false
        default: return nil
        }
    }

    /// The printer's serial number; nil when it doesn't say. Throws only `CancellationError`.
    func serial() async throws -> String? {
        try await getvar(ZebraCommands.serialNumber)
    }

    /// The object names on E: (fonts and anything else stored there), upper-cased.
    func fonts() async throws -> [String] {
        try await fontEntries().map(\.name)
    }

    /// The objects on E: with their sizes in bytes, names upper-cased.
    func fontEntries() async throws -> [DirectoryEntry] {
        let reply = try await query(ZebraCommands.fontDirectory, complete: frames(1))
        guard isDirectoryListing(reply) else { throw PrinterBadReply(host: address, what: "font listing") }
        return parseDirectoryEntries(reply)
    }

    /// Sends a job as is: no status checks before or after.
    func send(_ zpl: String) async throws {
        try await write([Data(zpl.utf8)], progress: nil)
    }

    /// Installs a TrueType font on E: as `name` (upper-cased): `~DYE:NAME,B,T,<len>,,` then the
    /// bytes, `progress` hearing them go out. A resident font is never installed, and a name that
    /// isn't a plain `NAME.TTF` is refused (`FontInstallRefused`) before anything is sent.
    func installFont(name: String, bytes: Data, progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        let upper = name.uppercased()
        guard isPrinterFontName(upper) else { throw FontInstallRefused(message: "Not a printer font name: \(name)") }
        guard !isResidentFont(upper) else { throw FontInstallRefused(message: "\(upper) is built into the printer and is never installed") }
        guard !bytes.isEmpty else { throw FontInstallRefused(message: "\(upper) has no bytes") }
        try await write([Data(ZebraCommands.downloadFontHeader(name: upper, totalBytes: bytes.count).utf8), bytes], progress: progress)
    }

    private func getvar(_ command: String) async throws -> String? {
        do {
            return parseGetvar(try await query(command, complete: { replyHasQuotedValue($0) }))
        } catch is PrinterError {
            return nil
        }
    }

    private func frames(_ n: Int) -> @Sendable (Data) -> Bool { { replyHasFrames($0, n) } }
}

// MARK: Errors

/// A printer that couldn't be used; `host` is its address as the transport names it.
protocol PrinterError: LocalizedError, Sendable {
    var host: String { get }
}

/// Nothing accepted a connection on the port in time (a connection that sits in `.waiting` past
/// the connect budget included), the connection failed, or it failed while the command was being
/// written. `localNetworkDenied` is set when it waited with iOS's Local Network policy denial.
struct PrinterUnreachable: PrinterError {
    var host: String
    var localNetworkDenied = false
    var errorDescription: String? { "No printer answered at \(host)" }
}

/// The connection didn't take the whole job within its time (the edge's `printer_timeout`).
struct PrinterTimeout: PrinterError {
    var host: String
    var errorDescription: String? { "The printer at \(host) didn't take the job in time" }
}

/// The printer took the query but said nothing before the read gave up.
struct PrinterNoReply: PrinterError {
    var host: String
    var errorDescription: String? { "The printer at \(host) didn't reply" }
}

/// The printer replied, but not with the answer the query asks for.
struct PrinterBadReply: PrinterError {
    var host: String
    var what: String
    var errorDescription: String? { "The printer at \(host) sent an unreadable \(what) reply" }
}

/// `installFont` refused the font before anything was sent (Android's `require` failures).
struct FontInstallRefused: LocalizedError, Sendable {
    var message: String
    var errorDescription: String? { message }
}

/// The connection waited with iOS's Local Network denial (`NetworkZebra` marks it), the `~JX`
/// clear before a job included.
func wasLocalNetworkDenied(_ error: Error) -> Bool {
    if let clear = error as? PrinterClearFailed { return wasLocalNetworkDenied(clear.cause) }
    return (error as? PrinterUnreachable)?.localNetworkDenied == true
}

// MARK: Replies

// When each reply is whole (the edge's REPLY_COMPLETE): ~HS is three STX..ETX frames, ~HI and the
// E: listing one, a getvar one quoted value. Shared by the transports and the network scan.

/// At least `n` ETX-closed frames.
func replyHasFrames(_ reply: Data, _ n: Int) -> Bool { reply.count(of: 0x03) >= n }

/// A whole quoted getvar value (two double quotes).
func replyHasQuotedValue(_ reply: Data) -> Bool { reply.count(of: UInt8(ascii: "\"")) >= 2 }

/// `[A-Z0-9_\-]{1,64}\.TTF`, ASCII only.
private func isPrinterFontName(_ name: String) -> Bool {
    let scalars = Array(name.unicodeScalars)
    guard (5...68).contains(scalars.count), scalars.suffix(4) == Array(".TTF".unicodeScalars) else { return false }
    return scalars.dropLast(4).allSatisfy { s in
        ("A"..."Z").contains(s) || ("0"..."9").contains(s) || s == "_" || s == "-"
    }
}

extension Data {
    fileprivate func count(of byte: UInt8) -> Int { reduce(0) { $0 + ($1 == byte ? 1 : 0) } }
}
