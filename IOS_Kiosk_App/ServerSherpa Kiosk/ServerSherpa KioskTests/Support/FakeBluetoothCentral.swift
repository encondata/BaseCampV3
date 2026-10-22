import CoreBluetooth
import Foundation
@testable import ServerSherpa_Kiosk

/// Makes the fake central, counting how often (the real client asks iOS for Bluetooth
/// permission the moment it makes its central).
@MainActor
final class FakeBluetoothClient: BluetoothCentralClient {
    let central: FakeBluetoothCentral
    private(set) var made = 0

    init(state: BluetoothCentralState = .poweredOn) {
        central = FakeBluetoothCentral(state: state)
    }

    func makeCentral(onEvent: @escaping @MainActor (BluetoothCentralEvent) -> Void) -> any BluetoothCentral {
        made += 1
        central.onEvent = onEvent
        return central
    }
}

/// A central that records what it is asked and answers the way CoreBluetooth does: later, on the
/// main queue, in order. Its state changes only when the test reports one.
@MainActor
final class FakeBluetoothCentral: BluetoothCentral {
    private(set) var state: BluetoothCentralState
    fileprivate var onEvent: (@MainActor (BluetoothCentralEvent) -> Void)?

    /// The peripherals iOS knows by identifier (`retrievePeripherals` finds them).
    var known: [FakePeripheral] = []
    private(set) var retrieved: [[UUID]] = []
    private(set) var connects: [UUID] = []
    private(set) var cancels: [UUID] = []
    private(set) var scanning = false
    private(set) var scans = 0

    init(state: BluetoothCentralState) {
        self.state = state
    }

    /// Bluetooth was switched on or off, or the permission changed.
    func report(_ state: BluetoothCentralState) {
        self.state = state
        deliver(.stateChanged(state))
    }

    /// `p` is heard while scanning.
    func advertise(_ p: FakePeripheral, rssi: Int, advertisesZebra: Bool = false) {
        p.central = self
        deliver(.discovered(p, name: p.name, rssi: rssi, advertisesZebra: advertisesZebra))
    }

    func scan() {
        scanning = true
        scans += 1
    }

    func stopScan() { scanning = false }

    func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [any BluetoothPeripheral] {
        retrieved.append(identifiers)
        return known.filter { identifiers.contains($0.identifier) }
    }

    func connect(_ peripheral: any BluetoothPeripheral) {
        connects.append(peripheral.identifier)
        guard let p = peripheral as? FakePeripheral else { return }
        p.central = self
        switch p.connectBehavior {
        case .answer:
            p.isConnected = true
            deliver(.connected(p))
        case .silent:
            break // out of range: iOS keeps the connect pending
        case .fail(let error):
            deliver(.failedToConnect(p, error))
        }
    }

    func cancelConnection(_ peripheral: any BluetoothPeripheral) {
        cancels.append(peripheral.identifier)
        guard let p = peripheral as? FakePeripheral, p.isConnected else { return }
        p.isConnected = false
        deliver(.disconnected(p, nil)) // CoreBluetooth reports the end of a cancelled link too
    }

    fileprivate func deliver(_ event: BluetoothCentralEvent) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.onEvent?(event) }
        }
    }
}

/// A Zebra (by default the office ZD421) behind the fake central: its parser service, Device
/// Information, the writes it was sent, and acknowledgments, indications and drops on demand.
@MainActor
final class FakePeripheral: BluetoothPeripheral {
    enum ConnectBehavior {
        case answer
        case silent
        case fail(Error)
    }

    let identifier: UUID
    var name: String?
    var maximumWriteLength = 244
    var connectBehavior = ConnectBehavior.answer
    var hasZebraService = true
    /// Device Information values by characteristic UUID.
    var deviceInfo: [String: String]
    /// Each time its services are asked for, the next of these drops the link (before Ready).
    var dropsOnDiscover: [Error] = []
    /// Device Information characteristics whose reads fail (an ATT error).
    var failingReads: Set<String> = []
    /// Acknowledges each write at once; when off the test acknowledges with `ack()`.
    var autoAck = true

