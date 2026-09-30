import Foundation
import Observation

let PAIR_POLL_INTERVAL: TimeInterval = 2

enum PairPhase: Equatable { case requesting, showing, denied, expired, error }

/// "ABCD1234" → "ABCD-1234".
func formatPairCode(_ code: String) -> String {
    code.count > 4 ? "\(code.prefix(4))-\(code.dropFirst(4))" : code
}

/// The host of a URL, or the text itself when it has none.
func portalHost(_ url: String) -> String { URL(string: url)?.host() ?? url }

/// Seconds as "m:ss".
func formatRemaining(_ seconds: Int) -> String {
    "\(seconds / 60):" + String(format: "%02d", seconds % 60)
}

/// Android `PairPanel.kt`'s state holder: request a code, count down, poll
/// every 2 s; an approved pair signs the kiosk in.
@MainActor @Observable
final class PairViewModel {
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let auth: KioskAuth
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    private(set) var phase: PairPhase = .requesting
    private(set) var pair: PairCreated?
    private(set) var error = ""
    private(set) var remainingSec = 0

    init(api: KioskApi, identity: Identity, auth: KioskAuth,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         clock: @escaping () -> Date = Date.init) {
        self.api = api
        self.identity = identity
        self.auth = auth
        self.sleep = sleep
        self.clock = clock
    }

    /// A fresh code, then the poll loop (the panel's first appearance, Try again, Get a new code).
    func begin() async {
        await request()
        if phase == .showing { startPolling() }
    }

    func request() async {
        generation += 1
        let mine = generation
        pollTask?.cancel()
        pollTask = nil
        phase = .requesting
        pair = nil
        error = ""
        let me = identity.current
        do {
            let created = try await api.createPairRequest(serial: me.serial, name: me.name)
            guard mine == generation else { return }
            pair = created
            remainingSec = remaining(created)
            phase = .showing
        } catch {
            guard mine == generation else { return }
            self.error = switch (error as? ApiError)?.code {
            case "pair_rate_limited": "too many codes requested — wait a few minutes"
            case "network": "network error"
            default: "server error"
            }
            phase = .error
        }
    }

    /// Ticks the countdown each second and polls every 2 s while showing a code.
    func startPolling() {
        pollTask?.cancel()
        let mine = generation
        pollTask = Task { [weak self] in
            guard let start = self?.clock() else { return }
            var nextPoll = start.addingTimeInterval(PAIR_POLL_INTERVAL)
            while true {
                guard let sleep = self?.sleep else { return }
                do { try await sleep(.seconds(1)) } catch { return }
                guard let self, !Task.isCancelled, mine == self.generation,
                      self.phase == .showing, let pair = self.pair else { return }
                let left = self.remaining(pair)
                self.remainingSec = left
                if left <= 0 { self.phase = .expired; return }
                if self.clock() < nextPoll { continue }
                nextPoll = self.clock().addingTimeInterval(PAIR_POLL_INTERVAL)
                guard let result = try? await self.api.pollPair(code: pair.code, pollToken: pair.pollToken) else {
                    continue   // transient; the next tick retries
                }
                guard !Task.isCancelled, mine == self.generation else { return }
                switch result.status {
                case .approved:
                    if let session = result.session { self.auth.completePair(session); return }
                case .denied: self.phase = .denied; return
                case .expired: self.phase = .expired; return
                case .pending: break
                }
            }
        }
    }

    /// Stops the poll loop now (the pair view was left).
    func stop() {
        pollTask?.cancel()
        pollTask = nil
        generation += 1
    }

    private func remaining(_ p: PairCreated) -> Int {
        guard let expires = parseInstant(p.expiresAt) else { return 0 }
        return max(0, Int(expires.timeIntervalSince(clock())))
    }
}

