import Foundation
import Observation

// MARK: - Move dates (Android `formatMoveDates`)

private func moveDay(_ iso: String) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = parser.date(from: iso)
    if date == nil {
        parser.formatOptions = [.withInternetDateTime]
        date = parser.date(from: iso)
    }
    guard let date else { return String(iso.prefix(10)) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "MMM d"
    return formatter.string(from: date)
}

/// "Sep 20 – Sep 22" / "Starts Sep 20" / "Ends Sep 22" / nil.
func formatMoveDates(_ i: SetupOptionInitiative) -> String? {
    let s = i.scheduledStart.map(moveDay), e = i.scheduledEnd.map(moveDay)
    switch (s, e) {
    case let (s?, e?): return "\(s) – \(e)"
    case let (s?, nil): return "Starts \(s)"
    case let (nil, e?): return "Ends \(e)"
    default: return nil
    }
}

/// "#abc" / "#aabbcc" → 0xRRGGBB; anything else → slate (0x8A97AA).
func parseCssHex(_ css: String) -> UInt32 {
    var v = css.trimmingCharacters(in: .whitespaces)
    if v.hasPrefix("#") { v.removeFirst() }
    if v.count == 3 { v = v.map { "\($0)\($0)" }.joined() }
    guard v.count == 6, let n = UInt32(v, radix: 16) else { return 0x8A97AA }
    return n
}

// MARK: - View model

/// kiosk/src/pages/KioskSetup.tsx: Move → Site → Scan type, then the summary.
@MainActor @Observable
final class KioskSetupViewModel {
    enum Step { case move, site, scanType, summary }

    private(set) var step: Step
    private(set) var options: SetupOptions?
    private(set) var loadError: String?
    private(set) var saving = false
    /// The API error code of the last failed save.
    private(set) var saveError: String?
    private(set) var initiativeId = ""
    private(set) var siteId = ""
    private(set) var scanStatus = ""

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let sync: Sync
    @ObservationIgnored private let auth: KioskAuth

    init(api: KioskApi, identity: Identity, prefs: KioskPrefs, sync: Sync, auth: KioskAuth) {
        self.api = api
        self.identity = identity
        self.prefs = prefs
        self.sync = sync
        self.auth = auth
        step = prefs.setupSelection != nil && prefs.setupState.isComplete ? .summary : .move
    }

    /// What this kiosk is set up for (the summary's subject).
    var selection: KioskSetupSelection? { prefs.setupSelection }
    /// Whether "Cancel" on step 1 returns to a summary.
    var canCancel: Bool { selection != nil && prefs.setupState.isComplete }

    /// Step number for the "Step N of 3" line; nil on the summary.
    var stepNumber: Int? {
        switch step {
        case .move: 1
        case .site: 2
        case .scanType: 3
        case .summary: nil
        }
    }

    var siteChoices: [(site: SetupOptionSite, role: String)] {
        guard let i = options?.initiatives.first(where: { $0.id == initiativeId }) else { return [] }
        var out: [(SetupOptionSite, String)] = []
        if let s = i.sourceSite { out.append((s, "source")) }
        if let d = i.destinationSite { out.append((d, "destination")) }
        return out
    }

    /// Loads the options the portal offers now and revalidates cached choices against them.
    /// A move session sees only its own move.
    func load() async {
        loadError = nil
        options = nil
        do {
            var opts = try await api.setupOptions()
            if case .authed(let session) = auth.state, let move = session.kioskMove {
                opts.initiatives = opts.initiatives.filter { $0.id == move.initiativeId }
            }
            if !initiativeId.isEmpty, !opts.initiatives.contains(where: { $0.id == initiativeId }) {
                initiativeId = ""; siteId = ""; scanStatus = ""
            }
            let move = opts.initiatives.first { $0.id == initiativeId }
            let sites = [move?.sourceSite?.id, move?.destinationSite?.id].compactMap { $0 }
            if !siteId.isEmpty, !sites.contains(siteId) { siteId = "" }
            if !scanStatus.isEmpty, !opts.scanTypes.contains(where: { $0.key == scanStatus }) { scanStatus = "" }
            options = opts
        } catch {
            loadError = "Couldn't load setup options."
        }
    }

    func pickMove(_ id: String) {
        if id != initiativeId { siteId = "" }
        initiativeId = id
        step = .site
    }

    func pickSite(_ id: String) {
        siteId = id
        step = .scanType
    }

    func back() {
        switch step {
        case .scanType: step = .site
        case .site: step = .move
        case .move, .summary: break
        }
    }

    /// "Change setup": reopen the wizard at step 1 with the saved choices preselected.
    func changeSetup() {
        if let sel = selection { initiativeId = sel.initiativeId; siteId = sel.siteId; scanStatus = sel.scanStatus }
        else { initiativeId = ""; siteId = ""; scanStatus = "" }
        saveError = nil
        step = .move
        Task { await load() }
    }

    /// "Cancel" on step 1 of a change: back to the summary.
    func cancelChange() { if canCancel { step = .summary } }

    func pickScanType(_ key: String) async {
        scanStatus = key
        saving = true
        saveError = nil
        do {
            let r = try await api.submitSetup(KioskSetupIn(serial: identity.current.serial, initiativeId: initiativeId, siteId: siteId, scanStatus: key))
            prefs.setupSelection = KioskSetupSelection(initiativeId: r.initiativeId, initiativeName: r.initiativeName, siteId: r.siteId, siteName: r.siteName, siteRole: r.siteRole, scanStatus: r.scanStatus, scanLabel: r.scanStatusLabel)
            prefs.setupState = .complete
            saving = false
            step = .summary
            sync.run(initiativeId: r.initiativeId, initiativeName: r.initiativeName)
        } catch {
            if !prefs.setupState.isComplete { prefs.setupState = .failed }
            saving = false
            saveError = (error as? ApiError)?.code ?? "unknown_error"
        }
    }

    func syncAgain() {
        if let sel = selection { sync.run(initiativeId: sel.initiativeId, initiativeName: sel.initiativeName) }
    }
}
