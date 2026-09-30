import Foundation
@testable import ServerSherpa_Kiosk

private let unset = ApiError(status: 500, code: "unset", detail: [:])

/// A KioskApi whose answers are set per test (Android `FakeKioskApi`). Every
/// member records its name in `calls`; unset results throw `unset`.
final class FakeKioskApi: KioskApi, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _heartbeats: [HeartbeatIn] = []
    private var _scanBatches: [KioskScanBatchIn] = []

    var loginResult: @Sendable () throws -> SessionData = { throw ApiError(status: 401, code: "invalid_credentials") }
    var moveLoginResult: @Sendable (String) throws -> SessionData = { _ in throw ApiError(status: 401, code: "invalid_credentials") }
    var heartbeatResult: @Sendable (HeartbeatIn) throws -> HeartbeatResult = { HeartbeatResult(deviceId: "d1", name: $0.name, registration: "ok") }
    var systemStatusResult: @Sendable () throws -> SystemStatus = { SystemStatus() }
    var pairCreated: @Sendable () throws -> PairCreated = { throw unset }
    var pollResult: @Sendable () throws -> PairPoll = { PairPoll(status: .pending, session: nil) }
    var setupOptionsResult: @Sendable () throws -> SetupOptions = { SetupOptions() }
    var submitSetupResult: @Sendable (KioskSetupIn) throws -> KioskSetupResult = { _ in throw unset }
    var assets: @Sendable () async throws -> KioskAssetsSync = { throw unset }
    var people: @Sendable () async throws -> KioskPeopleSync = { throw unset }
    var containers: @Sendable () async throws -> KioskContainersSync = { throw unset }
    var trucks: @Sendable () async throws -> KioskTrucksSync = { throw unset }
    var postScansResult: @Sendable (KioskScanBatchIn) async throws -> KioskScanBatchOut = { KioskScanBatchOut(accepted: $0.scans.map(\.clientScanId)) }
    var rfidResult: @Sendable (String, KioskRfidEnrollIn) throws -> KioskRfidEnroll = { id, b in KioskRfidEnroll(assetId: id, rfidTag: b.rfidTag) }
    /// When set, `postRfidEnroll` awaits this before answering (holds a POST in flight).
    var rfidGate: (@Sendable () async -> Void)?
    var statusResult: @Sendable (String) throws -> KioskTimeclockStatus = { _ in throw unset }
    var clockInResult: @Sendable (ClockInIn) throws -> KioskTimeclockStatus = { _ in throw unset }
    var clockOutResult: @Sendable (ClockOutIn) throws -> KioskTimeclockStatus = { _ in throw unset }
    var imageResult: @Sendable (String) throws -> Data = { _ in throw unset }

    var calls: [String] { lock.lock(); defer { lock.unlock() }; return _calls }
    var heartbeats: [HeartbeatIn] { lock.lock(); defer { lock.unlock() }; return _heartbeats }
    /// Every body `postScans` was called with, in order.
    var scanBatches: [KioskScanBatchIn] { lock.lock(); defer { lock.unlock() }; return _scanBatches }

    private func record(_ name: String) { lock.lock(); _calls.append(name); lock.unlock() }

    func login(email: String, password: String) async throws -> SessionData { record("login"); return try loginResult() }
    func moveLogin(password: String) async throws -> SessionData { record("moveLogin"); return try moveLoginResult(password) }
    func logout() async { record("logout") }
    func systemStatus() async throws -> SystemStatus { record("status"); return try systemStatusResult() }
    func createPairRequest(serial: String, name: String) async throws -> PairCreated { record("pair"); return try pairCreated() }
    func pollPair(code: String, pollToken: String) async throws -> PairPoll { record("poll"); return try pollResult() }
    func heartbeat(_ body: HeartbeatIn) async throws -> HeartbeatResult {
        lock.lock(); _calls.append("heartbeat"); _heartbeats.append(body); lock.unlock()
        return try heartbeatResult(body)
    }
    func signOut(serial: String) async { record("signOut") }
    func setupOptions() async throws -> SetupOptions { record("setupOptions"); return try setupOptionsResult() }
    func submitSetup(_ body: KioskSetupIn) async throws -> KioskSetupResult { record("submitSetup"); return try submitSetupResult(body) }
    func syncAssets(initiativeId: String) async throws -> KioskAssetsSync { record("syncAssets"); return try await assets() }
    func syncPeople() async throws -> KioskPeopleSync { record("syncPeople"); return try await people() }
    func syncContainers(initiativeId: String) async throws -> KioskContainersSync { record("syncContainers"); return try await containers() }
    func syncTrucks(initiativeId: String) async throws -> KioskTrucksSync { record("syncTrucks"); return try await trucks() }
    func postScans(_ body: KioskScanBatchIn) async throws -> KioskScanBatchOut {
        lock.lock(); _calls.append("postScans"); _scanBatches.append(body); lock.unlock()
        return try await postScansResult(body)
    }
    func postRfidEnroll(assetId: String, _ body: KioskRfidEnrollIn) async throws -> KioskRfidEnroll { record("rfid"); await rfidGate?(); return try rfidResult(assetId, body) }
    func timeclockStatus(personId: String) async throws -> KioskTimeclockStatus { record("timeclockStatus"); return try statusResult(personId) }
    func clockIn(_ body: ClockInIn) async throws -> KioskTimeclockStatus { record("clockIn"); return try clockInResult(body) }
    func clockOut(_ body: ClockOutIn) async throws -> KioskTimeclockStatus { record("clockOut"); return try clockOutResult(body) }
    func fetchImage(url: String) async throws -> Data { record("image"); return try imageResult(url) }
}

