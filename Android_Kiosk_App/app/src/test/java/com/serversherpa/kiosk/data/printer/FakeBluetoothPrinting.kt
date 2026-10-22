package com.serversherpa.kiosk.data.printer

import java.util.Collections
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

    /** Every connect, as (address, serial). */
    val connects: MutableList<Pair<String?, String?>> = Collections.synchronizedList(ArrayList())
    @Volatile var connectError: Exception? = null
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
        val out = Channel<List<FoundBluetoothPrinter>>(Channel.UNLIMITED)
        if (availability.value != BluetoothAvailability.READY) out.close() else scan = out
        return out.receiveAsFlow().onCompletion { if (scan === out) scan = null }
    }

    /** The running scan hears [found] (the whole list so far). */
    fun hear(vararg found: FoundBluetoothPrinter) {
        scan?.trySend(found.toList())
    }

    /** The running scan ends by itself (its 30 s, or Bluetooth going off). */
    fun endScan() {
        scan?.close()
        scan = null
    }

    override fun stopScan() {
        stops++
        endScan()
    }

    override suspend fun connect(address: String?, serial: String?): BluetoothPrinterInfo {
        connects += address to serial
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
        endScan()
        link.value = link.value.copy(connected = false)
    }
}
