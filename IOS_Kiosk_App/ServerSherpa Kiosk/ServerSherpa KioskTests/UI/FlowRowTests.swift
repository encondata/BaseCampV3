import CoreGraphics
import Testing
@testable import ServerSherpa_Kiosk

/// `FlowRow` (Android's FlowRow): items left to right, a new line when the next one doesn't fit.
struct FlowRowTests {
    @Test func fillsALineThenWraps() {
        #expect(flowLines([100, 100, 100], maxWidth: 320, spacing: 16) == [[0, 1], [2]])
        #expect(flowLines([100, 100, 100], maxWidth: 332, spacing: 16) == [[0, 1, 2]])
    }

    @Test func anItemWiderThanTheLineGetsItsOwn() {
        #expect(flowLines([50, 400, 50], maxWidth: 320, spacing: 8) == [[0], [1], [2]])
    }

    @Test func unboundedWidthIsOneLine() {
        #expect(flowLines([300, 300, 300], maxWidth: .infinity, spacing: 8) == [[0, 1, 2]])
        #expect(flowLines([], maxWidth: 320, spacing: 8) == [])
    }
}
