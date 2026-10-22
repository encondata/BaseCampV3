import Foundation

/// Zebra's resident fonts: built into the printer, so never downloaded or pushed to it (the
/// kiosk font route refuses them). Mirrors RESIDENT_FONTS in kiosk/src/lib/stationPrinter.ts.
let RESIDENT_FONTS: [String] = ["TT0003M_.TTF"]

/// A resident font, by the library's `resident` flag or by its printer object name.
func isResidentFont(_ name: String, residentFlag: Bool = false) -> Bool {
    residentFlag || RESIDENT_FONTS.contains(name.uppercased())
}
