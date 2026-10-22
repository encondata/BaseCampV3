import Foundation
@testable import ServerSherpa_Kiosk

/// A TcBackend whose answers are set per test (Android `FakeTcBackend`). Every
/// call is recorded as "people", "status:<id>", "clockIn:<id>" or "clockOut:<id>";
/// each answer is a swappable async closure, so a test can hold one open.
final class FakeTcBackend: TcBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _finished: [String] = []

    private var _peopleResult: @Sendable () async throws -> [KioskPersonRow] = { [] }
    private var _statusResult: @Sendable (String) async throws -> KioskTimeclockStatus = { tcOff($0) }
    private var _clockInResult: @Sendable (String) async throws -> KioskTimeclockStatus = { tcOn($0) }
    private var _clockOutResult: @Sendable (String) async throws -> KioskTimeclockStatus = { tcOff($0) }

    var peopleResult: @Sendable () async throws -> [KioskPersonRow] {
        get { lock.withLock { _peopleResult } } set { lock.withLock { _peopleResult = newValue } }
    }
    var statusResult: @Sendable (String) async throws -> KioskTimeclockStatus {
        get { lock.withLock { _statusResult } } set { lock.withLock { _statusResult = newValue } }
    }
    var clockInResult: @Sendable (String) async throws -> KioskTimeclockStatus {
        get { lock.withLock { _clockInResult } } set { lock.withLock { _clockInResult = newValue } }
    }
    var clockOutResult: @Sendable (String) async throws -> KioskTimeclockStatus {
        get { lock.withLock { _clockOutResult } } set { lock.withLock { _clockOutResult = newValue } }
    }

    var calls: [String] { lock.withLock { _calls } }
    /// Calls that have returned (answered or thrown), in order.
    var finished: [String] { lock.withLock { _finished } }
    func count(_ prefix: String) -> Int { calls.filter { $0.hasPrefix(prefix) }.count }

    private func record(_ call: String) { lock.withLock { _calls.append(call) } }
    private func finish(_ call: String) { lock.withLock { _finished.append(call) } }

    func people() async throws -> [KioskPersonRow] {
        record("people"); defer { finish("people") }
        return try await peopleResult()
    }
    func status(personId: String) async throws -> KioskTimeclockStatus {
        record("status:\(personId)"); defer { finish("status:\(personId)") }
        return try await statusResult(personId)
    }
    func clockIn(personId: String) async throws -> KioskTimeclockStatus {
        record("clockIn:\(personId)"); defer { finish("clockIn:\(personId)") }
        return try await clockInResult(personId)
    }
    func clockOut(personId: String) async throws -> KioskTimeclockStatus {
        record("clockOut:\(personId)"); defer { finish("clockOut:\(personId)") }
        return try await clockOutResult(personId)
    }
}

/// Holds a fake call in flight until `open()`; ignores cancellation, like a hung socket.
actor HoldGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() { isOpen = true; let w = waiters; waiters = []; for c in w { c.resume() } }
}

let TC_JIMMY = KioskPersonRow(id: "p1", displayName: "Jimmy Henderson", firstName: "James", lastName: "Henderson", preferredName: "Jimmy",
                              rfidTag: "000000000000000000100348", badgeUid: "B-UID-1", jobTitle: "Crew lead", externalId: "E-42",
                              isWorker: true, hasAccount: true)
let TC_TINA = KioskPersonRow(id: "p2", displayName: "Tina Timeclock", firstName: "Tina", lastName: "Timeclock", rfidTag: "1003", isWorker: true)

func tcOff(_ id: String) -> KioskTimeclockStatus {
    KioskTimeclockStatus(person: KioskTimeclockPerson(id: id, displayName: id == "p1" ? "Jimmy Henderson" : "Tina Timeclock",
                                                      firstName: id == "p1" ? "James" : "Tina", preferredName: id == "p1" ? "Jimmy" : nil),
                         clockedIn: false)
}

func tcOn(_ id: String) -> KioskTimeclockStatus {
    var s = tcOff(id)
    s.clockedIn = true
    s.todayMinutes = 444
    return s
}
