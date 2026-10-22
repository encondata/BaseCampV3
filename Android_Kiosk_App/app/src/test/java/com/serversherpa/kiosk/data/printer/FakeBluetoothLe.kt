package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.printer.ZebraBluetoothSpec

/**
 * An adapter that records what it is asked and answers the way Android does: availability from a
 * state the test sets, advertisements only while a scan runs, and GATT connections to the
 * [FakePrinter]s it knows by address. A connection to an address with no printer stays pending,
 * as Android's direct connect does while nothing answers. Events go straight to the listener (the
 * link moves them onto its own dispatcher, as it does for Android's binder threads).
 */
class FakeBluetoothLe(
    var state: BluetoothAvailability = BluetoothAvailability.READY,
    private val now: () -> Long = { 0L },
) : BluetoothLeClient {
    private var listener: ((BluetoothLeEvent) -> Unit)? = null

    val printers = mutableMapOf<String, FakePrinter>()
    /** Every address a GATT connection was opened to, in order. */
    val connects = mutableListOf<String>()
    /** Every GATT connection handed out, in order. */
    val links = mutableListOf<FakeGatt>()
    var scanning = false
        private set
    var scanStarts = 0
        private set
    /** Scans refuse to start (Android's scan throttle, say). */
    var refuseScan = false

    /** A printer at [address] (the office ZD421 unless told otherwise). */
    fun printer(
        address: String,
        serial: String = SERIAL,
        manufacturer: String = ZEBRA,
    ): FakePrinter = FakePrinter(address, serial, manufacturer).also { printers[address] = it }

    override fun availability(): BluetoothAvailability = state

    override fun listen(onEvent: (BluetoothLeEvent) -> Unit) {
        listener = onEvent
    }

    override fun startScan(): Boolean {
        if (refuseScan) return false
        scanning = true
        scanStarts++
        return true
    }

    override fun stopScan() {
        scanning = false
    }

    override fun connect(address: String, onEvent: (GattEvent) -> Unit): GattLink {
        connects += address
        val gatt = FakeGatt(address, printers[address], onEvent, now)
        links += gatt
        gatt.start()
        return gatt
    }

    /** Bluetooth (or Location, or a permission) changed. */
    fun report(state: BluetoothAvailability) {
        this.state = state
        listener?.invoke(BluetoothLeEvent.AvailabilityChanged)
    }

    /** One advertisement, heard only while a scan runs; [name] is its scan record's name. */
    fun advertise(address: String, name: String?, rssi: Int, advertisesZebra: Boolean = false) {
        if (scanning) listener?.invoke(BluetoothLeEvent.Advertised(address, name, rssi, advertisesZebra))
    }

    fun scanFails(code: Int = 2) {
        scanning = false
        listener?.invoke(BluetoothLeEvent.ScanFailed(code))
    }

    /** Android removed the bond with [address]. */
    fun bondLost(address: String) {
        listener?.invoke(BluetoothLeEvent.BondLost(address))
    }

    companion object {
        const val SERIAL = "D8J224508535"
        const val ZEBRA = "Zebra Technologies"
    }
}

/** A printer behind the fake adapter: how it answers a connect and each GATT operation. */
class FakePrinter(val address: String, serial: String, manufacturer: String) {
    enum class Connect { ANSWER, SILENT }

    var connect = Connect.ANSWER
    /** When set, the connect fails with this status before the link comes up (133, say). */
    var connectFailStatus: Int? = null
    var hasParserService = true
    /** Device Information values by short UUID; a missing one isn't offered. */
    val deviceInfo = linkedMapOf(
        ZebraBluetoothSpec.MANUFACTURER_UUID to manufacturer,
        ZebraBluetoothSpec.MODEL_UUID to "ZD421",
        ZebraBluetoothSpec.SERIAL_UUID to serial,
        ZebraBluetoothSpec.FIRMWARE_UUID to "V93.21.38Z",
        ZebraBluetoothSpec.LINK_OS_UUID to "7.3",
    )
    /** A read answered with this status (by short UUID). */
    val readStatus = mutableMapOf<String, Int>()
    /** Reads never answered on their own (the test answers them with [FakeGatt.answer]). */
    val silentReads = mutableSetOf<String>()
    var mtuGranted = 247
    var mtuStatus = 0
    var cccdStatus = 0
    /** Each new connection's service discovery drops the link with the next of these statuses. */
    val dropsOnDiscover = ArrayDeque<Int>()
    /** Setup operations are answered at once; off, the test answers each with [FakeGatt.answer]. */
    var autoAnswer = true
    /** Writes are acknowledged at once; off, the test acknowledges each with [FakeGatt.ack]. */
    var autoAck = true
}

/**
 * One GATT connection to a [FakePrinter]. Like Android it takes one operation at a time: one asked
 * while another is unanswered is refused (false) and counted in [overlaps].
 */
