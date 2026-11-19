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
    /// The value scanned as a tag is this asset's own asset ID (its barcode label).
    case ownAssetId
    /// The value scanned as a tag is this asset's own serial.
    case ownSerial
    /// The value scanned as a tag is another asset's asset ID.
    case otherAssetId
    /// The value scanned as a tag is another asset's serial.
    case otherSerial
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
    // The web kiosk's words (Android SledWords: plain text, no sled involved).
    case .ownAssetId: return "That's this asset's own asset ID, not an RFID tag."
    case .ownSerial: return "That's this asset's own serial, not an RFID tag."
    case .otherAssetId: return "That's the asset ID for \(holder), not an RFID tag."
    case .otherSerial: return "That's the serial for \(holder), not an RFID tag."
    }
}

/// The web kiosk's first check (`kiosk/src/lib/enrollGate.ts`, ruling 13): a value scanned at
/// the tag step that is a roster asset's asset ID or serial is a barcode, not a tag. Checked on
/// the raw value, before padding, as the web does. Nil when there is no roster (`index` nil) or
/// no match; else the match, as this asset's own or another's (holder: its name, else its asset
/// ID). `checkEnrollTag` runs after this, on the padded tag.
func checkEnrollRaw<A: ScanAsset>(index: ScanIndex<A>?, target: A, raw: String) -> EnrollTagVerdict? {
    guard let index, let hit = matchAssetOrSerial(index, raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    let own = hit.asset.id == target.id
    let issue: EnrollTagIssue = switch hit.kind {
    case .serial: own ? .ownSerial : .otherSerial
    case .assetId, .rfid: own ? .ownAssetId : .otherAssetId
    }
    return EnrollTagVerdict(issue: issue, holder: own ? nil : nonBlank(hit.asset.name) ?? nonBlank(hit.asset.assetId))
}

private func nonBlank(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return value
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
