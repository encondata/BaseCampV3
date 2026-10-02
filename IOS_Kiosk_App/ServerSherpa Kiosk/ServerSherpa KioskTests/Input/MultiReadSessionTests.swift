import Testing
@testable import ServerSherpa_Kiosk

struct MultiReadSessionTests {
    @Test func eachDistinctValueOnceNewestFirstCapped() {
        let s = MultiReadSession()
        #expect(s.offer("A")); #expect(!s.offer("A")); #expect(s.offer(" B "))
        for i in 1...10 { _ = s.offer("V\(i)") }
        #expect(s.count == 12)
        #expect(s.recent == ["V10", "V9", "V8", "V7", "V6"])
        #expect(!s.offer(""))
    }
}
