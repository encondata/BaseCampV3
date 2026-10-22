import CoreBluetooth
import Foundation

// The thin seam between the Bluetooth printer link (`ZebraBluetooth`) and CoreBluetooth: what
// the link asks of a central and a peripheral, and what they tell it back, as events in the order
// they happened. Services and characteristics are named by their UUID strings as
// `CBUUID.uuidString` gives them (upper-case; the short form for the 16-bit standard ones), the
// way `ZebraBluetoothSpec` spells them. The real adapters run on the main queue, as the spike on
// branch ble-spike did; the tests' fakes implement the same protocols.

/// The central's state (`CBManagerState`).
enum BluetoothCentralState: Equatable, Sendable {
    case unknown, resetting, unsupported, unauthorized, poweredOff, poweredOn
}

/// What CoreBluetooth reported, delivered on the main actor in order.
enum BluetoothCentralEvent: Sendable {
    case stateChanged(BluetoothCentralState)
    /// An advertisement while scanning: the advertised name (else the peripheral's), its signal,
    /// and whether it advertises Zebra's parser service or Zebra's company UUID.
    case discovered(any BluetoothPeripheral, name: String?, rssi: Int, advertisesZebra: Bool)
    case connected(any BluetoothPeripheral)
    case failedToConnect(any BluetoothPeripheral, Error?)
    case disconnected(any BluetoothPeripheral, Error?)
    case discoveredServices(any BluetoothPeripheral, Error?)
    case discoveredCharacteristics(any BluetoothPeripheral, service: String, Error?)
    /// A read answered, or an indication arrived.
    case updatedValue(any BluetoothPeripheral, characteristic: String, Data?, Error?)
    /// A write with response was acknowledged (or failed).
    case wroteValue(any BluetoothPeripheral, characteristic: String, Error?)
    case updatedNotificationState(any BluetoothPeripheral, characteristic: String, isNotifying: Bool, Error?)
}

/// Makes the one central, on first use only: creating a `CBCentralManager` is what makes iOS ask
/// for Bluetooth permission (D11).
@MainActor
protocol BluetoothCentralClient: AnyObject {
    func makeCentral(onEvent: @escaping @MainActor (BluetoothCentralEvent) -> Void) -> any BluetoothCentral
}

/// What the link needs from `CBCentralManager`.
@MainActor
protocol BluetoothCentral: AnyObject {
    var state: BluetoothCentralState { get }
    /// Every device nearby, duplicates included (so signal strength stays current).
    func scan()
    func stopScan()
    func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [any BluetoothPeripheral]
    func connect(_ peripheral: any BluetoothPeripheral)
    func cancelConnection(_ peripheral: any BluetoothPeripheral)
}

/// What the link needs from `CBPeripheral`. A call naming a service or characteristic that was
/// never discovered does nothing.
@MainActor
protocol BluetoothPeripheral: AnyObject, Sendable {
    /// The iPad's own identifier for the device (iOS never shows its address).
    var identifier: UUID { get }
    var name: String? { get }
    /// `maximumWriteValueLength(for: .withoutResponse)`: one ATT packet, the chunk size (D5).
    var maximumWriteLength: Int { get }
    /// The services discovered so far.
    var serviceUUIDs: [String] { get }
    func characteristicUUIDs(ofService service: String) -> [String]
    func discoverServices(_ services: [String])
    func discoverCharacteristics(ofService service: String)
    func readValue(service: String, characteristic: String)
    func setNotify(_ enabled: Bool, service: String, characteristic: String)
    func writeWithResponse(_ data: Data, service: String, characteristic: String)
}

/// CBError 14 (the printer removed its pairing with this iPad) or 15 (pairing didn't finish):
/// retrying can't help until the user forgets the printer in Settings (D10).
func isBluetoothPairingLost(_ error: Error?) -> Bool {
    guard let error = error as NSError?, error.domain == CBErrorDomain else { return false }
    return error.code == CBError.Code.peerRemovedPairingInformation.rawValue
        || error.code == CBError.Code.encryptionTimedOut.rawValue
}

/// Why a link ended, for the connection details (`BluetoothDrop.reason`).
func describeBluetoothError(_ error: Error?) -> String {
    guard let error = error as NSError? else { return "The link closed" }
    return "\(error.localizedDescription) (\(error.domain) \(error.code))"
}

// MARK: CoreBluetooth

/// The real client: one `CBCentralManager` on the main queue.
@MainActor
final class CoreBluetoothClient: BluetoothCentralClient {
    func makeCentral(onEvent: @escaping @MainActor (BluetoothCentralEvent) -> Void) -> any BluetoothCentral {
        CoreBluetoothCentral(onEvent: onEvent)
    }
}

/// `CBCentralManager` (main queue) and the delegate of it and of every peripheral it hands out.
/// It keeps no peripherals itself: the link holds the one it uses.
@MainActor
final class CoreBluetoothCentral: NSObject, BluetoothCentral {
    private let onEvent: @MainActor (BluetoothCentralEvent) -> Void
    // The app says when Bluetooth is off itself (D11), so iOS's own alert stays away.
    private lazy var manager = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])

    init(onEvent: @escaping @MainActor (BluetoothCentralEvent) -> Void) {
        self.onEvent = onEvent
        super.init()
        _ = manager
    }

    var state: BluetoothCentralState { centralState(manager.state) }

    func scan() {
        manager.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    func stopScan() { manager.stopScan() }

    func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [any BluetoothPeripheral] {
        manager.retrievePeripherals(withIdentifiers: identifiers).map(wrap)
    }

    func connect(_ peripheral: any BluetoothPeripheral) {
        guard let cb = (peripheral as? CoreBluetoothPeripheral)?.peripheral else { return }
        manager.connect(cb, options: nil)
    }

    func cancelConnection(_ peripheral: any BluetoothPeripheral) {
        guard let cb = (peripheral as? CoreBluetoothPeripheral)?.peripheral else { return }
        manager.cancelPeripheralConnection(cb)
    }

    fileprivate func wrap(_ peripheral: CBPeripheral) -> any BluetoothPeripheral {
        peripheral.delegate = self
        return CoreBluetoothPeripheral(peripheral)
    }
}

