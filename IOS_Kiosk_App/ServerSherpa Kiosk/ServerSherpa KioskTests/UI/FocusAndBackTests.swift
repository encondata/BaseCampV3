import Testing
@testable import ServerSherpa_Kiosk

struct FocusAndBackTests {
    @Test func reclaimsOnlyWhenWantedUnfocusedAndNothingElseHoldsFocus() {
        #expect(shouldReclaimFocus(wantsFocus: true, isFocused: false, somethingElseHasFocus: false))
        #expect(!shouldReclaimFocus(wantsFocus: true, isFocused: false, somethingElseHasFocus: true))
        #expect(!shouldReclaimFocus(wantsFocus: true, isFocused: true, somethingElseHasFocus: false))
        #expect(!shouldReclaimFocus(wantsFocus: false, isFocused: false, somethingElseHasFocus: false))
    }

    @Test func backButtonShowsOnlyOnPushedScreens() {
        #expect(!showsBackButton(pathCount: 0))
        #expect(showsBackButton(pathCount: 1))
        #expect(showsBackButton(pathCount: 3))
    }
}
