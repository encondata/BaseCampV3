import Foundation
import Observation

/// What the last update check left: nothing yet, one out, its offer, or why it failed.
enum UpdateCheckState: Equatable {
    case idle
    case checking
    case done(UpdateOffer)
    case failed(String)
}

/// Asks the Devices site for a newer build and holds what Home and Settings show. Checks only
/// while signed in: after sign-in and on foreground once `interval` has passed since the last
/// check (`checkIfDue`), and whenever Settings asks (`checkNow`). One request at a time: a check
/// asked for while one is out waits for that one. A failed check keeps the last offer for Home.
/// Later hides the offer on Home until another one comes (in memory: a relaunch shows it again).
@MainActor @Observable
final class UpdateChecker {
    static let interval: TimeInterval = 6 * 3600

    static let noDevicesUrlMessage = "This kiosk's API address doesn't start with api., so the Devices site can't be found."

    private(set) var state: UpdateCheckState = .idle
    /// When the last check finished (answered or failed); nil before the first one.
    private(set) var lastChecked: Date?
    let installed: InstalledApp

    /// The last answer's offer, kept through a failed check that follows it.
    private var lastOffer: UpdateOffer?
    /// The offer Later hid from Home.
    private var hidden: UpdateOffer?

    @ObservationIgnored private let api: any DevicesApi
    @ObservationIgnored private let devicesUrl: @MainActor () -> String?
    @ObservationIgnored private let signedIn: @MainActor () -> Bool
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    /// Bumped by `reset()`, so a check out at sign-out drops its answer.
    @ObservationIgnored private var generation = 0

    init(api: any DevicesApi, installed: InstalledApp, devicesUrl: @escaping @MainActor () -> String?,
         signedIn: @escaping @MainActor () -> Bool, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.installed = installed
        self.devicesUrl = devicesUrl
        self.signedIn = signedIn
        self.now = now
    }

    /// The offer Home shows: one with Update, or register first; nil once Later hid it.
    var homeOffer: UpdateOffer? {
        guard let offer = lastOffer, offer.showsOnHome, offer != hidden else { return nil }
        return offer
    }

    /// The Devices site's host, for copy; nil when the API URL has none.
    var devicesHost: String? {
        devicesUrl().flatMap { URLComponents(string: $0)?.host }
    }

    /// Checks now (Settings' Check for updates), or joins the check already out. Nothing while
    /// signed out.
    func checkNow() async {
        guard signedIn() else { return }
        if let running = inFlight { await running.value; return }
        let generation = generation
        let task = Task { await self.run(generation: generation) }
        inFlight = task
        await task.value
    }

    /// Checks when signed in and the last check is `interval` old or there was none.
    func checkIfDue() async {
        guard signedIn() else { return }
        if let last = lastChecked, now().timeIntervalSince(last) < Self.interval { return }
        await checkNow()
    }

    /// Hides the current offer from Home; Settings still shows it.
    func later() {
        hidden = lastOffer
    }

    /// Sign-out: forgets the checks, the offer and Later; a check out drops its answer.
    func reset() {
        generation += 1
        inFlight?.cancel()
        inFlight = nil
        state = .idle
        lastChecked = nil
        lastOffer = nil
        hidden = nil
    }

    private func run(generation: Int) async {
        defer { if generation == self.generation { inFlight = nil } }
        guard let url = devicesUrl() else {
            finish(.failed(Self.noDevicesUrlMessage))
            return
        }
        state = .checking
        let result: UpdateCheckState
        do {
            let answer = try await api.checkUpdates(installed.query)
            guard generation == self.generation else { return }
            let offer = updateOffer(answer, profile: installed.profile, devicesUrl: url)
            lastOffer = offer
            result = .done(offer)
        } catch {
            guard generation == self.generation else { return }
            result = .failed(message(for: error))
        }
        finish(result)
    }

    private func finish(_ result: UpdateCheckState) {
        state = result
        lastChecked = now()
    }

    private func message(for error: Error) -> String {
        if let error = error as? DevicesApiError, error == .noDevicesUrl { return Self.noDevicesUrlMessage }
        guard let error = error as? ApiError else { return "The update check didn't finish. Try again." }
        if error.isNetwork { return "Can't reach \(devicesHost ?? "the Devices site")." }
        if let message = error.detailString("message"), !message.isEmpty { return message }
        return "The Devices site answered \(error.status)."
    }
}
