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
/// answer (`checkIfDue`; a failed check doesn't count, so the next foreground tries again), and
/// whenever Settings asks (`checkNow`). One request at a time: a check
/// asked for while one is out waits for that one. A failed check keeps the last offer for Home.
/// Later hides the offer on Home until another version or build comes (in memory: a relaunch shows
/// it again). Update never opens a kept link: the install link expires 30 minutes after the answer
/// that carried it, so `freshInstallUrl` asks again first.
@MainActor @Observable
final class UpdateChecker {
    static let interval: TimeInterval = 6 * 3600

    static let noDevicesUrlMessage = "This kiosk's API address doesn't start with api., so the Devices site can't be found."
    /// A Devices 401/403: it couldn't verify the kiosk's token with the main API. Says nothing
    /// about the kiosk session, which stays signed in.
    static let notConfirmedMessage = "The Devices site couldn't confirm this sign-in. Try again later."

    private(set) var state: UpdateCheckState = .idle
    /// When the last check finished (answered or failed), for Settings' Last checked; nil before
    /// the first one.
    private(set) var lastChecked: Date?
    /// When the Devices site last answered: the 6-hour gate counts from here.
    @ObservationIgnored private var lastAnswered: Date?
    let installed: InstalledApp

    /// The last answer's offer, kept through a failed check that follows it (Home's card and
    /// Settings' detail under a failure).
    private(set) var lastOffer: UpdateOffer?
    /// What Later hid from Home: the offer's version and build, not the offer itself (its install
    /// link is new on every answer).
    private var hidden: LaterKey?

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
        guard let offer = lastOffer, offer.showsOnHome, LaterKey(offer) != hidden else { return nil }
        return offer
    }

    /// Update's tap: checks now (or joins the check already out) and returns the install link
    /// only when that answer offers one, an `itms-services` link. Otherwise nil, and `state` says
    /// why (up to date now, not ready, or the failure).
    func freshInstallUrl() async -> URL? {
        guard signedIn() else { return nil }
        await checkNow()
        guard case .done(.available(_, _, _, _, let url)) = state,
              url.scheme?.lowercased() == "itms-services" else { return nil }
        return url
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

    /// Checks when signed in and the last answer is `interval` old or there was none.
    func checkIfDue() async {
        guard signedIn() else { return }
        if let last = lastAnswered, now().timeIntervalSince(last) < Self.interval { return }
        await checkNow()
    }

    /// Hides the current offer from Home; Settings still shows it.
    func later() {
        hidden = lastOffer.flatMap(LaterKey.init)
    }

    /// Sign-out: forgets the checks, the offer and Later; a check out drops its answer.
    func reset() {
        generation += 1
        inFlight?.cancel()
        inFlight = nil
        state = .idle
        lastChecked = nil
        lastAnswered = nil
        lastOffer = nil
        hidden = nil
    }

    private func run(generation: Int) async {
        // A sign-out after `checkNow` queued this run but before it started: nothing to do.
        guard generation == self.generation else { return }
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
            lastAnswered = now()
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
        if error.status == 401 || error.status == 403 { return Self.notConfirmedMessage }
        if let message = error.detailString("message"), !message.isEmpty { return message }
        return "The Devices site answered \(error.status)."
    }
}

/// What Later remembers about the offer it hid: a build by version and build, a register-first
/// message by its text.
private enum LaterKey: Equatable {
    case build(version: String, build: String?)
    case registerFirst(String)

    init?(_ offer: UpdateOffer) {
        switch offer {
        case .available(let version, let build, _, _, _): self = .build(version: version, build: build)
        case .registerFirst(let message): self = .registerFirst(message)
        case .upToDate, .waiting: return nil
        }
    }
}
