import Foundation
import Observation

/// While someone is signed in and the app is in front: an immediate beat,
/// then one a minute. Each beat upserts the kiosk's Device row and returns
/// the registration state. Failures keep the last state (and any pending
/// sign_in) and are retried next tick.
@MainActor @Observable
final class Heartbeat {
    private(set) var registration: RegistrationState?

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let version: String
    @ObservationIgnored private let rawInfo: @MainActor () -> [String: String]
    @ObservationIgnored private let interval: Duration
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var pendingSignIn: LoginMethod?

    init(
        api: KioskApi,
        identity: Identity,
        version: String,
        rawInfo: @escaping @MainActor () -> [String: String] = DeviceInfo.rawInfo,
        interval: Duration = .seconds(60),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.api = api
        self.identity = identity
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
        task?.cancel()
        task = nil
        registration = nil
    }

    /// Beat right now (after a rename). Resolves after the attempt.
    func now() async { await beat() }

    private func beat() async {
        let me = identity.current
        let asSignIn = pendingSignIn
        let body = HeartbeatIn(serial: me.serial, name: me.name, mode: "ios", version: version, rawInfo: rawInfo(), signIn: asSignIn != nil, loginMethod: asSignIn?.rawValue)
        do {
            let result = try await api.heartbeat(body)
            if Task.isCancelled { return }
            if let asSignIn, pendingSignIn == asSignIn { pendingSignIn = nil }
            registration = RegistrationState.fromWire(result.registration) ?? RegistrationState.none
        } catch {
            // keep the last known state and any pending sign-in
        }
    }
}
