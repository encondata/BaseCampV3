package com.serversherpa.kiosk.data.printer

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.location.LocationManagerCompat
import com.serversherpa.kiosk.core.printer.ZebraBluetoothSpec
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred

// The thin seam between the Bluetooth printer link (ZebraBluetooth) and Android's Bluetooth LE API:
// what the link asks of the adapter and of one GATT connection, and what they report back as
// events. UUIDs travel as full 128-bit upper-case strings ([gattUuid]). Events arrive on any thread
// (Android delivers them on binder threads); ZebraBluetooth moves them onto its one dispatcher. The
// real adapters are at the bottom of this file; the tests' fake implements the same interfaces.

/** [uuid] as a full upper-case 128-bit UUID string: a 16-bit short form like `180A` becomes
 *  `0000180A-0000-1000-8000-00805F9B34FB` (the Bluetooth base UUID). */
fun gattUuid(uuid: String): String =
    (if (uuid.length == 4) "0000$uuid-0000-1000-8000-00805F9B34FB" else uuid).uppercase()

/** Whether two UUID strings name the same UUID (short or long form, any case). */
fun sameUuid(a: String, b: String): Boolean = gattUuid(a) == gattUuid(b)

/** The adapter: availability, the scan, and new GATT connections. */
interface BluetoothLeClient {
    /** What Bluetooth allows right now, from the adapter, the granted permissions and (API 30)
     *  Location. Reading it never prompts. */
    fun availability(): BluetoothAvailability

    /** From now on every adapter event goes to [onEvent], on any thread. Called once. */
    fun listen(onEvent: (BluetoothLeEvent) -> Unit)

    /** Starts an unfiltered LE scan that reports every advertisement (the printer advertises no
     *  service UUIDs, so a filter would find nothing). False when it couldn't start. */
    fun startScan(): Boolean

    fun stopScan()

    /** Opens a GATT connection to [address] over LE, autoConnect off; its events go to [onEvent],
     *  on any thread. Null when it couldn't even be started (a bad address, no adapter). */
    fun connect(address: String, onEvent: (GattEvent) -> Unit): GattLink?
}

/** What the adapter reported. */
sealed interface BluetoothLeEvent {
    /** Bluetooth turned on or off, or Location did: read [BluetoothLeClient.availability] again. */
    data object AvailabilityChanged : BluetoothLeEvent

    /** An advertisement: [name] is the scan record's device name (never `BluetoothDevice.getName()`,
     *  which needs the connect permission), null when it carries none; [advertisesZebra] when it
     *  lists Zebra's parser service or Zebra's member UUID `FE79`. */
    data class Advertised(val address: String, val name: String?, val rssi: Int, val advertisesZebra: Boolean) : BluetoothLeEvent

    /** The scan stopped with an error (Android's `SCAN_FAILED_*`). */
    data class ScanFailed(val errorCode: Int) : BluetoothLeEvent

    /** The bond with [address] was removed (bonded, then none). */
    data class BondLost(val address: String) : BluetoothLeEvent
}

/**
 * One GATT connection (`BluetoothGatt`). Each operation call returns false when Android refused it
 * (it allows one outstanding operation, so a second is refused until the first one's callback):
 * call them through a [GattQueue]. A service or characteristic not discovered yet is refused too.
 */
interface GattLink {
    val address: String
    fun discoverServices(): Boolean
    /** Whether discovery found [characteristic] in [service]. Not an operation. */
    fun hasCharacteristic(service: String, characteristic: String): Boolean
    fun read(service: String, characteristic: String): Boolean
    fun requestMtu(mtu: Int): Boolean
    /** `setCharacteristicNotification(true)` and the CCCD write of `ENABLE_INDICATION_VALUE`; its
     *  callback is [GattEvent.IndicationsEnabled]. */
    fun enableIndications(service: String, characteristic: String): Boolean
    /** A write with response (`WRITE_TYPE_DEFAULT`); its callback is [GattEvent.CharacteristicWritten]. */
    fun write(service: String, characteristic: String, value: ByteArray): Boolean
    /** `requestConnectionPriority(CONNECTION_PRIORITY_HIGH)`. Not an operation (no callback). */
    fun requestHighPriority(): Boolean
    fun disconnect()
    /** Frees the connection. No event follows; always called after a failed connect, too. */
    fun close()
}

