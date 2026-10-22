import Foundation

/**
 A Zebra over Bluetooth LE: `ZebraTransport` over the app's one link (`ZebraBluetooth`), so the
 setup checks, font installs, test labels and Print Labels send exactly what they send to a network
 printer. Its `address` (every error's `host`) is the printer's serial.

 Each call reconnects first when the link is down (the printer is found by the iPad's identifier,
 else by its serial, and confirmed by its Device Information serial), and nothing reconnects on its
 own while idle (D4). Writes go in acknowledged chunks within `ZebraBluetoothSpec.sendBudget`; a
 drop, `close()` or a budget that runs out fails the write at once. Queries drain late bytes first
 and read the reply until it is whole, `queryIdle` after its last byte, or `queryTotal`.
 */
struct BluetoothZebra: ZebraTransport {
    let bluetooth: ZebraBluetooth
    let serial: String
    let peripheralId: UUID?

    var address: String { serial }

    func query(_ command: String, complete: @escaping @Sendable (Data) -> Bool) async throws -> String {
        try await bluetooth.query(command, on: target, complete: complete)
    }

    func write(_ parts: [Data], progress: (@Sendable (_ sent: Int, _ total: Int) -> Void)?) async throws {
        try await bluetooth.write(parts, on: target, progress: progress)
    }

    private var target: BluetoothTarget { BluetoothTarget(peripheralId: peripheralId, serial: serial) }
}

extension BluetoothZebra: SetupZebra {}

// MARK: Errors (alongside PrinterUnreachable, PrinterTimeout and PrinterNoReply, with host = serial)

/// Bluetooth is off, not allowed for the kiosk, missing, or not ready yet.
struct BluetoothUnavailable: PrinterError {
    var host: String
    var availability: BluetoothAvailability
    var errorDescription: String? {
        switch availability {
        case .poweredOff: BLUETOOTH_OFF_TEXT
        case .unauthorized: BLUETOOTH_DENIED_TEXT
        case .unsupported: "This device doesn't support Bluetooth LE."
        case .unknown, .ready: "Bluetooth isn't ready yet. Try again in a moment."
        }
    }
}

/// iOS doesn't know the printer by its identifier, and no device named its serial was heard
/// within the connect budget.
struct BluetoothPrinterNotFound: PrinterError {
    var host: String
    var errorDescription: String? { "No Bluetooth printer named \(host) was found nearby." }
}

/// The device isn't a Zebra: its manufacturer isn't "Zebra Technologies", or it has no Zebra
/// parser service.
struct BluetoothNotZebra: PrinterError {
    var host: String
    var errorDescription: String? { "\(host.isEmpty ? "This device" : host) isn't a Zebra printer." }
}

/// The device answering to the saved identifier reports another serial (another printer after a
/// repair, say): it isn't used. `host` is the serial expected.
struct BluetoothSerialMismatch: PrinterError {
    var host: String
    var found: String?
    var errorDescription: String? { "The printer that answered is \(found ?? "another printer"), not \(host)." }
}

/// The printer forgot this iPad (CBError 14) or pairing didn't finish (15): no retries until the
/// user forgets the printer in Settings and connects again (D10).
struct BluetoothPairingLost: PrinterError {
    var host: String
    var errorDescription: String? { pairingLostText(serial: host) }
}
