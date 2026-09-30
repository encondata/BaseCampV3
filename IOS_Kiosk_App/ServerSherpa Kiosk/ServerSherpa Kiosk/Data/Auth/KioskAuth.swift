import Foundation
import Observation

enum LoginMethod: String, Sendable { case password, link }

enum AuthState: Equatable {
    case loading, anon
    case authed(SessionData)
}

extension SessionData {
    var isAdmin: Bool { maxRank >= ADMIN_RANK }
    var isDeveloper: Bool { roles.contains("developer") }
}

/// kiosk/src/auth/KioskAuthContext.tsx without the React.
@MainActor @Observable
final class KioskAuth {
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let refresher: SessionRefresher
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let prefs: KioskPrefs

    private(set) var state: AuthState = .loading

    /// Set only by login()/moveLogin()/completePair(), never by a cookie restore,
    /// so the API can auto-register the kiosk and record how the person signed in.
    @ObservationIgnored private var pendingSignIn: LoginMethod?

    /// Runs first in `logout()`; the container points it at `heartbeat.stop()`.
    @ObservationIgnored var onLogout: (@MainActor () -> Void)?

    init(api: KioskApi, refresher: SessionRefresher, identity: Identity, prefs: KioskPrefs) {
        self.api = api
        self.refresher = refresher
        self.identity = identity
        self.prefs = prefs
    }

    /// Cookie restore on launch.
    func restore() async {
        if let data = await refresher.refresh() { apply(data) } else { state = .anon }
    }

    func login(email: String, password: String) async throws {
        let data = try await api.login(email: email, password: password)
        pendingSignIn = .password
        apply(data)
    }

    /// The web's rule: the heartbeat only knows password | link, so a move password is "password".
    func moveLogin(password: String) async throws {
        let data = try await api.moveLogin(password: password)
        pendingSignIn = .password
        apply(data)
    }

    /// The pair poll has already stored the session with the refresher.
    func completePair(_ data: SessionData) {
        pendingSignIn = .link
        apply(data)
    }

    func logout() async {
        onLogout?()
        await api.signOut(serial: identity.current.serial)
        await api.logout()
        await refresher.clear()
        state = .anon
    }

    /// The session died underneath us (SessionCoordinator).
    func endSession() { state = .anon }

    func can(_ resource: String, _ action: String) -> Bool {
        guard case .authed(let s) = state else { return computeCan(nil, resource, action) }
        return computeCan(s.perms, resource, action)
    }

    /// The heartbeat consumes this exactly once per sign-in.
    func takePendingSignIn() -> LoginMethod? {
        defer { pendingSignIn = nil }
        return pendingSignIn
    }

    /// Enters `.authed`. A move session for a different initiative than the
    /// saved setup drops that selection (KioskAuthContext's rule).
    private func apply(_ session: SessionData) {
        if let move = session.kioskMove, let saved = prefs.setupSelection, saved.initiativeId != move.initiativeId {
            prefs.setupSelection = nil
            prefs.setupState = .incomplete
        }
        state = .authed(session)
    }
}
