package com.serversherpa.kiosk.data.printer

import java.util.Collections
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * What the screens use of the Bluetooth side, faked: [availability] is what the test sets, a scan
 * lists what the test [hear]s until [stopScan], [endScan] or a scan that isn't allowed, and
 * [connect] answers with [answer] (or throws [connectError]). Everything asked is recorded.
 */
class FakeBluetoothPrinting(state: BluetoothAvailability = BluetoothAvailability.READY) : BluetoothPrinting {
    override val availability = MutableStateFlow(state)
    override val link = MutableStateFlow(BluetoothLinkInfo())
    /** How the last scan ended (`ZebraBluetooth`'s reasons). */
    @Volatile override var lastScanEnd: BluetoothScanEnd? = null
        private set
    /** The link's event log, as a test fills it. */
    override val events: MutableList<BluetoothLinkEvent> = Collections.synchronizedList(ArrayList())

    /** Every connect, as (address, serial). */
    val connects: MutableList<Pair<String?, String?>> = Collections.synchronizedList(ArrayList())
    @Volatile var connectError: Exception? = null
    /** When set, a connect waits for it (the printer taking its time to answer). */
    @Volatile var connectGate: CompletableDeferred<Unit>? = null
    /** What a connect to an address answers (the office ZD421 unless the test says otherwise). */
    @Volatile var answer: (address: String?) -> BluetoothPrinterInfo = { address ->
        BluetoothPrinterInfo(address.orEmpty(), "Zebra Technologies", "ZD421", FakeBluetoothLe.SERIAL, "V93.21.38Z", "7.3")
    }
    @Volatile var scans = 0
    @Volatile var stops = 0
    @Volatile var refreshes = 0
    @Volatile var closes = 0

    @Volatile private var scan: Channel<List<FoundBluetoothPrinter>>? = null

    /** A scan is listening. */
    val scanning: Boolean get() = scan != null

    override fun scan(): Flow<List<FoundBluetoothPrinter>> {
        scans++
        endScan(BluetoothScanEnd.REPLACED)
        val out = Channel<List<FoundBluetoothPrinter>>(Channel.UNLIMITED)
        // Bluetooth off, not allowed, missing, or Location off: the scan ends at once
        // (`ZebraBluetooth`'s rule); one asked while Bluetooth is turning on waits.
        when (availability.value) {
            BluetoothAvailability.READY, BluetoothAvailability.UNKNOWN -> scan = out
            else -> {
                lastScanEnd = BluetoothScanEnd.REFUSED
                out.close()
            }
        }
        return out.receiveAsFlow().onCompletion { if (scan === out) scan = null }
    }

    /** The running scan hears [found] (the whole list so far). */
    fun hear(vararg found: FoundBluetoothPrinter) {
        scan?.trySend(found.toList())
    }

    /** The running scan ends without Stop: another Bluetooth call took the radio (the default),
     *  Bluetooth went away, Android wouldn't scan, or ([why] = FINISHED) its 30 s ran out. */
    fun endScan(why: BluetoothScanEnd = BluetoothScanEnd.INTERRUPTED) {
        val out = scan ?: return
        lastScanEnd = why
        out.close()
        scan = null
    }

    /** The scan's 30 s (counted once Bluetooth was ready) ran out. */
    fun finishScan() = endScan(BluetoothScanEnd.FINISHED)

    override fun stopScan() {
        stops++
        endScan(BluetoothScanEnd.STOPPED)
    }

    override suspend fun connect(address: String?, serial: String?): BluetoothPrinterInfo {
        connects += address to serial
        endScan(BluetoothScanEnd.INTERRUPTED)
        connectGate?.await()
        connectError?.let { throw it }
        val info = answer(address)
        link.value = BluetoothLinkInfo(connected = true, info = info)
        return info
    }

    override fun refreshAvailability() {
        refreshes++
    }

    override fun close() {
        closes++
        endScan(BluetoothScanEnd.CLOSED)
        link.value = link.value.copy(connected = false)
    }
}
