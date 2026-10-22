import Foundation
import Observation
import SwiftUI
import UIKit

// kiosk/src/timeclock/TimeclockFlow.tsx's side effects. The transitions are
// `tcReduce`; this model owns the people list, the status read, the punch,
// the flash and sound and the timers, and reports each outcome as an event.
// Everything a step shows (the step, the person, the typed text, the keyboard
// layer, the photo) lives here, never in a view, so a rotation or any other
// view rebuild keeps it.
//
// Finding a person: a badge reader is a keyboard, so on Welcome and Enter Your
// Name its keystrokes land in `query` (`keyInsert`), and a value that names
// exactly one person (RFID tag, badge UUID, id — `matchPersonExact`) selects
// them the moment it is complete, unless it is also the start of a longer tag
// (`isAmbiguousPrefix`), when Return settles it. A camera scan (`onScan`) is a
// whole code: its owner, or "We couldn't find that code."
//
// Two guards keep a punch honest:
//  - one punch per tap: the reducer ignores the punch-starting events while
//    `busy`, and a punch is sent only when an event takes the state into busy;
//    Try again re-reads the status first, so a punch that landed despite the
//    error is never sent twice;
//  - one person per answer: every person gets a fresh session number, and
//    leaving (idle, Done, Back off the name screen) bumps it, so a status or
//    punch that answers late is dropped rather than painted over the next screen.

let TC_MAX_RESULTS = 8
let TC_NOT_FOUND = "We couldn't find that code."
let TC_NO_NAME_MATCH = "No one matches that name."
let TC_LOOKUP_UNREACHABLE = "Can't reach the portal. Try again."
let TC_LOOKUP_FAILED = "Something went wrong. Try again."
let TC_NO_PEOPLE = "No people on this kiosk. Sync from Kiosk Setup."
let TC_PEOPLE_FAILED = "Can't load the people list. Try again shortly."

@MainActor @Observable
final class TimeclockFlowModel {
    let mode: TcMode
    private(set) var state: TcState
    /// The search box (Enter Your Name) or the reader's hidden input (Welcome).
    private(set) var query = ""
    private(set) var message: String?
    /// A status read for a person is in flight: the input and the keys are off.
    private(set) var looking = false
    /// The status re-read after a 409 is in flight.
    private(set) var refreshing = false
    private(set) var peopleFailed = false
    private(set) var index: PeopleIndex<KioskPersonRow>?
    /// The confirm card's photo; nil shows initials.
    private(set) var avatar: UIImage?
    /// The on-screen keyboard's Shift and 123 layer.
    private(set) var kbShift = false
    private(set) var kbSymbols = false
    /// Station: Welcome takes nobody while the station key is missing or lapsed.
    var paused = false
    /// Station, with `paused`: the key never arrived (rather than the registration lapsing).
    var keyMissing = false
    /// Kiosk mode: leave the flow (Home), after Done, idle, or Back on Enter Your Name.
    @ObservationIgnored var onExit: (() -> Void)?

    @ObservationIgnored private let backend: TcBackend
    @ObservationIgnored private let flash: FlashController
    @ObservationIgnored private let sound: SoundPlayer?
    @ObservationIgnored private let appearance: @MainActor () -> Appearance
    @ObservationIgnored private let fetchImage: @Sendable (String) async throws -> Data
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

    @ObservationIgnored private var session = 0
    @ObservationIgnored private var peopleRead = 0
    @ObservationIgnored private var started = false
    @ObservationIgnored private var peopleTask: Task<Void, Never>?
    @ObservationIgnored private var lookupTask: Task<Void, Never>?
    @ObservationIgnored private var punchTask: Task<Void, Never>?
    @ObservationIgnored private var avatarTask: Task<Void, Never>?
    @ObservationIgnored private var idleTask: Task<Void, Never>?
    @ObservationIgnored private var doneTask: Task<Void, Never>?
    @ObservationIgnored private var printingTask: Task<Void, Never>?
    @ObservationIgnored private var messageTask: Task<Void, Never>?
    @ObservationIgnored private var quietTask: Task<Void, Never>?