    fileprivate(set) var isConnected = false
    fileprivate(set) weak var central: FakeBluetoothCentral?
    private(set) var writes: [Data] = []
    /// Writes that arrived while an earlier one was still unacknowledged (must stay 0).
    private(set) var overlapping = 0
    private(set) var notifying = false
    private var unacked = 0
    private var discovered = false

    init(id: UUID = UUID(), name: String? = nil, serial: String = "D8J224508535", manufacturer: String = "Zebra Technologies") {
        identifier = id
        self.name = name ?? serial
        deviceInfo = [
            ZebraBluetoothSpec.manufacturerUUID: manufacturer,
            ZebraBluetoothSpec.modelUUID: "ZD421",
            ZebraBluetoothSpec.serialUUID: serial,
            ZebraBluetoothSpec.firmwareUUID: "V93.21.38Z",
            ZebraBluetoothSpec.linkOsUUID: "7.3",
        ]
    }

    /// Every byte written, in order.
    var written: Data { writes.reduce(into: Data()) { $0.append($1) } }

    var serviceUUIDs: [String] {
        guard discovered else { return [] }
        return (hasZebraService ? [ZebraBluetoothSpec.serviceUUID] : []) + [ZebraBluetoothSpec.deviceInfoUUID]
    }

    func characteristicUUIDs(ofService service: String) -> [String] {
        switch service {
        case ZebraBluetoothSpec.serviceUUID: [ZebraBluetoothSpec.fromPrinterUUID, ZebraBluetoothSpec.toPrinterUUID]
        case ZebraBluetoothSpec.deviceInfoUUID: deviceInfo.keys.sorted()
        default: []
        }
    }

    func discoverServices(_ services: [String]) {
        if !dropsOnDiscover.isEmpty {
            drop(dropsOnDiscover.removeFirst())
            return
        }
        discovered = true
        central?.deliver(.discoveredServices(self, nil))
    }

    func discoverCharacteristics(ofService service: String) {
        central?.deliver(.discoveredCharacteristics(self, service: service, nil))
    }

    func readValue(service: String, characteristic: String) {
        if failingReads.contains(characteristic) {
            central?.deliver(.updatedValue(self, characteristic: characteristic, nil, NSError(domain: CBATTErrorDomain, code: 5)))
            return
        }
        central?.deliver(.updatedValue(self, characteristic: characteristic, deviceInfo[characteristic].map { Data($0.utf8) }, nil))
    }

    func setNotify(_ enabled: Bool, service: String, characteristic: String) {
        notifying = enabled
        central?.deliver(.updatedNotificationState(self, characteristic: characteristic, isNotifying: enabled, nil))
    }

    func writeWithResponse(_ data: Data, service: String, characteristic: String) {
        if unacked > 0 { overlapping += 1 }
        writes.append(data)
        unacked += 1
        if autoAck { ack() }
    }

    /// Acknowledges the oldest unacknowledged write.
    func ack(error: Error? = nil) {
        guard unacked > 0 else { return }
        unacked -= 1
        central?.deliver(.wroteValue(self, characteristic: ZebraBluetoothSpec.toPrinterUUID, error))
    }

    /// One indication on From Printer Data.
    func indicate(_ text: String) {
        central?.deliver(.updatedValue(self, characteristic: ZebraBluetoothSpec.fromPrinterUUID, Data(text.utf8), nil))
    }

    /// The printer (or the radio) drops the link.
    func drop(_ error: Error) {
        isConnected = false
        notifying = false
        central?.deliver(.disconnected(self, error))
    }
}

/// A CoreBluetooth error as CoreBluetooth reports it (14 `peerRemovedPairingInformation`,
/// 15 `encryptionTimedOut`, 7 `peripheralDisconnected`).
func cbError(_ code: Int) -> NSError { NSError(domain: CBErrorDomain, code: code) }
