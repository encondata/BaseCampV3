import Foundation

struct Hsl: Equatable, Sendable {
    var h: Double
    var s: Double
    var l: Double
}

/// The three scan flashes and their duration — kiosk-local.
struct Appearance: Equatable, Sendable {
    var goodScan: Hsl
    var notFoundScan: Hsl
    var duplicateScan: Hsl
    var flashMs: Int
}

let FLASH_MS_MIN = 100
let FLASH_MS_MAX = 2000
let FLASH_MS_STEP = 50

let DEFAULT_APPEARANCE = Appearance(
    goodScan: Hsl(h: 150, s: 60, l: 45),
    notFoundScan: Hsl(h: 0, s: 70, l: 50),
    duplicateScan: Hsl(h: 38, s: 92, l: 50),
    flashMs: 350
)

func clampFlashMs(_ value: Int?) -> Int {
    guard let value else { return DEFAULT_APPEARANCE.flashMs }
    return min(max(value, FLASH_MS_MIN), FLASH_MS_MAX)
}

/// A JSON number only — a quoted "10" or a boolean is not a number, exactly as the web's typeof check says.
func jsonNumber(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
}

/// Kotlin `roundToInt`: half rounds up, saturating at the Int range.
private func roundToInt(_ x: Double) -> Int {
    let r = (x + 0.5).rounded(.down)
    if r >= Double(Int32.max) { return Int(Int32.max) }
    if r <= Double(Int32.min) { return Int(Int32.min) }
    return Int(r)
}

private func hslOf(_ v: Any?) -> Hsl? {
    guard let obj = v as? [String: Any],
          let h = jsonNumber(obj["h"]), let s = jsonNumber(obj["s"]), let l = jsonNumber(obj["l"])
    else { return nil }
    guard (0...360).contains(h), (0...100).contains(s), (0...100).contains(l) else { return nil }
    return Hsl(h: h, s: s, l: l)
}

/// Each channel falls back on its own, as appearance.ts does.
func parseAppearance(_ raw: String?) -> Appearance {
    guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let obj = (try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed])) as? [String: Any]
    else { return DEFAULT_APPEARANCE }
    return Appearance(
        goodScan: hslOf(obj["good_scan"]) ?? DEFAULT_APPEARANCE.goodScan,
        notFoundScan: hslOf(obj["not_found_scan"]) ?? DEFAULT_APPEARANCE.notFoundScan,
        duplicateScan: hslOf(obj["duplicate_scan"]) ?? DEFAULT_APPEARANCE.duplicateScan,
        flashMs: clampFlashMs(jsonNumber(obj["flash_ms"]).map(roundToInt))
    )
}

extension Appearance {
    /// Same keys and shape as Android's (and the web's) stored document.
    func toJSON() -> String {
        func obj(_ c: Hsl) -> [String: Any] { ["h": c.h, "s": c.s, "l": c.l] }
        let doc: [String: Any] = [
            "good_scan": obj(goodScan),
            "not_found_scan": obj(notFoundScan),
            "duplicate_scan": obj(duplicateScan),
            "flash_ms": flashMs,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

/// `hsl(150 60% 45%)` — the readout string the Appearance tab shows.
func hslCss(_ hsl: Hsl) -> String {
    "hsl(\(roundToInt(hsl.h)) \(roundToInt(hsl.s))% \(roundToInt(hsl.l))%)"
}

/// Opaque RGB, each channel 0…1 (same math as Android's `hslToArgb`).
func hslToRGB(_ hsl: Hsl) -> (r: Double, g: Double, b: Double) {
    let h = ((hsl.h.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)
    let s = min(max(hsl.s / 100, 0), 1)
    let l = min(max(hsl.l / 100, 0), 1)
    let c = (1 - abs(2 * l - 1)) * s
    let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
    let m = l - c / 2
    let (r1, g1, b1): (Double, Double, Double)
    switch h {
    case ..<60: (r1, g1, b1) = (c, x, 0)
    case ..<120: (r1, g1, b1) = (x, c, 0)
    case ..<180: (r1, g1, b1) = (0, c, x)
    case ..<240: (r1, g1, b1) = (0, x, c)
    case ..<300: (r1, g1, b1) = (x, 0, c)
    default: (r1, g1, b1) = (c, 0, x)
    }
    func ch(_ v: Double) -> Double { Double(min(max(roundToInt((v + m) * 255), 0), 255)) / 255 }
    return (ch(r1), ch(g1), ch(b1))
}