    init(mode: TcMode, backend: TcBackend, flash: FlashController, sound: SoundPlayer?,
         appearance: @escaping @MainActor () -> Appearance,
         fetchImage: @escaping @Sendable (String) async throws -> Data,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.mode = mode
        self.backend = backend
        self.flash = flash
        self.sound = sound
        self.appearance = appearance
        self.fetchImage = fetchImage
        self.sleep = sleep
        state = tcInitialState(mode)
    }

    // MARK: what the steps read

    var step: TcStep { state.step }
    var atStart: Bool { state.step == tcStartStep(mode) }
    /// Welcome and Enter Your Name take keystrokes and scans.
    var typing: Bool { state.step == .welcome || state.step == .name }
    /// The input is off: a lookup runs, or a paused station's Welcome.
    var inputOff: Bool { looking || (state.step == .welcome && paused) }
    /// A punch or the status re-read is in flight: the buttons wait.
    var busy: Bool { state.busy || refreshing }
    var hasBack: Bool { [.name, .confirm, .action, .clockOut].contains(state.step) }
    var rosterSize: Int? { index?.size }
    var results: [KioskPersonRow] {
        guard let index, state.step == .name, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return searchPeople(index, query, limit: TC_MAX_RESULTS)
    }
    /// The box has text but nobody matches it (and no message says more).
    var noMatches: Bool {
        index != nil && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && results.isEmpty && message == nil
    }
    private var noPeople: Bool { mode == .kiosk && index?.size == 0 }
    var shownMessage: String? {
        message ?? ((peopleFailed && index == nil) ? TC_PEOPLE_FAILED : nil) ?? (noPeople ? TC_NO_PEOPLE : nil)
    }
    var firstName: String { tcFirstName(state.status?.person) }
    private var idleActive: Bool { !atStart && state.step != .done }

    // MARK: lifecycle

    /// Reads the people once; later reads come with each return to the start
    /// and from `loadPeople` (a kiosk's sync finishing).
    func start() {
        guard !started else { return }
        started = true
        loadPeople()
    }

    /// Stops every timer and drops every pending answer (the flow went away).
    /// A punch still in flight may be recorded by the portal; its answer is dropped.
    func stop() {
        session += 1
        peopleRead += 1
        for task in [peopleTask, lookupTask, avatarTask, idleTask, doneTask, printingTask, messageTask, quietTask] { task?.cancel() }
        looking = false
        refreshing = false
    }

    /// Waits for in-flight reads, punches and photo fetches (tests).
    func settle() async {
        for _ in 0..<4 {
            await peopleTask?.value
            await lookupTask?.value
            await punchTask?.value
            await avatarTask?.value
        }
    }

    /// The people list. The old index stays in use until the new one arrives;
    /// a superseded read loses.
    func loadPeople() {
        peopleRead += 1
        let mine = peopleRead
        peopleTask = Task { [weak self] in
            guard let self else { return }
            do {
                let backend = self.backend
                let people = try await read { try await backend.people() }
                guard mine == peopleRead else { return }
                index = buildPeopleIndex(people)
                peopleFailed = false
            } catch {
                guard mine == peopleRead, !(error is CancellationError) else { return }
                peopleFailed = true
            }
        }
    }

    // MARK: transitions

    @discardableResult
    private func apply(_ event: TcEvent) -> (prev: TcState, next: TcState) {
        let prev = state
        let wasIdle = idleActive
        let next = tcReduce(prev, event)
        guard next != prev else { return (prev, next) }
        state = next
        if next.step != prev.step { stepChanged(from: prev.step, to: next.step) }
        if idleActive && !wasIdle {
            restartIdle()
        } else if !idleActive {
            idleTask?.cancel()
            idleTask = nil
        }
        return (prev, next)
    }

    private func stepChanged(from old: TcStep, to new: TcStep) {
        // a station that runs all day picks up new hires each time it is back at its start
        if new == tcStartStep(mode) { loadPeople() }
        if new == .name { kbShift = false; kbSymbols = false }
        if old == .welcome { quietTask?.cancel() }
        if old == .printing { printingTask?.cancel() }
        if old == .done { doneTask?.cancel() }
        if new == .printing {
            printingTask = timer(TcTimers.printing) { _ = $0.apply(.printingDone) }
        }
        if new == .done {
            doneTask = timer(TcTimers.done) { $0.exit() }
        }
    }

