import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct AccessTests {
    @Test func computeCanReadsTheNestedMap() {
        let perms = ["kiosk": ["view": true, "add": false]]
        #expect(computeCan(perms, "kiosk", "view"))
        #expect(!computeCan(perms, "kiosk", "add"))
        #expect(!computeCan(perms, "labels", "view"))
        #expect(!computeCan(nil, "kiosk", "view"))
    }

    @Test func adminRankIsSixty() { #expect(ADMIN_RANK == 60) }
}
