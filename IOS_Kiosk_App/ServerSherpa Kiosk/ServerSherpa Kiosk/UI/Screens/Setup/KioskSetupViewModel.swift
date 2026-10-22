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

// MARK: - Summary

/// The summary's line: a regular kiosk's move, site, role and scan type, or a Time Clock
/// station's move and site ("no move" / "no site" when it has none), as the web says it.
func setupSummaryText(_ sel: KioskSetupSelection) -> String {
    if sel.isTimeclockStation {
        let move = sel.moveId == nil ? "no move" : sel.initiativeName
        let site = sel.siteIdOrNil == nil ? "no site" : sel.siteName
        return "This kiosk is a Time Clock station for \(move) at \(site)."
    }
    return "This kiosk is set up for \(sel.initiativeName) at \(sel.siteName) (\(sel.siteRole)) · scan type \(sel.scanLabel)"
}

// MARK: - View model

/// kiosk/src/pages/KioskSetup.tsx: first "What is this kiosk?", then
/// - a Regular kiosk: Move → Site → Scan type, then (here and on Android only) what labels
///   print on, then the summary;
/// - a Time Clock station: Move (with a **No move** card) → Site (the move's sites, or every
///   site plus **No site** without a move). Picking the site saves the setup, issues the station
///   key and signs the person out, which lands the kiosk on the station's Welcome.
@MainActor @Observable
final class KioskSetupViewModel {
    enum Step { case type, move, site, scanType, labels, summary }
    /// What the kiosk is: the first step's choice.
    enum Kind { case regular, timeclock }

    static let typeHeading = "What is this kiosk?"
    /// The first step's cards (copy: controller ruling, flagged to Jimmy).
    static let kindChoices: [(kind: Kind, title: String, blurb: String)] = [
        (.regular, "Regular kiosk", "Scan, enroll and print with a signed-in crew."),
        (.timeclock, "Time Clock", "Crews clock in and out here; it stays ready on its own."),
    ]
    /// The Time Clock path's No move card.
    static let noMoveBlurb = "Punches are filed under no move and sorted out later in the portal."

    /// The last step's cards: the label kind, its title and its one-line description.
    static let labelKindChoices: [(kind: LabelKind, title: String, blurb: String)] = [
        (.top, "Top", "Labels for the top of the device."),
        (.front, "Front", "Labels for the front of the device."),
    ]
    static let labelsHeading = "What do labels print on?"

    private static let stepNames: [Step: String] = [.type: "TYPE", .move: "MOVE", .site: "SITE", .scanType: "SCAN TYPE", .labels: "LABELS"]

    private(set) var step: Step
    private(set) var options: SetupOptions?
    private(set) var loadError: String?
    private(set) var saving = false
    /// The API error code of the last failed save.
    private(set) var saveError: String?
    /// The API error code of a Time Clock station key that could not be issued (the setup saved).
    private(set) var keyError: String?
    /// Nil until the first step is answered.
    private(set) var kind: Kind?
    private(set) var initiativeId = ""
    private(set) var siteId = ""
    /// A Time Clock station's "No move" and "No site" (the ids stay "").
    private(set) var noMove = false
    private(set) var noSite = false
    private(set) var scanStatus = ""
    /// The last step's choice; Top until picked, the saved kind when changing a setup.
    private(set) var labelKind: LabelKind = .top

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let sync: Sync
    @ObservationIgnored private let auth: KioskAuth
    @ObservationIgnored private let heartbeat: Heartbeat
    @ObservationIgnored private let station: TimeclockStation

    init(api: KioskApi, identity: Identity, prefs: KioskPrefs, sync: Sync, auth: KioskAuth, heartbeat: Heartbeat, station: TimeclockStation) {
        self.api = api
        self.identity = identity
        self.prefs = prefs
        self.sync = sync
        self.auth = auth
        self.heartbeat = heartbeat
        self.station = station
        step = prefs.setupSelection != nil && prefs.setupState.isComplete ? .summary : .type
    }

