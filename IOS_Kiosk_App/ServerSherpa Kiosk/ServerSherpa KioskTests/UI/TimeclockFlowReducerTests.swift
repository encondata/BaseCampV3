import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// kiosk/src/timeclock/flow.test.ts, case for case.
struct TimeclockFlowReducerTests {
    private static let OFF = KioskTimeclockStatus(person: KioskTimeclockPerson(id: "p-1", displayName: "Alex Worker"), clockedIn: false)
    private static let ON: KioskTimeclockStatus = { var s = OFF; s.clockedIn = true; return s }()

    private let NETWORK = "Can't reach the portal. Your punch was not recorded. Try again."
    private let OTHER = "Something went wrong. Your punch was not recorded. Try again."
    private let CHANGED = "Your status changed. Please choose again."

    private func at(_ step: TcStep, mode: TcMode = .station, _ over: (inout TcState) -> Void = { _ in }) -> TcState {
        var s = tcInitialState(mode)
        s.step = step
        s.status = Self.OFF
        over(&s)
        return s
    }

    // MARK: constants

    @Test func pinsTheTimers() {
        #expect(TcTimers.idle == .seconds(20))
        #expect(TcTimers.done == .seconds(8))
        #expect(TcTimers.printing == .seconds(3))
        #expect(TcTimers.message == .seconds(5))
        #expect(TcTimers.scanQuiet == .milliseconds(1500))
        #expect(TcTimers.readTimeout == .seconds(10))
    }

    @Test func startsOnWelcomeInStationModeAndNameInKioskMode() {
        #expect(tcStartStep(.station) == .welcome)
        #expect(tcStartStep(.kiosk) == .name)
        #expect(tcInitialState(.station) == TcState(mode: .station, step: .welcome, status: nil, busy: false, error: nil, notice: nil, punched: nil))
        #expect(tcInitialState(.kiosk).step == .name)
    }

    // MARK: reducer

    @Test func enterNameGoesFromWelcomeToNameAndNowhereElse() {
        #expect(tcReduce(at(.welcome), .enterName).step == .name)
        let confirm = at(.confirm)
        #expect(tcReduce(confirm, .enterName) == confirm)
    }

    @Test func identifiedStoresTheStatusAndGoesToConfirmClearingErrorNoticeAndPunched() {
        let s = tcReduce(at(.name) { $0.error = "x"; $0.notice = "y"; $0.punched = .in; $0.busy = true }, .identified(Self.ON))
        #expect(s.step == .confirm)
        #expect(s.status == Self.ON)
        #expect(s.error == nil)
        #expect(s.notice == nil)
        #expect(s.punched == nil)
        #expect(s.busy == false)
    }

    @Test func confirmNoAndBackFromConfirmReturnToName() {
        #expect(tcReduce(at(.confirm), .confirmNo).step == .name)
        #expect(tcReduce(at(.confirm), .back).step == .name)
    }

    @Test func backFromNameGoesToWelcomeInStationModeAndIsANoOpInKioskMode() {
        #expect(tcReduce(at(.name), .back).step == .welcome)
        let kiosk = at(.name, mode: .kiosk)
        #expect(tcReduce(kiosk, .back) == kiosk)
    }

    @Test func confirmYesGoesToAction() {
        #expect(tcReduce(at(.confirm), .confirmYes).step == .action)
    }

    @Test func chooseOutGoesToClockOutOnlyWhenClockedIn() {
        #expect(tcReduce(at(.action) { $0.status = Self.ON }, .chooseOut).step == .clockOut)
        let off = at(.action)
        #expect(tcReduce(off, .chooseOut) == off)
    }

    @Test func chooseInWhenNotClockedInStaysOnActionAndGoesBusy() {
        let s = tcReduce(at(.action), .chooseIn)
        #expect(s.step == .action)
        #expect(s.busy)
    }

    @Test func chooseInIsIgnoredWhenAlreadyClockedIn() {
        let on = at(.action) { $0.status = Self.ON }
        #expect(tcReduce(on, .chooseIn) == on)
    }

    @Test func punchStartedSetsBusyAndClearsTheError() {
        let s = tcReduce(at(.clockOut) { $0.status = Self.ON; $0.error = "x" }, .punchStarted)
        #expect(s.step == .clockOut)
        #expect(s.busy)
        #expect(s.error == nil)
    }

