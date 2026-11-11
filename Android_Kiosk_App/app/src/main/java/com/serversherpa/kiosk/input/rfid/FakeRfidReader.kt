package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledTriggerReadback
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import com.serversherpa.kiosk.core.rfid.effectiveLayout
import com.serversherpa.kiosk.core.rfid.keys
import com.serversherpa.kiosk.core.rfid.readbackOf
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/**
 * A reader with no hardware behind it. It drives every test, and the Developer
 * tab uses it to drive the reader adapter — connect, a trigger press, tag
 * reads, trigger release — as a plumbing smoke test on a phone with no sled.
 * That burst never reaches the Scanning screen's live panel or the outbox:
 * `RfidController` only acts on triggers while armed, and only that screen
 * arms it.
 *
 * It ships in `main`, not `test`, for exactly that reason, so every knob
 * defaults to success.
 *
 * It keeps the [RfidReader] contract the way the Zebra adapter does: a call
 * in the wrong state fails with [SledNotConnected]; [info] is null during a
 * connect attempt and after [disconnect], set before `Connected` or
 * `NeedsRegion` is published, and kept through a link loss; [scanner] is
 * `Off` whenever the link is not `Connected`. It also records what it was
 * asked, and [violations] catches a controller that calls it during a sweep or
 * makes two calls at once.
 */
class FakeRfidReader(name: String = "Fake RFD40") : RfidReader {
    private val readerName = name

    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection

    private val _connectNote = MutableStateFlow<String?>(null)
    override val connectNote: StateFlow<String?> = _connectNote

    private val _info = MutableStateFlow<SledInfo?>(null)
    override val info: StateFlow<SledInfo?> = _info

    private val _scanner = MutableStateFlow<SledScannerState>(SledScannerState.Off)
    override val scanner: StateFlow<SledScannerState> = _scanner

    private val _batchRecovery = MutableStateFlow(false)
    override val batchRecovery: StateFlow<Boolean> = _batchRecovery

