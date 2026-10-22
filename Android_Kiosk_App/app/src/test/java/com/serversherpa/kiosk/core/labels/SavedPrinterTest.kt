package com.serversherpa.kiosk.core.labels

import com.serversherpa.kiosk.core.labels.PrinterConnection.Bluetooth
import com.serversherpa.kiosk.core.labels.PrinterConnection.Network
import com.serversherpa.kiosk.ui.screens.labels.noZebraAnswerText
import com.serversherpa.kiosk.ui.screens.labels.printerSummary
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** A saved printer's connection: network (today's `host`) or Bluetooth, the JSON that keeps a
 *  printer saved before Bluetooth loading as it was, and the copy that names the connection. */
class SavedPrinterTest {
    // KioskPrefs' decoder, and its encoder (defaults not encoded, so the serializer must write what it needs).
    private val json = Json { ignoreUnknownKeys = true }
    private val network = SavedPrinter("10.0.0.5", "ZD421", "X", 203)
    private val bluetooth = SavedPrinter(Bluetooth("D8J224508535", "C4:7B:A3:00:11:22"), "ZD421", "D8J224508535", 300)

    // ── JSON ──

    @Test fun oldSavedPrinterLoadsAsNetwork() {
        val raw = """{"printer":{"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203},"offsetX":3}"""
        val options = json.decodeFromString<LabelOptions>(raw)
        assertEquals(Network("10.0.0.5"), options.printer?.connection)
        assertEquals(network, options.printer)
        assertEquals(3, options.offsetX)
    }

    @Test fun networkPrinterRoundTrips() {
        val text = json.encodeToString(network)
        assertEquals(network, json.decodeFromString<SavedPrinter>(text))
        assertTrue(text, text.contains(""""type":"network""""))
        assertTrue(text, text.contains(""""host":"10.0.0.5""""))
    }

    @Test fun bluetoothPrinterRoundTrips() {
        val text = json.encodeToString(bluetooth)
        assertEquals(bluetooth, json.decodeFromString<SavedPrinter>(text))
        assertTrue(text, text.contains(""""type":"bluetooth""""))
        // an older build still decodes it: `host` is there, blank
        assertTrue(text, text.contains(""""host":"""""))
    }

    @Test fun aBluetoothPrinterNotYetSeenByThisHandheldRoundTrips() {
        val unseen = SavedPrinter(Bluetooth("D8J224508535", null), "ZD421", "D8J224508535", 300)
        assertEquals(unseen, json.decodeFromString<SavedPrinter>(json.encodeToString(unseen)))
        // and with the nulls written out, as a Json with encodeDefaults would
        val explicit = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = true }
        assertEquals(unseen, explicit.decodeFromString<SavedPrinter>(explicit.encodeToString(unseen)))
    }

    /** The class an older build decodes a saved printer with. */
    @kotlinx.serialization.Serializable
    private data class Old(val host: String, val model: String, val serial: String, val dpi: Int)

    @Test fun aBluetoothPrinterReadByAnOldDecoder() {
        val old = json.decodeFromString<Old>(json.encodeToString(bluetooth))
        assertEquals(Old("", "ZD421", "D8J224508535", 300), old)
        assertEquals(Old("10.0.0.5", "ZD421", "X", 203), json.decodeFromString<Old>(json.encodeToString(network)))
    }

    @Test fun aPrinterWithoutAConnectionOrHostDoesNotDecode() {
        assertThrows(SerializationException::class.java) {
            json.decodeFromString<SavedPrinter>("""{"model":"ZD421","serial":"X","dpi":203}""")
        }
    }

    @Test fun theConnectionWinsOverTheHostItAlsoCarries() {
        val raw = """{"connection":{"type":"bluetooth","serial":"D8J224508535"},"host":"","model":"ZD421","serial":"D8J224508535","dpi":300}"""
        assertEquals(Bluetooth("D8J224508535", null), json.decodeFromString<SavedPrinter>(raw).connection)
        val both = """{"connection":{"type":"network","host":"10.0.0.9"},"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203}"""
        assertEquals(Network("10.0.0.9"), json.decodeFromString<SavedPrinter>(both).connection)
    }

    @Test fun labelOptionsKeepTheirTolerantDecodingWithABluetoothPrinter() {
        val options = LabelOptions(printer = bluetooth, offsetX = -4, offsetY = 7, peel = true)
        assertEquals(options, json.decodeFromString<LabelOptions>(json.encodeToString(options)))
        assertEquals(LabelOptions(), json.decodeFromString<LabelOptions>("{}"))
    }

    // ── accessors ──

    @Test fun hostAndIsBluetoothFollowTheConnection() {
        assertEquals("10.0.0.5", network.host)
        assertFalse(network.isBluetooth)
        assertNull(bluetooth.host)
        assertTrue(bluetooth.isBluetooth)
        assertEquals(network, SavedPrinter(Network("10.0.0.5"), "ZD421", "X", 203))
    }

    // ── copy ──

    @Test fun summaryNamesTheConnection() {
        assertEquals("ZD421 at 10.0.0.5 · 203 dpi", printerSummary(network))
        assertEquals("ZD421 · Bluetooth D8J224508535 · 300 dpi", printerSummary(bluetooth))
        assertEquals("Zebra at 10.0.0.5 · 300 dpi", printerSummary(SavedPrinter("10.0.0.5", "  ", "", 300)))
        assertEquals("Zebra · Bluetooth D8J224508535 · 300 dpi", printerSummary(bluetooth.copy(model = "")))
    }

    @Test fun unreachableTextNamesTheConnection() {
        assertEquals("Can't reach the printer at 10.0.0.5.", printerUnreachableText(network))
        assertEquals("Can't reach the printer D8J224508535 over Bluetooth.", printerUnreachableText(bluetooth))
    }

    @Test fun noAnswerTextNamesTheConnection() {
        assertEquals("No Zebra printer answered at 10.0.0.5.", noZebraAnswerText(Network("10.0.0.5")))
        assertEquals(
            "No Zebra printer answered over Bluetooth as D8J224508535.",
            noZebraAnswerText(Bluetooth("D8J224508535", null)),
        )
    }
}
