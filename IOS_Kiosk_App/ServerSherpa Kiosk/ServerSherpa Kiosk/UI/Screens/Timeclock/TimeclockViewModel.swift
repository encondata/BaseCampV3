import Foundation
import Observation
import SwiftUI
import UIKit

let TIMECLOCK_MAX_RESULTS = 8
private let NO_PEOPLE_DATA = "No people on this kiosk. Sync from Kiosk Setup."
let TIMECLOCK_IDLE_SECONDS = 20
private let TICK_SECONDS = 30
private let TOAST_SECONDS = 5
private let ERROR_SECONDS = 3

/// "3h 12m", or "45m" under the hour.
func formatMinutes(_ total: Int) -> String {
    let m = max(0, total)
    let h = m / 60
    return h > 0 ? "\(h)h \(m % 60)m" : "\(m)m"
}

/// Whole minutes from `iso` to `nowMs`, rounded half up, never negative; 0 when `iso` does not parse.
func minutesSince(_ iso: String, nowMs: Int64) -> Int {
    guard let start = parseInstant(iso) else { return 0 }
    let startMs = start.timeIntervalSince1970 * 1000
    return max(0, Int(((Double(nowMs) - startMs) / 60_000.0 + 0.5).rounded(.down)))
}

/// "3:05 PM" in `timeZone` (the device's by default); the input unchanged when it does not parse.
func clockTime(_ iso: String, timeZone: TimeZone = .current) -> String {
    guard let date = parseInstant(iso) else { return iso }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = timeZone
    f.dateFormat = "h:mm a"
    return f.string(from: date)
}

func initialsOf(_ name: String) -> String {
    let words = name.split(whereSeparator: \.isWhitespace)
    guard let first = words.first else { return "?" }
    let last = words.count > 1 ? words.last.map { String($0.prefix(1)) } ?? "" : ""
    return (String(first.prefix(1)) + last).uppercased()
}

func timeclockPunchErrorText(_ error: Error) -> String {
    let err = error as? ApiError
    if err?.code == "already_clocked_in" { return "They are already clocked in. Refreshing…" }
    if err?.code == "not_clocked_in" { return "They are not clocked in. Refreshing…" }
    if err?.code == "read_only_mode" || err?.status == 423 { return "The portal is in read-only mode. Try again shortly." }
    if err?.code == "network" { return "Can't reach the portal. The punch was not recorded." }
    return "Couldn't record the punch (\(err?.code ?? "unknown_error"))."
}

/// kiosk/src/pages/Timeclock.tsx: entry (badge/id/name) and selected (one button). No local history.
/// The screen feeds scans from the scan bus into `scan`; this model never reads the bus itself.
@MainActor @Observable
final class TimeclockViewModel {
    enum LoadStatus: Equatable { case loading, ready, error }

    private(set) var loadStatus = LoadStatus.loading
    private(set) var rosterSize = 0
    /// What the entry box holds right now (the screen mirrors its text here).
    private(set) var query = ""
    private(set) var results: [KioskPersonRow] = []
    private(set) var selected: KioskPersonRow?
    private(set) var status: KioskTimeclockStatus?
    private(set) var statusPhase = LoadStatus.loading
    private(set) var avatar: UIImage?
    /// A punch is in flight.
    private(set) var busy = false
    private(set) var error: String?
    private(set) var toast: String?
    /// "Now" for the elapsed-time line, refreshed every 30 s while a person is open.
    private(set) var nowMs: Int64

    /// The zone "since" and "last clock-out" times are shown in.
    let timeZone: TimeZone

    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let flash: FlashController
    @ObservationIgnored private let sound: SoundPlayer?
    @ObservationIgnored private let clock: @Sendable () -> Int64
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var index: PeopleIndex<KioskPersonRow>?
    @ObservationIgnored private var statusId = 0
    @ObservationIgnored private var idleTask: Task<Void, Never>?
    @ObservationIgnored private var tickTask: Task<Void, Never>?
    @ObservationIgnored private var errorTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var avatarTask: Task<Void, Never>?
    @ObservationIgnored private var punchTask: Task<Void, Never>?
    @ObservationIgnored private var punchId = 0

