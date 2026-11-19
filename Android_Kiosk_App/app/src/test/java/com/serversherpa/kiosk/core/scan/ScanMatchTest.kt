package com.serversherpa.kiosk.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private data class A(
    override val id: String, override val assetId: String, override val name: String? = null,
    override val rfid: String? = null, override val serialNumber: String? = null, override val makeModel: String = "",
) : ScanAsset

class ScanMatchTest {
    private val rack = A("1", "A-100", "Rack", rfid = "000000000000000000100348", serialNumber = "SN-1")
    private val server = A("2", "A-200", "Server", rfid = null, serialNumber = "sn-2")
    private val index = buildScanIndex(listOf(rack, server))

    @Test fun rfidThenAssetIdThenSerial() {
        assertEquals(ScanMatchKind.RFID, matchScan(index, "100348")?.kind)
        assertEquals(ScanMatchKind.RFID, matchScan(index, "000000000000000000100348")?.kind)
        assertEquals("1", matchScan(index, "a-100")?.asset?.id)
        assertEquals(ScanMatchKind.ASSET_ID, matchScan(index, "a-100")?.kind)
        assertEquals(ScanMatchKind.SERIAL, matchScan(index, "SN-2")?.kind)
        assertNull(matchScan(index, "nothing"))
        assertNull(matchScan(index, "   "))
    }

    @Test fun firstRowWinsOnDuplicateKeys() {
        val dup = A("9", "A-100", "Other")
        val i = buildScanIndex(listOf(rack, dup))
        assertEquals("1", matchScan(i, "A-100")?.asset?.id)
        assertEquals(2, i.size)
    }

    @Test fun labelScansTryAssetIdThenSerialThenRfid() {
        assertEquals(ScanMatchKind.ASSET_ID, matchLabelScan(index, "a-100")?.kind)
        assertEquals(ScanMatchKind.SERIAL, matchLabelScan(index, "SN-2")?.kind)
        assertEquals("1", matchLabelScan(index, "100348")?.asset?.id)
        assertEquals(ScanMatchKind.RFID, matchLabelScan(index, "000000000000000000100348")?.kind)
        assertNull(matchLabelScan(index, "nothing"))
    }

    @Test fun aLabelScanThatIsOneAssetsIdAndAnothersTagPicksTheAssetId() {
        val tagged = A("3", "A-300", "Tagged", rfid = "000000000000000000777777")
        val numbered = A("4", "777777", "Numbered")
        val i = buildScanIndex(listOf(tagged, numbered))
        assertEquals("4", matchLabelScan(i, "777777")?.asset?.id)
        assertEquals("3", matchScan(i, "777777")?.asset?.id) // Scanning keeps RFID first
    }

    @Test fun assetOrSerialNeverMatchesByTag() {
        assertNull(matchAssetOrSerial(index, "100348"))
        assertEquals(ScanMatchKind.ASSET_ID, matchAssetOrSerial(index, "A-100")?.kind)
        assertEquals(ScanMatchKind.SERIAL, matchAssetOrSerial(index, "sn-1")?.kind)
    }

    @Test fun scanTypeWire() {
        assertEquals("rfid", scanTypeFor(ScanMatchKind.RFID))
        assertEquals("barcode", scanTypeFor(ScanMatchKind.ASSET_ID))
        assertEquals("barcode", scanTypeFor(ScanMatchKind.SERIAL))
    }

    @Test fun anRfidMatchSendsTheStoredTagAndEverythingElseSendsTheValueAsScanned() {
        // The portal's RFID match is exact, so a label's short form must go out as the full tag.
        assertEquals(SentScan("000000000000000000100348", "rfid"), sentScan(matchScan(index, "100348")!!, "100348"))
        assertEquals(SentScan("a-100", "barcode"), sentScan(matchScan(index, "a-100")!!, "a-100"))
        assertEquals(SentScan("SN-2", "barcode"), sentScan(matchScan(index, "SN-2")!!, "SN-2"))
        // A tag match with no stored tag can't happen, but never send an empty value.
        assertEquals(SentScan("100348", "rfid"), sentScan(ScanMatch(ScanMatchKind.RFID, server), "100348"))
    }

    @Test fun aPrintedLabelSendsWhatItMatchedOnInMatchLabelScansOrder() {
        // Asset ID and serial go out as scanned barcodes; a tag's value goes out as the stored tag.
        assertEquals(SentScan("a-100", "barcode"), labelScan(rack, "a-100"))
        assertEquals(SentScan("SN-1", "barcode"), labelScan(rack, "SN-1"))
        assertEquals(SentScan("000000000000000000100348", "rfid"), labelScan(rack, "100348"))
        // A value that is this asset's ID and (padded) its tag is still the asset ID.
        val both = A("5", "777777", "Both", rfid = "000000000000000000777777")
        assertEquals(SentScan("777777", "barcode"), labelScan(both, "777777"))
    }
}
