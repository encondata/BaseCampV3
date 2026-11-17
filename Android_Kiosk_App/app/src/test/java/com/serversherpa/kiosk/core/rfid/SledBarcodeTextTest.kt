package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Barcode bytes from the sled's scanner: decoded, trimmed, and labeled. */
class SledBarcodeTextTest {
    @Test fun strictUtf8Decodes() {
        assertEquals("é", decodeBarcode("é".toByteArray(Charsets.UTF_8)))
        assertEquals("SN-ÅÖ-42", decodeBarcode("SN-ÅÖ-42".toByteArray(Charsets.UTF_8)))
        assertEquals("ABC123", decodeBarcode("ABC123".toByteArray(Charsets.US_ASCII)))
    }

    @Test fun invalidUtf8FallsBackToLatin1() {
        assertEquals("é", decodeBarcode(byteArrayOf(0xE9.toByte())))
        assertEquals("caféX", decodeBarcode(byteArrayOf(0x63, 0x61, 0x66, 0xE9.toByte(), 0x58)))
    }

    @Test fun blankAndNullAreDropped() {
        assertNull(decodeBarcode(null))
        assertNull(decodeBarcode(ByteArray(0)))
        assertNull(decodeBarcode("  \r\n\t".toByteArray(Charsets.UTF_8)))
    }

    @Test fun valuesAreTrimmed() {
        assertEquals("ASSET-0042", decodeBarcode("  ASSET-0042\r\n".toByteArray(Charsets.UTF_8)))
        assertEquals("a b", decodeBarcode("\ta b\n".toByteArray(Charsets.UTF_8)))
    }

    @Test fun typeLabelsComeFromTheTable() {
        assertEquals("CODE128", barcodeTypeLabel(3))
        assertEquals("QRCODE", barcodeTypeLabel(28))
        assertEquals("GS1_QRCODE", barcodeTypeLabel(194))
        assertNull(barcodeTypeLabel(999))
        val table = mapOf(
            1 to "CODE39", 2 to "CODABAR", 3 to "CODE128", 6 to "I2OF5", 7 to "CODE93", 8 to "UPCA",
            10 to "EAN8", 11 to "EAN13", 15 to "GS1_128", 17 to "PDF417", 27 to "DATAMATRIX", 28 to "QRCODE",
            45 to "AZTEC", 48 to "GS1_DATABAR", 49 to "GS1_DATABAR", 50 to "GS1_DATABAR",
            193 to "GS1_DATAMATRIX", 194 to "GS1_QRCODE",
        )
        for (type in -1..300) assertEquals("type $type", table[type], barcodeTypeLabel(type))
    }
}
