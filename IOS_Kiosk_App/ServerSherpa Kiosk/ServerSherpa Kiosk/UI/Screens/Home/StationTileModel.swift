import Foundation
import Observation

/// Start Time Clock's errors (web `StartTimeclock.tsx`, Android `startTimeclockError`): the key is
/// what can go wrong here.
func startTimeclockError(_ e: ApiError) -> String {
    if e.isNetwork { return "The station key hasn't arrived yet. Check the connection and try again in a minute." }
    if e.code == "move_locked" { return "A move password can't start the time clock. Sign in with your own account." }
    return "Couldn't start the time clock (\(e.code)). Try again."
}

/// A Time Clock station's Home tile (the web's Start Time Clock; Android `HomeScreen.startTimeclock`
/// and `AppContainer.startTimeclock`). It makes sure the station has its key, issuing one under
/// the signed-in session when it is missing (`TimeclockStation.issueKey`: one sign-in beat and one
/// retry on `not_signed_in_here`), then signs the person out, which leaves the station on Welcome.
///
/// A key that can't be had keeps the person signed in, with `error` (red, above the tiles) until
/// the next tap. While a tap runs, `starting` is true and the tiles are disabled.
@MainActor @Observable
final class StationTileModel {
    /// Anything that went wrong that isn't the portal's answer (Android's fallback).
    static let failedText = "Couldn't start the time clock. Try again."

    private(set) var starting = false
    private(set) var error: String?

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let station: TimeclockStation
    @ObservationIgnored private let heartbeat: Heartbeat
    @ObservationIgnored private let auth: KioskAuth

    init(api: KioskApi, station: TimeclockStation, heartbeat: Heartbeat, auth: KioskAuth) {
        self.api = api
        self.station = station
        self.heartbeat = heartbeat
        self.auth = auth
    }

    /// The tile's tap. Does nothing while a tap runs. The sign-out is for the person who tapped:
    /// a session that ended or changed while the key was on its way is left alone (the key is
    /// still kept: it belongs to the kiosk, not to the person).
    func start() async {
        guard !starting, case .authed(let session) = auth.state else { return }
        starting = true
        error = nil
        defer { starting = false }
        if station.credentials() == nil {
            do {
                try await station.issueKey(api: api, signInBeat: { await heartbeat.signInNow() })
            } catch {
                self.error = (error as? ApiError).map(startTimeclockError) ?? Self.failedText
                return
            }
        }
        guard case .authed(let now) = auth.state, now.person.id == session.person.id else { return }
        await auth.logout()
    }
}