    init(store: KioskStore, api: KioskApi, prefs: KioskPrefs, identity: Identity, flash: FlashController, sound: SoundPlayer?,
         clock: @escaping @Sendable () -> Int64 = { ServerSherpa_Kiosk.nowMs() },
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         timeZone: TimeZone = .current) {
        self.store = store
        self.api = api
        self.prefs = prefs
        self.identity = identity
        self.flash = flash
        self.sound = sound
        self.clock = clock
        self.sleep = sleep
        self.timeZone = timeZone
        nowMs = clock()
    }

    /// Rebuilds the match index from the local roster; the screen calls it again whenever `sync.rosterVersion` changes.
    func loadRoster() async {
        do {
            let people = try await store.people()
            try Task.checkCancellation()
            index = buildPeopleIndex(people)
            rosterSize = people.count
            loadStatus = .ready
        } catch is CancellationError {
            // A newer roster version superseded this load; it will report its own result.
        } catch {
            loadStatus = .error
        }
    }

    /// Waits for every in-flight lookup, avatar fetch and punch (tests).
    func settle() async {
        for _ in 0..<3 {
            await statusTask?.value
            await avatarTask?.value
            await punchTask?.value
        }
    }

    /// Stops every timer and in-flight request (screen disappeared); the portal may still complete a punch.
    func stop() {
        statusId += 1
        for task in [idleTask, tickTask, errorTask, toastTask, statusTask, avatarTask, punchTask] { task?.cancel() }
        punchTask = nil
        busy = false
    }

    // MARK: messages

    private func showError(_ text: String, seconds: Int? = nil) {
        errorTask?.cancel()
        error = text
        guard let seconds else { return }
        errorTask = Task { [weak self, sleep] in
            do { try await sleep(.seconds(seconds)) } catch { return }
            self?.error = nil
        }
    }

    private func showToast(_ text: String) {
        toastTask?.cancel()
        toast = text
        toastTask = Task { [weak self, sleep] in
            do { try await sleep(.seconds(TOAST_SECONDS)) } catch { return }
            self?.toast = nil
        }
    }

    private func flashBad() {
        let look = prefs.appearance
        flash.flash(Color(hsl: look.notFoundScan), ms: look.flashMs)
        sound?.play(.notFound)
    }

    private func flashGood() {
        let look = prefs.appearance
        flash.flash(Color(hsl: look.goodScan), ms: look.flashMs)
        sound?.play(.good)
    }

    // MARK: selection

    /// Back to the entry box: drops the person, the status, every timer and any in-flight lookup.
    func toEntry() {
        statusId += 1
        for task in [errorTask, idleTask, tickTask, statusTask, avatarTask] { task?.cancel() }
        selected = nil
        status = nil
        statusPhase = .loading
        avatar = nil
        busy = false
        // A punch still in flight keeps running (the portal may record it) but no longer owns the screen.
        punchId += 1
        punchTask = nil
        query = ""
        results = []
        error = nil
    }

    /// The operator's Cancel button.
    func cancel() { toEntry() }

    /// Any touch while a person is open restarts the 20 s idle countdown.
    func bumpIdle() {
        guard selected != nil else { return }
        idleTask?.cancel()
        idleTask = Task { [weak self, sleep] in
            do { try await sleep(.seconds(TIMECLOCK_IDLE_SECONDS)) } catch { return }
            self?.toEntry()
        }
    }

    func select(_ person: KioskPersonRow) {
        errorTask?.cancel()
        error = nil
        query = ""
        results = []
        selected = person
        status = nil
        avatar = nil
        statusPhase = .loading
        bumpIdle()
        tickTask?.cancel()
        tickTask = Task { [weak self, sleep] in
            while !Task.isCancelled {
                do { try await sleep(.seconds(TICK_SECONDS)) } catch { return }
                guard let self else { return }
                nowMs = clock()
            }
        }
        loadStatus(person.id)
    }

    private func loadStatus(_ personId: String) {
        statusId += 1
        let mine = statusId
        statusTask?.cancel()
        avatarTask?.cancel()
        statusPhase = .loading
        statusTask = Task { [weak self] in
            guard let self else { return }
            do {
                let next = try await api.timeclockStatus(personId: personId)
                guard mine == statusId, !Task.isCancelled else { return }
                status = next
                statusPhase = .ready
                nowMs = clock()
                loadAvatar(next.person.avatarUrl, token: mine)
            } catch {
                guard mine == statusId, !Task.isCancelled else { return }
                statusPhase = .error
                let err = error as? ApiError
                showError(err?.code == "network"
                          ? "Can't reach the portal. Try again in a moment."
                          : "Couldn't read their status (\(err?.code ?? "unknown_error")).")
            }
        }
    }