    private val _vendorLogging = MutableStateFlow(false)
    override val vendorLogging: StateFlow<Boolean> = _vendorLogging

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 256)
    override val tags: SharedFlow<String> = _tags

    private val _pulls = MutableSharedFlow<TriggerPull>(extraBufferCapacity = 16)
    override val pulls: SharedFlow<TriggerPull> = _pulls

    /** [pulls] without their stamps. */
    override val triggers: Flow<TriggerEvent> = _pulls.map { it.event }

    private val _barcodes = MutableSharedFlow<SledBarcode>(extraBufferCapacity = 64)
    override val barcodes: SharedFlow<SledBarcode> = _barcodes

    private val _unsolicitedStops = MutableSharedFlow<String>(extraBufferCapacity = 16)
    override val unsolicitedStops: SharedFlow<String> = _unsolicitedStops

    // ── what a test reads back ──

    /** The settings last handed to [apply] while connected, for a test to assert on. */
    @Volatile var applied: RfidSettings? = null
        private set

    /** True between a successful [startInventory] and the next stop, connect,
     *  disconnect, [dropLink] or [setConnection] to anything but `Connected`. */
    @Volatile var inventoryRunning: Boolean = false
        private set

    private val _connectCalls = AtomicInteger(0)
    /** Every [connect] call, successful or not. */
    val connectCalls: Int get() = _connectCalls.get()

    private val _regionsCalls = AtomicInteger(0)
    /** Every [regions] call, in any state. */
    val regionsCalls: Int get() = _regionsCalls.get()

    /** The request the last [connect] was given. */
    @Volatile var lastRequest: SledConnectRequest? = null
        private set

    private val _layoutCalls = CopyOnWriteArrayList<SledTriggerLayout>()
    /** Every [setTriggerLayout] argument, in order, including calls that failed. */
    val layoutCalls: List<SledTriggerLayout> get() = _layoutCalls.toList()

    private val _batteryRequests = AtomicInteger(0)
    /** Every [requestBattery] call, in any state. */
    val batteryRequests: Int get() = _batteryRequests.get()

    private val _softScans = CopyOnWriteArrayList<Boolean>()
    /** Every [softScan] argument, in order, including calls that failed. */
    val softScans: List<Boolean> get() = _softScans.toList()

    private val _retryScannerCalls = AtomicInteger(0)
    /** Every [retryScanner] call, in any state. */
    val retryScannerCalls: Int get() = _retryScannerCalls.get()

    private val _disconnectCalls = AtomicInteger(0)
    /** Every [disconnect] call. */
    val disconnectCalls: Int get() = _disconnectCalls.get()

    private val _generation = AtomicInteger(0)
    /** The last generation handed out: one per successful [connect], and one when
     *  [setConnection] brings the link up while [info] is null. */
    val generation: Int get() = _generation.get()

    private val _violations = CopyOnWriteArrayList<String>()
    /**
     * Calls a real sled must not get: any of [apply], [startInventory],
     * [regions], [setRegion], [setTriggerLayout], [requestBattery] or [connect]
     * made while [inventoryRunning], and any two of those (or [stopInventory] or
     * [disconnect]) in flight at once. [softScan], [retryScanner],
     * [pairedSleds] and [setVendorLogging] are never violations. Each entry
     * names the calls involved. Controller tests assert it is empty.
     */
    val violations: List<String> get() = _violations.toList()

    // ── knobs (each defaults to success) ──

    /** What the next [connect] does. A failure whose exception is a
     *  [SledConnectException] publishes its `failed`; any other failure
     *  publishes `Failed(message)`, or the couldn't-reach sentence when it has
     *  no message. Either way the returned failure is a [SledConnectException]
     *  whose `failed` is the state just published. */
    @Volatile var connectResult: Result<Unit> = Result.success(Unit)

    /** What [apply] returns while connected. */
    @Volatile var applyResult: Result<Unit> = Result.success(Unit)

    /** What [startInventory] returns while connected; only success starts an inventory. */
    @Volatile var startResult: Result<Unit> = Result.success(Unit)

    /** What [stopInventory] returns while connected. */
    @Volatile var stopResult: Result<Unit> = Result.success(Unit)

    /** What [setTriggerLayout] returns while connected. Null: accept, with the
     *  read-back of `effectiveLayout(layout, false, info?.hasScanner)`. A
     *  success also becomes `info.trigger`; a failure leaves it as it was. */
    @Volatile var layoutResult: Result<SledTriggerReadback>? = null

    /** What this fake claims to support. Set it in a test before connecting. */
    @Volatile var reportedRegions: RfidRegions = RfidRegions(emptyList(), null)

    /** The last region a caller set, for a test to assert on. */
    @Volatile var lastRegionSet: Pair<String, Boolean?>? = null
        private set

    /** What [setRegion] returns while the link is up. */
    @Volatile var regionResult: Result<Unit> = Result.success(Unit)

    /** Makes a successful [connect] publish `NeedsRegion`: then only [regions]
     *  and [setRegion] work; [apply], [startInventory] and [setTriggerLayout]
     *  fail with [SledNotConnected]. */
    @Volatile var needsRegion: Boolean = false

    /** What [pairedSleds] returns. */
    @Volatile var paired: List<SledCandidate> = emptyList()

    private val hold = AtomicReference<CompletableDeferred<Unit>?>(null)
    /** Holds a call open: the next call that [violations] tracks awaits this
     *  before returning, and it resets to null as that call takes it. [connect]
     *  awaits it after publishing `Connecting`; [disconnect] after publishing
     *  `Disconnected`; every other call before it does anything. */
    var holdNext: CompletableDeferred<Unit>?
        get() = hold.get()
        set(value) = hold.set(value)

    // ── the reader ──

    private val inFlight = AtomicInteger(0)
    private val inFlightNames = mutableListOf<String>()

    /** Runs [body] as [call], recording a violation when another tracked call is
     *  already in flight, or (with [checksInventory]) when an inventory runs. */
    private suspend fun <T> tracked(call: String, checksInventory: Boolean, body: suspend () -> T): T {
        val running = inventoryRunning
        synchronized(inFlightNames) {
            val others = inFlightNames.toList()
            inFlightNames += call
            if (inFlight.getAndIncrement() > 0) {
                _violations += "$call while ${others.joinToString(" and ")} ${if (others.size == 1) "was" else "were"} in flight"
            }
        }
        if (checksInventory && running) _violations += "$call during a running inventory"
        try {
            return body()
        } finally {
            synchronized(inFlightNames) { inFlightNames.remove(call) }
            inFlight.decrementAndGet()
        }
    }

    private suspend fun awaitHold() {
        hold.getAndSet(null)?.await()
    }

    private val linkUp: Boolean
        get() = _connection.value.let { it is RfidConnection.Connected || it is RfidConnection.NeedsRegion }

    /** Always dials, so `connectCalls` shows whether the controller did: a call
     *  while already `Connected` reconnects with a new generation. */
    override suspend fun connect(request: SledConnectRequest): Result<Unit> = tracked("connect()", checksInventory = true) {
        _connectCalls.incrementAndGet()
        lastRequest = request
        inventoryRunning = false
        _info.value = null
        _scanner.value = SledScannerState.Off
        // Mirrors ZebraRfidReader.connect(), which clears its own connectNote
        // at the top of every new attempt so a stale note never lingers.
        _connectNote.value = null
        _connection.value = RfidConnection.Connecting
        awaitHold()
        connectResult.fold(
            onSuccess = {
                _info.value = SledInfo(generation = _generation.incrementAndGet(), name = readerName, address = request.address)
                _connection.value =
                    if (needsRegion) RfidConnection.NeedsRegion(readerName) else RfidConnection.Connected(readerName, 80)
                Result.success(Unit)
            },
            onFailure = { e ->
                val failed = (e as? SledConnectException)?.failed
                    ?: RfidConnection.Failed(e.message?.takeIf { it.isNotBlank() } ?: SledWords.couldNotReach(readerName))
                _connection.value = failed
                Result.failure(e as? SledConnectException ?: SledConnectException(failed).apply { initCause(e) })
            },
        )
    }

    override suspend fun disconnect() {
        tracked("disconnect()", checksInventory = false) {
            _disconnectCalls.incrementAndGet()
            inventoryRunning = false
            _info.value = null
            _scanner.value = SledScannerState.Off
            _connection.value = RfidConnection.Disconnected
            awaitHold()
        }
    }

    override suspend fun apply(settings: RfidSettings): Result<Unit> = tracked("apply()", checksInventory = true) {
        awaitHold()
        if (_connection.value !is RfidConnection.Connected) {
            Result.failure(SledNotConnected())
        } else {
            applied = settings
            applyResult
        }
    }

    override suspend fun startInventory(): Result<Unit> = tracked("startInventory()", checksInventory = true) {
        awaitHold()
        if (_connection.value !is RfidConnection.Connected) {
            Result.failure(SledNotConnected())
        } else {
            startResult.onSuccess { inventoryRunning = true }
        }
    }

    /** [SledNotConnected] unless `Connected`; there it always ends the
     *  inventory and returns [stopResult]. */
    override suspend fun stopInventory(): Result<Unit> = tracked("stopInventory()", checksInventory = false) {
        awaitHold()
        if (_connection.value !is RfidConnection.Connected) {
            Result.failure(SledNotConnected())
        } else {
            inventoryRunning = false
            stopResult
        }
    }

    override suspend fun regions(): Result<RfidRegions> = tracked("regions()", checksInventory = true) {
        _regionsCalls.incrementAndGet()
        awaitHold()
        if (!linkUp) Result.failure(SledNotConnected()) else Result.success(reportedRegions)
    }

    override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> = tracked("setRegion()", checksInventory = true) {
        awaitHold()
        if (!linkUp) {
            Result.failure(SledNotConnected())
        } else {
            regionResult.onSuccess {
                lastRegionSet = code to hopping
                reportedRegions = reportedRegions.copy(active = code)
            }
        }
    }

    override suspend fun setTriggerLayout(layout: SledTriggerLayout): Result<SledTriggerReadback> =
        tracked("setTriggerLayout()", checksInventory = true) {
            _layoutCalls += layout
            awaitHold()
            if (_connection.value !is RfidConnection.Connected) {
                Result.failure(SledNotConnected())
            } else {
                (layoutResult ?: Result.success(acceptedReadback(layout)))
                    .onSuccess { readback -> _info.update { it?.copy(trigger = readback) } }
            }
        }

    /** What a sled that takes every write reports for [layout]. */
    private fun acceptedReadback(layout: SledTriggerLayout): SledTriggerReadback {
        val (upper, lower) = effectiveLayout(layout, zebraHost = false, hasScanner = _info.value?.hasScanner).keys()
        return readbackOf(upper, lower, null)
    }

    override suspend fun requestBattery() {
        tracked("requestBattery()", checksInventory = true) {
            _batteryRequests.incrementAndGet()
            awaitHold()
        }
    }

    override suspend fun softScan(pull: Boolean): Result<Unit> {
        _softScans += pull
        return if (_scanner.value == SledScannerState.Ready) Result.success(Unit) else Result.failure(SledNotConnected())
    }

    override suspend fun retryScanner(): Result<Unit> {
        _retryScannerCalls.incrementAndGet()
        return if (_connection.value is RfidConnection.Connected) Result.success(Unit) else Result.failure(SledNotConnected())
    }

    override fun pairedSleds(): List<SledCandidate> = paired

    override fun setVendorLogging(on: Boolean) {
        _vendorLogging.value = on
    }

    // ── what a test or the Developer tab drives ──
    // MutableSharedFlow buffers up to its extraBufferCapacity even with zero
    // subscribers, so tryEmit alone would only fail once that buffer fills —
    // it would stay silently green for the much more common "no collector
    // yet" case. Checking subscriptionCount first makes that case loud too.

    /** A trigger event on [pulls] (and so on [triggers]), stamped [atMs]. */
    fun emitTrigger(event: TriggerEvent, atMs: Long? = null) {
        check(_pulls.subscriptionCount.value > 0) { "Dropped trigger event $event: nothing was collecting." }
        check(_pulls.tryEmit(TriggerPull(event, atMs))) { "Dropped trigger event $event: nothing was collecting." }
    }

    fun emitTag(epc: String) {
        check(_tags.subscriptionCount.value > 0) { "Dropped tag $epc: nothing was collecting." }
        check(_tags.tryEmit(epc)) { "Dropped tag $epc: nothing was collecting." }
    }

    /** A barcode from the sled's scanner, whatever [scanner] says. */
    fun emitBarcode(barcode: SledBarcode) {
        check(_barcodes.subscriptionCount.value > 0) { "Dropped barcode ${barcode.value}: nothing was collecting." }
        check(_barcodes.tryEmit(barcode)) { "Dropped barcode ${barcode.value}: nothing was collecting." }
    }

    /** A sweep the sled ended by itself. Only the event: [inventoryRunning]
     *  stays as it is, so a test can see whether the controller sent its stop. */
    fun emitUnsolicitedStop(reason: String) {
        check(_unsolicitedStops.subscriptionCount.value > 0) { "Dropped unsolicited stop ($reason): nothing was collecting." }
        check(_unsolicitedStops.tryEmit(reason)) { "Dropped unsolicited stop ($reason): nothing was collecting." }
    }

    fun setInfo(info: SledInfo?) {
        _info.value = info
    }

    fun setScanner(state: SledScannerState) {
        _scanner.value = state
    }

    fun setBatchRecovery(on: Boolean) {
        _batchRecovery.value = on
    }

    /** The link dropped: `Failed(reason, retryable = true)`, no inventory, the
     *  scanner `Off`, [info] kept (a drop, not a connect that never came up). */
    fun dropLink(reason: String) {
        inventoryRunning = false
        _scanner.value = SledScannerState.Off
        _connection.value = RfidConnection.Failed(reason, retryable = true)
    }

    /** This fake has no real batch-mode concept, so a test that needs to
     *  simulate "the reader reported a note" (e.g. proving RfidController or
     *  RfidPanel pass connectNote through) sets it directly here. */
    fun setConnectNote(note: String?) {
        _connectNote.value = note
    }

    /**
     * Publishes [c] as the reader would. Anything but `Connected` ends any
     * inventory (a real sled cannot be running one while disconnected) and
     * turns the scanner `Off`. `Connected` or `NeedsRegion` while [info] is
     * null also sets `info` to a new generation named for the state; while
     * `info` is set it is kept (a battery change is not a new generation).
     * `Connecting`, `Disconnected` and `Disabled` clear `info`, as the start
     * of an attempt and a disconnect do; `Failed` keeps it, as a link loss does.
     */
    fun setConnection(c: RfidConnection) {
        if (c !is RfidConnection.Connected) {
            inventoryRunning = false
            _scanner.value = SledScannerState.Off
        }
        when (c) {
            is RfidConnection.Connected -> if (_info.value == null) _info.value = SledInfo(generation = _generation.incrementAndGet(), name = c.name)
            is RfidConnection.NeedsRegion -> if (_info.value == null) _info.value = SledInfo(generation = _generation.incrementAndGet(), name = c.name)
            RfidConnection.Connecting, RfidConnection.Disconnected, RfidConnection.Disabled -> _info.value = null
            is RfidConnection.Failed -> Unit
        }
        _connection.value = c
    }
}