    private func timer(_ d: Duration, _ fire: @escaping @MainActor (TimeclockFlowModel) -> Void) -> Task<Void, Never> {
        Task { [weak self, sleep] in
            do { try await sleep(d) } catch { return }
            guard let self, !Task.isCancelled else { return }
            fire(self)
        }
    }

    // MARK: feedback and messages

    private func good() {
        let look = appearance()
        flash.flash(Color(hsl: look.goodScan), ms: look.flashMs)
        sound?.play(.good)
    }

    private func bad() {
        let look = appearance()
        flash.flash(Color(hsl: look.notFoundScan), ms: look.flashMs)
        sound?.play(.notFound)
    }

    private func showMessage(_ text: String) {
        messageTask?.cancel()
        message = text
        messageTask = timer(TcTimers.message) { $0.message = nil }
    }

    private func clearMessage() {
        messageTask?.cancel()
        message = nil
    }

    // MARK: activity and leaving

    /// Any touch or key: restarts the 20 s idle countdown off the start step.
    func onActivity() {
        if idleActive { restartIdle() }
    }

    private func restartIdle() {
        idleTask?.cancel()
        idleTask = timer(TcTimers.idle) { $0.exit() }
    }

    /// Leaves the flow: back to Welcome on a station, out to Home on a kiosk.
    func exit() {
        session += 1
        lookupTask?.cancel()
        quietTask?.cancel()
        query = ""
        clearMessage()
        looking = false
        refreshing = false
        avatar = nil
        apply(.reset)
        if mode == .kiosk { onExit?() }
    }

    /// All Set's Done.
    func done() { exit() }

    /// Back, bottom-left. It waits while a punch is in flight.
    func back() {
        guard hasBack, !busy else { return }
        if state.step == .name {
            session += 1                    // a lookup still in flight loses the screen
            lookupTask?.cancel()
            looking = false
            query = ""
            clearMessage()
            if mode == .kiosk {
                exit()
                return
            }
        }
        apply(.back)
    }

    // MARK: finding a person

    /// Every change of the typed value (the reader or the on-screen keys).
    func onType(_ next: String) {
        guard typing, !inputOff else { return }
        onActivity()
        if message != nil { clearMessage() }
        if let index, !isAmbiguousPrefix(index, next), let hit = matchPersonExact(index, next) {
            identify(hit)
            return
        }
        query = next
        armQuiet()
    }

    /// Return on the reader, or Search on the keys.
    func onSearch() {
        guard typing, !inputOff else { return }
        onActivity()
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let index else { return }
        if let exact = matchPersonExact(index, raw) {
            identify(exact)
            return
        }
        if state.step == .name {
            let rows = searchPeople(index, raw, limit: TC_MAX_RESULTS)
            if rows.count == 1 { identify(rows[0]) } else if rows.isEmpty { notFound(TC_NO_NAME_MATCH, clear: false) }
            return
        }
        notFound(TC_NOT_FOUND, clear: true)
    }

    /// A whole code from the camera: its owner, or not found.
    func onScan(_ raw: String) {
        guard typing, !inputOff else { return }
        onActivity()
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let index else { return }
        if let hit = matchPersonExact(index, value) { identify(hit) } else { notFound(TC_NOT_FOUND, clear: false) }
    }

    /// Text from a hardware keyboard or reader; a newline is its Return.
    func keyInsert(_ text: String) {
        var pending = ""
        for ch in text {
            if ch == "\n" || ch == "\r" {
                if !pending.isEmpty { onType(query + pending); pending = "" }
                onSearch()
            } else {
                pending.append(ch)
            }
        }
        if !pending.isEmpty { onType(query + pending) }
    }

    /// Backspace on a hardware keyboard.
    func keyDelete() {
        guard !query.isEmpty else { return }
        onType(String(query.dropLast()))
    }

    /// A result row.
    func pick(_ person: KioskPersonRow) {
        guard state.step == .name, !looking else { return }
        onActivity()
        identify(person)
    }

