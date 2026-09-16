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
