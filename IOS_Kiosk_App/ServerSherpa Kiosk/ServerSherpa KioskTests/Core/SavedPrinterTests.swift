import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// A saved printer's connection: network (today's `host`) or Bluetooth, the JSON that keeps a
/// printer saved before Bluetooth loading as it was, and the copy that names the connection.
struct SavedPrinterTests {
    private let network = SavedPrinter(host: "10.0.0.5", model: "ZD421", serial: "X", dpi: 203)
    private let bluetooth = SavedPrinter(
        connection: .bluetooth(serial: "D8J224508535", peripheralId: UUID(uuidString: "6F1A3C52-2D4B-4C6E-9B71-0A5E8D3F4C21")),
        model: "ZD421", serial: "D8J224508535", dpi: 300)

    // MARK: JSON

    @Test func oldSavedPrinterLoadsAsNetwork() throws {
        let json = #"{"printer":{"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203},"offsetX":3}"#
        let options = try JSONDecoder().decode(LabelOptions.self, from: Data(json.utf8))
        #expect(options.printer?.connection == .network(host: "10.0.0.5"))
        #expect(options.printer == network)
        #expect(options.offsetX == 3)
    }

    @Test func networkPrinterRoundTrips() throws {
        let data = try JSONEncoder().encode(network)
        #expect(try JSONDecoder().decode(SavedPrinter.self, from: data) == network)
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(text.contains(#""type":"network""#))
        #expect(text.contains(#""host":"10.0.0.5""#))
    }

    @Test func bluetoothPrinterRoundTrips() throws {
        let data = try JSONEncoder().encode(bluetooth)
        #expect(try JSONDecoder().decode(SavedPrinter.self, from: data) == bluetooth)
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(text.contains(#""type":"bluetooth""#))
        // an older build still decodes it: `host` is there, blank
        #expect(text.contains(#""host":"""#))
    }

    @Test func aBluetoothPrinterNotYetSeenByThisIPadRoundTrips() throws {
        let unseen = SavedPrinter(connection: .bluetooth(serial: "D8J224508535", peripheralId: nil), model: "ZD421", serial: "D8J224508535", dpi: 300)
        let data = try JSONEncoder().encode(unseen)
        #expect(try JSONDecoder().decode(SavedPrinter.self, from: data) == unseen)
    }

    @Test func aPrinterWithoutAConnectionOrHostDoesNotDecode() {
        let json = #"{"model":"ZD421","serial":"X","dpi":203}"#
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(SavedPrinter.self, from: Data(json.utf8)) }
    }

    @Test func theConnectionWinsOverTheHostItAlsoCarries() throws {
        let json = #"{"connection":{"type":"bluetooth","serial":"D8J224508535"},"host":"","model":"ZD421","serial":"D8J224508535","dpi":300}"#
        let printer = try JSONDecoder().decode(SavedPrinter.self, from: Data(json.utf8))
        #expect(printer.connection == .bluetooth(serial: "D8J224508535", peripheralId: nil))
    }

    @Test func labelOptionsKeepTheirTolerantDecodingWithABluetoothPrinter() throws {
        let options = LabelOptions(printer: bluetooth, offsetX: -4, offsetY: 7, peel: true)
        let back = try JSONDecoder().decode(LabelOptions.self, from: JSONEncoder().encode(options))
        #expect(back == options)
        #expect(try JSONDecoder().decode(LabelOptions.self, from: Data("{}".utf8)) == LabelOptions())
    }

    // MARK: accessors

    @Test func hostAndIsBluetoothFollowTheConnection() {
        #expect(network.host == "10.0.0.5")
        #expect(!network.isBluetooth)
        #expect(bluetooth.host == nil)
        #expect(bluetooth.isBluetooth)
        #expect(SavedPrinter(connection: .network(host: "10.0.0.5"), model: "ZD421", serial: "X", dpi: 203) == network)
    }

    // MARK: copy

    @Test func summaryNamesTheConnection() {
        #expect(printerSummary(network) == "ZD421 at 10.0.0.5 · 203 dpi")
        #expect(printerSummary(bluetooth) == "ZD421 · Bluetooth D8J224508535 · 300 dpi")
        #expect(printerSummary(SavedPrinter(host: "10.0.0.5", model: "  ", serial: "", dpi: 300)) == "Zebra at 10.0.0.5 · 300 dpi")
        var blank = bluetooth
        blank.model = ""
        #expect(printerSummary(blank) == "Zebra · Bluetooth D8J224508535 · 300 dpi")
    }

    @Test func unreachableTextNamesTheConnection() {
        #expect(printerUnreachableText(network) == "Can't reach the printer at 10.0.0.5.")
        #expect(printerUnreachableText(bluetooth) == "Can't reach the printer D8J224508535 over Bluetooth.")
        #expect(noZebraAnswerText(.network(host: "10.0.0.5")) == "No Zebra printer answered at 10.0.0.5.")
        #expect(noZebraAnswerText(.bluetooth(serial: "D8J224508535", peripheralId: nil)) == "No Zebra printer answered over Bluetooth as D8J224508535.")
    }
}
