import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// kiosk/src/timeclock/OnScreenKeyboard.test.tsx: the layout and the capitals. The
/// key presses themselves go through the flow model (TimeclockFlowModelTests).
struct TcOnScreenKeyboardTests {
    private func names(_ symbols: Bool) -> [String] {
        tcKeyboardRows(symbols: symbols).map { $0.map(\.name).joined(separator: " ") }
    }

    @Test func laysOutTheQwertyRowsWithShiftBackspace123SpaceAndSearch() {
        #expect(names(false) == [
            "Q W E R T Y U I O P",
            "A S D F G H J K L",
            "Shift Z X C V B N M Backspace",
            "Numbers Space Search",
        ])
        #expect(TcKey.numbers.label == "123")
        #expect(TcKey.letters.label == "ABC")
    }

    @Test func the123LayerHasDigitsAndNamePunctuation() {
        #expect(names(true) == [
            "1 2 3 4 5 6 7 8 9 0",
            "- ' . , & @ Backspace",
            "Letters Space Search",
        ])
    }

    @Test func typesACapitalAtTheStartOfAWordAndLowerCaseAfterIt() {
        #expect(tcLetterText("T", value: "", shift: false) == "T")
        #expect(tcLetterText("I", value: "T", shift: false) == "i")
        #expect(tcLetterText("N", value: "Tina ", shift: false) == "N")
        #expect(tcLetterText("Q", value: "ab", shift: true) == "Q")
    }
}
