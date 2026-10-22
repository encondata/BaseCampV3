import Foundation

/// What labels print on: the top or the front of the device. `wire` is the generator's `kind`.
enum LabelKind: String, CaseIterable, Sendable {
    case top, front

    var wire: String { rawValue }

    /// Anything unknown (a selection saved before kinds existed) reads as Top.
    static func fromWire(_ value: String?) -> LabelKind {
        value.flatMap(LabelKind.init(rawValue:)) ?? .top
    }
}

/// How the iPad reaches its printer: a network host (TCP port 9100), or Bluetooth LE by the
/// printer's serial (its Bluetooth name) plus this iPad's own identifier for it, which iOS hands
/// out once the printer has been found (nil until then).
enum PrinterConnection: Hashable, Sendable {
    case network(host: String)
    case bluetooth(serial: String, peripheralId: UUID?)
}

/// Which printer a connection reaches, whatever the way: the network host, or the Bluetooth serial
/// (in any case). The iPad's identifier for a Bluetooth printer only finds it, and iOS can give it
/// another one, so it isn't part of it (Ruling 7).
enum PrinterIdentity: Hashable, Sendable {
    case network(host: String)
    case bluetooth(serial: String)
}

extension PrinterConnection {
    var identity: PrinterIdentity {
        switch self {
        case .network(let host): .network(host: host)
        case .bluetooth(let serial, _): .bluetooth(serial: serial.uppercased())
        }
    }
}

extension PrinterConnection: Codable {
    private enum CodingKeys: String, CodingKey { case type, host, serial, peripheralId }
    private enum Kind: String { case network, bluetooth }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch Kind(rawValue: type) {
        case .network:
            self = .network(host: try c.decode(String.self, forKey: .host))
        case .bluetooth:
            self = .bluetooth(serial: try c.decode(String.self, forKey: .serial),
                              peripheralId: try c.decodeIfPresent(UUID.self, forKey: .peripheralId))
        case nil:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown printer connection \(type)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .network(let host):
            try c.encode(Kind.network.rawValue, forKey: .type)
            try c.encode(host, forKey: .host)
        case .bluetooth(let serial, let peripheralId):
            try c.encode(Kind.bluetooth.rawValue, forKey: .type)
            try c.encode(serial, forKey: .serial)
            try c.encodeIfPresent(peripheralId, forKey: .peripheralId)
        }
    }
}

/// The Zebra labels print to; its `dpi` picks the template.
///
/// Saved as JSON with `connection` and, for a build from before Bluetooth, the old `host` beside it
/// (the network host, or `""` for a Bluetooth printer). A printer saved before Bluetooth has only
/// `host`, and reads back as a network printer.
struct SavedPrinter: Codable, Equatable, Sendable {
    var connection: PrinterConnection
    var model: String
    var serial: String
    var dpi: Int

    /// A network printer at `host`.
    init(host: String, model: String, serial: String, dpi: Int) {
        self.init(connection: .network(host: host), model: model, serial: serial, dpi: dpi)
    }

    init(connection: PrinterConnection, model: String, serial: String, dpi: Int) {
        self.connection = connection
        self.model = model
        self.serial = serial
        self.dpi = dpi
    }

    /// The network host; nil for a Bluetooth printer.
    var host: String? {
        if case .network(let host) = connection { host } else { nil }
    }

    var isBluetooth: Bool {
        if case .bluetooth = connection { true } else { false }
    }

    private enum CodingKeys: String, CodingKey { case connection, host, model, serial, dpi }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if c.contains(.connection) {
            connection = try c.decode(PrinterConnection.self, forKey: .connection)
        } else {
            connection = .network(host: try c.decode(String.self, forKey: .host))
        }
        model = try c.decode(String.self, forKey: .model)
        serial = try c.decode(String.self, forKey: .serial)
        dpi = try c.decode(Int.self, forKey: .dpi)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(connection, forKey: .connection)
        try c.encode(host ?? "", forKey: .host)
        try c.encode(model, forKey: .model)
        try c.encode(serial, forKey: .serial)
        try c.encode(dpi, forKey: .dpi)
    }
}

/// The label settings: `kind` picks the template (with the printer's DPI); offsets (dots) and
/// `peel` are applied only when a label is sent, so they never change a stored label.
struct LabelSettings: Equatable, Sendable {
    var kind: LabelKind = .top
    var printer: SavedPrinter? = nil
    var offsetX: Int = 0
    var offsetY: Int = 0
    var peel: Bool = false
}

/// The label settings that live under the `ss.kiosk.labels` key: everything in `LabelSettings`
/// except the kind, which is saved with the Kiosk Setup selection.
struct LabelOptions: Codable, Equatable, Sendable {
    var printer: SavedPrinter? = nil
    var offsetX: Int = 0
    var offsetY: Int = 0
    var peel: Bool = false

    init(printer: SavedPrinter? = nil, offsetX: Int = 0, offsetY: Int = 0, peel: Bool = false) {
        self.printer = printer
        self.offsetX = offsetX
        self.offsetY = offsetY
        self.peel = peel
    }

    /// A member missing from the saved JSON takes its default, as on Android.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        printer = try c.decodeIfPresent(SavedPrinter.self, forKey: .printer)
        offsetX = c.contains(.offsetX) ? try c.decode(Int.self, forKey: .offsetX) : 0
        offsetY = c.contains(.offsetY) ? try c.decode(Int.self, forKey: .offsetY) : 0
        peel = c.contains(.peel) ? try c.decode(Bool.self, forKey: .peel) : false
    }
}