/** What one GATT connection reported. */
sealed interface GattEvent {
    /** The link came up ([connected], [status] 0) or went down or never came up; then [status] is
     *  why (an HCI reason like 8, the supervision timeout, or a GATT status like 133). */
    data class ConnectionChanged(val status: Int, val connected: Boolean) : GattEvent
    data class ServicesDiscovered(val status: Int) : GattEvent
    class CharacteristicRead(val characteristic: String, val value: ByteArray?, val status: Int) : GattEvent
    data class MtuChanged(val mtu: Int, val status: Int) : GattEvent
    /** The CCCD write that turns [characteristic]'s indications on was answered. */
    data class IndicationsEnabled(val characteristic: String, val status: Int) : GattEvent
    /** A write with response was acknowledged ([status] 0) or refused. */
    data class CharacteristicWritten(val characteristic: String, val status: Int) : GattEvent
    /** An indication (or notification) on [characteristic]. */
    class Indication(val characteristic: String, val value: ByteArray) : GattEvent
}

/** GATT statuses the link reads. */
object GattStatus {
    const val SUCCESS = 0

    /** An operation answered 5 (insufficient authentication), 8 (insufficient authorization), 15
     *  (insufficient encryption) or 137 (authentication failed): the printer wants a pairing this
     *  device no longer has, and Android's own retry with pairing already failed (D10). */
    val PAIRING_LOST: Set<Int> = setOf(5, 8, 15, 137)

    /** A disconnect's status is an HCI reason, where 5 is an authentication failure (137 if a stack
     *  reports the GATT one). 8 there is the supervision timeout (the printer went out of range or
     *  off), an ordinary drop, never a lost pairing. */
    val PAIRING_LOST_ON_DISCONNECT: Set<Int> = setOf(5, 137)
}

/** Why a link went down, for the connection details. */
fun describeDisconnect(status: Int): String = when (status) {
    GattStatus.SUCCESS -> "The link closed"
    8 -> "The link timed out: the printer is off or out of range (status 8)"
    19 -> "The printer ended the link (status 19)"
    22 -> "This device ended the link (status 22)"
    5, 137 -> "The printer refused this device's pairing (status $status)"
    133 -> "Bluetooth error (status 133)"
    else -> "The link dropped (status $status)"
}

/** Android didn't take a GATT request (its call returned false). */
class GattNotIssued(op: String) : Exception("Android didn't take the GATT request: $op")

/**
 * One GATT operation at a time on [link], in the order asked. Android's GATT client allows one
 * outstanding operation: one issued before the last one's callback is refused and lost. So each
 * operation waits here until the one before it is answered (or the link ends), then goes out; its
 * [Pending.result] is the callback's event. A caller may stop waiting for a result (a fallback
 * timeout): the operation still holds its turn until Android answers it, and that late answer
 * completes it, never the next one.
 *
 * Not thread-safe: call it, events included ([onEvent]), from the link owner's one dispatcher.
 */
class GattQueue(private val link: GattLink) {
    sealed class Op(val label: String) {
        internal abstract fun issue(link: GattLink): Boolean
        internal abstract fun answeredBy(event: GattEvent): Boolean

        data object DiscoverServices : Op("discover services") {
            override fun issue(link: GattLink) = link.discoverServices()
            override fun answeredBy(event: GattEvent) = event is GattEvent.ServicesDiscovered
        }

        class Read(val service: String, val characteristic: String) : Op("read $characteristic") {
            override fun issue(link: GattLink) = link.read(service, characteristic)
            override fun answeredBy(event: GattEvent) =
                event is GattEvent.CharacteristicRead && sameUuid(event.characteristic, characteristic)
        }

        class RequestMtu(val mtu: Int) : Op("request MTU $mtu") {
            override fun issue(link: GattLink) = link.requestMtu(mtu)
            override fun answeredBy(event: GattEvent) = event is GattEvent.MtuChanged
        }