/// A SessionRefresher whose answers are set per test (Android `FakeRefresher`).
final class FakeRefresher: SessionRefresher, @unchecked Sendable {
    private let lock = NSLock()
    private var _cleared = 0
    private var _stored: SessionData?
    var refreshResult: @Sendable () -> SessionData? = { nil }

    let sessionEnded: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation

    init() { (sessionEnded, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1)) }

    var cleared: Int { lock.lock(); defer { lock.unlock() }; return _cleared }
    var stored: SessionData? { lock.lock(); defer { lock.unlock() }; return _stored }

    func refresh() async -> SessionData? { refreshResult() }
    func store(_ data: SessionData) async { lock.lock(); _stored = data; lock.unlock() }
    func clear() async { lock.lock(); _cleared += 1; _stored = nil; lock.unlock() }
    func emitSessionEnded() { continuation.yield() }
}

func fakeSession(roles: [String] = ["worker"], maxRank: Int = 20, mustChange: Bool = false, kioskMove: KioskMove? = nil) -> SessionData {
    SessionData(
        accessToken: "tok", expiresIn: 900, sessionExpiresAt: "2026-09-16T00:00:00Z",
        person: PersonOut(id: "p1", firstName: "Tina", lastName: "T", displayName: "Tina T"),
        roles: roles, mustChangePassword: mustChange, perms: ["kiosk": ["view": true]], maxRank: maxRank, kioskMove: kioskMove
    )
}

func testSelection(initiativeId: String) -> KioskSetupSelection {
    KioskSetupSelection(initiativeId: initiativeId, initiativeName: "Move", siteId: "s1", siteName: "HQ", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
}

/// Polls `condition` on the main actor until it holds (or a 3 s timeout).
@MainActor func waitUntil(_ condition: @MainActor () -> Bool) async {
    for _ in 0..<300 {
        if condition() { return }
        try? await Task.sleep(for: .milliseconds(10))
    }
}

/// A hand-cranked sleeper: each `sleep` suspends until the test calls `tick()` (an early tick is banked).
actor TickGate {
    private var waiters: [CheckedContinuation<Void, Error>] = []
    private var credits = 0

    func sleep(_ d: Duration) async throws {
        if credits > 0 { credits -= 1; return }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiters.append($0) }
        } onCancel: { Task { await self.cancelAll() } }
    }

    func tick() { if waiters.isEmpty { credits += 1 } else { waiters.removeFirst().resume() } }
    private func cancelAll() { let w = waiters; waiters = []; for c in w { c.resume(throwing: CancellationError()) } }
}
