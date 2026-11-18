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
/// the next tap or a change of setup (`shownError`). While a tap runs, `starting` is true and the
/// tiles are disabled.
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
    @ObservationIgnored private let prefs: KioskPrefs
    /// The setup selection when last looked at (`followSetup`).
    @ObservationIgnored private var seenSetup: KioskSetupSelection?

    init(api: KioskApi, station: TimeclockStation, heartbeat: Heartbeat, auth: KioskAuth, prefs: KioskPrefs) {
        self.api = api
        self.station = station
        self.heartbeat = heartbeat
        self.auth = auth
        self.prefs = prefs
        seenSetup = prefs.setupSelection
        followSetup()
    }

    private var isTimeclockStation: Bool { prefs.setupSelection?.isTimeclockStation == true }

    /// What Home shows above the tiles: the error, only while this kiosk is a Time Clock station.
    var shownError: String? { isTimeclockStation ? error : nil }

    /// A new setup (a Regular re-setup, a Clear Setup, a move session dropping it) makes the last
    /// tap's error stale: it goes. The setup can change while Home isn't on screen, so the model
    /// follows it rather than the view.
    private func followSetup() {
        withObservationTracking {
            _ = prefs.setupSelection
        } onChange: { [weak self] in
            // onChange runs before the new value is set: look on the next main-actor turn.
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.prefs.setupSelection != self.seenSetup {
                    self.seenSetup = self.prefs.setupSelection
                    self.error = nil
                }
                self.followSetup()
            }
        }
    }

    /// The tile's tap. Does nothing while a tap runs. The sign-out is for the person who tapped:
    /// a session that ended or changed while the key was on its way is left alone (the key is
    /// still kept: it belongs to the kiosk, not to the person). A setup that stopped being a Time
    /// Clock station meanwhile (a Clear Setup) drops the key and signs nobody out.
    func start() async {
        guard !starting, case .authed(let session) = auth.state else { return }
        starting = true
        error = nil
        defer { starting = false }
        if station.credentials() == nil {
            do {
                try await station.issueKey(api: api, signInBeat: { await heartbeat.signInNow() })
            } catch {
                if isTimeclockStation { self.error = (error as? ApiError).map(startTimeclockError) ?? Self.failedText }
                return
            }
            // The key was issued for a Time Clock station this kiosk no longer is.
            guard isTimeclockStation else {
                station.clearKey()
                return
            }
        }
        guard case .authed(let now) = auth.state, now.person.id == session.person.id else { return }
        await auth.logout()
    }
}
