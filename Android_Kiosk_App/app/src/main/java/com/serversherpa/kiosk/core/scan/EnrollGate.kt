package com.serversherpa.kiosk.core.scan

import com.serversherpa.kiosk.core.rfid.SledWords

/**
 * The gates RFID Enroll puts in front of a save.
 *
 * Two things go wrong on a busy floor: the same asset gets walked past the
 * reader twice, and the same tag gets waved at two assets. Both are caught
 * here, from what this kiosk already knows, so the operator hears about it
 * at the box instead of after a round trip. The portal still has the last
 * word — these checks narrow what reaches it, they do not replace it.
 */

/** One line of this session's enroll log: what this kiosk has already put on
 *  an asset since the screen opened. Memory only — it is a gate against a
 *  repeat scan, not a record. The portal holds the record. */
data class EnrollLogEntry(val assetRowId: String, val tag: String, val assetName: String)

enum class EnrollTagIssue {
    /** The tag being scanned is the one already on this asset. */
    SAME_TAG_ON_THIS_ASSET,
    /** This kiosk put the tag on something else a moment ago. */
    TAG_USED_THIS_SESSION,
    /** The synced roster says the tag belongs to another asset. */
    TAG_ON_ANOTHER_ASSET,
    /** The value scanned as a tag is this asset's own asset ID (its barcode label). */
    OWN_ASSET_ID,
    /** The value scanned as a tag is this asset's own serial. */
    OWN_SERIAL,
    /** The value scanned as a tag is another asset's asset ID. */
    OTHER_ASSET_ID,
    /** The value scanned as a tag is another asset's serial. */
    OTHER_SERIAL,
}

data class EnrollTagVerdict(val issue: EnrollTagIssue, val holder: String?)

fun enrollTagText(verdict: EnrollTagVerdict): String {
    val holder = verdict.holder ?: "another asset"
    return when (verdict.issue) {
        EnrollTagIssue.SAME_TAG_ON_THIS_ASSET -> "That tag is already on this asset."
        EnrollTagIssue.TAG_USED_THIS_SESSION -> "You just enrolled that tag on $holder. Scan a different tag."
        EnrollTagIssue.TAG_ON_ANOTHER_ASSET -> "That tag is on $holder. Scan a different tag."
        EnrollTagIssue.OWN_ASSET_ID -> SledWords.ENROLL_OWN_ASSET_ID
        EnrollTagIssue.OWN_SERIAL -> SledWords.ENROLL_OWN_SERIAL
        EnrollTagIssue.OTHER_ASSET_ID -> SledWords.enrollOtherAssetId(verdict.holder)
        EnrollTagIssue.OTHER_SERIAL -> SledWords.enrollOtherSerial(verdict.holder)
    }
}

/**
 * The web kiosk's first check (`kiosk/src/lib/enrollGate.ts`, ruling 13): a
 * value scanned at the tag step that is a roster asset's asset ID or serial
 * is a barcode, not a tag. Checked on the raw value, before padding, as the
 * web does. Null when there is no roster ([index] null) or no match; else the
 * match, as this asset's own or another's (holder: its name, else its asset
 * ID). [checkEnrollTag] runs after this, on the padded tag.
 */
fun <A : ScanAsset> checkEnrollRaw(index: ScanIndex<A>?, target: A, raw: String): EnrollTagVerdict? {
    if (index == null) return null
    val hit = matchAssetOrSerial(index, raw.trim()) ?: return null
    val own = hit.asset.id == target.id
    val issue = when (hit.kind) {
        ScanMatchKind.SERIAL -> if (own) EnrollTagIssue.OWN_SERIAL else EnrollTagIssue.OTHER_SERIAL
        else -> if (own) EnrollTagIssue.OWN_ASSET_ID else EnrollTagIssue.OTHER_ASSET_ID
    }
    return EnrollTagVerdict(issue, if (own) null else hit.asset.name?.takeIf { it.isNotBlank() } ?: hit.asset.assetId.takeIf { it.isNotBlank() })
}

/** What this session already did to an asset, if anything. */
fun enrolledThisSession(log: List<EnrollLogEntry>, assetRowId: String): EnrollLogEntry? =
    log.firstOrNull { it.assetRowId == assetRowId }

/**
 * Why this tag must not be saved onto this asset, or null to go ahead.
 *
 * The session log is consulted before the roster: it is the fresher of the
 * two, and after a save that the local roster update missed it is the only
 * one that knows.
 */
fun <A : ScanAsset> checkEnrollTag(
    index: ScanIndex<A>?,
    log: List<EnrollLogEntry>,
    target: A,
    padded: String,
): EnrollTagVerdict? {
    val want = rfidKey(padded) ?: return null
    if (rfidKey(target.rfid) == want) return EnrollTagVerdict(EnrollTagIssue.SAME_TAG_ON_THIS_ASSET, null)
    log.firstOrNull { rfidKey(it.tag) == want && it.assetRowId != target.id }
        ?.let { return EnrollTagVerdict(EnrollTagIssue.TAG_USED_THIS_SESSION, it.assetName) }
    index?.byRfid?.get(want)?.takeIf { it.id != target.id }
        ?.let { return EnrollTagVerdict(EnrollTagIssue.TAG_ON_ANOTHER_ASSET, it.name ?: it.assetId) }
    return null
}
