import Foundation

/// Ends the signed-in state when the session dies, and runs the heartbeat
/// exactly while a usable session exists and the app is in the foreground.
@MainActor
final class SessionCoordinator {
    private let refresher: SessionRefresher
    private let auth: KioskAuth
    private let heartbeat: Heartbeat
    private var listener: Task<Void, Never>?
    private var running = false

    init(refresher: SessionRefresher, auth: KioskAuth, heartbeat: Heartbeat) {
        self.refresher = refresher
        self.auth = auth
        self.heartbeat = heartbeat
    }

    func start() {
        listener?.cancel()
        let ended = refresher.sessionEnded
        listener = Task { [weak self] in
            for await _ in ended {
                guard let self else { return }
                self.heartbeat.stop()
                self.running = false
                self.auth.endSession()
            }
        }
    }

    /// Call when the auth state or scene phase changes; acts only on a change of the run condition.
    func evaluate(foreground: Bool) {
        var run = false
        if case .authed(let s) = auth.state { run = foreground && !s.mustChangePassword }
        guard run != running else { return }
        running = run
        if run { heartbeat.start(signIn: auth.takePendingSignIn()) } else { heartbeat.stop() }
    }
}
