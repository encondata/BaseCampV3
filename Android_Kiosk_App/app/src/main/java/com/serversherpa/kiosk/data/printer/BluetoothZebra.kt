package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.LOCATION_OFF_TEXT
import com.serversherpa.kiosk.core.printer.pairingLostText

/** Which printer a Bluetooth call is for: its Bluetooth [address] (when known) and its [serial],
 *  which is its Bluetooth name. */
data class BluetoothTarget(val address: String?, val serial: String?)

/**
 * A Zebra over Bluetooth LE: [ZebraTransport] over the app's one link ([ZebraBluetooth]), so the
 * setup checks, font installs, test labels and Print Labels send exactly what they send to a network
 * printer. Its [address] (every error's `host`) is the printer's serial; [bluetoothAddress] is the
 * Bluetooth address it was saved with.
 *
 * Each call reconnects first when the link is down (by the address, else by scanning for the
 * serial, within `CONNECT_READY_MS`), and nothing reconnects on its own while idle (D4). A write
 * goes out in acknowledged chunks within `sendBudgetMs`; a drop, or a budget that runs out, fails
 * it at once. A query drains late bytes first, then reads the reply until it is whole,
 * `QUERY_IDLE_MS` after its last byte, or `QUERY_TOTAL_MS`.
 */
class BluetoothZebra internal constructor(
    private val bluetooth: ZebraBluetooth,
    val serial: String,
    val bluetoothAddress: String?,
) : ZebraTransport {
    override val address: String get() = serial

    private val target = BluetoothTarget(bluetoothAddress, serial)

    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String =
        bluetooth.query(target, command, complete)

    override suspend fun write(parts: List<ByteArray>, progress: WriteProgress?) =
        bluetooth.write(target, parts, progress)
}

// --- Errors (beside PrinterUnreachable, PrinterTimeout and PrinterNoReply, with host = the serial) ---

/** Bluetooth is off, not allowed for the kiosk, missing, or (API 30, when a printer must be found
 *  by scanning) Location is off. */
class BluetoothUnavailable(host: String, val availability: BluetoothAvailability) :
    PrinterException(host, unavailableText(availability))

/** No address to try, and no device named the serial was heard within the connect budget. */
class BluetoothPrinterNotFound(host: String) :
    PrinterException(host, "No Bluetooth printer named $host was found nearby.")

/** The device found for the printer isn't a Zebra: its manufacturer isn't "Zebra Technologies", or
 *  it lacks the Zebra parser service. The printer itself may be fine (another device answered at
 *  its address, or under its name). */
class BluetoothNotZebra(host: String) :
    PrinterException(
        host,
        if (host.isEmpty()) "The Bluetooth device found isn't a Zebra printer."
        else "The Bluetooth device found for $host isn't a Zebra printer.",
    )

/** The device that answered reports another serial ([found]) than the one expected ([host]): it isn't used. */
class BluetoothSerialMismatch(host: String, val found: String?) :
    PrinterException(host, "The printer that answered is ${found ?: "another printer"}, not $host.")

/** The printer forgot this device (GATT status 5, 8, 15 or 137, or a bond lost): no retries until
 *  it is forgotten in Android Settings and connected again (D10). */
class BluetoothPairingLost(host: String) : PrinterException(host, pairingLostText(host))

private fun unavailableText(availability: BluetoothAvailability): String =
    bluetoothUnavailableText(availability) ?: "Bluetooth isn't ready yet. Try again in a moment."

/** What to tell the crew when Bluetooth can't be used: it's off, not allowed for the kiosk, (API 30,
 *  for a scan) Location is off, or the device has no Bluetooth LE. Null while it can be used, or
 *  while its state isn't known yet. */
fun bluetoothUnavailableText(availability: BluetoothAvailability): String? = when (availability) {
    BluetoothAvailability.POWERED_OFF -> BLUETOOTH_OFF_TEXT
    BluetoothAvailability.UNAUTHORIZED -> BLUETOOTH_DENIED_TEXT
    BluetoothAvailability.LOCATION_OFF -> LOCATION_OFF_TEXT
    BluetoothAvailability.UNSUPPORTED -> "This device doesn't support Bluetooth LE."
    BluetoothAvailability.UNKNOWN, BluetoothAvailability.READY -> null
}

/** A Bluetooth failure the crew fixes on the device, not at the printer: Bluetooth off, not allowed,
 *  missing or (a scan on API 30) Location off ([BluetoothUnavailable]), or a printer that forgot
 *  this device ([BluetoothPairingLost]), also when it stopped the `~JX` clear before a call
 *  ([PrinterClearFailed]). Null for any other failure (Bluetooth not ready in time reads as
 *  unreachable). */
fun bluetoothRefusal(error: Throwable): PrinterException? = when (error) {
    is PrinterClearFailed -> error.cause?.let(::bluetoothRefusal)
    is BluetoothUnavailable -> error.takeIf { bluetoothUnavailableText(it.availability) != null }
    is BluetoothPairingLost -> error
    else -> null
}
