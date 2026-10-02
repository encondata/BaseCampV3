import Foundation
import SwiftUI
import Observation

/// kiosk/src/pages/Scan.tsx statusLabel(): what the receipt list's pill says.
func statusLabel(_ row: OutboxRow) -> String {
    switch row.status {
    case .accepted: "Sent"
    case .sending: "Sending"
    case .retrying: "Retrying (\(row.attempts)/\(OutboxMachine.BACKOFF.count))"
    case .failed: "Failed: \(row.lastError ?? "timeout")"
    case .nomatch: "No match"
    case .queued: "Queued"
    }
}

private enum ScanTimeFormats {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return f
    }()
    /// Receipt rows render on the main actor; the lock keeps the shared output formatter's zone change safe anyway.
    static let lock = NSLock()
}

/// HH:mm:ss in the given time zone (default: the device's) from a row's ISO `scannedAt`; the raw text when it isn't a date.
func scanTime(_ iso: String, in zone: TimeZone = .current) -> String {
    var parsed = ScanTimeFormats.withFraction.date(from: iso)
    if parsed == nil { parsed = ScanTimeFormats.plain.date(from: iso) }
    guard let date = parsed else { return iso }
    ScanTimeFormats.lock.lock()
    defer { ScanTimeFormats.lock.unlock() }
    ScanTimeFormats.clock.timeZone = zone
    return ScanTimeFormats.clock.string(from: date)
}

extension OutboxRow {
    /// RFID values show without their zero padding.
    var shownValue: String { scanType == "rfid" ? displayRfid(scannedValue) : scannedValue }
}

extension KioskAssetRow {
    var outboxAsset: OutboxAsset {
        OutboxAsset(id: id, assetId: assetId, name: name, rfid: rfid, serialNumber: serialNumber, makeModel: makeModel)
    }
}

/// kiosk/src/pages/Scan.tsx: match locally, flash + sound, queue in the outbox.
/// Scans arrive only through `onScan`, which the screen feeds from the scan bus.
@MainActor @Observable
final class ScanViewModel {
    enum LoadStatus: Equatable { case loading, ready, error }

    static let NO_MOVE_DATA = "No move data on this kiosk. Sync from Kiosk Setup."

    private(set) var loadStatus = LoadStatus.loading
    private(set) var rosterSize = 0
    private(set) var error: String?
    private(set) var confirmDiscard = false
    /// Set by the outbox when an operator action couldn't be saved.
    var storageError: String? { outbox.storageError }

    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let sync: Sync
    @ObservationIgnored private let outbox: Outbox
    @ObservationIgnored private let prefs: KioskPrefs
    @ObservationIgnored private let flash: FlashController
    @ObservationIgnored private let sound: SoundPlayer?
    @ObservationIgnored private var index: ScanIndex<KioskAssetRow>?

    init(store: KioskStore, sync: Sync, outbox: Outbox, prefs: KioskPrefs, flash: FlashController, sound: SoundPlayer?) {
        self.store = store
        self.sync = sync
        self.outbox = outbox
        self.prefs = prefs
        self.flash = flash
        self.sound = sound
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

    func onScan(_ raw: String) async {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return }
        let look = prefs.appearance
        // A hardware scan can arrive before the roster or the setup is ready (the
        // typed input is disabled then). Say so instead of dropping it silently.
        guard let index, let sel = prefs.setupSelection, rosterSize > 0 else {
            flash.flash(Color(hsl: look.notFoundScan), ms: look.flashMs)
            sound?.play(.notFound)
            error = Self.NO_MOVE_DATA
            return
        }
        error = nil
        let hit = matchScan(index, value)
        if hit != nil {
            flash.flash(Color(hsl: look.goodScan), ms: look.flashMs)
            sound?.play(.good)
        } else {
            flash.flash(Color(hsl: look.notFoundScan), ms: look.flashMs)
            sound?.play(.notFound)
        }
        await outbox.enqueue(EnqueueInput(
            scannedValue: value, scanType: hit.map { scanTypeFor($0.kind) } ?? "barcode",
            asset: hit?.asset.outboxAsset, siteId: sel.siteId, initiativeId: sel.initiativeId, scanStatus: sel.scanStatus))
    }

    func retryFailed() async { await outbox.retryFailed() }
    func clearSent() async { await outbox.clearSent() }
    func askDiscard() { confirmDiscard = true }
    func cancelDiscard() { confirmDiscard = false }

    func discardFailed() async {
        confirmDiscard = false
        await outbox.discardFailed()
    }
}
