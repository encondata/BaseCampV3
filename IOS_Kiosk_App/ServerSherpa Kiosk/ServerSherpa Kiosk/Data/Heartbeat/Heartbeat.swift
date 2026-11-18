import Foundation
import Observation

/// While someone is signed in and the app is in front: an immediate beat,
/// then one a minute. Each beat upserts the kiosk's Device row and returns
/// the registration state. Failures keep the last state (and any pending
/// sign_in) and are retried next tick.
///
/// A Clear Setup the reply asks for (Android `Heartbeat`) is applied once (setup dropped, Setup
/// banner raised), announced on `setupClearSignal` and `onSetupCleared`, and acknowledged on an
/// immediate re-beat and every beat after until the reply stops asking for it. A reply that
/// lands after `stop()` (sign-out, the app leaving the front, a session that ended) is dropped
/// whole, so a beat sent for one session never changes the next one.
@MainActor @Observable
final class Heartbeat {
    private(set) var registration: RegistrationState?
    /// Goes up by one each time a Clear Setup is applied: the UI's cue to take whoever is signed
    /// in to Kiosk Setup (`SetupClearedRedirect`). It never goes up for an id applied before.
    private(set) var setupClearSignal = 0
    /// Runs with the id each time a Clear Setup is applied; the container points it at dropping a
    /// Time Clock station key (Android `setupCleared` → `stationKeys.clear()`).
    @ObservationIgnored var onSetupCleared: (@MainActor (String) -> Void)?

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let version: String
    @ObservationIgnored private let rawInfo: @MainActor () -> [String: String]
    @ObservationIgnored private let interval: Duration
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var pendingSignIn: LoginMethod?
    /// Bumped by `stop()` (and so by `start()`): a beat whose reply lands under a newer
    /// generation belongs to a stopped heartbeat and is dropped.
    @ObservationIgnored private var generation = 0

    init(
        api: KioskApi,
        identity: Identity,
        prefs: KioskPrefs,
        version: String,
        rawInfo: @escaping @MainActor () -> [String: String] = DeviceInfo.rawInfo,
        interval: Duration = .seconds(60),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.api = api
        self.identity = identity
        self.prefs = prefs
        self.version = version
        self.rawInfo = rawInfo
        self.interval = interval
        self.sleep = sleep
    }

    func start(signIn: LoginMethod?) {
        stop()
        if let signIn { pendingSignIn = signIn }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.beat()
                let interval = self.interval, sleep = self.sleep
                do { try await sleep(interval) } catch { return }
            }
        }
    }

    func stop() {
        generation += 1
        task?.cancel()
        task = nil
        registration = nil
    }

    /// Beat right now (after a rename). Resolves after the attempt.
    func now() async { await beat() }

    /// A sign-in beat right now: the portal records this person as signed in here again (Kiosk
    /// Setup's station key needs that, 403 `not_signed_in_here` otherwise). Resolves after the attempt.
    /// A failed attempt leaves nothing pending, so a later beat never records a second sign-in.
    func signInNow(_ method: LoginMethod) async {
        await beat(signIn: method)
    }

    /// `signIn`: a one-off sign-in beat (`signInNow`); otherwise any pending sign-in rides along.
    /// Every beat carries a Clear Setup ack still owed (`setup_cleared`).
    private func beat(signIn: LoginMethod? = nil) async {
        let started = generation
        let me = identity.current
        let asSignIn = signIn ?? pendingSignIn
        let ack = prefs.pendingSetupClearAck()
        let body = HeartbeatIn(serial: me.serial, name: me.name, mode: "ios", version: version, rawInfo: rawInfo(), signIn: asSignIn != nil, loginMethod: asSignIn?.rawValue,
                               setupCleared: ack)
        do {
            let result = try await api.heartbeat(body)
            // stop() ran meanwhile: the reply is dropped whole (no ack, no clear, no registration)
            guard started == generation, !Task.isCancelled else { return }
            if let asSignIn, pendingSignIn == asSignIn { pendingSignIn = nil }
            prefs.settleSetupClearAck(sentAck: ack, replyId: result.clearSetup)
            // True only the first time for an id, so the re-beat below happens at most once per
            // clear: a server repeating the id can't drive a loop.
            let asked = result.clearSetup
            let applied = asked.map { prefs.applySetupClear($0) } ?? false
            registration = RegistrationState.fromWire(result.registration) ?? RegistrationState.none
            if applied, let asked {
                setupClearSignal += 1
                onSetupCleared?(asked)
                if task != nil { await beat() }   // the loop runs: acknowledge right away
            }
        } catch {
            // keep the last known state, any pending sign-in and any unsent ack
        }
    }
}
