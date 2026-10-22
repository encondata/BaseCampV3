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

    // MARK: labels

    /// The /kiosk/sync/assets body as text, exactly as sent: label generation reads each
    /// asset's raw JSON (its number literals as written), so it is never re-serialized.
    func assetsSyncRaw(initiativeId: String) async throws -> String
    /// The /kiosk/sync/label-templates body as text, exactly as sent.
    func labelTemplatesRaw(initiativeId: String) async throws -> String
    func labelFonts(initiativeId: String) async throws -> KioskLabelFonts
    /// The font file's bytes. 404 font_not_found; 403 font_not_servable for a resident font.
    func labelFontContent(id: String, initiativeId: String) async throws -> Data

    // MARK: scans, RFID, timeclock

    /// Idempotent on client_scan_id; throws on anything but 200 (the outbox's back-off signal).
    func postScans(_ body: KioskScanBatchIn) async throws -> KioskScanBatchOut
    /// 409 rfid_in_use (detail asset_name), 422 bad_rfid/rfid_too_long, 404, 423, network.
    func postRfidEnroll(assetId: String, _ body: KioskRfidEnrollIn) async throws -> KioskRfidEnroll
    /// `serial` names the kiosk so "today" is its site's day; `tz` (the kiosk's own IANA
    /// zone) is the day when the site has none. Either is left out of the query when nil.
    func timeclockStatus(personId: String, serial: String?, tz: String?) async throws -> KioskTimeclockStatus
    func clockIn(_ body: ClockInIn) async throws -> KioskTimeclockStatus
    func clockOut(_ body: ClockOutIn) async throws -> KioskTimeclockStatus

    // MARK: Time Clock station

    /// `POST /kiosk/station-key` under the signed-in session: a new station key for this
    /// kiosk, shown once. 403 `not_signed_in_here` until a heartbeat registered the session.
    func issueStationKey(serial: String) async throws -> String

    /// Unauthenticated GET of an absolute (presigned) URL, e.g. an avatar.
    func fetchImage(url: String) async throws -> Data
}
