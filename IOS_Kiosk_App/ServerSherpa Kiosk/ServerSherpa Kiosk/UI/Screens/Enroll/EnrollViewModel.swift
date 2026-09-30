import Foundation
import Observation
import SwiftUI

let MAX_ENROLLMENTS = 25
private let NO_MOVE_DATA = "No move data on this kiosk. Sync from Kiosk Setup."
private let TOAST_SECONDS = 5.0
private let ERROR_SECONDS = 4.0

struct EnrollmentRow: Equatable, Identifiable, Sendable {
    let id: String
    let assetRowId: String
    let name: String
    let serial: String?
    let rfid: String
    let replaced: Bool
    let at: String
}

func saveErrorText(_ error: Error) -> String {
    let err = error as? ApiError
    if err?.code == "rfid_in_use" { return "That tag is already on \(err?.detailString("asset_name") ?? "another asset")." }
    if err?.code == "bad_rfid" { return rfidProblemText(.notAlphanumeric) }
    if err?.code == "rfid_too_long" { return rfidProblemText(.tooLong) }
    if err?.code == "read_only_mode" || err?.status == 423 { return "The portal is in read-only mode. Try again shortly." }
    if err?.code == "network" { return "Can't reach the portal. The tag was not saved." }
    return "Couldn't save the tag (\(err?.code ?? "unknown_error"))."
}

/// kiosk/src/pages/Enroll.tsx: asset (ID/serial only) → tag (padded), online only.
/// The screen feeds scans from the scan bus into `onScan`; this model never reads the bus itself.
@MainActor @Observable
final class EnrollViewModel {
    enum LoadStatus: Equatable { case loading, ready, error }

    private(set) var loadStatus = LoadStatus.loading
    private(set) var rosterSize = 0
    private(set) var asset: KioskAssetRow?
    /// What the tag box holds right now (the screen mirrors its text here for the preview).
    private(set) var tagValue = ""
    private(set) var saving = false
    private(set) var error: String?
    private(set) var toast: String?
    private(set) var enrollments: [EnrollmentRow] = []
    /// An asset that already carries a tag waits here until the operator says to replace it.
    private(set) var awaitingUpdate = false
    /// The tag this asset carries right now: the session log's when this kiosk set it, else the roster's.
    private(set) var currentTag: String?
    /// Whether that tag was put on by this kiosk since the screen opened.
    private(set) var enrolledHere = false

    /// What the tag box would store, or nil while it is empty or invalid.
    var tagPreview: String? { padRfid(tagValue).tag }

    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let identity: Identity
    @ObservationIgnored private let flash: FlashController
    @ObservationIgnored private let sound: SoundPlayer?
    @ObservationIgnored private let clock: () -> Int64
    @ObservationIgnored private let idGen: () -> String
    @ObservationIgnored private var index: ScanIndex<KioskAssetRow>?
    @ObservationIgnored private var errorTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    init(store: KioskStore, api: KioskApi, prefs: KioskPrefs, identity: Identity, flash: FlashController, sound: SoundPlayer?,
         clock: @escaping () -> Int64 = nowMs, idGen: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.store = store
        self.api = api
        self.prefs = prefs
        self.identity = identity
        self.flash = flash
        self.sound = sound
        self.clock = clock
        self.idGen = idGen
    }

    /// Rebuilds the match index from the local roster; the screen calls it again whenever `sync.rosterVersion` changes.
    func loadRoster() async {
        do {
            let assets = try await store.assets()
            try Task.checkCancellation()
            index = buildScanIndex(assets)
            rosterSize = assets.count
            loadStatus = .ready
        } catch is CancellationError {
            // A newer roster version superseded this load; it will report its own result.
        } catch {
            loadStatus = .error
        }
    }

    func setTagValue(_ value: String) { tagValue = value }

