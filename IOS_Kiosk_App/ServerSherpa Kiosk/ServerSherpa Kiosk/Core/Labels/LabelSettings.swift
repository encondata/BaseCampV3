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

/// The network Zebra labels print to; its `dpi` picks the template.
struct SavedPrinter: Codable, Equatable, Sendable {
    var host: String
    var model: String
    var serial: String
    var dpi: Int
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
