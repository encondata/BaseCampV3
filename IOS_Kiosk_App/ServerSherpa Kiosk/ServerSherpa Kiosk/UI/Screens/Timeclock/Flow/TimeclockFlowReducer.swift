import Foundation

// kiosk/src/timeclock/flow.ts: the guided time clock flow as a pure reducer.
// The model owns every side effect (the status read, the punch, the badge
// print, the timers) and reports what happened as an event; nothing here
// touches the network, a timer or the clock, so each transition is a plain
// state-in, state-out test.
//
// Two modes share the steps. `station` is the signed-out Time Clock kiosk:
// it starts on `welcome` and Back from `name` returns there. `kiosk` is a
// signed-in kiosk reaching the flow from its Home: it starts on `name`, and
// leaving from there is the model's call, so Back from `name` changes nothing here.

enum TcMode: Equatable, Sendable { case station, kiosk }

enum TcStep: String, Equatable, Sendable {
    case welcome, name, confirm, action, clockOut, badge, printing, verify, done
}

enum TcPunch: Equatable, Sendable { case `in`, out }

struct TcState: Equatable, Sendable {
    var mode: TcMode
    var step: TcStep
    var status: KioskTimeclockStatus?
    var busy: Bool
    var error: String?
    var notice: String?
    var punched: TcPunch?
}

enum TcEvent: Equatable, Sendable {
    case enterName
    case identified(KioskTimeclockStatus)
    case confirmYes
    case confirmNo
    case chooseIn
    case chooseOut
    case punchStarted
    case punchSucceeded(KioskTimeclockStatus, TcPunch)
    case punchFailed(String)
    case statusRefreshed(KioskTimeclockStatus)
    case badgeNew
    case badgeExisting
    case printingDone
    case verifyContinue
    case back
    case reset
}

enum TcTimers {
    /// A screen never outlives the person at it: 20 s without a touch or key returns to the start.
    static let idle: Duration = .seconds(20)
    /// All Set returns to the start on its own after this long.
    static let done: Duration = .seconds(8)
    /// The Printing placeholder advances to Verify after this long.
    static let printing: Duration = .seconds(3)
    /// How long "We couldn't find that code." and its kind stay up.
    static let message: Duration = .seconds(5)
    /// Welcome's hidden input forgets a half-typed value after this much quiet.
    static let scanQuiet: Duration = .milliseconds(1500)
    /// Status and people reads give up after this long. Punches never time out.
    static let readTimeout: Duration = .seconds(10)
}

let TC_NOTICE_CHANGED = "Your status changed. Please choose again."
private let ERROR_UNREACHABLE = "Can't reach the portal. Your punch was not recorded. Try again."
private let ERROR_OTHER = "Something went wrong. Your punch was not recorded. Try again."
private let ERROR_READ_ONLY = "The portal is in read-only mode. Your punch was not recorded. Try again shortly."
/// kiosk/src/lib/api.ts `CLOUD_SIGN_IN_TEXT` (a laptop signed in offline).
private let CLOUD_SIGN_IN_TEXT = "Sign in again while online to do this."

func tcStartStep(_ mode: TcMode) -> TcStep { mode == .station ? .welcome : .name }

func tcInitialState(_ mode: TcMode) -> TcState {
    TcState(mode: mode, step: tcStartStep(mode), status: nil, busy: false, error: nil, notice: nil, punched: nil)
}

private func failureText(_ code: String) -> String {
    if code == "network" || code == "edge_offline" { return ERROR_UNREACHABLE }
    if code == "cloud_sign_in_required" { return CLOUD_SIGN_IN_TEXT }
    if code == "read_only_mode" { return ERROR_READ_ONLY }
    return ERROR_OTHER
}

/// The events that start a punch. While one is in flight (`busy`) they change
/// nothing, so a double tap can never send a second punch: the model sends only
/// when an event takes the state into busy.
private func startsPunch(_ event: TcEvent) -> Bool {
    switch event {
    case .chooseIn, .chooseOut, .punchStarted: true
    default: false
    }
}

func tcReduce(_ state: TcState, _ event: TcEvent) -> TcState {
    if state.busy && startsPunch(event) { return state }
    var s = state
    switch event {
    case .enterName:
        if state.step == .welcome { s.step = .name }
    case .identified(let status):
        s.step = .confirm
        s.status = status
        s.busy = false
        s.error = nil
        s.notice = nil
        s.punched = nil
    case .confirmNo:
        s.step = .name
    case .confirmYes:
        s.step = .action
    case .chooseOut:
        guard state.status?.clockedIn == true else { return state }
        s.step = .clockOut
        s.error = nil
        s.notice = nil
    case .chooseIn:
        // The model punches straight away (no second confirm to clock in).
        guard let status = state.status, !status.clockedIn else { return state }
        s.busy = true
        s.error = nil
        s.notice = nil
    case .punchStarted:
        s.busy = true
        s.error = nil
    case .punchSucceeded(let status, let punched):
        s.step = punched == .in ? .badge : .done
        s.status = status
        s.punched = punched
        s.busy = false
        s.error = nil
        s.notice = nil
    case .punchFailed(let code):
        s.busy = false
        if code == "already_clocked_in" || code == "not_clocked_in" {
            s.step = .action
            s.error = nil
            s.notice = TC_NOTICE_CHANGED
        } else {
            s.error = failureText(code)
            s.notice = nil
        }
    case .statusRefreshed(let status):
        s.status = status
        s.busy = false
    case .badgeNew:
        s.step = .printing
    case .printingDone:
        s.step = .verify
    case .verifyContinue, .badgeExisting:
        s.step = .done
    case .back:
        switch state.step {
        case .confirm: s.step = .name
        case .name:
            guard state.mode == .station else { return state }
            s.step = .welcome
        case .action: s.step = .confirm
        case .clockOut:
            s.step = .action
            s.error = nil
        default: return state
        }
    case .reset:
        return tcInitialState(state.mode)
    }
    return s
}