    private func showError(_ text: String, seconds: Double = ERROR_SECONDS) {
        errorTask?.cancel()
        error = text
        errorTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.error = nil
        }
    }

    private func showToast(_ text: String) {
        toastTask?.cancel()
        toast = text
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(TOAST_SECONDS))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    private func flashBad() {
        let look = prefs.appearance
        flash.flash(Color(hsl: look.notFoundScan), ms: look.flashMs)
        sound?.play(.notFound)
    }

    private func flashGood() {
        let look = prefs.appearance
        flash.flash(Color(hsl: look.goodScan), ms: look.flashMs)
        sound?.play(.good)
    }

    /// Routes to whichever step is current; the screen calls this from its scan-bus task.
    func onScan(_ value: String) async {
        if asset == nil {
            submitAsset(value)
        } else if awaitingUpdate {
            // The gate is the point: a tag read while an asset is waiting for
            // confirmation is exactly the accidental retag this screen refuses.
            flashBad()
            showError(updateGateText())
        } else {
            await submitTag(value)
        }
    }

    private func updateGateText() -> String {
        let name = asset?.name ?? asset?.assetId ?? "this asset"
        return enrolledHere
            ? "You just enrolled \(name). Tap Update RFID Value to change its tag."
            : "\(name) already has a tag. Tap Update RFID Value to replace it."
    }

    /// The operator said yes: open the box for the new tag.
    func confirmUpdate() {
        guard asset != nil else { return }
        errorTask?.cancel()
        awaitingUpdate = false
        tagValue = ""
        error = nil
    }

    func submitAsset(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return }
        // A hardware scan can arrive before the roster or the setup is ready (the
        // typed input is disabled then). Say so instead of dropping it silently.
        guard let index, loadStatus == .ready, rosterSize > 0, prefs.setupSelection != nil else {
            flashBad()
            showError(NO_MOVE_DATA)
            return
        }
        if let hit = matchAssetOrSerial(index, value) {
            errorTask?.cancel()
            // What this kiosk did a moment ago outranks the synced roster: after a
            // save whose local roster update failed, the log is the only one that
            // knows this asset was just tagged.
            let mine = enrolledThisSession(sessionLog(), assetRowId: hit.asset.id)
            let rosterTag = hit.asset.rfid.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
            let tag = mine?.tag ?? rosterTag
            asset = hit.asset
            tagValue = ""
            error = nil
            awaitingUpdate = tag != nil
            currentTag = tag
            enrolledHere = mine != nil
            flashGood()
            return
        }
        flashBad()
        let asTag = matchScan(index, value)
        showError(asTag?.kind == .rfid ? "That's an RFID tag. Scan the asset's serial or ID first." : "No asset found for \"\(value)\".")
    }

    func submitTag(_ raw: String) async {
        guard let target = asset, !saving, !awaitingUpdate else { return }
        let padded = padRfid(raw)
        guard let tag = padded.tag else {
            tagValue = ""
            showError(rfidProblemText(padded.problem ?? .empty))
            return
        }
        // Instantly, from what this kiosk holds: the tag on this very asset, the
        // tags it has handed out since the screen opened, and the synced roster.
        if let verdict = checkEnrollTag(index: index, log: sessionLog(), target: target, padded: tag) {
            flashBad()
            tagValue = ""
            showError(enrollTagText(verdict))
            return
        }
        saving = true
        error = nil
        // Again on the way out: a sync may have rebuilt the roster while the
        // operator was still lining the tag up. Nothing is awaited between this
        // check and the post, so the roster cannot change in between.
        if let verdict = checkEnrollTag(index: index, log: sessionLog(), target: target, padded: tag) {
            flashBad()
            saving = false
            tagValue = ""
            showError(enrollTagText(verdict))
            return
        }
        let sel = prefs.setupSelection
        do {
            let result = try await api.postRfidEnroll(assetId: target.id, KioskRfidEnrollIn(
                serial: identity.current.serial, rfidTag: tag, scanStatus: prefs.checkpoint(.enroll),
                clientScanId: idGen(), siteId: sel?.siteId, initiativeId: sel?.initiativeId))
            flashGood()
            // The tag is saved on the portal at this point; a failure here only
            // means this kiosk's own copy of the roster is stale.
            do { try await store.updateAssetRfid(id: target.id, rfid: result.rfidTag) }
            catch is CancellationError { throw CancellationError() }
            catch { showError("The tag was saved to the portal, but this kiosk's copy is stale.") }
            await loadRoster()
            let name = result.assetName ?? target.name ?? target.assetId
            showToast("Enrolled \(name) → \(displayRfid(result.rfidTag))")
            let row = EnrollmentRow(
                id: idGen(), assetRowId: target.id, name: name, serial: result.serialNumber ?? target.serialNumber, rfid: result.rfidTag,
                replaced: !(target.rfid ?? "").isEmpty && !result.alreadyHadTag, at: Self.isoTime(clock()))
            enrollments = Array(([row] + enrollments).prefix(MAX_ENROLLMENTS))
            asset = nil
            tagValue = ""
            saving = false
            awaitingUpdate = false
            currentTag = nil
            enrolledHere = false
        } catch is CancellationError {
            saving = false
        } catch {
            flashBad()
            saving = false
            tagValue = ""
            showError(saveErrorText(error))
        }
    }

    /// This session's enrollments as the gate wants them.
    private func sessionLog() -> [EnrollLogEntry] {
        enrollments.map { EnrollLogEntry(assetRowId: $0.assetRowId, tag: $0.rfid, assetName: $0.name) }
    }

    func cancel() {
        errorTask?.cancel()
        asset = nil
        tagValue = ""
        saving = false
        error = nil
        awaitingUpdate = false
        currentTag = nil
        enrolledHere = false
    }

    private static func isoTime(_ ms: Int64) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
}