    @Test func punchSucceededInGoesToBadgeOutGoesToDone() {
        let inn = tcReduce(at(.action) { $0.busy = true }, .punchSucceeded(Self.ON, .in))
        #expect(inn.step == .badge)
        #expect(inn.status == Self.ON)
        #expect(inn.punched == .in)
        #expect(inn.busy == false)
        #expect(inn.error == nil)
        let out = tcReduce(at(.clockOut) { $0.status = Self.ON; $0.busy = true }, .punchSucceeded(Self.OFF, .out))
        #expect(out.step == .done)
        #expect(out.status == Self.OFF)
        #expect(out.punched == .out)
        #expect(out.busy == false)
    }

    @Test(arguments: ["already_clocked_in", "not_clocked_in"])
    func punchFailedStatusChangedReturnsToActionWithANotice(code: String) {
        let s = tcReduce(at(.clockOut) { $0.status = Self.ON; $0.busy = true }, .punchFailed(code))
        #expect(s.step == .action)
        #expect(s.busy == false)
        #expect(s.notice == CHANGED)
        #expect(s.error == nil)
    }

    @Test func statusRefreshedReplacesTheStatusAndKeepsTheNotice() {
        let s = tcReduce(at(.action) { $0.notice = CHANGED }, .statusRefreshed(Self.ON))
        #expect(s.step == .action)
        #expect(s.status == Self.ON)
        #expect(s.notice == CHANGED)
        #expect(s.busy == false)
    }

    @Test(arguments: ["network", "edge_offline"])
    func punchFailedUnreachableSaysThePortalIsUnreachable(code: String) {
        let s = tcReduce(at(.action) { $0.busy = true }, .punchFailed(code))
        #expect(s.step == .action)
        #expect(s.busy == false)
        #expect(s.error == NETWORK)
    }

    @Test func punchFailedWithAnyOtherCodeIsTheGenericErrorAndStaysOnTheStep() {
        let s = tcReduce(at(.clockOut) { $0.status = Self.ON; $0.busy = true }, .punchFailed("boom"))
        #expect(s.step == .clockOut)
        #expect(s.busy == false)
        #expect(s.error == OTHER)
    }

    @Test(arguments: [
        ("cloud_sign_in_required", "Sign in again while online to do this."),
        ("read_only_mode", "The portal is in read-only mode. Your punch was not recorded. Try again shortly."),
    ])
    func punchFailedCodesWithTheirOwnMessage(code: String, text: String) {
        #expect(tcReduce(at(.action) { $0.busy = true }, .punchFailed(code)).error == text)
    }

    @Test func aGenericPunchFailedClearsAnEarlierNotice() {
        let s = tcReduce(at(.action) { $0.busy = true; $0.notice = CHANGED }, .punchFailed("network"))
        #expect(s.busy == false)
        #expect(s.error == NETWORK)
        #expect(s.notice == nil)
    }

    @Test func punchStartingEventsWhileBusyAreIgnoredSoADoubleTapNeverSendsTwoPunches() {
        let cases: [(TcEvent, TcState)] = [
            (.chooseIn, at(.action) { $0.busy = true }),
            (.chooseOut, at(.action) { $0.status = Self.ON; $0.busy = true }),
            (.punchStarted, at(.clockOut) { $0.status = Self.ON; $0.busy = true }),
        ]
        for (event, busy) in cases {
            #expect(tcReduce(busy, event) == busy)
        }
    }

    @Test func badgeBranches() {
        #expect(tcReduce(at(.badge), .badgeNew).step == .printing)
        #expect(tcReduce(at(.printing), .printingDone).step == .verify)
        #expect(tcReduce(at(.verify), .verifyContinue).step == .done)
        #expect(tcReduce(at(.badge), .badgeExisting).step == .done)
    }

    @Test func backFromActionGoesToConfirmAndFromClockOutToAction() {
        #expect(tcReduce(at(.action), .back).step == .confirm)
        #expect(tcReduce(at(.clockOut) { $0.status = Self.ON }, .back).step == .action)
    }

    @Test func backFromBadgeStaysOnBadge() {
        let s = at(.badge) { $0.punched = .in }
        #expect(tcReduce(s, .back) == s)
    }

    @Test func resetReturnsToTheInitialStateForTheMode() {
        #expect(tcReduce(at(.done) { $0.punched = .out }, .reset) == tcInitialState(.station))
        #expect(tcReduce(at(.done, mode: .kiosk) { $0.punched = .out }, .reset) == tcInitialState(.kiosk))
    }
}
