import Testing
import UIKit
@testable import ServerSherpa_Kiosk

struct QrTests {
    /// "HELLO" at correction level M is a version-1 symbol: 21 modules plus
    /// Core Image's one-module quiet zone on each side.
    @Test func imageIsModulesTimesScale() throws {
        let image = try #require(Qr.image(for: "HELLO", scale: 4))
        let cg = try #require(image.cgImage)
        #expect(cg.width == 23 * 4)
        #expect(cg.height == 23 * 4)
    }

    @Test func aLongerLinkStillRenders() throws {
        let image = try #require(Qr.image(for: "https://portal.dev.serversherpa.com/link/ABCD1234", scale: 6))
        let cg = try #require(image.cgImage)
        #expect(cg.width == cg.height)
        #expect(cg.width % 6 == 0)
    }
}
