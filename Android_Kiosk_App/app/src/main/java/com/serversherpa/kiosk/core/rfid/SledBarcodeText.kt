package com.serversherpa.kiosk.core.rfid

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * The text of a barcode the sled's scanner sent: strict UTF-8 when the
 * bytes are valid UTF-8, else ISO-8859-1; trimmed. Null for no bytes, or
 * for text that is blank once trimmed.
 */
fun decodeBarcode(bytes: ByteArray?): String? {
    if (bytes == null || bytes.isEmpty()) return null
    val text = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        String(bytes, Charsets.ISO_8859_1)
    }
    return text.trim().ifEmpty { null }
}

/** The scanner's barcode type codes the app names; others get no label. */
private val BARCODE_TYPE_LABELS = mapOf(
    1 to "CODE39",
    2 to "CODABAR",
    3 to "CODE128",
    6 to "I2OF5",
    7 to "CODE93",
    8 to "UPCA",
    10 to "EAN8",
    11 to "EAN13",
    15 to "GS1_128",
    17 to "PDF417",
    27 to "DATAMATRIX",
    28 to "QRCODE",
    45 to "AZTEC",
    48 to "GS1_DATABAR",
    49 to "GS1_DATABAR",
    50 to "GS1_DATABAR",
    193 to "GS1_DATAMATRIX",
    194 to "GS1_QRCODE",
)

/** The label for the scanner's barcode [type] code, or null when the table has none. */
fun barcodeTypeLabel(type: Int): String? = BARCODE_TYPE_LABELS[type]
