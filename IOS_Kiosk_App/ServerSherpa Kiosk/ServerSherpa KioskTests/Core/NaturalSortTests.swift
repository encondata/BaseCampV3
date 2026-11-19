import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// Android NaturalSortTest, case for case.
struct NaturalSortTests {
    @Test func numbersByValue() {
        #expect(naturalCompare("Rack 2", "Rack 10") < 0)
        #expect(naturalCompare("a10", "a9") > 0)
        #expect(naturalCompare("a1", "a01") < 0)
        #expect(naturalCompare("a1", "a1") == 0)
    }

    @Test func caseIgnored() {
        #expect(naturalCompare("ABC", "abc") == 0)
        #expect(naturalCompare("apple", "Banana") < 0)
    }

    @Test func nullsFirst() {
        #expect(naturalCompare(nil, "a") < 0)
        #expect(naturalCompare(nil, "") == 0)
        #expect(naturalCompare("a", nil) > 0)
    }

    /// A longer string with the same start sorts after; equal values with more leading zeros
    /// sort after, decided only once the rest ties.
    @Test func prefixesAndLeadingZeros() {
        #expect(naturalCompare("Rack", "Rack 1") < 0)
        #expect(naturalCompare("a01b", "a1c") < 0)
        #expect(naturalCompare("a001", "a01") > 0)
    }
}