class FakeGatt(
    override val address: String,
    private val printer: FakePrinter?,
    private val onEvent: (GattEvent) -> Unit,
    private val now: () -> Long,
) : GattLink {
    /** Every operation that went out: "discover", "read 2A29", "mtu 247", "cccd", "write 244". */
    val ops = mutableListOf<String>()
    /** The bytes of each write, and when each went out. */
    val writes = mutableListOf<ByteArray>()
    val writeTimes = mutableListOf<Long>()
    /** Operations asked while one was unanswered (Android refuses them): must stay 0. */
    var overlaps = 0
        private set
    /** How many operations had gone out when the high connection priority was asked. */
    var priorityAfterOps: Int? = null
        private set
    var connected = false
        private set
    var notifying = false
        private set
    var disconnected = false
        private set
    var closed = false
        private set

    private var discovered = false
    private var pending: ((Int?) -> Unit)? = null

    /** An operation is out and unanswered. */
    val waitingForAnswer: Boolean get() = pending != null

    /** Every byte written, in order. */
    fun written(): ByteArray = writes.fold(ByteArray(0)) { all, w -> all + w }

    internal fun start() {
        val p = printer ?: return // nothing answers at this address: the connect stays pending
        val failure = p.connectFailStatus
        when {
            failure != null -> emit(GattEvent.ConnectionChanged(failure, false))
            p.connect == FakePrinter.Connect.SILENT -> Unit
            else -> {
                connected = true
                emit(GattEvent.ConnectionChanged(0, true))
            }
        }
    }

    override fun discoverServices(): Boolean = op("discover", printer?.autoAnswer == true) { status ->
        val drop = printer?.dropsOnDiscover?.removeFirstOrNull()
        if (drop != null) {
            drop(drop)
        } else {
            discovered = true
            emit(GattEvent.ServicesDiscovered(status ?: 0))
        }
    }

    override fun hasCharacteristic(service: String, characteristic: String): Boolean {
        val p = printer ?: return false
        if (!discovered) return false
        return when {
            sameUuid(service, ZebraBluetoothSpec.SERVICE_UUID) -> p.hasParserService &&
                (sameUuid(characteristic, ZebraBluetoothSpec.TO_PRINTER_UUID) || sameUuid(characteristic, ZebraBluetoothSpec.FROM_PRINTER_UUID))
            sameUuid(service, ZebraBluetoothSpec.DEVICE_INFO_UUID) -> short(characteristic) in p.deviceInfo
            else -> false
        }
    }

    override fun read(service: String, characteristic: String): Boolean {
        val p = printer ?: return false
        val key = short(characteristic)
        return op("read $key", p.autoAnswer && key !in p.silentReads) { status ->
            val s = status ?: p.readStatus[key] ?: 0
            val value = if (s == 0) p.deviceInfo[key]?.toByteArray(Charsets.UTF_8) else null
            emit(GattEvent.CharacteristicRead(gattUuid(characteristic), value, s))
        }
    }

    override fun requestMtu(mtu: Int): Boolean {
        val p = printer ?: return false
        return op("mtu $mtu", p.autoAnswer) { status ->
            val s = status ?: p.mtuStatus
            emit(GattEvent.MtuChanged(if (s == 0) p.mtuGranted else 23, s))
        }
    }

    override fun enableIndications(service: String, characteristic: String): Boolean {
        val p = printer ?: return false
        return op("cccd", p.autoAnswer) { status ->
            val s = status ?: p.cccdStatus
            if (s == 0) notifying = true
            emit(GattEvent.IndicationsEnabled(gattUuid(characteristic), s))
        }
    }

    override fun write(service: String, characteristic: String, value: ByteArray): Boolean {
        val p = printer ?: return false
        val taken = op("write ${value.size}", false) { status ->
            emit(GattEvent.CharacteristicWritten(gattUuid(characteristic), status ?: 0))
        }
        if (!taken) return false
        writes += value.copyOf()
        writeTimes += now()
        if (p.autoAck) answer()
        return true
    }

    override fun requestHighPriority(): Boolean {
        priorityAfterOps = ops.size
        return true
    }

    override fun disconnect() {
        disconnected = true
    }

    override fun close() {
        closed = true
        connected = false
        notifying = false
        pending = null
    }

    /** Answers the operation that is out ([status] overrides the printer's own). */
    fun answer(status: Int? = null) {
        val answer = pending ?: throw AssertionError("no operation is waiting for an answer")
        pending = null
        answer(status)
    }

    /** Acknowledges the write that is out. */
    fun ack(status: Int = 0) = answer(status)

    /** One indication on From Printer Data. */
    fun indicate(text: String) = indicate(text.toByteArray(Charsets.ISO_8859_1))

    fun indicate(bytes: ByteArray) {
        if (notifying) emit(GattEvent.Indication(gattUuid(ZebraBluetoothSpec.FROM_PRINTER_UUID), bytes))
    }

    /** The printer (or the radio) drops the link with [status]. */
    fun drop(status: Int) {
        if (closed) return
        connected = false
        notifying = false
        pending = null
        emit(GattEvent.ConnectionChanged(status, false))
    }

    private fun op(label: String, answerAtOnce: Boolean, answer: (Int?) -> Unit): Boolean {
        if (closed || !connected) return false
        if (pending != null) {
            overlaps++
            return false
        }
        ops += label
        pending = answer
        if (answerAtOnce) answer()
        return true
    }

    private fun emit(event: GattEvent) {
        if (!closed) onEvent(event)
    }

    private fun short(uuid: String): String {
        val full = gattUuid(uuid)
        return if (full.startsWith("0000") && full.endsWith("-0000-1000-8000-00805F9B34FB")) full.substring(4, 8) else full
    }
}