    /// An on-screen key. Letters come out capitalized at the start of the box
    /// and after a space; Shift capitalizes the next letter once.
    func pressKey(_ key: TcKey) {
        guard state.step == .name, !looking else { return }
        onActivity()
        switch key {
        case .letter(let ch):
            let text = tcLetterText(ch, value: query, shift: kbShift)
            kbShift = false
            onType(query + text)
        case .symbol(let ch): onType(query + ch)
        case .space: onType(query + " ")
        case .backspace: onType(String(query.dropLast()))
        case .shift: kbShift.toggle()
        case .numbers: kbSymbols = true
        case .letters: kbSymbols = false
        case .search: onSearch()
        }
    }

    private func notFound(_ text: String, clear: Bool) {
        bad()
        if clear { query = "" }
        showMessage(text)
    }

    /// Welcome's hidden input: a value nobody finished (no Return) is cleared
    /// after a moment of quiet, so it can't spoil the next scan. A value that
    /// waited only because it was also the start of a longer tag is settled
    /// instead: the reader has stopped, so the exact match was meant.
    private func armQuiet() {
        quietTask?.cancel()
        guard state.step == .welcome, !query.isEmpty, !looking else { return }
        quietTask = timer(TcTimers.scanQuiet) { m in
            guard m.state.step == .welcome, !m.looking else { return }
            if let index = m.index, let exact = matchPersonExact(index, m.query) { m.identify(exact) } else { m.query = "" }
        }
    }

    private func identify(_ person: KioskPersonRow) {
        session += 1
        let mine = session
        quietTask?.cancel()
        lookupTask?.cancel()
        query = ""
        clearMessage()
        looking = true
        avatar = nil
        let backend = self.backend
        lookupTask = Task { [weak self] in
            guard let self else { return }
            do {
                let status = try await read { try await backend.status(personId: person.id) }
                guard mine == session else { return }
                looking = false
                good()
                apply(.identified(status))
                loadAvatar(status.person.avatarUrl, token: mine)
            } catch {
                guard mine == session else { return }
                looking = false
                bad()
                let code = tcCode(error)
                showMessage(code == "network" || code == "edge_offline" ? TC_LOOKUP_UNREACHABLE : TC_LOOKUP_FAILED)
            }
        }
    }

    /// The presigned photo; nothing on any failure (the card shows initials).
    private func loadAvatar(_ url: String?, token: Int) {
        avatarTask?.cancel()
        guard let url, !url.isEmpty else { return }
        let fetchImage = self.fetchImage
        avatarTask = Task { [weak self] in
            guard let data = try? await fetchImage(url) else { return }
            guard let self, token == session, !Task.isCancelled else { return }
            avatar = UIImage(data: data)
        }
    }

    // MARK: the steps' buttons

    func enterName() {
        guard state.step == .welcome, !paused else { return }
        query = ""
        clearMessage()
        apply(.enterName)
    }

    func confirmYes() { apply(.confirmYes) }

    func confirmNo() {
        query = ""
        apply(.confirmNo)
    }

    /// Clock In punches at once.
    func chooseIn() {
        guard !refreshing else { return }
        punch(.chooseIn, .in)
    }

    func chooseOut() {
        guard !refreshing else { return }
        apply(.chooseOut)
    }

    func confirmClockOut() {
        guard state.step == .clockOut, !refreshing else { return }
        punch(.punchStarted, .out)
    }

    /// Try again after a failed punch: re-reads the status first, so a punch
    /// that landed despite the error (a dropped answer) is not sent twice.
    func retry() {
        guard state.step == .action || state.step == .clockOut, state.error != nil, !refreshing else { return }
        let kind: TcPunch = state.step == .clockOut ? .out : .in
        let (prev, next) = apply(.punchStarted)
        guard !prev.busy, next.busy, let personId = next.status?.person.id else { return }
        let mine = session
        let backend = self.backend
        punchTask = Task { [weak self] in
            guard let self else { return }
            let fresh: KioskTimeclockStatus
            do {
                fresh = try await read { try await backend.status(personId: personId) }
            } catch {
                guard mine == session else { return }
                bad()
                apply(.punchFailed(tcCode(error)))
                return
            }
            guard mine == session else { return }
            if fresh.clockedIn == (kind == .in) {
                good()
                apply(.punchSucceeded(fresh, kind))
                return
            }
            await runPunch(kind, personId: personId, session: mine)
        }
    }

