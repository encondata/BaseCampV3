import Foundation

enum OutboxStatus: String, Codable, Sendable {
    case queued, sending, accepted, retrying, failed, nomatch

    /// An unrecognized status (a row written by a newer build) reads as `queued`
    /// rather than throwing — a stored row must never crash the outbox.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OutboxStatus(rawValue: raw) ?? .queued
    }
}

/// The matched asset, denormalized onto the row so the receipt list keeps
/// showing it after the roster is re-synced or cleared. Local storage only,
/// so the JSON keys are camelCase.
struct OutboxAsset: Codable, Equatable, Sendable {
    var id: String
    var assetId: String
    var name: String?
    var rfid: String?
    var serialNumber: String?
    var makeModel: String
}

struct OutboxRow: Equatable, Sendable {
    var clientScanId: String
    /// Monotonic per kiosk; the list is ordered by this, not by scannedAt.
    var seq: Int64
    var scannedValue: String
    var scanType: String
    var scannedAt: String
    var asset: OutboxAsset?
    var matched: Bool
    var status: OutboxStatus
    var attempts: Int
    var nextAttemptAt: Int64?
    var lastError: String?
    var siteId: String
    var initiativeId: String
    var scanStatus: String
}

struct EnqueueInput: Sendable {
    var scannedValue: String
    var scanType: String
    var asset: OutboxAsset?
    var siteId: String
    var initiativeId: String
    var scanStatus: String
}

/// queued = queued + sending + retrying ("still on its way").
struct OutboxCounts: Equatable, Sendable {
    var queued: Int
    var accepted: Int
    var failed: Int
    var nomatch: Int
    var total: Int
}

/// ISO-8601 with milliseconds and a `Z` suffix, e.g. `1970-01-01T00:00:00.000Z`.
func isoMillis(_ ms: Int64) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

private func parseIsoMillis(_ iso: String) -> Int64 {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: iso) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
    f.formatOptions = [.withInternetDateTime]
    if let d = f.date(from: iso) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
    return 0
}

enum OutboxMachine {
    /// Waits between retries, indexed by the row's pre-increment attempts.
    static let BACKOFF: [Int64] = [2000, 4000, 15000, 60000]
    static let MAX_BATCH = 100
    static let BATCH_DELAY_MS: Int64 = 500
    static let LIST_CAP = 200
    static let NOMATCH_TTL_MS: Int64 = 120_000
    static let NOMATCH_SWEEP_MS: Int64 = 10_000

    static func newRow(_ input: EnqueueInput, clientScanId: String, seq: Int64, nowMs: Int64) -> OutboxRow {
        let matched = input.asset != nil
        return OutboxRow(
            clientScanId: clientScanId, seq: seq, scannedValue: input.scannedValue, scanType: input.scanType,
            scannedAt: isoMillis(nowMs), asset: input.asset, matched: matched,
            status: matched ? .queued : .nomatch, attempts: 0,
            nextAttemptAt: nil, lastError: nil, siteId: input.siteId, initiativeId: input.initiativeId, scanStatus: input.scanStatus
        )
    }

    /// Rows left `sending` by a process that died mid-POST go back to queued.
    static func recoverStranded(_ all: [OutboxRow]) -> [OutboxRow] {
        all.filter { $0.status == .sending }.map { var r = $0; r.status = .queued; return r }
    }

    static func dueRows(_ all: [OutboxRow], nowMs: Int64) -> [OutboxRow] {
        let due = all.filter { $0.status == .queued || ($0.status == .retrying && ($0.nextAttemptAt ?? 0) <= nowMs) }
        return Array(due.sorted { $0.seq < $1.seq }.prefix(MAX_BATCH))
    }

    static func markSending(_ batch: [OutboxRow]) -> [OutboxRow] {
        batch.map { var r = $0; r.status = .sending; return r }
    }

    /// A named rejection is permanent; an id in neither list is `no_ack`.
    static func applyResponse(_ batch: [OutboxRow], accepted: Set<String>, rejected: [String: String]) -> [OutboxRow] {
        batch.map { row in
            var r = row
            if accepted.contains(row.clientScanId) {
                r.status = .accepted; r.nextAttemptAt = nil; r.lastError = nil
            } else {
                r.status = .failed; r.lastError = rejected[row.clientScanId] ?? "no_ack"
            }
            return r
        }
    }

    static func applyFailure(_ batch: [OutboxRow], code: String, nowMs: Int64) -> [OutboxRow] {
        batch.map { row in
            var r = row
            r.attempts = row.attempts + 1
            r.lastError = code
            if row.attempts < BACKOFF.count {
                r.status = .retrying; r.nextAttemptAt = nowMs + BACKOFF[row.attempts]
            } else {
                r.status = .failed; r.nextAttemptAt = nil
            }
            return r
        }
    }

    static func staleNoMatch(_ all: [OutboxRow], nowMs: Int64) -> [OutboxRow] {
        let cutoff = nowMs - NOMATCH_TTL_MS
        return all.filter { $0.status == .nomatch && parseIsoMillis($0.scannedAt) < cutoff }
    }

    static func counts(_ all: [OutboxRow]) -> OutboxCounts {
        var c = OutboxCounts(queued: 0, accepted: 0, failed: 0, nomatch: 0, total: all.count)
        for r in all {
            switch r.status {
            case .accepted: c.accepted += 1
            case .failed: c.failed += 1
            case .nomatch: c.nomatch += 1
            default: c.queued += 1
            }
        }
        return c
    }

    /// Milliseconds until the earliest retry is due (0 when overdue), or nil when none is retrying.
    /// (Kotlin: `nextRetryDelayMs`.)
    static func nextWake(_ all: [OutboxRow], nowMs: Int64) -> Int64? {
        all.filter { $0.status == .retrying && $0.nextAttemptAt != nil }
            .map { max(0, $0.nextAttemptAt! - nowMs) }
            .min()
    }

    static func retryFailed(_ all: [OutboxRow]) -> [OutboxRow] {
        all.filter { $0.status == .failed }.map {
            var r = $0; r.status = .queued; r.attempts = 0; r.nextAttemptAt = nil; r.lastError = nil; return r
        }
    }
}