    /// What this kiosk is set up for (the summary's subject).
    var selection: KioskSetupSelection? { prefs.setupSelection }
    /// Whether "Cancel" on step 1 returns to a summary.
    var canCancel: Bool { selection != nil && prefs.setupState.isComplete }

    /// The steps this kind walks (a Regular kiosk's until one is picked).
    private var path: [Step] { kind == .timeclock ? [.type, .move, .site] : [.type, .move, .site, .scanType, .labels] }

    /// Step number for the step line; nil on the summary.
    var stepNumber: Int? {
        guard step != .summary, let i = path.firstIndex(of: step) else { return nil }
        return i + 1
    }

    /// "STEP 1 · TYPE" before the kind is picked (the length depends on it), then
    /// "STEP 4 OF 5 · SCAN TYPE" / "STEP 3 OF 3 · SITE"; nil on the summary.
    var stepHeader: String? {
        guard let n = stepNumber, let name = Self.stepNames[step] else { return nil }
        return kind == nil ? "STEP \(n) · \(name)" : "STEP \(n) OF \(path.count) · \(name)"
    }

    /// A move session is locked to its move: no "No move" for it (web `kioskMove`).
    var offersNoMove: Bool { kind == .timeclock && kioskMove == nil }
    /// "No site" only without a move: a move's station always stands at one of its sites.
    var offersNoSite: Bool { kind == .timeclock && noMove }

    private var kioskMove: KioskMove? {
        if case .authed(let session) = auth.state { return session.kioskMove }
        return nil
    }