    /// The presigned avatar, fetched with URLSession; nothing on any failure (the screen shows initials).
    /// A response that lands after the selection moved on is discarded.
    private func loadAvatar(_ url: String?, token: Int) {
        avatar = nil
        guard let url else { return }
        avatarTask = Task { [weak self] in
            guard let self else { return }
            guard let data = try? await api.fetchImage(url: url) else { return }
            guard token == statusId, !Task.isCancelled else { return }
            avatar = UIImage(data: data)
        }
    }

    // MARK: entry

    /// Every keystroke: a complete badge selects at once unless it is also a prefix of a longer tag.
    func onQueryChange(_ next: String) {
        if let index, isAmbiguousPrefix(index, next) {
            query = next
            results = searchPeople(index, next, limit: TIMECLOCK_MAX_RESULTS)
            return
        }
        if let index, let hit = matchPersonExact(index, next) {
            select(hit)
            return
        }
        query = next
        if let index, !next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            results = searchPeople(index, next, limit: TIMECLOCK_MAX_RESULTS)
        } else {
            results = []
        }
    }

    func onSubmit(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return }
        // A badge scan can arrive before the roster is ready (the typed input is
        // disabled then). Say so instead of dropping it silently. `scan` routes
        // here whenever `onQueryChange` could not select anybody, so it is covered too.
        guard let index, loadStatus == .ready, rosterSize > 0 else {
            flashBad()
            query = ""
            showError(NO_PEOPLE_DATA, seconds: ERROR_SECONDS)
            return
        }
        if let hit = matchPersonExact(index, value) { select(hit); return }
        let rows = searchPeople(index, value, limit: TIMECLOCK_MAX_RESULTS)
        if rows.count == 1 { select(rows[0]); return }
        if rows.count > 1 { return }
        flashBad()
        query = ""
        showError("No worker found for \"\(value)\".", seconds: ERROR_SECONDS)
    }

    /// The screen's entry point from the scan bus: returns at once so the bus loop keeps draining.
    /// A scan that arrives while a person is open or a punch is in flight is dropped (Android's guard).
    func scan(_ value: String) {
        guard selected == nil, !busy, punchTask == nil else { return }
        onQueryChange(value)
        if selected == nil { onSubmit(value) }
    }

    // MARK: punch

    func punch() {
        guard let person = selected, let status, !busy, punchTask == nil else { return }
        let clockingOut = status.clockedIn
        errorTask?.cancel()
        busy = true
        error = nil
        punchId += 1
        let mine = punchId
        punchTask = Task { [weak self] in
            await self?.runPunch(person, clockingOut: clockingOut)
            if self?.punchId == mine { self?.punchTask = nil }
        }
    }

    private func runPunch(_ person: KioskPersonRow, clockingOut: Bool) async {
        do {
            let serial = identity.current.serial
            let sel = prefs.setupSelection
            let next = clockingOut
                ? try await api.clockOut(ClockOutIn(serial: serial, personId: person.id))
                : try await api.clockIn(ClockInIn(serial: serial, personId: person.id, siteId: sel?.siteId, initiativeId: sel?.initiativeId))
            flashGood()
            let name = next.person.displayName
            let minutes = next.lastEntry?.minutes
            showToast(clockingOut
                      ? "Clocked out — \(name)" + (minutes.map { " · \(formatMinutes($0))" } ?? "")
                      : "Clocked in — \(name)")
            // Only the person this punch was for goes back to entry; a newer selection is left alone.
            if selected?.id == person.id { toEntry() }
        } catch {
            guard selected?.id == person.id else { return }
            if Task.isCancelled { busy = false; return }
            flashBad()
            busy = false
            showError(timeclockPunchErrorText(error), seconds: ERROR_SECONDS)
            bumpIdle()
            let code = (error as? ApiError)?.code
            if code == "already_clocked_in" || code == "not_clocked_in" { loadStatus(person.id) }
        }
    }
}
