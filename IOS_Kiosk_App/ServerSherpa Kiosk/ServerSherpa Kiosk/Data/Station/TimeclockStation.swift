import Foundation
import Observation

/// Signed out, a Time Clock station rests on its Welcome screen instead of sign-in, unless
/// someone asked for sign-in (Welcome's gear). The key is not part of the rule: a station whose
/// key is missing still rests on Welcome, with the "waiting for its station key" copy.
func stationRests(selection: KioskSetupSelection?, loginRequested: Bool) -> Bool {
    selection?.isTimeclockStation == true && !loginRequested
}

/// The sign-in screen offers "Back to the time clock" on a Time Clock station (it is only ever
/// shown there after the gear, since a resting station shows Welcome instead).
func loginOffersBackToTimeclock(selection: KioskSetupSelection?) -> Bool {
    selection?.isTimeclockStation == true
}

/// "scheme://host:port" of an http(s) URL (default ports spelled out), lowercased; nil otherwise.
func apiOrigin(_ url: String) -> String? {
    guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = u.host?.lowercased(), !host.isEmpty else { return nil }
    let port = u.port ?? (scheme == "https" ? 443 : 80)
    return "\(scheme)://\(host):\(port)"
}

/// Whether the sign-in page's Settings sheet (This Kiosk, open signed out) stays up. On a Time
/// Clock station it closes as soon as the sign-in request ends (Back, a sign-in, or the quiet
/// minute running out), so nobody leaves the station stuck in Settings.
func loginSettingsSheetShown(_ open: Bool, selection: KioskSetupSelection?, loginRequested: Bool) -> Bool {
    open && (selection?.isTimeclockStation != true || loginRequested)
}

/// The Time Clock station's live state (the web's `GET /edge/timeclock/station`, kept on the
/// device since there is no edge): whether the key is there, whether the portal paused the
/// station, and whether Welcome's gear asked for the sign-in page.
///
/// The key is bound to the API origin that issued it: a call is made only while the kiosk's API
/// URL still has that origin, and a changed origin drops the key (the station then waits for a
/// new one), so a signed-out person who edits the API URL can never send the key elsewhere.
///
/// Every key write goes through here so `hasKey` never disagrees with the Keychain. The
/// station's calls report back what the portal said about the key:
///  - 401 `station_key_invalid` and 403 `wrong_station_type` drop it (waiting copy);
///  - 403 `kiosk_not_registered` keeps it and pauses the station (paused copy);
///  - any answer from the portal un-pauses it (someone signed in here, or an admin renewed it).
@MainActor @Observable
final class TimeclockStation {
    /// How long an untouched sign-in page waits before going back to the time clock (web
    /// `TIMECLOCK_RETURN_MS`).
    static let loginReturn: Duration = .seconds(60)

    private(set) var hasKey: Bool
    /// The portal answered 403 `kiosk_not_registered`: a lapsed registration, key kept.
    private(set) var registrationPaused = false
    /// Welcome's gear asked for sign-in; cleared by "Back to the time clock", a quiet minute on
    /// the sign-in page, or a sign-in.
    private(set) var loginRequested = false

    /// Welcome takes nobody: the key is missing or the registration lapsed.
    var welcomePaused: Bool { !hasKey || registrationPaused }
    /// Welcome's notice is the "waiting for its station key" copy rather than the paused one.
    var welcomeKeyMissing: Bool { !hasKey }

    @ObservationIgnored private let keys: StationKeyStore
    @ObservationIgnored private let serial: @MainActor () -> String
    @ObservationIgnored private let apiUrl: @MainActor () -> String
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var loginTimer: Task<Void, Never>?

    /// `apiUrl`: the kiosk's current API URL (`KioskConfig.apiUrl`).
    init(keys: StationKeyStore, serial: @escaping @MainActor () -> String, apiUrl: @escaping @MainActor () -> String,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.keys = keys
        self.serial = serial
        self.apiUrl = apiUrl
        self.sleep = sleep
        hasKey = keys.get() != nil
        _ = credentials()   // a key from another origin is dropped at once
    }

    // MARK: the key

    /// The key and the kiosk's serial for a station call; nil without a key. A key whose origin
    /// is not the current API URL's (or that has none) is dropped and nothing is sent.
    func credentials() -> (key: String, serial: String)? {
        guard let key = keys.get() else {
            hasKey = false
            return nil
        }
        guard let bound = keys.origin(), bound == apiOrigin(apiUrl()) else {
            clearKey()
            return nil
        }
        hasKey = true
        return (key, serial())
    }

    /// A freshly issued key (Kiosk Setup's Time Clock finish), bound to the current API origin.
    func storeKey(_ key: String) {
        keys.put(key, origin: apiOrigin(apiUrl()))
        hasKey = keys.get() != nil
        registrationPaused = false
    }

    /// The API URL is about to change to `newUrl` (Settings › This Kiosk, signed in or not): a
    /// different origin drops the key.
    func apiUrlChanging(to newUrl: String) {
        guard keys.get() != nil, keys.origin() != apiOrigin(newUrl) else { return }
        clearKey()
    }

    /// A Regular re-setup, Reset app, a move session dropping the setup, or a key the portal refused.
    func clearKey() {
        keys.clear()
        hasKey = false
        registrationPaused = false
    }

    /// The portal answered a call made with `key`.
    func noteAnswered() { registrationPaused = false }

    /// A station call made with `key` failed with `error`. A refusal of a key that has since been
    /// replaced (a setup issued a new one meanwhile) leaves the new one alone.
    func noteFailure(_ error: Error, key: String) {
        guard let api = error as? ApiError, !api.isNetwork else { return }
        switch (api.status, api.code) {
        case (401, "station_key_invalid"), (403, "wrong_station_type"):
            if keys.get() == key { clearKey() }
        case (403, "kiosk_not_registered"):
            registrationPaused = true
        default:
            // any other answer still came from the portal under this key
            registrationPaused = false
        }
    }

    // MARK: Welcome's gear and the sign-in page

    /// Welcome's gear: show the sign-in page, which returns here after a quiet minute.
    func requestLogin() {
        loginRequested = true
        restartLoginTimer()
    }

    /// A touch or keystroke on the sign-in page, or in the Settings sheet it opens, restarts its
    /// quiet minute.
    func noteLoginActivity() {
        guard loginRequested else { return }
        restartLoginTimer()
    }

    /// "Back to the time clock", or the quiet minute running out.
    func backToTimeclock() {
        loginTimer?.cancel()
        loginTimer = nil
        loginRequested = false
    }

    /// Someone signed in: a later sign-out rests on Welcome again.
    func signedIn() { backToTimeclock() }

    private func restartLoginTimer() {
        loginTimer?.cancel()
        loginTimer = Task { [weak self, sleep] in
            do { try await sleep(Self.loginReturn) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.backToTimeclock()
        }
    }
}