// Delegate callbacks arrive on the main queue (the manager's queue is nil): each hops onto the
// main actor synchronously.
extension CoreBluetoothCentral: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = centralState(central.state)
        MainActor.assumeIsolated { onEvent(.stateChanged(state)) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advertised = (advertisementData[CBAdvertisementDataLocalNameKey] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let name = advertised ?? peripheral.name
        let zebra = advertisesZebra(advertisementData)
        let rssi = RSSI.intValue
        MainActor.assumeIsolated { onEvent(.discovered(wrap(peripheral), name: name, rssi: rssi, advertisesZebra: zebra)) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated { onEvent(.connected(wrap(peripheral))) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated { onEvent(.failedToConnect(wrap(peripheral), error)) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated { onEvent(.disconnected(wrap(peripheral), error)) }
    }
}

extension CoreBluetoothCentral: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated { onEvent(.discoveredServices(wrap(peripheral), error)) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let uuid = service.uuid.uuidString
        MainActor.assumeIsolated { onEvent(.discoveredCharacteristics(wrap(peripheral), service: uuid, error)) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let uuid = characteristic.uuid.uuidString
        let value = characteristic.value
        MainActor.assumeIsolated { onEvent(.updatedValue(wrap(peripheral), characteristic: uuid, value, error)) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let uuid = characteristic.uuid.uuidString
        MainActor.assumeIsolated { onEvent(.wroteValue(wrap(peripheral), characteristic: uuid, error)) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let uuid = characteristic.uuid.uuidString
        let notifying = characteristic.isNotifying
        MainActor.assumeIsolated {
            onEvent(.updatedNotificationState(wrap(peripheral), characteristic: uuid, isNotifying: notifying, error))
        }
    }
}

/// One `CBPeripheral`. Services and characteristics are looked up among those discovered.
@MainActor
final class CoreBluetoothPeripheral: BluetoothPeripheral {
    let peripheral: CBPeripheral

    init(_ peripheral: CBPeripheral) {
        self.peripheral = peripheral
    }

    var identifier: UUID { peripheral.identifier }
    var name: String? { peripheral.name }
    var maximumWriteLength: Int { peripheral.maximumWriteValueLength(for: .withoutResponse) }
    var serviceUUIDs: [String] { peripheral.services?.map(\.uuid.uuidString) ?? [] }

    func characteristicUUIDs(ofService service: String) -> [String] {
        self.service(service)?.characteristics?.map(\.uuid.uuidString) ?? []
    }

    func discoverServices(_ services: [String]) {
        peripheral.discoverServices(services.map { CBUUID(string: $0) })
    }

    func discoverCharacteristics(ofService service: String) {
        guard let found = self.service(service) else { return }
        peripheral.discoverCharacteristics(nil, for: found)
    }

    func readValue(service: String, characteristic: String) {
        guard let found = self.characteristic(characteristic, of: service) else { return }
        peripheral.readValue(for: found)
    }

    func setNotify(_ enabled: Bool, service: String, characteristic: String) {
        guard let found = self.characteristic(characteristic, of: service) else { return }
        peripheral.setNotifyValue(enabled, for: found)
    }

    func writeWithResponse(_ data: Data, service: String, characteristic: String) {
        guard let found = self.characteristic(characteristic, of: service) else { return }
        peripheral.writeValue(data, for: found, type: .withResponse)
    }

    private func service(_ uuid: String) -> CBService? {
        let id = CBUUID(string: uuid)
        return peripheral.services?.first { $0.uuid == id }
    }

    private func characteristic(_ uuid: String, of service: String) -> CBCharacteristic? {
        let id = CBUUID(string: uuid)
        return self.service(service)?.characteristics?.first { $0.uuid == id }
    }
}

private func centralState(_ state: CBManagerState) -> BluetoothCentralState {
    switch state {
    case .poweredOn: .poweredOn
    case .poweredOff: .poweredOff
    case .unauthorized: .unauthorized
    case .unsupported: .unsupported
    case .resetting: .resetting
    case .unknown: .unknown
    @unknown default: .unknown
    }
}

/// Whether an advertisement names Zebra's parser service or Zebra's Bluetooth SIG company UUID
/// (FE79). A ZD421 advertises neither (only its name), so the serial-shaped name is the main flag.
private func advertisesZebra(_ advertisement: [String: Any]) -> Bool {
    let zebra = [CBUUID(string: ZebraBluetoothSpec.serviceUUID), CBUUID(string: "FE79")]
    let keys = [CBAdvertisementDataServiceUUIDsKey, CBAdvertisementDataOverflowServiceUUIDsKey, CBAdvertisementDataSolicitedServiceUUIDsKey]
    for key in keys where ((advertisement[key] as? [CBUUID]) ?? []).contains(where: zebra.contains) {
        return true
    }
    let serviceData = (advertisement[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data]) ?? [:]
    return serviceData.keys.contains(where: zebra.contains)
}
