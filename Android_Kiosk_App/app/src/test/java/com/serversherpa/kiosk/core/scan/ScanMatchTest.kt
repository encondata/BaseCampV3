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
}
