import Foundation
@testable import ServerSherpa_Kiosk

/// Bluetooth as the screens see it (`BluetoothPrinting`): its state, a scan the test feeds
/// (`hear`), a connect that answers with the printer's Device Information (`info`, by identifier)
/// or throws (and can be held), and the link it reports.
@MainActor
final class FakeBluetoothPrinting: BluetoothPrinting {
    var availability = BluetoothAvailability.ready
    private(set) var link = BluetoothLinkInfo()
    /// Device Information by the iPad's identifier for each printer.
    var info: [UUID: BluetoothPrinterInfo] = [:]
    /// Thrown by connect() when set.
    var connectError: Error?
    /// While set, connect() waits (after recording the call).
    var connectHold = false
    private(set) var scans = 0
    private(set) var connects: [BluetoothTarget] = []
    private(set) var closes = 0
    private var feed: AsyncStream<[FoundBluetoothPrinter]>.Continuation?
    private var feedId = 0

    /// A scan is running (the screen listens to it).
    var scanning: Bool { feed != nil }

    func scan() -> AsyncStream<[FoundBluetoothPrinter]> {
        scans += 1
        endScan()
        let id = scans
        let (stream, continuation) = AsyncStream.makeStream(of: [FoundBluetoothPrinter].self)
        // The screen stopped listening (it left, or picked another way to find a printer).
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.abandoned(id) }
        }
        // Bluetooth off, not allowed or missing: the scan ends at once (`ZebraBluetooth`'s rule).
        if [.poweredOff, .unauthorized, .unsupported].contains(availability) {
            continuation.finish()
        } else {
            feed = continuation
            feedId = id
        }
        return stream
    }

    /// What the scan heard so far, strongest first.
    func hear(_ list: [FoundBluetoothPrinter]) { feed?.yield(list) }

    func stopScan() { endScan() }

    /// The scan ends without Stop: its 30 s ran out, or another Bluetooth call took the radio.
    func endScanByItself() { endScan() }

    func connect(peripheralId: UUID?, serial: String?) async throws -> BluetoothPrinterInfo {
        connects.append(BluetoothTarget(peripheralId: peripheralId, serial: serial))
        endScan()
        while connectHold { try await Task.sleep(for: .milliseconds(2)) }
        if let connectError { throw connectError }
        guard let id = peripheralId, let found = info[id] else { throw PrinterUnreachable(host: serial ?? "") }
        linkUp(found)
        return found
    }

    func close() {
        closes += 1
        endScan()
        link.connected = false
    }

    /// The link is up to `printer` (a label's send connected it, say).
    func linkUp(_ printer: BluetoothPrinterInfo) {
        link = BluetoothLinkInfo(connected: true, info: printer, chunkBytes: 244)
    }

    private func endScan() {
        feed?.finish()
        feed = nil
    }

    private func abandoned(_ id: Int) {
        if feedId == id { feed = nil }
    }
}
