import Foundation

/// What sign-out's server calls send, captured before local state is cleared,
/// so they can run afterward (and never touch a later session).
struct SignOutCredentials: Equatable, Sendable {
    var apiUrl: String
    var accessToken: String?
    var refreshCookie: String? = nil
}

/// Every endpoint the kiosk calls - kiosk/src/lib/api.ts, function for function.
/// Implementations throw `ApiError` on any non-2xx or transport failure
/// unless a member says otherwise.
protocol KioskApi: Sendable {
    func login(email: String, password: String) async throws -> SessionData
    /// `POST /kiosk/move-login`: signs in as the move's hidden kiosk identity.
    func moveLogin(password: String) async throws -> SessionData
    /// `POST /auth/logout` with the refresh cookie captured at sign-out. Never
    /// throws and keeps no state: local state was already cleared.
    func logout(_ credentials: SignOutCredentials) async
    func systemStatus() async throws -> SystemStatus
    func createPairRequest(serial: String, name: String) async throws -> PairCreated
    /// 404 reads as `.expired`. An approved answer carries the session and its
    /// refresh cookie but keeps neither (`KioskAuth.completePair` does).
    func pollPair(code: String, pollToken: String) async throws -> PairPoll
    func heartbeat(_ body: HeartbeatIn) async throws -> HeartbeatResult
    /// `POST /kiosk/sign-out` with the token captured at sign-out. Never throws -
    /// the kiosk has dropped its own token either way.
    func signOut(serial: String, credentials: SignOutCredentials) async

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
