package com.serversherpa.kiosk.core.printer

/** What a Zebra printer's Bluetooth LE link is built on: its GATT UUIDs, the limits the link
 *  keeps (measured on a ZD421 over iOS, 2026-10-22), and the copy that explains its failures.
 *  The Android Bluetooth code that uses these lives in `data/printer`. */
object ZebraBluetoothSpec {
    // --- GATT (UUID strings; the 16-bit ones are the Bluetooth base UUID's short form) ---

    /** Zebra's parser service: raw ZPL in, replies out. */
    const val SERVICE_UUID = "38EB4A80-C570-11E3-9507-0002A5D5C51B"
    /** "From Printer Data": the replies, delivered as indications. */
    const val FROM_PRINTER_UUID = "38EB4A81-C570-11E3-9507-0002A5D5C51B"
    /** "To Printer Data": the bytes to print, written with a response. */
    const val TO_PRINTER_UUID = "38EB4A82-C570-11E3-9507-0002A5D5C51B"
    /** Zebra's 16-bit member UUID, which its advertisements may carry. */
    const val ZEBRA_MEMBER_UUID = "FE79"

    /** The standard Device Information service, and the five values read from it. */
    const val DEVICE_INFO_UUID = "180A"
    const val MANUFACTURER_UUID = "2A29"
    const val MODEL_UUID = "2A24"
    const val SERIAL_UUID = "2A25"
    const val FIRMWARE_UUID = "2A26"
    const val LINK_OS_UUID = "2A28"

    /** The Client Characteristic Configuration descriptor: written to turn indications on. */
    const val CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb"

    // --- Limits (milliseconds, unless a count) ---

    /** The ATT MTU asked for; the chunk is what the printer grants minus 3 (see [chunkBytes]). */
    const val REQUESTED_MTU = 247
    /** Connecting and getting ready (Device Information read, MTU, indications on). */
    const val CONNECT_READY_MS = 10_000L
    /** A query ends this long after its last byte, or [QUERY_TOTAL_MS] in all. */
    const val QUERY_IDLE_MS = 2_000L
    const val QUERY_TOTAL_MS = 5_000L
    /** Before a query, stray bytes of an earlier reply are drained: this much quiet, at most [DRAIN_MAX_MS]. */
    const val DRAIN_QUIET_MS = 300L
    const val DRAIN_MAX_MS = 1_000L
    /** After a drop before the link was ready: at most this many tries, this far apart. */
    const val RECONNECT_TRIES = 3
    const val RECONNECT_SPACING_MS = 3_000L
    /** A scan for printers. */
    const val SCAN_MS = 30_000L

    /** How long a send of [bytes] may take: 15 s plus 1 s per 2 KB (twice the measured time). */
    fun sendBudgetMs(bytes: Int): Long = 15_000 + bytes * 1_000L / 2_048

    /** A Zebra's Bluetooth name is its serial number: 12 capital letters and digits. */
    fun looksLikeZebraSerial(name: String): Boolean = SERIAL_NAME.matches(name)

    /** The bytes per write: the negotiated [mtu] less the 3-byte ATT header, or 20 (the minimum
     *  MTU's payload) when the MTU request failed or came back below 23. */
    fun chunkBytes(mtu: Int?): Int = if (mtu == null || mtu < 23) 20 else mtu - 3

    private val SERIAL_NAME = Regex("[A-Z0-9]{12}")
}

// --- Copy ---

/** Bluetooth is switched off on the handheld. */
const val BLUETOOTH_OFF_TEXT = "Turn on Bluetooth to reach the printer."

/** Android keeps the kiosk off Bluetooth (the nearby-devices permission is denied). */
const val BLUETOOTH_DENIED_TEXT = "Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer."

/** Android 11 and older find Bluetooth devices only while Location is on. */
const val LOCATION_OFF_TEXT = "Turn on Location to find Bluetooth printers on this device."

/** Under the scan results, for a printer that doesn't show up. */
const val BLUETOOTH_SCAN_HINT_TEXT =
    "Don't see the printer? Hold FEED on the printer for 5 seconds (the middle light blinks), then scan again. " +
        "A Zebra's Bluetooth name is its serial number, like D8J224508535."

/** A font download was cut short; the printer is still waiting for the rest of it. */
const val FONT_INSTALL_CUT_TEXT = "The font install was cut off. Turn the printer off and on, then tap Check again."

/** The printer removed its pairing with this handheld (GATT status 5, 8, 15 or 137, or a lost bond). */
fun pairingLostText(serial: String): String =
    "The printer forgot this device. Open Android Settings › Connected devices, forget $serial, " +
        "then come back and tap Connect."