        class EnableIndications(val service: String, val characteristic: String) : Op("enable indications on $characteristic") {
            override fun issue(link: GattLink) = link.enableIndications(service, characteristic)
            override fun answeredBy(event: GattEvent) =
                event is GattEvent.IndicationsEnabled && sameUuid(event.characteristic, characteristic)
        }

        class Write(val service: String, val characteristic: String, val value: ByteArray) : Op("write ${value.size} B") {
            override fun issue(link: GattLink) = link.write(service, characteristic, value)
            override fun answeredBy(event: GattEvent) =
                event is GattEvent.CharacteristicWritten && sameUuid(event.characteristic, characteristic)
        }
    }

    /** One operation: [issued] completes when Android took it; [result] with its callback's event,
     *  or fails with [GattNotIssued] or the error the link ended with (both fail together). */
    class Pending internal constructor(val op: Op) {
        val issued = CompletableDeferred<Unit>()
        val result = CompletableDeferred<GattEvent>()

        /** The callback's event once it came (also for a caller that stopped waiting). */
        var answer: GattEvent? = null
            internal set

        internal fun fail(error: Throwable) {
            issued.completeExceptionally(error)
            result.completeExceptionally(error)
        }
    }

    private val waiting = ArrayDeque<Pending>()
    private var outstanding: Pending? = null
    private var ended: Throwable? = null

    /** Whether an operation went out and hasn't been answered. */
    val busy: Boolean get() = outstanding != null

    /** Queues [op]; it goes out once every earlier one is answered. */
    fun submit(op: Op): Pending {
        val pending = Pending(op)
        val error = ended
        if (error != null) {
            pending.fail(error)
        } else {
            waiting.addLast(pending)
            issueNext()
        }
        return pending
    }

    /** [event] arrived: true when it answered the operation that is out (the next one then goes out). */
    fun onEvent(event: GattEvent): Boolean {
        val pending = outstanding ?: return false
        if (!pending.op.answeredBy(event)) return false
        outstanding = null
        pending.answer = event
        pending.result.complete(event)
        issueNext()
        return true
    }

    /** The link ended: every operation, out or waiting, fails with [error], and so does each one
     *  submitted later. */
    fun fail(error: Throwable) {
        if (ended == null) ended = error
        outstanding?.fail(error)
        outstanding = null
        while (waiting.isNotEmpty()) waiting.removeFirst().fail(error)
    }

    private fun issueNext() {
        while (outstanding == null && waiting.isNotEmpty()) {
            val pending = waiting.removeFirst()
            val taken = try {
                pending.op.issue(link)
            } catch (_: RuntimeException) {
                false
            }
            if (taken) {
                outstanding = pending
                pending.issued.complete(Unit)
            } else {
                pending.fail(GattNotIssued(pending.op.label))
            }
        }
    }
}

/** Availability from what can be read without prompting: no LE radio, then a missing permission
 *  (asked first: on API 31+ even the switch-on request needs it), then the adapter's state, then
 *  (API 30, [needsLocation]) Location being off. */
internal fun bluetoothAvailability(
    hasLe: Boolean,
    permitted: Boolean,
    adapterOn: Boolean,
    adapterTurning: Boolean,
    needsLocation: Boolean,
    locationOn: Boolean,
): BluetoothAvailability = when {
    !hasLe -> BluetoothAvailability.UNSUPPORTED
    !permitted -> BluetoothAvailability.UNAUTHORIZED
    adapterTurning -> BluetoothAvailability.UNKNOWN
    !adapterOn -> BluetoothAvailability.POWERED_OFF
    needsLocation && !locationOn -> BluetoothAvailability.LOCATION_OFF
    else -> BluetoothAvailability.READY
}

// --- Android ---

/**
 * The real client: the adapter's LE scanner and `BluetoothGatt` (`connectGatt(context, false,
 * callback, TRANSPORT_LE)`). It checks nothing itself: ZebraBluetooth calls only while
 * [availability] allows it, and a SecurityException (a permission taken away underneath) reads as a
 * refused call. Adapter, Location and bond changes come from system broadcasts, registered in
 * [listen].
 */