    /// The move's source and destination; a Time Clock station with no move, every site (no role).
    var siteChoices: [(site: SetupOptionSite, role: String)] {
        if offersNoSite { return (options?.sites ?? []).map { ($0, "") } }
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
            let sites = noMove ? opts.sites.map(\.id) : [move?.sourceSite?.id, move?.destinationSite?.id].compactMap { $0 }
            if !siteId.isEmpty, !sites.contains(siteId) { siteId = "" }
            if !scanStatus.isEmpty, !opts.scanTypes.contains(where: { $0.key == scanStatus }) { scanStatus = "" }
            options = opts
        } catch {
            loadError = "Couldn't load setup options."
        }
    }

    /// The first step: Regular runs the existing steps; Time Clock runs Move → Site.
    func pickKind(_ next: Kind) {
        if next == .regular { noMove = false; noSite = false }
        kind = next
        saveError = nil
        keyError = nil
        step = .move
    }

    func pickMove(_ id: String) {
        if id != initiativeId || noMove { siteId = ""; noSite = false }
        initiativeId = id
        noMove = false
        step = .site
    }

    /// A Time Clock station's "No move": its Site step lists every site, plus No site.
    func pickNoMove() {
        if !noMove { siteId = ""; noSite = false }
        initiativeId = ""
        noMove = true
        step = .site
    }

    /// A Regular kiosk's site: on to the scan type. A Time Clock station's site saves
    /// (`finishTimeclock`).
    func pickSite(_ id: String) {
        siteId = id
        step = .scanType
    }

    /// Picking a scan type only advances: the setup is saved on the last step.
    func pickScanType(_ key: String) {
        scanStatus = key
        step = .labels
    }

    func back() {
        switch step {
        case .labels: step = .scanType
        case .scanType: step = .site
        case .site: step = .move
        case .move: step = .type
        case .type, .summary: break
        }
    }

    /// "Change setup": reopen the wizard at step 1 with the saved choices preselected.
    func changeSetup() {
        if let sel = selection {
            initiativeId = sel.initiativeId; siteId = sel.siteId; scanStatus = sel.scanStatus
            labelKind = LabelKind.fromWire(sel.labelKind)
            kind = sel.isTimeclockStation ? .timeclock : .regular
            noMove = sel.isTimeclockStation && sel.moveId == nil
            noSite = sel.isTimeclockStation && sel.siteIdOrNil == nil
        } else {
            initiativeId = ""; siteId = ""; scanStatus = ""; labelKind = .top
            kind = nil; noMove = false; noSite = false
        }
        saveError = nil
        keyError = nil
        step = .type
        Task { await load() }
    }

    /// "Cancel" on step 1 of a change: back to the summary.
    func cancelChange() { if canCancel { step = .summary } }

    /// The last step: saves the setup with the chosen label kind, then syncs the move. A kiosk
    /// that was a Time Clock station drops its station key.
    func finish(_ kind: LabelKind) async {
        labelKind = kind
        saving = true
        saveError = nil
        do {
            let r = try await api.submitSetup(KioskSetupIn(serial: identity.current.serial, initiativeId: initiativeId, siteId: siteId, scanStatus: scanStatus))
            // A regular kiosk's setup answers every member; "" only guards a malformed reply.
            let saved = KioskSetupSelection(initiativeId: r.initiativeId ?? "", initiativeName: r.initiativeName ?? "", siteId: r.siteId ?? "",
                                            siteName: r.siteName ?? "", siteRole: r.siteRole ?? "", scanStatus: r.scanStatus ?? "",
                                            scanLabel: r.scanStatusLabel ?? "", labelKind: kind.wire)
            prefs.setupSelection = saved
            prefs.setupState = .complete
            station.clearKey()
            saving = false
            step = .summary
            sync.run(initiativeId: saved.initiativeId, initiativeName: saved.initiativeName)
        } catch {
            if !prefs.setupState.isComplete { prefs.setupState = .failed }
            saving = false
            saveError = (error as? ApiError)?.code ?? "unknown_error"
        }
    }

    /// A Time Clock station's Site step (a site, or nil for No site): saves the setup with no
    /// scan type (web `finishTimeclock`), issues and stores the station key, then signs the
    /// person out so the kiosk rests on its Welcome. There is no move data to download.
    ///
    /// A failed save keeps the wizard on Site (`saveError`). A key that could not be issued
    /// keeps the saved setup and the session (`keyError`); picking the site again retries.
    func finishTimeclock(siteId site: String?) async {
        guard !saving else { return }
        siteId = site ?? ""
        noSite = site == nil
        saving = true
        saveError = nil
        keyError = nil
        let serial = identity.current.serial
        do {
            let r = try await api.submitSetup(KioskSetupIn(serial: serial, initiativeId: noMove ? nil : initiativeId, siteId: site,
                                                           scanStatus: nil, stationType: KioskSetupSelection.timeclockStation))
            prefs.setupSelection = .timeclock(initiativeId: r.initiativeId, initiativeName: r.initiativeName, siteId: r.siteId,
                                              siteName: r.siteName, siteRole: r.siteRole)
            prefs.setupState = .complete
        } catch {
            if !prefs.setupState.isComplete { prefs.setupState = .failed }
            saving = false
            saveError = (error as? ApiError)?.code ?? "unknown_error"
            return
        }
        do {
            station.storeKey(try await issueStationKey(serial: serial))
        } catch {
            saving = false
            keyError = (error as? ApiError)?.code ?? "unknown_error"
            return
        }
        saving = false
        step = .summary
        await auth.logout()
    }

    /// `POST /kiosk/station-key`. The portal issues it only to the person it last saw sign in
    /// here (a sign-in heartbeat stamps that): on 403 `not_signed_in_here`, one sign-in beat
    /// and one retry.
    private func issueStationKey(serial: String) async throws -> String {
        do {
            return try await api.issueStationKey(serial: serial)
        } catch let error as ApiError where error.status == 403 && error.code == "not_signed_in_here" {
            await heartbeat.signInNow(auth.lastSignIn ?? .password)
            return try await api.issueStationKey(serial: serial)
        }
    }

    func syncAgain() {
        if let sel = selection { sync.run(initiativeId: sel.initiativeId, initiativeName: sel.initiativeName) }
    }
}
