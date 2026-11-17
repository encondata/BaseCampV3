package com.serversherpa.kiosk.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private data class Row(
    override val id: String, override val assetId: String, override val name: String? = null,
    override val rfid: String? = null, override val serialNumber: String? = null, override val makeModel: String = "",
) : ScanAsset

class EnrollGateTest {
    private val rack = Row("a1", "A-1", "Rack", rfid = null, serialNumber = "SN1", makeModel = "Dell")
    private val tagged = Row("a2", "A-2", "Tagged rack", rfid = "000000000000000000100348", serialNumber = "SN2", makeModel = "HP")
    private val index = buildScanIndex(listOf(rack, tagged))

    @Test fun aFreeTagOnAnUntaggedAssetPasses() {
        assertNull(checkEnrollTag(index, emptyList(), rack, "000000000000000000100349"))
    }

    /** The double scan: the same tag waved at the asset that already wears it. */
    @Test fun theTagAnAssetAlreadyWearsIsRefused() {
        val v = checkEnrollTag(index, emptyList(), tagged, "000000000000000000100348")
        assertEquals(EnrollTagIssue.SAME_TAG_ON_THIS_ASSET, v?.issue)
        assertEquals("That tag is already on this asset.", enrollTagText(v!!))
    }

    /** Padding must not hide a repeat: the reader that pads and the one that
     *  doesn't are talking about the same tag. */
    @Test fun paddingDoesNotHideARepeat() {
        assertEquals(EnrollTagIssue.SAME_TAG_ON_THIS_ASSET, checkEnrollTag(index, emptyList(), tagged, "100348")?.issue)
    }

    @Test fun aTagTheRosterPutsOnAnotherAssetIsRefused() {
        val v = checkEnrollTag(index, emptyList(), rack, "100348")
        assertEquals(EnrollTagIssue.TAG_ON_ANOTHER_ASSET, v?.issue)
        assertEquals("That tag is on Tagged rack. Scan a different tag.", enrollTagText(v!!))
    }

    /** The session log is the fresher of the two: it catches a tag this kiosk
     *  handed out even when the local roster copy never took the update. */
    @Test fun aTagUsedThisSessionIsRefusedEvenWithAStaleRoster() {
        val log = listOf(EnrollLogEntry("a9", "000000000000000000100349", "Other rack"))
        val v = checkEnrollTag(index, log, rack, "100349")
        assertEquals(EnrollTagIssue.TAG_USED_THIS_SESSION, v?.issue)
        assertEquals("You just enrolled that tag on Other rack. Scan a different tag.", enrollTagText(v!!))
    }

    @Test fun theSessionLogSaysWhatThisKioskDidToAnAsset() {
        val log = listOf(EnrollLogEntry("a1", "000000000000000000100349", "Rack"))
        assertEquals("000000000000000000100349", enrolledThisSession(log, "a1")?.tag)
        assertNull(enrolledThisSession(log, "a2"))
    }

    /** Re-reading the same tag onto the same asset is a repeat, not a conflict:
     *  the "already on this asset" branch wins over the roster branch. */
    @Test fun theAssetsOwnTagIsNotReportedAsAConflict() {
        assertEquals(EnrollTagIssue.SAME_TAG_ON_THIS_ASSET, checkEnrollTag(index, emptyList(), tagged, "0100348")?.issue)
    }

    // ── The web's raw check (ruling 13): a barcode is not a tag ──

    @Test fun aTagEqualToThisAssetsOwnAssetIdIsRefused() {
        val v = checkEnrollRaw(index, rack, "A-1")
        assertEquals(EnrollTagIssue.OWN_ASSET_ID, v?.issue)
        assertEquals("That's this asset's own asset ID, not an RFID tag.", enrollTagText(v!!))
    }

    @Test fun aTagEqualToThisAssetsOwnSerialIsRefused() {
        val v = checkEnrollRaw(index, rack, "SN1")
        assertEquals(EnrollTagIssue.OWN_SERIAL, v?.issue)
        assertEquals("That's this asset's own serial, not an RFID tag.", enrollTagText(v!!))
    }

    @Test fun anotherAssetsAssetIdIsRefusedWithItsName() {
        val v = checkEnrollRaw(index, rack, "A-2")
        assertEquals(EnrollTagVerdict(EnrollTagIssue.OTHER_ASSET_ID, "Tagged rack"), v)
        assertEquals("That's the asset ID for Tagged rack, not an RFID tag.", enrollTagText(v!!))
    }

    @Test fun anotherAssetsSerialFallsBackToItsAssetId() {
        val nameless = Row("a3", "A-3", name = null, serialNumber = "SN3")
        val withNameless = buildScanIndex(listOf(rack, tagged, nameless))
        val v = checkEnrollRaw(withNameless, rack, "SN3")
        assertEquals(EnrollTagVerdict(EnrollTagIssue.OTHER_SERIAL, "A-3"), v)
        assertEquals("That's the serial for A-3, not an RFID tag.", enrollTagText(v!!))
    }

    @Test fun noIndexMeansNoRawCheck() {
        assertNull(checkEnrollRaw<Row>(null, rack, "A-1"))
        assertNull(checkEnrollRaw(index, rack, "000000000000000000100349"))
    }

    @Test fun theRawValueIsTrimmedBeforeMatching() {
        assertEquals(EnrollTagIssue.OWN_ASSET_ID, checkEnrollRaw(index, rack, "  a-1\n")?.issue)
        assertEquals(EnrollTagIssue.OTHER_SERIAL, checkEnrollRaw(index, rack, "\tSN2 ")?.issue)
    }
}
