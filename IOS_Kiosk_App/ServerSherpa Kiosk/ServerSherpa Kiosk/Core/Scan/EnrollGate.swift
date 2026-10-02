import Foundation

// The gates RFID Enroll puts in front of a save.
//
// Two things go wrong on a busy floor: the same asset gets walked past the
// reader twice, and the same tag gets waved at two assets. Both are caught
// here, from what this kiosk already knows, so the operator hears about it
// at the box instead of after a round trip. The portal still has the last
// word — these checks narrow what reaches it, they do not replace it.

/// One line of this session's enroll log: what this kiosk has already put on
/// an asset since the screen opened. Memory only — it is a gate against a
/// repeat scan, not a record. The portal holds the record.
struct EnrollLogEntry: Equatable, Sendable {
    var assetRowId: String
    var tag: String
    var assetName: String
}

enum EnrollTagIssue: Sendable {
    /// The tag being scanned is the one already on this asset.
    case sameTagOnThisAsset
    /// This kiosk put the tag on something else a moment ago.
    case tagUsedThisSession
    /// The synced roster says the tag belongs to another asset.
    case tagOnAnotherAsset
}

struct EnrollTagVerdict: Equatable, Sendable {
    var issue: EnrollTagIssue
    var holder: String?
}

func enrollTagText(_ verdict: EnrollTagVerdict) -> String {
    let holder = verdict.holder ?? "another asset"
    switch verdict.issue {
    case .sameTagOnThisAsset: return "That tag is already on this asset."
    case .tagUsedThisSession: return "You just enrolled that tag on \(holder). Scan a different tag."
    case .tagOnAnotherAsset: return "That tag is on \(holder). Scan a different tag."
    }
}

/// What this session already did to an asset, if anything.
func enrolledThisSession(_ log: [EnrollLogEntry], assetRowId: String) -> EnrollLogEntry? {
    log.first { $0.assetRowId == assetRowId }
}

/// Why this tag must not be saved onto this asset, or nil to go ahead.
///
/// The session log is consulted before the roster: it is the fresher of the
/// two, and after a save that the local roster update missed it is the only
/// one that knows.
func checkEnrollTag<A: ScanAsset>(index: ScanIndex<A>?, log: [EnrollLogEntry], target: A, padded: String) -> EnrollTagVerdict? {
    guard let want = rfidKey(padded) else { return nil }
    if rfidKey(target.rfid) == want { return EnrollTagVerdict(issue: .sameTagOnThisAsset, holder: nil) }
    if let hit = log.first(where: { rfidKey($0.tag) == want && $0.assetRowId != target.id }) {
        return EnrollTagVerdict(issue: .tagUsedThisSession, holder: hit.assetName)
    }
    if let other = index?.byRfid[want], other.id != target.id {
        return EnrollTagVerdict(issue: .tagOnAnotherAsset, holder: other.name ?? other.assetId)
    }
    return nil
}