    func badgeNew() { apply(.badgeNew) }
    func badgeExisting() { apply(.badgeExisting) }
    func verifyContinue() { apply(.verifyContinue) }

    // MARK: punches

    /// Sends a punch only when `event` takes the flow into busy.
    private func punch(_ event: TcEvent, _ kind: TcPunch) {
        let (prev, next) = apply(event)
        guard !prev.busy, next.busy, let personId = next.status?.person.id else { return }
        let mine = session
        punchTask = Task { [weak self] in
            await self?.runPunch(kind, personId: personId, session: mine)
        }
    }

    /// The punch itself: never timed out (a dropped POST may still be recorded).
    private func runPunch(_ kind: TcPunch, personId: String, session mine: Int) async {
        let backend = self.backend
        do {
            let next = kind == .in ? try await backend.clockIn(personId: personId) : try await backend.clockOut(personId: personId)
            guard mine == session else { return }
            good()
            apply(.punchSucceeded(next, kind))
        } catch {
            guard mine == session else { return }
            bad()
            let code = tcCode(error)
            apply(.punchFailed(code))
            // Someone punched elsewhere in between: the portal knows better than
            // the screen, so re-read and let them choose again.
            guard code == "already_clocked_in" || code == "not_clocked_in" else { return }
            refreshing = true
            do {
                let fresh = try await read { try await backend.status(personId: personId) }
                guard mine == session else { return }
                refreshing = false
                apply(.statusRefreshed(fresh))
            } catch {
                if mine == session { refreshing = false }
            }
        }
    }

    // MARK: reads

    /// A read that gives up after `TcTimers.readTimeout` as a network failure.
    private func read<T: Sendable>(_ op: @escaping @Sendable () async throws -> T) async throws -> T {
        try await tcWithTimeout(TcTimers.readTimeout, sleep: sleep, op)
    }
}

func tcCode(_ error: Error) -> String { (error as? ApiError)?.code ?? "unknown_error" }

/// Runs `op`, or throws a network `ApiError` once `limit` passes first. The
/// loser is canceled and never waited for (a hung socket can't hold the flow).
func tcWithTimeout<T: Sendable>(_ limit: Duration, sleep: @escaping @Sendable (Duration) async throws -> Void,
                                _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    let race = TcRace<T>()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
            guard race.arm(cont) else { return }
            let work = Task { do { race.finish(.success(try await op())) } catch { race.finish(.failure(error)) } }
            let clock = Task {
                do { try await sleep(limit) } catch { return }
                race.finish(.failure(ApiError(status: 0, code: "network")))
            }
            race.hold([work, clock])
        }
    } onCancel: {
        race.finish(.failure(CancellationError()))
    }
}

/// The first result wins; the rest (and the losing tasks) are dropped.
private final class TcRace<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<T, Error>?
    private var tasks: [Task<Void, Never>] = []
    private var result: Result<T, Error>?

    /// False when the race already ended (canceled before it began): resumed here.
    func arm(_ c: CheckedContinuation<T, Error>) -> Bool {
        let early = lock.withLock { () -> Result<T, Error>? in
            if let result { return result }
            cont = c
            return nil
        }
        if let early { c.resume(with: early); return false }
        return true
    }

    func hold(_ more: [Task<Void, Never>]) {
        let ended = lock.withLock { () -> Bool in
            if result != nil { return true }
            tasks += more
            return false
        }
        if ended { more.forEach { $0.cancel() } }
    }

    func finish(_ r: Result<T, Error>) {
        let (c, losers) = lock.withLock { () -> (CheckedContinuation<T, Error>?, [Task<Void, Never>]) in
            if result != nil { return (nil, []) }
            result = r
            let c = cont
            cont = nil
            let t = tasks
            tasks = []
            return (c, t)
        }
        losers.forEach { $0.cancel() }
        c?.resume(with: r)
    }
}