@SuppressLint("MissingPermission")
class AndroidBluetoothLe(context: Context) : BluetoothLeClient {
    private val app = context.applicationContext
    private val adapter: BluetoothAdapter? = app.getSystemService(BluetoothManager::class.java)?.adapter

    @Volatile
    private var listener: ((BluetoothLeEvent) -> Unit)? = null

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            listener?.invoke(advertisedFrom(result))
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { listener?.invoke(advertisedFrom(it)) }
        }

        override fun onScanFailed(errorCode: Int) {
            listener?.invoke(BluetoothLeEvent.ScanFailed(errorCode))
        }
    }

    override fun availability(): BluetoothAvailability {
        val state = try {
            adapter?.state
        } catch (_: SecurityException) {
            null
        }
        val location = app.getSystemService(LocationManager::class.java)
        return bluetoothAvailability(
            hasLe = adapter != null && app.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE),
            permitted = REQUIRED_PERMISSIONS.all {
                ContextCompat.checkSelfPermission(app, it) == PackageManager.PERMISSION_GRANTED
            },
            adapterOn = state == BluetoothAdapter.STATE_ON,
            adapterTurning = state == BluetoothAdapter.STATE_TURNING_ON || state == BluetoothAdapter.STATE_TURNING_OFF,
            needsLocation = Build.VERSION.SDK_INT < Build.VERSION_CODES.S,
            locationOn = location != null && LocationManagerCompat.isLocationEnabled(location),
        )
    }

    override fun listen(onEvent: (BluetoothLeEvent) -> Unit) {
        listener = onEvent
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    BluetoothAdapter.ACTION_STATE_CHANGED, LocationManager.MODE_CHANGED_ACTION ->
                        onEvent(BluetoothLeEvent.AvailabilityChanged)
                    BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
                        val previous = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR)
                        val now = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
                        val device = IntentCompat.getParcelableExtra(intent, BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                        if (device != null && previous == BluetoothDevice.BOND_BONDED && now == BluetoothDevice.BOND_NONE) {
                            onEvent(BluetoothLeEvent.BondLost(device.address))
                        }
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
            addAction(LocationManager.MODE_CHANGED_ACTION)
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
        }
        // Exported: these are protected system broadcasts, and the bond and adapter ones come from
        // the Bluetooth process (its own uid), which a non-exported receiver wouldn't hear.
        ContextCompat.registerReceiver(app, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    override fun startScan(): Boolean {
        val scanner = adapter?.bluetoothLeScanner ?: return false
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        return try {
            scanner.startScan(null, settings, scanCallback)
            true
        } catch (_: SecurityException) {
            false
        } catch (_: IllegalStateException) {
            false // Bluetooth went off
        }
    }

    override fun stopScan() {
        try {
            adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        } catch (_: SecurityException) {
        } catch (_: IllegalStateException) {
        }
    }

    override fun connect(address: String, onEvent: (GattEvent) -> Unit): GattLink? {
        val device = try {
            adapter?.getRemoteDevice(address)
        } catch (_: IllegalArgumentException) {
            null
        } ?: return null
        val gatt = try {
            device.connectGatt(app, false, GattCallback(onEvent), BluetoothDevice.TRANSPORT_LE)
        } catch (_: SecurityException) {
            null
        } ?: return null
        return AndroidGattLink(address, gatt)
    }

    private companion object {
        /** API 31+: the nearby-devices pair; API 30: fine location (scans need it). */
        val REQUIRED_PERMISSIONS: List<String> =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                listOf(Manifest.permission.ACCESS_FINE_LOCATION)
            }
    }
}

/** An advertisement as the link reads it: the name from the scan record. */
internal fun advertisedFrom(result: ScanResult): BluetoothLeEvent.Advertised {
    val record = result.scanRecord
    val uuids = buildList {
        record?.serviceUuids?.forEach { add(it.uuid.toString()) }
        record?.serviceData?.keys?.forEach { add(it.uuid.toString()) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) record?.serviceSolicitationUuids?.forEach { add(it.uuid.toString()) }
    }
    val zebra = uuids.any {
        sameUuid(it, ZebraBluetoothSpec.SERVICE_UUID) || sameUuid(it, ZebraBluetoothSpec.ZEBRA_MEMBER_UUID)
    }
    return BluetoothLeEvent.Advertised(result.device.address, record?.deviceName, result.rssi, zebra)
}

