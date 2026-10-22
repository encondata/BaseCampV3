import Foundation
@testable import ServerSherpa_Kiosk

/// A StationApi whose answers are set per test. Every call is recorded as "people",
/// "status:<id>", "clockIn:<id>" or "clockOut:<id>", with the key, serial and tz it carried.
final class FakeStationApi: StationApi, @unchecked Sendable {
    struct Call: Equatable { var name: String; var key: String; var serial: String; var tz: String? }

    private let lock = NSLock()
    private var _calls: [Call] = []
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

    var calls: [Call] { lock.withLock { _calls } }
    var names: [String] { calls.map(\.name) }

    private func record(_ call: Call) { lock.withLock { _calls.append(call) } }

    func people(key: String, serial: String) async throws -> [KioskPersonRow] {
        record(Call(name: "people", key: key, serial: serial, tz: nil))
        return try await peopleResult()
    }
    func status(key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus {
        record(Call(name: "status:\(personId)", key: key, serial: serial, tz: tz))
        return try await statusResult(personId)
    }
    func clockIn(key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus {
        record(Call(name: "clockIn:\(personId)", key: key, serial: serial, tz: tz))
        return try await clockInResult(personId)
    }
    func clockOut(key: String, serial: String, personId: String, tz: String) async throws -> KioskTimeclockStatus {
        record(Call(name: "clockOut:\(personId)", key: key, serial: serial, tz: tz))
        return try await clockOutResult(personId)
    }
}

/// The API URL test stations are bound to.
let TEST_API_URL = "https://api.test"

/// A Time Clock station selection with no move and no site.
func timeclockSelection(initiativeId: String? = nil, siteId: String? = nil) -> KioskSetupSelection {
    .timeclock(initiativeId: initiativeId, initiativeName: initiativeId == nil ? nil : "Move A",
               siteId: siteId, siteName: siteId == nil ? nil : "Dock 4", siteRole: initiativeId == nil ? nil : "source")
}

/// A value a test changes while code under test reads it.
final class MutableBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { _value = value }
    var value: T {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
}
