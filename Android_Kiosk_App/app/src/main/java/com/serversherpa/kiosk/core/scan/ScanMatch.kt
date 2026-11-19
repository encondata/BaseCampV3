package com.serversherpa.kiosk.core.scan

/** What matching needs from an asset row (the Room entity and the
 *  synced `KioskAssetRow` both provide these). */
interface ScanAsset {
    val id: String
    val assetId: String
    val name: String?
    val rfid: String?
    val serialNumber: String?
    val makeModel: String
}

enum class ScanMatchKind { RFID, ASSET_ID, SERIAL }

data class ScanMatch<A : ScanAsset>(val kind: ScanMatchKind, val asset: A)

class ScanIndex<A : ScanAsset>(
    val byRfid: Map<String, A>,
    val byAssetId: Map<String, A>,
    val bySerial: Map<String, A>,
    val size: Int,
)

private fun key(value: String?): String? = value?.trim()?.uppercase()?.takeIf { it.isNotEmpty() }

/** Zero-padding stripped, upper-cased — so a handheld that pads the EPC
 *  and a fixed reader that doesn't land on the same asset. */
fun rfidKey(value: String?): String? {
    if (value.isNullOrBlank()) return null
    return key(displayRfid(value.trim()))
}

/** First row wins on a duplicate key, as in scanMatch.ts. */
fun <A : ScanAsset> buildScanIndex(assets: List<A>): ScanIndex<A> {
    val byRfid = LinkedHashMap<String, A>()
    val byAssetId = LinkedHashMap<String, A>()
    val bySerial = LinkedHashMap<String, A>()
    for (asset in assets) {
        rfidKey(asset.rfid)?.let { byRfid.putIfAbsent(it, asset) }
        key(asset.assetId)?.let { byAssetId.putIfAbsent(it, asset) }
        key(asset.serialNumber)?.let { bySerial.putIfAbsent(it, asset) }
    }
    return ScanIndex(byRfid, byAssetId, bySerial, assets.size)
}

/** RFID first (the readers), then asset ID (the labels), then serial. */
fun <A : ScanAsset> matchScan(index: ScanIndex<A>, raw: String): ScanMatch<A>? {
    val plain = key(raw) ?: return null
    rfidKey(raw)?.let { index.byRfid[it] }?.let { return ScanMatch(ScanMatchKind.RFID, it) }
    index.byAssetId[plain]?.let { return ScanMatch(ScanMatchKind.ASSET_ID, it) }
    index.bySerial[plain]?.let { return ScanMatch(ScanMatchKind.SERIAL, it) }
    return null
}

/** Print Labels: asset ID, then serial, then RFID (a tag's value read from its barcode). RFID
 *  comes last so a value that is one asset's ID and another's tag still prints the asset ID's
 *  label, as it did before RFID values matched here. */
fun <A : ScanAsset> matchLabelScan(index: ScanIndex<A>, raw: String): ScanMatch<A>? =
    matchAssetOrSerial(index, raw) ?: rfidKey(raw)?.let { index.byRfid[it] }?.let { ScanMatch(ScanMatchKind.RFID, it) }

/** Asset ID or serial only — RFID Enroll's first step, where a tag read
 *  must not silently pick "re-tag that asset". */
fun <A : ScanAsset> matchAssetOrSerial(index: ScanIndex<A>, raw: String): ScanMatch<A>? {
    val plain = key(raw) ?: return null
    index.byAssetId[plain]?.let { return ScanMatch(ScanMatchKind.ASSET_ID, it) }
    index.bySerial[plain]?.let { return ScanMatch(ScanMatchKind.SERIAL, it) }
    return null
}

/** The ingest endpoint's `scan_type`. */
fun scanTypeFor(kind: ScanMatchKind): String = if (kind == ScanMatchKind.RFID) "rfid" else "barcode"

/** A matched scan's `scanned_value` and `scan_type`, as the outbox sends them. */
data class SentScan(val value: String, val type: String)

/** An RFID match sends the asset's stored tag, not the value as read: this app ignores leading
 *  zeros ([rfidKey]), the portal's RFID match does not, so a label's short form (`100348`) would
 *  match here and never there. Anything else is sent exactly as scanned, for the portal to re-match. */
fun <A : ScanAsset> sentScan(hit: ScanMatch<A>, raw: String): SentScan {
    val tag = hit.asset.rfid?.trim()?.takeIf { it.isNotEmpty() }
    return SentScan(if (hit.kind == ScanMatchKind.RFID && tag != null) tag else raw, scanTypeFor(hit.kind))
}

/** What a printed label's scan sends: what [raw] matched on [asset] in [matchLabelScan]'s order
 *  (asset ID, serial, then tag), through [sentScan]. A value that matches none of them goes out
 *  as a scanned barcode. */
fun <A : ScanAsset> labelScan(asset: A, raw: String): SentScan {
    val one = buildScanIndex(listOf(asset))
    return matchLabelScan(one, raw)?.let { sentScan(it, raw) } ?: SentScan(raw, "barcode")
}
