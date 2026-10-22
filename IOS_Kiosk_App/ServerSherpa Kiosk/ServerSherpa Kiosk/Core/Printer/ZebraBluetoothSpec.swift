import Foundation

/// What a Zebra printer's Bluetooth LE link is built on: its GATT UUIDs, the limits the link
/// keeps (measured on a ZD421, 2026-10-22), and the copy that explains its failures. The
/// CoreBluetooth code that uses these lives in `Data/Printer`.
enum ZebraBluetoothSpec {
    // MARK: GATT (UUID strings, as CBUUID takes them)

    /// Zebra's parser service: raw ZPL in, replies out.
    static let serviceUUID = "38EB4A80-C570-11E3-9507-0002A5D5C51B"
    /// "From Printer Data": the replies, delivered as indications.
    static let fromPrinterUUID = "38EB4A81-C570-11E3-9507-0002A5D5C51B"
    /// "To Printer Data": the bytes to print, written with a response.
    static let toPrinterUUID = "38EB4A82-C570-11E3-9507-0002A5D5C51B"

    /// The standard Device Information service, and the five values read from it.
    static let deviceInfoUUID = "180A"
    static let manufacturerUUID = "2A29"
    static let modelUUID = "2A24"
    static let serialUUID = "2A25"
    static let firmwareUUID = "2A26"
    static let linkOsUUID = "2A28"

    // MARK: Limits (seconds, unless a count)

    /// Connecting and getting ready (Device Information read, indications on).
    static let connectReady: TimeInterval = 10.0
    /// A query ends this long after its last byte, or `queryTotal` in all.
    static let queryIdle: TimeInterval = 2.0
    static let queryTotal: TimeInterval = 5.0
    /// Before a query, stray bytes of an earlier reply are drained: this much quiet, at most `drainMax`.
    static let drainQuiet: TimeInterval = 0.3
    static let drainMax: TimeInterval = 1.0
    /// After a drop before the link was ready: at most this many tries, this far apart.
    static let reconnectTries = 3
    static let reconnectSpacing: TimeInterval = 3.0
    /// A scan for printers.
    static let scanDuration: TimeInterval = 30.0

    /// How long a send of `bytes` may take: 15 s plus 1 s per 2 KB (twice the measured time).
    static func sendBudget(bytes: Int) -> TimeInterval {
        15 + TimeInterval(bytes) / 2048
    }

    /// A Zebra's Bluetooth name is its serial number: 12 capital letters and digits.
    static func looksLikeZebraSerial(_ name: String) -> Bool {
        let scalars = name.unicodeScalars
        return scalars.count == 12 && scalars.allSatisfy { ("A"..."Z").contains($0) || ("0"..."9").contains($0) }
    }
}

// MARK: Copy

/// Bluetooth is switched off on the iPad.
let BLUETOOTH_OFF_TEXT = "Turn on Bluetooth to reach the printer."

/// iOS keeps the kiosk off Bluetooth.
let BLUETOOTH_DENIED_TEXT = "Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer."

/// Under the scan results, for a printer that doesn't show up.
let BLUETOOTH_SCAN_HINT_TEXT =
    "Don't see the printer? Hold FEED on the printer for 5 seconds (the middle light blinks), then scan again. "
    + "A Zebra's Bluetooth name is its serial number, like D8J224508535."

/// A font download was cut short; the printer is still waiting for the rest of it.
let FONT_INSTALL_CUT_TEXT = "The font install was cut off. Turn the printer off and on, then tap Check again."

/// A font install to the printer was cut off, so nothing more is sent to it until it answers a
/// check (over any transport): the send was refused before anything went out.
struct PrinterNeedsRestart: LocalizedError, Sendable {
    var errorDescription: String? { FONT_INSTALL_CUT_TEXT }
}

/// The printer removed its pairing with this iPad (CBError 14) or the pairing timed out (15).
/// iOS can't open Settings › Bluetooth from an app, so the steps say where to go and the card
/// offers Connect only (Ruling 15).
func pairingLostText(serial: String) -> String {
    "The printer forgot this iPad. In the iPad's Settings app, open Bluetooth, tap ⓘ next to \(serial), "
        + "choose Forget This Device, then come back and tap Connect."
}