/** `BluetoothGatt` behind [GattLink], with the API 33+ calls where they exist and the older ones
 *  below them. */
@SuppressLint("MissingPermission")
private class AndroidGattLink(override val address: String, private val gatt: BluetoothGatt) : GattLink {
    override fun discoverServices(): Boolean = guard { gatt.discoverServices() }

    override fun hasCharacteristic(service: String, characteristic: String): Boolean =
        characteristic(service, characteristic) != null

    override fun read(service: String, characteristic: String): Boolean = guard {
        val c = characteristic(service, characteristic) ?: return@guard false
        gatt.readCharacteristic(c)
    }

    override fun requestMtu(mtu: Int): Boolean = guard { gatt.requestMtu(mtu) }

    @Suppress("DEPRECATION")
    override fun enableIndications(service: String, characteristic: String): Boolean = guard {
        val c = characteristic(service, characteristic) ?: return@guard false
        if (!gatt.setCharacteristicNotification(c, true)) return@guard false
        val cccd = c.getDescriptor(UUID.fromString(ZebraBluetoothSpec.CCCD_UUID)) ?: return@guard false
        val value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
        } else {
            cccd.value = value
            gatt.writeDescriptor(cccd)
        }
    }

    @Suppress("DEPRECATION")
    override fun write(service: String, characteristic: String, value: ByteArray): Boolean = guard {
        val c = characteristic(service, characteristic) ?: return@guard false
        val type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeCharacteristic(c, value, type) == BluetoothStatusCodes.SUCCESS
        } else {
            c.writeType = type
            c.value = value
            gatt.writeCharacteristic(c)
        }
    }

    override fun requestHighPriority(): Boolean = guard {
        gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
    }

    override fun disconnect() {
        guard {
            gatt.disconnect()
            true
        }
    }

    override fun close() {
        guard {
            gatt.close()
            true
        }
    }

    private fun characteristic(service: String, characteristic: String): BluetoothGattCharacteristic? =
        gatt.getService(UUID.fromString(gattUuid(service)))?.getCharacteristic(UUID.fromString(gattUuid(characteristic)))

    /** A call Android refused with an exception (a permission taken away, Bluetooth gone) is a refusal. */
    private inline fun guard(call: () -> Boolean): Boolean = try {
        call()
    } catch (_: SecurityException) {
        false
    } catch (_: IllegalStateException) {
        false
    }
}

/** `BluetoothGattCallback` as [GattEvent]s. On API 33+ Android calls both the new value-carrying
 *  callbacks and the old ones; the old ones are used only below 33, so nothing arrives twice. */
private class GattCallback(private val onEvent: (GattEvent) -> Unit) : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
        onEvent(GattEvent.ConnectionChanged(status, newState == BluetoothProfile.STATE_CONNECTED))
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
        onEvent(GattEvent.ServicesDiscovered(status))
    }

    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
        onEvent(GattEvent.CharacteristicRead(uuidOf(characteristic.uuid), value.copyOf(), status))
    }

    @Deprecated("Below API 33 only")
    @Suppress("DEPRECATION")
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
        onEvent(GattEvent.CharacteristicRead(uuidOf(characteristic.uuid), characteristic.value?.copyOf(), status))
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
        onEvent(GattEvent.MtuChanged(mtu, status))
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
        if (sameUuid(descriptor.uuid.toString(), ZebraBluetoothSpec.CCCD_UUID)) {
            onEvent(GattEvent.IndicationsEnabled(uuidOf(descriptor.characteristic.uuid), status))
        }
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
        onEvent(GattEvent.CharacteristicWritten(uuidOf(characteristic.uuid), status))
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        onEvent(GattEvent.Indication(uuidOf(characteristic.uuid), value.copyOf()))
    }

    @Deprecated("Below API 33 only")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
        onEvent(GattEvent.Indication(uuidOf(characteristic.uuid), characteristic.value?.copyOf() ?: ByteArray(0)))
    }

    private fun uuidOf(uuid: UUID): String = uuid.toString().uppercase()
}
