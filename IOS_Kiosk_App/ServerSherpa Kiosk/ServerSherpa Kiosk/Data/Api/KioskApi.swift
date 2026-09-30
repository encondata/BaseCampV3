import Foundation

/// Every endpoint the kiosk calls - kiosk/src/lib/api.ts, function for function.
/// Implementations throw `ApiError` on any non-2xx or transport failure
/// unless a member says otherwise.
protocol KioskApi: Sendable {
    func login(email: String, password: String) async throws -> SessionData
    /// `POST /kiosk/move-login`: signs in as the move's hidden kiosk identity.
    func moveLogin(password: String) async throws -> SessionData
    /// Never throws - an offline logout still clears local state.
    func logout() async
    func systemStatus() async throws -> SystemStatus
    func createPairRequest(serial: String, name: String) async throws -> PairCreated
    /// 404 reads as `.expired`; an approved answer stores the session.
    func pollPair(code: String, pollToken: String) async throws -> PairPoll
    func heartbeat(_ body: HeartbeatIn) async throws -> HeartbeatResult
    /// Never throws - the kiosk is dropping its own token either way.
    func signOut(serial: String) async

    // MARK: setup & sync

    func setupOptions() async throws -> SetupOptions
    func submitSetup(_ body: KioskSetupIn) async throws -> KioskSetupResult
    func syncAssets(initiativeId: String) async throws -> KioskAssetsSync
    func syncPeople() async throws -> KioskPeopleSync
    func syncContainers(initiativeId: String) async throws -> KioskContainersSync
    func syncTrucks(initiativeId: String) async throws -> KioskTrucksSync

    // MARK: scans, RFID, timeclock

    /// Idempotent on client_scan_id; throws on anything but 200 (the outbox's back-off signal).
    func postScans(_ body: KioskScanBatchIn) async throws -> KioskScanBatchOut
    /// 409 rfid_in_use (detail asset_name), 422 bad_rfid/rfid_too_long, 404, 423, network.
    func postRfidEnroll(assetId: String, _ body: KioskRfidEnrollIn) async throws -> KioskRfidEnroll
    func timeclockStatus(personId: String) async throws -> KioskTimeclockStatus
    func clockIn(_ body: ClockInIn) async throws -> KioskTimeclockStatus
    func clockOut(_ body: ClockOutIn) async throws -> KioskTimeclockStatus

    /// Unauthenticated GET of an absolute (presigned) URL, e.g. an avatar.
    func fetchImage(url: String) async throws -> Data
}
