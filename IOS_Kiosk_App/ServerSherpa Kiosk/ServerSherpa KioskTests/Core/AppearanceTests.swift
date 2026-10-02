import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct AppearanceTests {
    @Test func defaults() {
        #expect(DEFAULT_APPEARANCE.goodScan == Hsl(h: 150, s: 60, l: 45))
        #expect(DEFAULT_APPEARANCE.notFoundScan == Hsl(h: 0, s: 70, l: 50))
        #expect(DEFAULT_APPEARANCE.duplicateScan == Hsl(h: 38, s: 92, l: 50))
        #expect(DEFAULT_APPEARANCE.flashMs == 350)
    }

    @Test func parsePerFieldFallback() {
        let a = parseAppearance(#"{"good_scan":{"h":10,"s":20,"l":30},"not_found_scan":{"h":999,"s":1,"l":1},"flash_ms":5000}"#)
        #expect(a.goodScan == Hsl(h: 10, s: 20, l: 30))
        #expect(a.notFoundScan == DEFAULT_APPEARANCE.notFoundScan)   // out of range -> default
        #expect(a.duplicateScan == DEFAULT_APPEARANCE.duplicateScan) // missing -> default
        #expect(a.flashMs == 2000)                                   // clamped
        #expect(parseAppearance(nil) == DEFAULT_APPEARANCE)
        #expect(parseAppearance("not json") == DEFAULT_APPEARANCE)
    }

    @Test func roundTrip() {
        var a = DEFAULT_APPEARANCE
        a.flashMs = 700
        a.goodScan = Hsl(h: 1, s: 2, l: 3)
        #expect(parseAppearance(a.toJSON()) == a)
    }

    @Test func jsonUsesTheSharedKeys() {
        let obj = (try? JSONSerialization.jsonObject(with: Data(DEFAULT_APPEARANCE.toJSON().utf8))) as? [String: Any]
        #expect(Set(obj?.keys ?? [:].keys) == ["good_scan", "not_found_scan", "duplicate_scan", "flash_ms"])
        #expect(obj?["flash_ms"] as? Int == 350)
    }

    @Test func hslConversion() {
        func rgb255(_ h: Hsl) -> [Int] {
            let c = hslToRGB(h)
            return [c.r, c.g, c.b].map { Int(($0 * 255).rounded()) }
        }
        #expect(rgb255(Hsl(h: 150, s: 60, l: 45)) == [0x2E, 0xB8, 0x73])
        #expect(rgb255(Hsl(h: 0, s: 70, l: 50)) == [0xD9, 0x26, 0x26])
        #expect(hslCss(Hsl(h: 150, s: 60, l: 45)) == "hsl(150 60% 45%)")
    }

    @Test func clamp() {
        #expect(clampFlashMs(3) == 100)
        #expect(clampFlashMs(99999) == 2000)
        #expect(clampFlashMs(nil) == 350)
    }

    @Test func quotedNumbersAreNotNumbers() {
        let a = parseAppearance(#"{"good_scan":{"h":"10","s":"20","l":"30"},"flash_ms":"900"}"#)
        #expect(a.goodScan == DEFAULT_APPEARANCE.goodScan)
        #expect(a.flashMs == DEFAULT_APPEARANCE.flashMs)
    }

    @Test func booleansAreNotNumbers() {
        #expect(parseAppearance(#"{"flash_ms":true}"#).flashMs == 350)
    }
}
