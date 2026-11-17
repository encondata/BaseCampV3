package com.serversherpa.kiosk.input.rfid

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import android.view.InputDevice
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.core.rfid.AttributeRead
import com.serversherpa.kiosk.core.rfid.BatchPrevention
import com.serversherpa.kiosk.core.rfid.BatchRecoveryPlan
import com.serversherpa.kiosk.core.rfid.BondedDevice
import com.serversherpa.kiosk.core.rfid.InterimWriteOutcome
import com.serversherpa.kiosk.core.rfid.LayoutWrite
import com.serversherpa.kiosk.core.rfid.LayoutWriteOutcome
import com.serversherpa.kiosk.core.rfid.LinkTroubleTracker
import com.serversherpa.kiosk.core.rfid.PerformOutcome
import com.serversherpa.kiosk.core.rfid.PowerTable
import com.serversherpa.kiosk.core.rfid.Precheck
import com.serversherpa.kiosk.core.rfid.PushOutcome
import com.serversherpa.kiosk.core.rfid.ResultClass
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SLED_BEST_STEP_DEADLINE_MS
import com.serversherpa.kiosk.core.rfid.SettingStep
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledKey
import com.serversherpa.kiosk.core.rfid.SledLayoutMemory
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledTriggerReadback
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TeardownPlan
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import com.serversherpa.kiosk.core.rfid.VendorError
import com.serversherpa.kiosk.core.rfid.batchPrevention
import com.serversherpa.kiosk.core.rfid.batchRecoveryPlan
import com.serversherpa.kiosk.core.rfid.bestStepDue
import com.serversherpa.kiosk.core.rfid.classifyResult
import com.serversherpa.kiosk.core.rfid.connectFailure
import com.serversherpa.kiosk.core.rfid.effectiveLayout
import com.serversherpa.kiosk.core.rfid.isInterimFor
import com.serversherpa.kiosk.core.rfid.layoutInForceUsesScanner
import com.serversherpa.kiosk.core.rfid.message
import com.serversherpa.kiosk.core.rfid.pairedSledsOf
import com.serversherpa.kiosk.core.rfid.performOutcome
import com.serversherpa.kiosk.core.rfid.powerIndex
import com.serversherpa.kiosk.core.rfid.powerTable
import com.serversherpa.kiosk.core.rfid.precheck as decidePrecheck
import com.serversherpa.kiosk.core.rfid.regionArgs
import com.serversherpa.kiosk.core.rfid.runInterimWrite
import com.serversherpa.kiosk.core.rfid.runLayoutWrite
import com.serversherpa.kiosk.core.rfid.runSettingSteps
import com.serversherpa.kiosk.core.rfid.scannerWanted
import com.serversherpa.kiosk.core.rfid.sentence
import com.serversherpa.kiosk.core.rfid.stopSettled
import com.serversherpa.kiosk.core.rfid.teardownPlan
import com.serversherpa.kiosk.core.rfid.triggerTypePasses
import com.serversherpa.kiosk.core.rfid.usesScanner
import com.serversherpa.kiosk.core.rfid.vendorLogLine
import com.zebra.rfid.api3.AttributeInfo
import com.zebra.rfid.api3.BATCH_MODE
import com.zebra.rfid.api3.BEEPER_VOLUME
import com.zebra.rfid.api3.DYNAMIC_POWER_OPTIMIZATION
import com.zebra.rfid.api3.ENUM_NEW_KEYLAYOUT_TYPE
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.ENUM_TRIGGER_MODE
import com.zebra.rfid.api3.HANDHELD_TRIGGER_EVENT_TYPE
import com.zebra.rfid.api3.IEvents
import com.zebra.rfid.api3.INVENTORY_STATE
import com.zebra.rfid.api3.InvalidUsageException
import com.zebra.rfid.api3.OperationFailureException
import com.zebra.rfid.api3.RFIDReader
import com.zebra.rfid.api3.RFIDResults
import com.zebra.rfid.api3.RFID_EVENT_TYPE
import com.zebra.rfid.api3.ReaderDevice
import com.zebra.rfid.api3.Readers
import com.zebra.rfid.api3.RegionInfo
import com.zebra.rfid.api3.RegulatoryConfig
import com.zebra.rfid.api3.RfidEventsListener
import com.zebra.rfid.api3.RfidReadEvents
import com.zebra.rfid.api3.RfidStatusEvents
import com.zebra.rfid.api3.SESSION
import com.zebra.rfid.api3.SL_FLAG
import com.zebra.rfid.api3.START_TRIGGER_TYPE
import com.zebra.rfid.api3.STATUS_EVENT_TYPE
import com.zebra.rfid.api3.STOP_TRIGGER_TYPE
import com.zebra.rfid.api3.SetAttribute
import com.zebra.rfid.api3.StartTrigger
import com.zebra.rfid.api3.StopTrigger
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the vendor connect sequence produced ([ZebraRfidReader.openVendorConnection]). */
sealed interface VendorOpen {
    /** The link is up and set up. */
    data class Up(val info: SledInfo) : VendorOpen

    /** The link is up but the sled has no region: only the listener and the disconnect event are registered. */
    data class NoRegion(val info: SledInfo) : VendorOpen

    /** The sled was holding a batch of offline tags; the recovery ran. [purged] says whether the tags were cleared. */
    data class BatchCleared(val purged: Boolean) : VendorOpen
}

/**
 * The Zebra RFD40-family sled, through the vendor's `com.zebra.rfid.api3`.
 * This file and `ZebraBarcodeEngine.kt` are the only two that import a Zebra
 * SDK (`CorePurityTest.onlyDesignatedFilesImportTheZebraSdk`).
 *
 * **One worker thread.** Every vendor block (connect, setup, teardown,
 * apply, start, stop, purge, regions, set region, trigger layout, battery)
 * runs on one thread,
 * [WORKER_THREAD_NAME], made once for the life of the adapter, in the order
 * the calls arrive. A call posts its block and awaits it; a caller that stops
 * waiting stops only its wait, and the block still runs to the end. Nothing
 * here interrupts a thread or cancels a future: the vendor bounds its own
 * waits (2 s per status, 15 s for a save, under 30 s for a connect), and the
 * controller's waits are its own. Every block checks the state before its
 * first vendor call and returns [SledNotConnected] in the wrong one.
 *
 * **Per-connection generation.** Each connect attempt and each disconnect
 * starts a new generation. A new listener per connection carries its
 * generation, and a tag, trigger, battery or disconnect callback from any
 * other generation is dropped. State is written under one small lock with
 * the generation check inside it, so a block that finishes after a newer
 * call never overwrites what that call published. A loss (the vendor's
 * disconnect event, or two link-trouble results in a row) is recorded for
 * its generation; for the current one it writes
 * `Failed(couldNotReach(name), retryable = true, fix = CONNECT)` while the state is
 * `Connecting`, `Connected` or `NeedsRegion`, and the link's blocks then
 * return [SledNotConnected].
 *
 * **Connect.** A pre-check over Android's bonded list runs before any
 * vendor object is built ([precheck]); then [openVendorConnection] runs the
 * vendor sequence (spec, Connect sequence). A failed connect's cleanup runs
 * once, on a thread of its own for that attempt, and asks nothing of the
 * sled: it removes the listener, disconnects and disposes. The worker's next
 * block waits until that cleanup has ended, however long it takes (logged
 * every [CLEANUP_BOUND_MS], or [BATCH_CLEANUP_BOUND_MS] after a batch
 * recovery), because the vendor keeps one protocol layer and one Bluetooth
 * transport for the whole process: each `RFIDReader` is only a handle on
 * them, so a late cleanup would close or confuse the next attempt's link.
 *
 * Every operator sentence is a [SledWords] member. Vendor result names and
 * texts go to the log (`adb logcat -s ZebraRfidReader`) through
 * [vendorLogLine], never onto the screen. A `LinkageError` (a class or native
 * library the raw vendor `.aar` needs and the device lacks) is caught beside
 * every `Exception`, so a connect still ends in a sentence.
 *
 * [zebraHost] says whether the phone is a Zebra handheld (`isZebraHost`):
 * there the sled always gets the RFID layout (`effectiveLayout`, used by
 * every trigger layout write) and no scanner session.
 *
 * **The scanner session** (connect step 12) is [ZebraBarcodeEngine]'s, on its
 * own worker. The adapter asks it for the session `scannerWanted` calls for
 * (ruling 7: `Connected`, the layout in force uses the scanner, not a Zebra
 * host, a sled not known to lack one) after a connect comes up and after each
 * [setTriggerLayout], and for none at the start of each attempt, on a
 * disconnect and on a link loss, so [scanner] is `Off` whenever the link is
 * not `Connected`. It never waits for the session. The adapter's own
 * Bluetooth receiver closes the session when Bluetooth turns off.
 *
 * **No beam until the scanner is ready** (the spec's step-18 fork). The
 * session takes about a second or two to come up after a layout that uses
 * the scanner is written, and a scan made meanwhile is dropped. So a layout
 * that uses the scanner, written while [scanner] is not `Ready` for the
 * current generation (always at connect), gets its no-beam keys
 * (`interimKeys`) first; the session opens from that read-back
 * (`layoutInForceUsesScanner`), and when the engine turns `Ready` for the
 * current generation the real keys are written on the worker, once, unless a
 * newer layout or generation came first (during a sweep, after its stop).
 * `Ready` means the sled acknowledged the scanner engine's scan enable. A
 * scanner that does not start keeps
 * the no-beam keys; Try again's `Ready` writes the real ones. A sled that
 * refuses the no-beam keys gets the real keys at once.
 */
open class ZebraRfidReader(
    private val context: Context,
    private val scope: CoroutineScope,
    private val zebraHost: Boolean = false,
) : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection.asStateFlow()

    private val _connectNote = MutableStateFlow<String?>(null)
    override val connectNote: StateFlow<String?> = _connectNote.asStateFlow()

    private val _info = MutableStateFlow<SledInfo?>(null)
    override val info: StateFlow<SledInfo?> = _info.asStateFlow()

    private val _batchRecovery = MutableStateFlow(false)
    override val batchRecovery: StateFlow<Boolean> = _batchRecovery.asStateFlow()

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = TAGS_BUFFER)
    override val tags: SharedFlow<String> = _tags.asSharedFlow()

    private val _pulls = MutableSharedFlow<TriggerPull>(extraBufferCapacity = 16)
    override val pulls: SharedFlow<TriggerPull> = _pulls.asSharedFlow()
    override val triggers: Flow<TriggerEvent> = _pulls.map { it.event }

    private val _unsolicitedStops = MutableSharedFlow<String>(extraBufferCapacity = 16)
    override val unsolicitedStops: SharedFlow<String> = _unsolicitedStops.asSharedFlow()

    /** What [setVendorLogging] last set; the vendor's logger is process-wide, so this is too. */
    override val vendorLogging: StateFlow<Boolean> = vendorLoggingState.asStateFlow()

    /**
     * The sled's scanner session, built on first use by [buildScannerEngine]
     * and never from the constructor, where a test subclass's override would
     * run before its own fields exist (preflight ruling 2). The adapter's
     * Bluetooth receiver is registered with it, for the adapter's life, and
     * its turns to `Ready` post the real trigger keys ([scannerReady]).
     */
    private val scannerEngine: ZebraBarcodeEngine by lazy {
        buildScannerEngine().also {
            registerBluetoothReceiver(it)
            it.onReady = ::scannerReady
        }
    }

    /** `Off` whenever the link is not `Connected`; otherwise the engine's `Opening`, `Ready` or `Unavailable`. */
    final override val scanner: StateFlow<SledScannerState> get() = scannerEngine.state

    /** Barcodes from the sled's scanner, emitted only while [scanner] is `Ready`. */
    final override val barcodes: SharedFlow<SledBarcode> get() = scannerEngine.barcodes

    /**
     * The layout the controller last requested in the current generation:
     * the connect request's, or the last [setTriggerLayout] that passed the
     * state check in this generation (a refused call never changes it).
     * While no read-back was accepted, the layout in force is its
     * `effectiveLayout` (ruling 27), and the scanner session follows it.
     * Written under [stateLock].
     */
    @Volatile private var requestedLayout: SledTriggerLayout = SledTriggerLayout.RFID

    /** The one thread every vendor block runs on; never interrupted. */
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, WORKER_THREAD_NAME).apply { isDaemon = true }
    }

    private val generations = AtomicInteger(0)

    /** The generation callbacks and blocks must carry to count. */
    internal val currentGeneration: Int get() = generations.get()

    /** Guards a generation check together with the state writes it allows. Held briefly, never around a vendor call. */
    private val stateLock = Any()

    /** Every generation whose link was lost. */
    private val lostGenerations: MutableSet<Int> = ConcurrentHashMap.newKeySet()

    /** The chosen sled's name for the attempt in flight, for the link-loss sentence before `info` is set. */
    @Volatile private var linkName: String? = null

    /** The chosen sled's address for the attempt in flight (and the link it opened), for [layoutMemory]. Worker-confined. */
    private var linkAddress: String? = null

    /** The sleds this adapter wrote a trigger layout to: their config is never saved ([layoutMayBeLive]). */
    private val layoutMemory = SledLayoutMemory()

    /** The vendor objects of the open (or failed, not yet cleaned up) link. Read by the cleanup thread. */
    @Volatile private var link: VendorLink? = null

    // Worker-confined from here down.
    private var openGeneration = NO_GENERATION
    private var links = LinkTroubleTracker()
    private var batchInARow = false
    private var batchNote: String? = null
    private var pendingCleanup: Thread? = null
    private var pendingCleanupBoundMs = CLEANUP_BOUND_MS

    /** This connection's transmit-power table (connect step 8); null until read, or when the sled gave none. */
    private var powerTable: PowerTable? = null

    /** The settings the last push left on the sled (all of them, or all but the refused ones); null before any push. */
    private var lastApplied: RfidSettings? = null

    /** A start found an inventory already running: after the next stop, set the start and stop triggers IMMEDIATE again. */
    private var reimmediateAfterStop = false

    /** A vendor call in this connect's setup said the sled has no region (steps 8 to 11). */
    private var sawRegionNotSet = false

    /**
     * The no-beam keys the last layout write left on the sled, for the
     * generation and the effective layout they stand in for; null after a
     * write of real keys, or when that write was refused. The scanner's
     * `Ready` writes the real keys only while this still names the current
     * generation and the effective layout asked of it ([finishNoBeamLayout]).
     */
    private var noBeamFor: NoBeam? = null

    /** The scanner came up while an inventory was running: [finishNoBeamLayout] runs again after the next stop. */
    private var noBeamAfterStop = false

    // Written on the worker and on the vendor's event thread.
    private val inventory = InventoryTracker { nowMs() }
    @Volatile private var lastTagAtMs = 0L

    /** The last battery level the current generation reported, kept so the publish at the end of a connect can show it. */
    @Volatile private var lastBatteryPct: Int? = null

    /**
     * True when the last vendor open ended in a batch result, with no other
     * open outcome since (a pre-check refusal leaves it as it was). A batch
     * result now is then the second in a row, which only stops the radio
     * ([batchRecoveryPlan], ruling 28). Read it on the worker, from
     * [openVendorConnection].
     */
    protected val lastOpenWasBatch: Boolean get() = batchInARow

    /** One connection's vendor objects and its listener. */
    private class VendorLink(val readers: Readers, val listener: RfidEventsListener) {
        @Volatile var reader: RFIDReader? = null
        @Volatile var listenerAdded = false
    }

    /**
     * A failed connect's cleanup thread. It closes [vendor], the link its
     * attempt built, captured on the worker when the cleanup started: never
     * whatever [link] holds by the time the thread runs.
     */
    private class CleanupThread(val vendor: VendorLink?, body: Runnable, name: String) : Thread(body, name)

    /** A region refusal (or a region reading `NA`) surfaced in setup: the link stays up as `NeedsRegion`. */
    private class RegionNotConfigured : Exception()

    /** No-beam keys on the sled for [generation], standing in for the effective [layout] until the scanner is ready. */
    private data class NoBeam(val generation: Int, val layout: SledTriggerLayout)

    companion object {
        internal const val TAG = "ZebraRfidReader"
        internal const val WORKER_THREAD_NAME = "ZebraRfidWorker"
        private const val CLEANUP_THREAD_PREFIX = "ZebraRfidCleanup-"

        /** A best setup step not started this long after the vendor `connect()` returned is skipped. */
        internal const val BEST_STEP_DEADLINE_MS = SLED_BEST_STEP_DEADLINE_MS

        /**
         * How long the worker's next block waits for a failed connect's
         * cleanup before it logs that it is still waiting. It keeps waiting:
         * the cleanup's vendor calls act on the process's one vendor link.
         */
        internal const val CLEANUP_BOUND_MS = 5_000L

        /** The same, after a batch recovery (its close). */
        internal const val BATCH_CLEANUP_BOUND_MS = 20_000L

        /**
         * How many tag reads wait for the controller. Its collector waits
         * while a start is in flight (up to its start wait plus a wait for its
         * gate), and the sled reports in the order of a thousand tags a
         * second, so 512 could drop tags of a dense field that "report each
         * tag once" never reports again. The buffer only grows as it fills.
         */
        internal const val TAGS_BUFFER = 16_384

        /** The batch recovery's pause after its stop, and before its one retry of the batch-mode write. */
        internal const val BATCH_PAUSE_MS = 500L

        /** The names of connect steps 8 to 11, as logged and as [runBestSteps] returns the skipped ones. */
        internal const val STEP_IDENTITY = "identity"
        internal const val STEP_DUMP = "dump"
        internal const val STEP_LAYOUT = "trigger layout"
        internal const val STEP_BATTERY = "battery"

        /** How many looks ([STOP_SETTLE_POLL_MS] apart) the unsolicited-stop wait off the worker takes at most (500 ms). */
        private const val STOP_SETTLE_MAX_POLLS = 50

        private const val NO_GENERATION = -1
        private const val BATCH_MODE_ATTRIBUTE = 1500
        private const val REGION_NOT_SET_CODE = "NA"

        /** The key-layout attribute: written by a raw layout write, read back after every write, and read by the battery block. */
        internal const val KEY_LAYOUT_ATTRIBUTE = 2269
        private const val KEY_LAYOUT_ATTRIBUTE_TYPE = "B"

        /** Connect step 9 reads these, as found: key layout, Bluetooth host mode, scan batch mode. */
        private val DUMP_ATTRIBUTES = listOf(KEY_LAYOUT_ATTRIBUTE, 1587, 2325)

        /** `setTriggerMode` sends anything only to this model; it is called for no other. */
        private const val TRIGGER_MODE_MODEL = "RFD8500"

        /** What [setVendorLogging] last set, for the whole process: the vendor's logger is one static object. */
        private val vendorLoggingState = MutableStateFlow(false)

        /** The sled the scanner session is closed for: none in particular. */
        private val NO_SLED = SledIdentity(name = null, address = null, serial = null)
    }

    // ── connect and disconnect ──

    /**
     * Publishes `Connecting` and clears [connectNote] and [info]; then, on
     * the worker: tears a stale link down, runs the pre-check (a refusal
     * builds no vendor object), runs [openVendorConnection], and publishes
     * `Connected` or `NeedsRegion` after setting [info], or `Failed`. A link
     * that recorded a loss or is not up at the end fails as retryable. The
     * first batch clear fails as retryable with
     * [SledWords.BATCH_CLEARED_RETRYING] and leaves a note for the next
     * successful connect; a second batch result in a row is the end state,
     * [SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE] with a
     * [BatchModeUnrecoverableException] cause. A failure is a
     * [SledConnectException] whose `failed` is the state just published; an
     * attempt overtaken by a newer call publishes nothing and returns
     * [SledNotConnected].
     */
    final override suspend fun connect(request: SledConnectRequest): Result<Unit> {
        val generation = synchronized(stateLock) {
            val next = generations.incrementAndGet()
            requestedLayout = request.layout
            // Off before Connecting shows: the scanner is Off whenever the link is not Connected.
            scannerEngine.want(next, open = false, target = NO_SLED)
            _connectNote.value = null
            _info.value = null
            _connection.update { RfidConnection.Connecting }
            next
        }
        return onWorker { connectOnWorker(request, generation) }
    }

    /**
     * Bumps the generation and publishes `Disconnected` (clearing [info]) first,
     * with the scanner session's terminate queued (teardown step 1, not waited
     * for), then tears down on the worker. Idempotent; never throws.
     */
    final override suspend fun disconnect() {
        synchronized(stateLock) {
            val next = generations.incrementAndGet()
            scannerEngine.want(next, open = false, target = NO_SLED)
            _info.value = null
            _connection.update { RfidConnection.Disconnected }
        }
        try {
            onWorker { tearDownOpenLink() }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Log.w(TAG, "Teardown after a disconnect threw; the state is Disconnected anyway.", t)
        }
    }

    private fun connectOnWorker(request: SledConnectRequest, generation: Int): Result<Unit> {
        // A disconnect or a newer connect came in while this block waited in
        // the queue: its own block will run next, so there is nothing to dial.
        if (generation != currentGeneration) return Result.failure(SledNotConnected())
        return try {
            attempt(request, generation)
        } catch (t: Throwable) {
            Log.w(TAG, "Connect failed outside the vendor sequence.", t)
            fail(generation, connectFailure(vendorErrorOf(t), linkName, severalPaired = false, classLoading = t is LinkageError))
        } finally {
            _batchRecovery.value = false
        }
    }

    private fun attempt(request: SledConnectRequest, generation: Int): Result<Unit> {
        tearDownOpenLink()
        links = LinkTroubleTracker()
        linkName = null
        linkAddress = null
        powerTable = null
        reimmediateAfterStop = false
        sawRegionNotSet = false
        noBeamFor = null
        noBeamAfterStop = false
        inventory.reset()
        lastBatteryPct = null
        val chosen = when (val pre = precheck(request.address)) {
            is Precheck.Refused -> {
                Log.i(TAG, "Pre-check refused the connect: ${pre.failed.reason}")
                return fail(generation, pre.failed)
            }
            is Precheck.Chosen -> pre
        }
        val name = chosen.sled.name
        linkName = name
        linkAddress = chosen.sled.address
        openGeneration = generation
        Log.i(TAG, "Connecting to $name (${chosen.sled.address}), generation $generation.")
        val opened = try {
            openVendorConnection(chosen.sled, request, generation)
        } catch (t: Throwable) {
            batchInARow = false
            val failed = if (t !is SledConnectException && generation in lostGenerations) {
                reached(name)
            } else {
                failureOf(t, name, chosen.severalPaired)
            }
            // A failed connect's cleanup never asks anything of the sled: no
            // stop, no batch-mode write, no save. Its sled has just failed a
            // step (or, after a password error, was never unlocked), so each
            // of those could wait out the vendor's 2 s to 15 s timeouts, and
            // the batch-mode step already ran at connect step 2.
            cleanUpAfterFailedConnect(teardownPlan(linkUp = false, wroteLayout = false), CLEANUP_BOUND_MS, generation)
            return fail(generation, failed)
        }
        return when (opened) {
            is VendorOpen.BatchCleared -> batchCleared(opened.purged, generation)
            is VendorOpen.Up -> linkCameUp(opened.info, chosen, generation, needsRegion = false)
            is VendorOpen.NoRegion -> linkCameUp(opened.info, chosen, generation, needsRegion = true)
        }
    }

    private fun linkCameUp(opened: SledInfo, chosen: Precheck.Chosen, generation: Int, needsRegion: Boolean): Result<Unit> {
        batchInARow = false
        val name = chosen.sled.name
        if (generation in lostGenerations || !vendorLinkUpQuietly()) return notUpAtTheEnd(name, generation)
        val info = opened.copy(
            generation = generation,
            address = opened.address ?: chosen.sled.address,
            autoChosen = chosen.autoChosen,
        )
        val note = batchNote
        // The loss is checked again under the lock. A disconnect event that
        // lands after the check above records its loss before it takes the
        // lock, so either this sees it, or its write lands after this publish.
        val outcome = synchronized(stateLock) {
            when {
                generation != currentGeneration -> Publish.STALE
                generation in lostGenerations -> Publish.LOST
                else -> {
                    if (note != null) _connectNote.value = combineConnectNotes(_connectNote.value, note)
                    _info.value = info
                    _connection.update {
                        if (needsRegion) RfidConnection.NeedsRegion(info.name) else RfidConnection.Connected(info.name, lastBatteryPct)
                    }
                    // Step 12: queued on the scanner worker; the connect does not wait for it.
                    syncScannerLocked()
                    Publish.DONE
                }
            }
        }
        when (outcome) {
            Publish.STALE -> {
                Log.i(TAG, "Generation $generation came up after a newer call; leaving its link to that call's teardown.")
                return Result.failure(SledNotConnected())
            }
            Publish.LOST -> return notUpAtTheEnd(name, generation)
            Publish.DONE -> Unit
        }
        batchNote = null
        Log.i(TAG, "${info.name} is ${if (needsRegion) "up with no region set" else "connected"} (generation $generation).")
        return Result.success(Unit)
    }

    /** What the publish at the end of a connect found under the lock. */
    private enum class Publish { DONE, STALE, LOST }

    /** A link that recorded a loss, or is not up, at the end of setup: cleaned up, and failed retryably. */
    private fun notUpAtTheEnd(name: String, generation: Int): Result<Unit> {
        Log.w(TAG, "The link to $name was not up at the end of setup (generation $generation).")
        cleanUpAfterFailedConnect(teardownPlan(linkUp = false, wroteLayout = false), CLEANUP_BOUND_MS, generation)
        return fail(generation, reached(name))
    }

    private fun batchCleared(purged: Boolean, generation: Int): Result<Unit> {
        cleanUpAfterFailedConnect(teardownPlan(linkUp = false, wroteLayout = false), BATCH_CLEANUP_BOUND_MS, generation)
        if (batchInARow) {
            // This open only stopped the radio (batchRecoveryPlan), so the note
            // stays the one from the recovery that ran the purge.
            Log.w(TAG, "Batch mode: a second batch result in a row. Stopping here instead of clearing again.")
            return fail(
                generation,
                RfidConnection.Failed(SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE),
                BatchModeUnrecoverableException(),
            )
        }
        batchInARow = true
        batchNote = if (purged) SledWords.BATCH_CLEARED_NOTE else SledWords.BATCH_NOT_CLEARED_NOTE
        return fail(generation, RfidConnection.Failed(SledWords.BATCH_CLEARED_RETRYING, retryable = true))
    }

    /**
     * Publishes [failed] when [generation] is still current, and returns it as
     * the connect's failure. An attempt overtaken by a newer call publishes
     * nothing and returns [SledNotConnected], so a [SledConnectException]
     * always carries the state just published.
     */
    private fun fail(generation: Int, failed: RfidConnection.Failed, cause: Throwable? = null): Result<Unit> {
        val published = synchronized(stateLock) {
            if (generation == currentGeneration) {
                _connection.update { failed }
                true
            } else {
                false
            }
        }
        if (!published) {
            Log.i(TAG, "Generation $generation failed after a newer call (${failed.reason}); publishing nothing.")
            return Result.failure(SledNotConnected())
        }
        val e = SledConnectException(failed)
        if (cause != null) e.initCause(cause)
        return Result.failure(e)
    }

    private fun failureOf(t: Throwable, name: String, severalPaired: Boolean): RfidConnection.Failed {
        if (t is SledConnectException) {
            Log.w(TAG, "Connect failed: ${t.failed.reason}", t)
            return t.failed
        }
        val error = logFailure("connect", t)
        return connectFailure(error, name, severalPaired, classLoading = t is LinkageError)
    }

    private fun reached(name: String?): RfidConnection.Failed =
        RfidConnection.Failed(SledWords.couldNotReach(name), retryable = true, fix = SledFix.CONNECT)

    // ── the worker, cleanup and teardown ──

    /** Runs [block] on the worker after any pending cleanup, and awaits it. A caller that stops waiting leaves it running. */
    private suspend fun <T> onWorker(block: () -> T): T {
        val done = CompletableDeferred<T>()
        worker.execute {
            try {
                awaitCleanup()
                done.complete(block())
            } catch (t: Throwable) {
                done.completeExceptionally(t)
            }
        }
        return done.await()
    }

    /**
     * Starts the one cleanup of a failed attempt, on its own thread, against
     * that attempt's link (captured here, on the worker), so the failed
     * connect returns at once; the worker's next block waits for it
     * ([awaitCleanup]). Nothing to close: just drops the references.
     */
    private fun cleanUpAfterFailedConnect(plan: TeardownPlan, boundMs: Long, generation: Int) {
        if (!hasOpenVendorConnection()) {
            dropVendorRefs()
            return
        }
        val thread = CleanupThread(
            link,
            Runnable { closeQuietly(plan, "cleanup after a failed connect") },
            "$CLEANUP_THREAD_PREFIX$generation",
        )
        thread.isDaemon = true
        pendingCleanup = thread
        pendingCleanupBoundMs = boundMs
        thread.start()
    }

    /**
     * Waits until a failed attempt's cleanup has ended, then drops that
     * attempt's references. It never goes on while the cleanup still runs:
     * the vendor has one protocol layer and one Bluetooth transport per
     * process, so the cleanup's disconnect and dispose would close the next
     * link, share its status replies and unregister its receivers. Its calls
     * ask nothing of the sled, and the vendor bounds its own waits; a wait
     * past [pendingCleanupBoundMs] is logged each time it passes.
     */
    private fun awaitCleanup() {
        val thread = pendingCleanup ?: return
        var waitedMs = 0L
        while (true) {
            try {
                thread.join(pendingCleanupBoundMs)
            } catch (e: InterruptedException) {
                // Nothing interrupts the worker. The flag is left clear on purpose:
                // set, it would make every later vendor wait end at once.
                Log.w(TAG, "The wait for a failed connect's cleanup was interrupted; waiting on.", e)
                continue
            }
            if (!thread.isAlive) break
            waitedMs += pendingCleanupBoundMs
            Log.w(TAG, "The cleanup of a failed connect is still running after $waitedMs ms; waiting for it, so two links never overlap.")
        }
        pendingCleanup = null
        dropVendorRefs()
    }

    /** Tears down whatever link is open, with the plan its state allows, then drops the references. */
    private fun tearDownOpenLink() {
        if (hasOpenVendorConnection()) {
            closeQuietly(teardownPlan(linkKnownUp(), layoutMayBeLive()), "teardown")
        }
        dropVendorRefs()
    }

    /**
     * Whether the chosen sled's running config may hold a trigger layout this
     * process wrote, from this connection or an earlier one
     * ([SledLayoutMemory]): its config is then never saved. On the worker.
     */
    private fun layoutMayBeLive(): Boolean = layoutMemory.mayHoldLayout(linkAddress)

    private fun linkKnownUp(): Boolean = openGeneration !in lostGenerations && vendorLinkUpQuietly()

    private fun vendorLinkUpQuietly(): Boolean = try {
        vendorLinkUp()
    } catch (t: Throwable) {
        Log.w(TAG, "Checking whether the link is up threw; treating it as down.", t)
        false
    }

    private fun closeQuietly(plan: TeardownPlan, why: String) {
        try {
            closeVendorConnection(plan)
        } catch (t: Throwable) {
            Log.w(TAG, "Teardown ($why) threw; carrying on.", t)
        }
    }

    private fun dropVendorRefs() {
        forgetVendorConnection()
        openGeneration = NO_GENERATION
    }

    // ── seams (overridden by ZebraRfidReaderTest; the real bodies talk to the vendor) ──

    /** Android's bonded list. Empty when Bluetooth is off or Nearby devices is not granted. */
    @SuppressLint("MissingPermission")
    protected open fun bondedDevices(): List<BondedDevice> {
        if (!RfidPermissions.nearbyGranted(context)) return emptyList()
        return try {
            val adapter = bluetoothAdapter()
            if (adapter == null || !adapter.isEnabled) {
                emptyList()
            } else {
                adapter.bondedDevices.orEmpty().map { BondedDevice(it.name, it.address) }
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "Reading the bonded list threw; treating it as empty.", e)
            emptyList()
        }
    }

    /** The pre-check (spec, Pre-check): Bluetooth, Nearby devices and the bonded list, before any vendor object. */
    protected open fun precheck(savedAddress: String?): Precheck =
        decidePrecheck(bluetoothOn(), RfidPermissions.nearbyGranted(context), bondedDevices(), savedAddress)

    /**
     * The scanner engine seam. Internal, not protected, because the engine's
     * types are internal (preflight ruling 2). The real engine runs the
     * vendor's scanner SDK on its own worker; [scannerEngine] calls this once,
     * on first use.
     */
    internal open fun buildScannerEngine(): ZebraBarcodeEngine =
        vendorScannerEngine(context.applicationContext ?: context, ::bluetoothOn)

    /** Whether Bluetooth is on; off when it cannot be read. The pre-check and the scanner engine both ask. */
    private fun bluetoothOn(): Boolean = try {
        bluetoothAdapter()?.isEnabled == true
    } catch (e: RuntimeException) {
        Log.w(TAG, "Reading whether Bluetooth is on threw; treating it as off.", e)
        false
    }

    /**
     * The whole vendor connect sequence, on the worker. Builds `Readers` with
     * the Bluetooth transport, lists it once and takes the entry whose
     * address is [sled]'s, then: 1 `connect()`; 2 batch-mode prevention
     * (best); 3 this generation's listener and the disconnect event; 4 the
     * trigger events, checked and retried once; 5 tag events; 6 inventory,
     * battery, power and temperature events (best); 7 start and stop triggers
     * IMMEDIATE, one retry each; then the best steps 8 to 11 through
     * [runBestSteps]: 8 identity and the power table, 9 the read-only dump,
     * 10 the trigger layout write of `request.layout` and its read-back, 11
     * the battery block. A best step not started within
     * [BEST_STEP_DEADLINE_MS] of step 1 returning is skipped and logged. A
     * region check (a region reading `NA`) runs right after step 1.
     *
     * Returns [VendorOpen.Up] (with the identity fields and `trigger` set as
     * far as the steps got), or [VendorOpen.NoRegion] when the sled has no
     * region (from `connect()`, a setup step or the region check), or
     * [VendorOpen.BatchCleared] after the batch recovery. Throws on failure:
     * a [SledConnectException] for a failure that already has its sentence
     * (step 4's [SledWords.TRIGGER_NOT_SET_UP]; link trouble on any setup step
     * or a loss recorded for [generation], both `couldNotReach`, retryable,
     * [SledFix.CONNECT]), anything else for [connect] to map through
     * [connectFailure].
     */
    protected open fun openVendorConnection(sled: SledCandidate, request: SledConnectRequest, generation: Int): VendorOpen {
        val readers = Readers(ExportedReceiverContext(context), ENUM_TRANSPORT.BLUETOOTH)
        val vendor = VendorLink(readers, LinkListener(generation))
        link = vendor
        val listed = readers.GetAvailableRFIDReaderList().orEmpty()
        Log.i(TAG, "The vendor lists ${listed.size} paired reader(s): " + listed.joinToString { "${it.name} (${it.address})" })
        val device = listed.firstOrNull { it.address.equals(sled.address, ignoreCase = true) }
            ?: throw IllegalStateException("${sled.name} (${sled.address}) is not on the vendor's reader list.")
        // getRFIDReader() is called by name: the vendor's setter is spelled
        // setRFIDRReader, so Kotlin synthesizes no property for the pair.
        val rfid = device.getRFIDReader()
            ?: throw IllegalStateException("The vendor gave no reader object for ${sled.name}.")
        vendor.reader = rfid
        val name = device.name ?: sled.name
        val info = SledInfo(generation, name, sled.address)

        // Step 1.
        try {
            rfid.connect()
        } catch (e: OperationFailureException) {
            when (e.results) {
                RFIDResults.RFID_BATCHMODE_IN_PROGRESS -> {
                    logFailure("connect", e)
                    val plan = batchRecoveryPlan(secondInARow = lastOpenWasBatch, layoutMayBeLive = layoutMayBeLive())
                    return VendorOpen.BatchCleared(recoverFromBatchMode(rfid, vendor, plan))
                }
                RFIDResults.RFID_READER_REGION_NOT_CONFIGURED -> {
                    logFailure("connect", e)
                    return noRegion(rfid, vendor, LinkSetup(name, generation), info)
                }
                else -> throw e
            }
        }
        val setup = LinkSetup(name, generation)
        return try {
            setUpLink(rfid, vendor, setup)
            // Steps 8 to 11. Link trouble in any of them fails the connect, retryably (ruling 46).
            val ops = VendorSetupOps(rfid, device, setup::checkLoss, info)
            runBestSteps(request, setup::sinceConnectReturned, ops, links, name)
            setup.checkLoss()
            if (sawRegionNotSet) noRegion(rfid, vendor, setup, ops.info) else VendorOpen.Up(ops.info)
        } catch (e: RegionNotConfigured) {
            noRegion(rfid, vendor, setup, info)
        }
    }

    /** The no-region link: only the listener and the disconnect event (what setup already registered stays). */
    private fun noRegion(rfid: RFIDReader, vendor: VendorLink, setup: LinkSetup, info: SledInfo): VendorOpen.NoRegion {
        Log.w(TAG, "${info.name} has no region set: keeping the link with only the listener and the disconnect event.")
        try {
            setup.must("link events") { registerLinkEvents(rfid, vendor) }
        } catch (e: RegionNotConfigured) {
            Log.w(TAG, "The sled refused the link events for want of a region too; keeping the link anyway.")
        }
        return VendorOpen.NoRegion(info)
    }

    /** Teardown steps 2 to 4 for the open link; the real body is [tearDownVendor]. */
    protected open fun closeVendorConnection(plan: TeardownPlan) {
        tearDownVendor(plan)
    }

    /** True while vendor objects of a link (open, or failed and not cleaned up) are held. */
    protected open fun hasOpenVendorConnection(): Boolean = link != null

    /**
     * Drops the references to the link's vendor objects without closing them:
     * after its teardown, or once a failed connect's cleanup (which closed
     * the link it captured) has ended. On the worker.
     */
    protected open fun forgetVendorConnection() {
        link = null
    }

    /** The vendor's own view of the link (`rfid.isConnected()`). */
    protected open fun vendorLinkUp(): Boolean = link?.reader?.isConnected() == true

    /** The open link's reader object, which every operation's block runs against; null with no link. On the worker. */
    protected open fun linkedReader(): RFIDReader? = link?.reader

    private fun bluetoothAdapter(): BluetoothAdapter? = context.getSystemService(BluetoothManager::class.java)?.adapter

    // ── the connect sequence, steps 2 to 7 ──

    /** One connect's setup: the best-step clock, started when step 1 returned, and the step rules. */
    private inner class LinkSetup(private val name: String, val generation: Int) {
        private val connectReturnedAt = nowMs()

        fun sinceConnectReturned(): Long = nowMs() - connectReturnedAt

        fun lost(): Boolean = generation in lostGenerations

        /** A loss recorded for this generation fails the connect, retryably. */
        fun checkLoss() {
            if (lost()) throw SledConnectException(reached(name))
        }

        /** A must step: a failure fails the connect. Link trouble fails it at once; otherwise [retries] more tries. */
        fun must(step: String, retries: Int = 0, body: () -> Unit) {
            var left = retries
            while (true) {
                try {
                    body()
                    break
                } catch (t: Throwable) {
                    screen(step, t)
                    if (left-- <= 0) throw t
                    Log.w(TAG, "Setup: trying $step once more.")
                }
            }
            checkLoss()
        }

        /** A best step: skipped past the deadline; a refusal is logged and setup goes on; link trouble still fails it. */
        fun best(step: String, body: () -> Unit) {
            val since = sinceConnectReturned()
            if (!bestStepDue(since)) {
                Log.w(TAG, "Setup: skipped $step, $since ms after the connect returned.")
                return
            }
            try {
                body()
            } catch (t: Throwable) {
                screen(step, t)
                Log.w(TAG, "Setup: $step was refused; carrying on.")
            }
            checkLoss()
        }

        /** Logs [t], then turns a region refusal into [RegionNotConfigured] and link trouble or a loss into the retryable failure. */
        fun screen(step: String, t: Throwable) {
            if (t is SledConnectException || t is RegionNotConfigured) throw t
            val error = logFailure(step, t)
            if (isRegionNotSet(t)) throw RegionNotConfigured()
            if (lost() || (error != null && classifyResult(error) == ResultClass.LINK_TROUBLE)) {
                throw SledConnectException(reached(name))
            }
        }
    }

    private fun setUpLink(rfid: RFIDReader, vendor: VendorLink, setup: LinkSetup) {
        setup.best("region check") { checkRegion(rfid) }
        // Step 2. Its save runs before this connection's layout write, and
        // never for a sled an earlier connection wrote a layout to, whose
        // running config may still hold it; a rejected read is not saved.
        setup.best("batch-mode prevention") {
            val value = readAttribute(rfid, BATCH_MODE_ATTRIBUTE)
            val prevention = batchPrevention(value, layoutMayBeLive())
            Log.i(TAG, "Batch-mode prevention: attribute $BATCH_MODE_ATTRIBUTE reads ${value ?: "(no answer for it)"}: $prevention.")
            if (prevention != BatchPrevention.NOTHING) preventBatchMode(save = prevention == BatchPrevention.OFF_AND_SAVE, rfid = rfid)
        }
        // Step 3.
        setup.must("link events") { registerLinkEvents(rfid, vendor) }
        // Step 4.
        setUpTriggerEvents(rfid, setup)
        // Step 5.
        setup.must("tag events") {
            rfid.Events.setTagReadEvent(true)
            rfid.Events.setAttachTagDataWithReadEvent(true)
        }
        // Step 6.
        setup.best("inventory start event") { rfid.Events.setInventoryStartEvent(true) }
        setup.best("inventory stop event") { rfid.Events.setInventoryStopEvent(true) }
        setup.best("battery event") { rfid.Events.setBatteryEvent(true) }
        setup.best("power event") { rfid.Events.setPowerEvent(true) }
        setup.best("temperature event") { rfid.Events.setTemperatureAlarmEvent(true) }
        // Step 7: a sled left on its own triggers could start the radio while the app is disarmed.
        setup.must("start trigger", retries = 1) {
            rfid.Config.setStartTrigger(StartTrigger().apply { triggerType = START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE })
        }
        setup.must("stop trigger", retries = 1) {
            rfid.Config.setStopTrigger(StopTrigger().apply { triggerType = STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE })
        }
    }

    /** The sled's region; one reading `NA` has none set. A failed read is logged and setup goes on. */
    private fun checkRegion(rfid: RFIDReader) {
        val region = rfid.Config.getRegulatoryConfig()?.region
        Log.i(TAG, "Region check: the sled's region reads ${region ?: "(nothing)"}.")
        if (region.equals(REGION_NOT_SET_CODE, ignoreCase = true)) throw RegionNotConfigured()
    }

    /** Step 3, and all the no-region and batch paths register: this generation's listener and the disconnect event. */
    private fun registerLinkEvents(rfid: RFIDReader, vendor: VendorLink) {
        if (!vendor.listenerAdded) {
            rfid.Events.addEventsListener(vendor.listener)
            vendor.listenerAdded = true
        }
        rfid.Events.setReaderDisconnectEvent(true)
    }

    /**
     * Step 4: the trigger events, checked with `isEventRegistered`, tried
     * twice ([runTriggerEventSetup]). A failure is exactly
     * [SledWords.TRIGGER_NOT_SET_UP]: retryable after link trouble, an open,
     * send or timeout result (on a try or on the check that follows), or a
     * recorded loss; not retryable when the sled answered the check, so the
     * event stayed unregistered on a sled that is listening. The check's link
     * trouble counts toward marking the link lost.
     */
    private fun setUpTriggerEvents(rfid: RFIDReader, setup: LinkSetup) {
        val outcome = runTriggerEventSetup(
            register = {
                rfid.Events.setHandheldEvent(true)
                rfid.Events.isEventRegistered(RFID_EVENT_TYPE.HANDHELD_TRIGGER_EVENT)
            },
            check = { readCheckedAttribute(rfid, KEY_LAYOUT_ATTRIBUTE, "Trigger events check") },
            screen = { step, t ->
                if (t is SledConnectException) throw t
                if (isRegionNotSet(t)) throw RegionNotConfigured()
                logFailure(step, t)
            },
        )
        when (outcome) {
            TriggerEventSetup.Registered -> setup.checkLoss()
            is TriggerEventSetup.NotRegistered -> {
                val checkClass = outcome.checkError?.let(::classifyResult)
                if (checkClass == ResultClass.LINK_TROUBLE && links.record(checkClass)) onLinkLost(setup.generation)
                throw SledConnectException(
                    RfidConnection.Failed(SledWords.TRIGGER_NOT_SET_UP, retryable = outcome.retryable || setup.lost(), fix = SledFix.CONNECT),
                )
            }
        }
    }

    /** Reads attribute [number]'s value; null when the reply was for another attribute ([readCheckedAttribute]). */
    private fun readAttribute(rfid: RFIDReader, number: Int): String? = readCheckedAttribute(rfid, number, "Batch-mode prevention")?.value

    /**
     * Reads attribute [number], accepted only when the reply is for that
     * attribute number: the vendor keeps one shared reply slot, so a reply
     * can be another attribute's. Null (logged under [step]) when it was not
     * accepted; throws what the vendor throws. The batch-mode read, the dump
     * and the key-layout read-back all read through this.
     */
    private fun readCheckedAttribute(rfid: RFIDReader, number: Int, step: String): AttributeInfo? {
        val read = rfid.Config.getAttribute(number, AttributeInfo())
        if (read.attNum != number) {
            Log.w(TAG, "$step: attribute $number, the reply was for attribute ${read.attNum}, so it was not accepted.")
            return null
        }
        return read
    }

    /**
     * The batch-mode safety step: batch mode off, saved only when [save].
     * Connect step 2 saves by [batchPrevention]; teardown and the stop after a
     * batch start save only while the sled cannot hold a layout this process
     * wrote (`teardownPlan(..., layoutMayBeLive()).saveConfig`), so a layout
     * is never saved. Throws; the caller decides what a failure means.
     */
    private fun preventBatchMode(save: Boolean, rfid: RFIDReader? = link?.reader) {
        val config = rfid?.Config ?: return
        config.setBatchMode(BATCH_MODE.DISABLE)
        if (save) config.saveConfig()
        Log.i(TAG, if (save) "Batch mode set off and saved." else "Batch mode set off, not saved.")
    }

    /**
     * `connect()` said `RFID_BATCHMODE_IN_PROGRESS`: the link is up, the
     * sled's capabilities were not fetched. Registers only the listener and
     * the disconnect event (asking for trigger events without capabilities
     * would tell the sled to leave them out), then runs the steps [plan]
     * allows, each guarded and logged: stop, a pause, purge (false on
     * failure), batch mode off (once more after a pause when refused as in
     * progress), save (left out for a sled whose running config may hold a
     * layout this process wrote). A second batch result in a row gets only
     * the stop (ruling 28). Returns whether a purge cleared the tags. The
     * close runs as the failed connect's cleanup (logged while it runs past
     * [BATCH_CLEANUP_BOUND_MS]); the steps here are bounded by the vendor's
     * own waits.
     */
    private fun recoverFromBatchMode(rfid: RFIDReader, vendor: VendorLink, plan: BatchRecoveryPlan): Boolean {
        _batchRecovery.value = true
        Log.w(
            TAG,
            if (plan.purge) {
                "Batch-mode recovery: the sled is holding tags from offline use. Clearing them."
            } else {
                "Batch-mode recovery: a second batch result in a row. Stopping the radio only; no second purge or save."
            },
        )
        recoveryStep("disconnect event") { registerLinkEvents(rfid, vendor) }
        if (plan.stop) recoveryStep("stop") { rfid.Actions.Inventory.stop() }
        var purged = false
        if (plan.purge) {
            pause(BATCH_PAUSE_MS)
            purged = recoveryStep("purge") { rfid.Actions.purgeTags() } == true
        }
        if (plan.disableBatchMode) {
            recoveryStep("batch mode off") {
                try {
                    rfid.Config.setBatchMode(BATCH_MODE.DISABLE)
                } catch (e: OperationFailureException) {
                    if (e.results != RFIDResults.RFID_OPERATION_IN_PROGRESS) throw e
                    logFailure("batch mode off", e)
                    pause(BATCH_PAUSE_MS)
                    rfid.Config.setBatchMode(BATCH_MODE.DISABLE)
                }
            }
        }
        if (plan.saveConfig) {
            recoveryStep("save") { rfid.Config.saveConfig() }
        } else if (plan.purge) {
            Log.w(TAG, "Batch-mode recovery: no save, since this sled may still hold a trigger layout this app wrote.")
        }
        return purged
    }

    private inline fun <T> recoveryStep(step: String, body: () -> T): T? = try {
        body().also { Log.w(TAG, "Batch-mode recovery: $step returned ${it ?: "nothing"}.") }
    } catch (t: Throwable) {
        logFailure("batch-mode recovery: $step", t)
        null
    }

    /** A pause on the worker. An interrupt (nothing sends one) only shortens it; see [awaitCleanup]. */
    private fun pause(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (e: InterruptedException) {
            Log.w(TAG, "A pause on the worker was interrupted; going on.", e)
        }
    }

    /**
     * Teardown for the link this thread may close: on a failed connect's
     * cleanup thread, the link captured for that attempt ([CleanupThread]);
     * on the worker, [link].
     */
    private fun tearDownVendor(plan: TeardownPlan) {
        val current = Thread.currentThread()
        val vendor = (if (current is CleanupThread) current.vendor else link) ?: return
        tearDownVendor(plan, vendor)
    }

    /**
     * Teardown steps 2 to 4 for [vendor], each guarded on its own: only when
     * [plan] says the link is up, stop and the batch-mode safety step; then
     * remove the listener and disconnect; then dispose the `Readers`, which
     * throws when no reader object was built. Runs on the worker, or on a
     * failed connect's cleanup thread against that attempt's objects.
     */
    private fun tearDownVendor(plan: TeardownPlan, vendor: VendorLink) {
        val rfid = vendor.reader
        if (rfid != null) {
            if (plan.stopInventory) teardownStep("stop") { rfid.Actions?.Inventory?.stop() }
            if (plan.disableBatchMode) teardownStep("batch-mode safety step") { preventBatchMode(save = plan.saveConfig, rfid = rfid) }
            if (vendor.listenerAdded) teardownStep("remove the listener") { rfid.Events?.removeEventsListener(vendor.listener) }
            teardownStep("disconnect") { rfid.disconnect() }
        }
        teardownStep("dispose") { vendor.readers.Dispose() }
    }

    private inline fun teardownStep(step: String, body: () -> Unit) {
        try {
            body()
        } catch (t: Throwable) {
            Log.i(TAG, "Teardown: $step threw (often expected, for example a stop with nothing running); carrying on.", t)
        }
    }

    // ── listener entry points (also called by tests) ──

    /** The link of [generation] was lost. Writes the failure only for the current generation in a linked state. */
    internal fun onLinkLost(generation: Int) {
        lostGenerations += generation
        synchronized(stateLock) {
            if (generation != currentGeneration) {
                Log.i(TAG, "A loss for generation $generation (now $currentGeneration) changes nothing.")
                return
            }
            // Off at once, before the failure shows; terminate and the mode reset are queued.
            scannerEngine.linkLost(generation)
            val name = _info.value?.name ?: linkName
            _connection.update { state ->
                when (state) {
                    // With the Connect fix, as every other couldn't-reach failure:
                    // its sentence ends "then tap Connect", and the scan screens'
                    // slot draws only the failure's own button.
                    is RfidConnection.Connecting, is RfidConnection.Connected, is RfidConnection.NeedsRegion -> reached(name)
                    else -> state
                }
            }
        }
        Log.w(TAG, "The link of generation $generation was lost.")
    }

    /** A trigger event: only a SCAN-type one is dropped (ruling 26). Stamped on receipt. */
    internal fun onTrigger(generation: Int, pressed: Boolean, typeName: String?) {
        if (generation != currentGeneration) return
        if (!triggerTypePasses(typeName)) {
            Log.i(TAG, "Dropped a ${if (pressed) "pull" else "release"} of type $typeName.")
            return
        }
        val pull = TriggerPull(if (pressed) TriggerEvent.PRESSED else TriggerEvent.RELEASED, System.currentTimeMillis())
        // A dropped release is the dangerous one: it can leave a latched read
        // running with nothing said anywhere, so it is worth a log line.
        if (!_pulls.tryEmit(pull)) Log.w(TAG, "Dropped a trigger ${pull.event}: the flow's buffer is full.")
    }

    /** A tag read for [generation]; dropped unless current. */
    internal fun onTag(generation: Int, epc: String) {
        if (generation != currentGeneration) return
        lastTagAtMs = nowMs()
        // The buffer holds TAGS_BUFFER; a drop here is a tag the operator thinks was read.
        if (!_tags.tryEmit(epc)) Log.w(TAG, "Dropped a tag read: the tags flow's buffer is full.")
    }

    /** The sled says an inventory started: one the app asked for, or one its own trigger started. */
    internal fun onStartEvent(generation: Int) {
        if (generation != currentGeneration) return
        inventory.markRunning()
        Log.i(TAG, "Inventory start event, generation $generation.")
    }

    /**
     * The sled says an inventory stopped. A stop the app asked for is only
     * noted (the stop wait looks for it), and so is the late event of an
     * earlier stop whose wait ended without it ([InventoryTracker.stopEvent]).
     * With no stop requested while an inventory runs, the sled ended the read
     * by itself: after the same wait a requested stop gets, its reason goes
     * out on [unsolicitedStops], from a coroutine on [scope] (ruling 45:
     * logged, never shown), unless the read it ended is no longer the
     * current one ([InventoryTracker.stillCurrent]): a start was asked for
     * after that read's start went out (even before this event came), or a
     * stop was asked for since the event, which ends that sweep anyway and
     * must not let the event end the next one.
     */
    internal fun onStopEvent(generation: Int) {
        if (generation != currentGeneration) return
        val event = inventory.stopEvent()
        when (event.kind) {
            StopEventKind.REQUESTED, StopEventKind.IDLE -> {
                Log.i(TAG, "Inventory stop event, generation $generation.")
                return
            }
            StopEventKind.LATE -> {
                Log.i(TAG, "Inventory stop event, generation $generation: the late one from the last stop, after its wait ended.")
                return
            }
            StopEventKind.UNSOLICITED -> Unit
        }
        val at = nowMs()
        val reason = "The sled ended the read by itself (an inventory stop event with no stop asked for, generation $generation)."
        Log.w(TAG, reason)
        scope.launch {
            var looks = 0
            while (looks++ < STOP_SETTLE_MAX_POLLS && !stopSettled(nowMs() - at, stopEventSeen = true, sinceLastTagMs = nowMs() - lastTagAtMs)) {
                delay(STOP_SETTLE_POLL_MS)
            }
            if (generation != currentGeneration) return@launch
            if (!inventory.stillCurrent(event)) {
                Log.i(TAG, "Dropped an unsolicited stop: a start or a stop was asked for since that read began, so it belongs to a sweep already ended.")
                return@launch
            }
            if (!_unsolicitedStops.tryEmit(reason)) Log.w(TAG, "Dropped an unsolicited stop: the flow's buffer is full.")
        }
    }

    /**
     * A battery level for [generation]; dropped unless current. Kept for the
     * publish at the end of a connect, since connect step 11's answer
     * usually lands while the state is still `Connecting`.
     */
    internal fun onBattery(generation: Int, level: Int) {
        synchronized(stateLock) {
            if (generation != currentGeneration) return
            lastBatteryPct = level
            _connection.update { state -> if (state is RfidConnection.Connected) state.copy(batteryPct = level) else state }
        }
    }

    /**
     * One connection's listener. It runs on the vendor's thread, so it only
     * hands values on: it never calls the vendor, and it catches everything.
     */
    private inner class LinkListener(private val generation: Int) : RfidEventsListener {
        override fun eventReadNotify(event: RfidReadEvents?) {
            try {
                val epc = event?.readEventData?.tagData?.tagID
                if (epc == null) Log.w(TAG, "Dropped a tag read with no tag ID.") else onTag(generation, epc)
            } catch (t: Throwable) {
                Log.w(TAG, "A tag callback threw.", t)
            }
        }

        override fun eventStatusNotify(event: RfidStatusEvents?) {
            try {
                status(event?.StatusEventData ?: return)
            } catch (t: Throwable) {
                Log.w(TAG, "A status callback threw.", t)
            }
        }

        private fun status(data: IEvents.StatusEventData) {
            when (data.statusEventType) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT -> {
                    val trigger = data.HandheldTriggerEventData
                    val kind = trigger?.handheldEvent
                    val type = trigger?.handheldTriggerType?.toString()
                    Log.i(TAG, "Trigger event $kind, type ${type ?: "(none)"}, generation $generation.")
                    when (kind) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> onTrigger(generation, pressed = true, typeName = type)
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> onTrigger(generation, pressed = false, typeName = type)
                        else -> Unit
                    }
                }
                STATUS_EVENT_TYPE.BATTERY_EVENT -> {
                    // Charging is not parsed (the vendor's flag parser only works for the word
                    // "true"); the raw text, the cause, is logged with the level.
                    val battery = data.BatteryData
                    Log.i(TAG, "Battery event: level ${battery?.level}, raw cause \"${battery?.cause}\", generation $generation.")
                    battery?.level?.let { onBattery(generation, it) }
                }
                STATUS_EVENT_TYPE.INVENTORY_START_EVENT -> onStartEvent(generation)
                STATUS_EVENT_TYPE.INVENTORY_STOP_EVENT -> onStopEvent(generation)
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> {
                    Log.w(TAG, "Disconnection event ${data.DisconnectionEventData?.disconnectionEvent}, generation $generation.")
                    onLinkLost(generation)
                }
                else -> Log.i(TAG, "Status event ${data.statusEventType}, generation $generation.")
            }
        }
    }

    // ── operations ──

    /**
     * The settings push: the six [settingSteps] through `runSettingSteps`.
     * A refusal is logged and the push goes on; link trouble stops it. The
     * failure message names what was refused, or says the push stopped.
     */
    final override suspend fun apply(settings: RfidSettings): Result<Unit> = onWorker {
        linkBlock("settings push", sentence = SledWords.SETTINGS_NOT_APPLIED) { rfid, generation ->
            val steps = settingSteps(settings, powerTable, ConfigRadio(rfid)).map { step ->
                SettingStep(step.label) {
                    try {
                        step.run()
                    } catch (t: Throwable) {
                        errorOf("settings push: ${step.label}", t)
                        throw t
                    }
                }
            }
            when (val outcome = runSettingSteps(steps, ::vendorErrorOf)) {
                PushOutcome.Applied -> {
                    recordClass(generation, null)
                    lastApplied = settings
                    Result.success(Unit)
                }
                is PushOutcome.Refused -> {
                    recordClass(generation, ResultClass.REFUSAL)
                    lastApplied = settings
                    Log.w(TAG, "Settings push: the sled refused ${outcome.labels}; the other settings were applied.")
                    Result.failure(Exception(outcome.message()))
                }
                PushOutcome.LinkTrouble -> {
                    recordClass(generation, ResultClass.LINK_TROUBLE)
                    Log.w(TAG, "Settings push: stopped at link trouble.")
                    Result.failure(Exception(outcome.message()))
                }
            }
        }
    }

    /**
     * One start, by the `perform()` outcome table: purge first when the last
     * push turned unique reporting on ([runStart]); success for started, sent
     * but not confirmed, and already running (whose start and stop triggers
     * are set IMMEDIATE again after the next stop); for a batch result, a
     * stop and the batch-mode safety step first; every failure carries
     * [sentence] of its outcome.
     */
    final override suspend fun startInventory(): Result<Unit> {
        // Counted before the wait for the worker: an unsolicited stop still
        // waiting to go out belongs to the sweep before this one.
        inventory.startAsked()
        return onWorker { startOnWorker() }
    }

    private fun startOnWorker(): Result<Unit> =
        linkBlock("start", sentence = SledWords.READ_DID_NOT_START) { rfid, generation ->
            inventory.startSending()
            var performError: VendorError? = null
            // How long each round trip took, for sizing the controller's start wait
            // (hardware script steps 7 and 8): a purge only runs with unique reporting on.
            var purgeMs: Long? = null
            var performMs = 0L
            val ops = object : InventoryOps {
                override fun purge(): Boolean {
                    val t0 = nowMs()
                    return try {
                        rfid.Actions.purgeTags()
                    } catch (t: Throwable) {
                        errorOf("purge", t)
                        false
                    } finally {
                        purgeMs = nowMs() - t0
                    }
                }

                override fun perform(): VendorError? {
                    val t0 = nowMs()
                    performError = try {
                        rfid.Actions.Inventory.perform()
                        null
                    } catch (t: Throwable) {
                        errorOf("start", t)
                    }
                    performMs = nowMs() - t0
                    return performError
                }
            }
            val outcome = runStart(lastApplied?.uniqueTagReport == true, ops)
            Log.i(TAG, "Start: ${purgeMs?.let { "purge $it ms, " } ?: ""}perform $performMs ms ($outcome).")
            recordResult(generation, performError)
            when (outcome) {
                PerformOutcome.STARTED -> inventory.markRunning()
                PerformOutcome.UNCONFIRMED -> {
                    inventory.markRunning()
                    Log.w(TAG, "Start: sent, unconfirmed (the start status may ride on the first tag).")
                }
                PerformOutcome.ALREADY_RUNNING -> {
                    inventory.markRunning()
                    reimmediateAfterStop = true
                    Log.w(TAG, "Start: an inventory was already running; the triggers are set IMMEDIATE again after the next stop.")
                }
                PerformOutcome.BATCH_MODE -> stopAfterABatchStart(rfid)
                PerformOutcome.CHARGING, PerformOutcome.NOT_SENT, PerformOutcome.REFUSED ->
                    Log.w(TAG, "Start failed: $outcome.")
            }
            val sentence = outcome.sentence()
            if (sentence == null) Result.success(Unit) else Result.failure(Exception(sentence))
        }

    /** `perform()` said the sled is reading into its store: a stop, then the batch-mode safety step, each guarded. */
    private fun stopAfterABatchStart(rfid: RFIDReader) {
        Log.w(TAG, "Start: the sled is in batch mode. Stopping it and turning batch mode off.")
        try {
            rfid.Actions.Inventory.stop()
        } catch (t: Throwable) {
            errorOf("stop after a batch start", t)
        }
        try {
            preventBatchMode(save = teardownPlan(linkUp = true, wroteLayout = layoutMayBeLive()).saveConfig, rfid = rfid)
        } catch (t: Throwable) {
            errorOf("batch-mode safety step after a batch start", t)
        }
    }

    /**
     * One stop. The stop is always sent; when nothing was running, its
     * failure is logged and the stop still counts as done. After a stop that
     * ended a running inventory, the worker waits until the stop event has
     * arrived and no tag has come for 100 ms, at most 500 ms ([stopSettled]),
     * because the vendor's stop returns before the last tags are delivered.
     * The wait is measured from when the stop returned ([stopThenSettle]).
     * Asking for a stop drops an unsolicited stop still waiting to go out
     * ([onStopEvent]): the caller is ending that sweep itself.
     */
    final override suspend fun stopInventory(): Result<Unit> {
        // Counted before the wait for the worker, like a start.
        inventory.stopAsked()
        return onWorker { stopOnWorker() }
    }

    private fun stopOnWorker(): Result<Unit> =
        linkBlock("stop", sentence = SledWords.MAY_STILL_BE_READING) { rfid, generation ->
            val wasRunning = inventory.beginStop()
            val error = stopThenSettle(
                wasRunning,
                stop = {
                    try {
                        rfid.Actions.Inventory.stop()
                        null
                    } catch (t: Throwable) {
                        errorOf("stop", t)
                    }
                },
                now = ::nowMs,
                pause = ::pause,
                stopEventSeen = { inventory.stopEventSeen },
                lastTagAtMs = { lastTagAtMs },
            )
            recordResult(generation, error)
            if (error != null && wasRunning) return@linkBlock Result.failure(Exception(SledWords.MAY_STILL_BE_READING))
            if (error != null) Log.i(TAG, "Stop: nothing was running, so the refusal counts as stopped.")
            // Settled: a later stop event belongs to an inventory the sled starts
            // by itself, or is the late one of this stop when its wait ended without it.
            inventory.stopEnded(waited = wasRunning)
            if (reimmediateAfterStop) {
                reimmediateAfterStop = false
                setTriggersImmediate(rfid, generation)
            }
            if (noBeamAfterStop) {
                noBeamAfterStop = false
                scannerReady(generation)
            }
            Result.success(Unit)
        }

    /**
     * The start and stop triggers IMMEDIATE again, after a start that found an
     * inventory already running. Each write on its own guard, with one more
     * try as in connect step 7, and each result counted ([runGuardedWrites]).
     */
    private fun setTriggersImmediate(rfid: RFIDReader, generation: Int) {
        runGuardedWrites(
            listOf(
                SettingStep("start trigger IMMEDIATE after a stop") {
                    rfid.Config.setStartTrigger(StartTrigger().apply { triggerType = START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE })
                },
                SettingStep("stop trigger IMMEDIATE after a stop") {
                    rfid.Config.setStopTrigger(StopTrigger().apply { triggerType = STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE })
                },
            ),
            errorOf = ::errorOf,
            record = { error ->
                recordResult(generation, error)
                generation in lostGenerations
            },
        )
    }

    /**
     * The regions this sled allows and the one in force. The list's length
     * is guarded (it throws when the sled never answered for its regions);
     * the active region is read on its own guard, so the list loads without
     * it; only the active region's detail (hopping, channels) is read.
     * Needs `Connected` or `NeedsRegion`.
     */
    final override suspend fun regions(): Result<RfidRegions> = onWorker {
        linkBlock("regions", allowNeedsRegion = true, sentence = SledWords.REGIONS_FAILED) { rfid, generation ->
            val errors = mutableListOf<VendorError>()
            val supported = try {
                supportedRegions(rfid)
            } catch (t: Throwable) {
                recordResult(generation, errorOf("regions: the supported list", t))
                return@linkBlock Result.failure(Exception(SledWords.REGIONS_FAILED))
            }
            val active = try {
                rfid.Config.getRegulatoryConfig()?.region
            } catch (t: Throwable) {
                errors += errorOf("regions: the active region", t)
                null
            }
            val regions = supported.mapNotNull { info ->
                val code = info.regionCode ?: return@mapNotNull null
                if (active != null && code.equals(active, ignoreCase = true)) regionDetail(rfid, info)?.let(errors::add)
                RfidRegion(
                    code = code,
                    name = info.name ?: code,
                    hoppingConfigurable = info.isHoppingConfigurable,
                    channels = info.supportedChannels.usable(),
                )
            }
            recordResult(generation, worstOf(errors))
            Log.i(TAG, "Regions: ${regions.size} supported, active ${active ?: "(unknown)"}.")
            Result.success(RfidRegions(regions, active))
        }
    }

    /**
     * Sets the regulatory region. The picked region's detail is read first;
     * when it says hopping is configurable, `hopping ?: true` is passed with
     * its supported channels, and the channel array is never null
     * ([regionArgs], ruling 23). A write that throws is checked by reading
     * the region back before a failure is reported. Never reconnects. Needs
     * `Connected` or `NeedsRegion`.
     */
    final override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> = onWorker {
        linkBlock("set region", allowNeedsRegion = true, sentence = SledWords.REGION_NOT_SET) { rfid, generation ->
            val errors = mutableListOf<VendorError>()
            val picked = try {
                supportedRegions(rfid).firstOrNull { it.regionCode.equals(code, ignoreCase = true) }
            } catch (t: Throwable) {
                errors += errorOf("set region: the supported list", t)
                null
            }
            if (picked != null) regionDetail(rfid, picked)?.let(errors::add)
            val args = regionArgs(picked?.isHoppingConfigurable == true, hopping, picked?.supportedChannels.usable())
            Log.i(TAG, "Set region $code: hopping ${args.hopping ?: "(left out)"}, ${args.channels.size} channel(s).")
            val config = RegulatoryConfig()
            config.region = code
            // The getter is isHoppingon() (lowercase "on"), so the setter is called by name.
            args.hopping?.let { config.setIsHoppingOn(it) }
            config.setEnabledChannels(args.channels.toTypedArray())
            val writeError = try {
                rfid.Config.setRegulatoryConfig(config)
                null
            } catch (t: Throwable) {
                errorOf("set region", t)
            }
            if (writeError == null) {
                recordResult(generation, worstOf(errors))
                return@linkBlock Result.success(Unit)
            }
            errors += writeError
            val readBack = try {
                rfid.Config.getRegulatoryConfig()?.region
            } catch (t: Throwable) {
                errors += errorOf("set region: the read-back", t)
                null
            }
            recordResult(generation, worstOf(errors))
            if (readBack.equals(code, ignoreCase = true)) {
                Log.w(TAG, "Set region: the write threw, but the region reads back as $readBack; counting it as set.")
                Result.success(Unit)
            } else {
                Log.w(TAG, "Set region: the region reads back as ${readBack ?: "(nothing)"}, not $code.")
                Result.failure(Exception(SledWords.REGION_NOT_SET))
            }
        }
    }

    /** The sled's supported regions; throws when it never answered for them (the list inside is null). */
    private fun supportedRegions(rfid: RFIDReader): List<RegionInfo> {
        val supported = rfid.ReaderCapabilities?.SupportedRegions ?: throw IllegalStateException("The sled reported no region list.")
        return (0 until supported.length()).map { supported.getRegionInfo(it) }
    }

    /** Fills [info]'s hopping flag and channels from the sled (`Config.getRegionInfo`, in place); the error, if any. */
    private fun regionDetail(rfid: RFIDReader, info: RegionInfo): VendorError? = try {
        rfid.Config.getRegionInfo(info)
        Log.i(TAG, "Region ${info.regionCode}: hopping configurable ${info.isHoppingConfigurable}, channels ${info.supportedChannels?.toList()}.")
        null
    } catch (t: Throwable) {
        errorOf("region detail for ${info.regionCode}", t)
    }

    /**
     * Writes [layout] as the effective layout (`effectiveLayout`, so a Zebra
     * host or a sled with no scanner gets RFID) and reports what the sled
     * reads back. A layout that uses the scanner, while [scanner] is not
     * `Ready` for the current generation, is written as its no-beam keys
     * first, and the result is that write's read-back; the real keys follow
     * once the scanner is ready ([finishNoBeamLayout]). `Accepted` updates
     * `info.trigger`; a read-back that could not be accepted sets it null and
     * fails; link trouble counts toward marking the link lost, leaves
     * `info.trigger` as it was and fails. Both failures are
     * [SledWords.TRIGGER_CHECK_FAILED]. Never saved. Only a call that passes
     * the state check, in the generation still current, becomes the requested
     * layout: a refused one, for example a call still queued when a newer
     * connect asked for its own layout, changes nothing (ruling 27).
     * Afterward, whatever the outcome, the scanner session is opened or
     * closed to match the layout in force, without waiting for it.
     */
    final override suspend fun setTriggerLayout(layout: SledTriggerLayout): Result<SledTriggerReadback> = onWorker {
        val result = writeLayoutBlock(layout)
        synchronized(stateLock) { syncScannerLocked() }
        result
    }

    private fun writeLayoutBlock(layout: SledTriggerLayout): Result<SledTriggerReadback> =
        linkBlock("trigger layout", sentence = SledWords.TRIGGER_CHECK_FAILED) { rfid, generation ->
            val scannerReady = synchronized(stateLock) {
                if (generation == currentGeneration) requestedLayout = layout
                generation == currentGeneration && scannerEngine.state.value == SledScannerState.Ready
            }
            val known = _info.value
            layoutResult(generation, writeTriggerLayout(rfid, layout, known?.model ?: known?.name, known?.hasScanner, generation, scannerReady))
        }

    /** What a layout write in [generation] reports, with `info.trigger` and the link-trouble count updated to match. */
    private fun layoutResult(generation: Int, outcome: LayoutWriteOutcome): Result<SledTriggerReadback> = when (outcome) {
        is LayoutWriteOutcome.Accepted -> {
            recordClass(generation, null)
            updateTrigger(generation, outcome.readback)
            Result.success(outcome.readback)
        }
        LayoutWriteOutcome.CheckFailed -> {
            recordClass(generation, null)
            updateTrigger(generation, null)
            Result.failure(Exception(SledWords.TRIGGER_CHECK_FAILED))
        }
        LayoutWriteOutcome.LinkTrouble -> {
            recordClass(generation, ResultClass.LINK_TROUBLE)
            Result.failure(Exception(SledWords.TRIGGER_CHECK_FAILED))
        }
    }

    private fun updateTrigger(generation: Int, readback: SledTriggerReadback?) {
        synchronized(stateLock) {
            if (generation == currentGeneration) _info.update { it?.copy(trigger = readback) }
        }
    }

    /**
     * Connect step 10 for [info]'s generation: the layout write of [layout]
     * and its read-back. The scanner is never ready this early in a connect,
     * so a layout that uses it gets its no-beam keys. The vendor sequence
     * runs it through [runBestSteps]; a seam double whose open stands in for
     * that sequence can run it the same way.
     */
    protected fun writeLayoutAtConnect(rfid: RFIDReader, info: SledInfo, layout: SledTriggerLayout): LayoutWriteOutcome =
        writeTriggerLayout(rfid, layout, info.model ?: info.name, info.hasScanner, info.generation, scannerReady = false)

    /**
     * The layout write and read-back for connect step 10, [setTriggerLayout]
     * and [finishNoBeamLayout] (spec, Trigger layout). A layout that uses the
     * scanner, while the scanner is not [scannerReady], goes in as its
     * no-beam keys ([runInterimWrite]) and is noted in [noBeamFor]; a sled
     * that refuses them gets the real keys at once. Otherwise the real keys
     * ([runLayoutWrite], with the spec's fallbacks). `setTriggerMode(mode,
     * false)` goes only to a model whose name contains `RFD8500`, with
     * `BARCODE_MODE` only for the real Barcode keys. Notes the sled in
     * [layoutMemory] before the first write, so nothing saves its config from
     * then on, in this connection or a later one. On the worker.
     */
    private fun writeTriggerLayout(
        rfid: RFIDReader,
        requested: SledTriggerLayout,
        model: String?,
        hasScanner: Boolean?,
        generation: Int,
        scannerReady: Boolean,
    ): LayoutWriteOutcome {
        val effective = effectiveLayout(requested, zebraHost, hasScanner)
        if (effective != requested) Log.i(TAG, "Trigger layout: $requested asked for, $effective written (Zebra host $zebraHost, has scanner $hasScanner).")
        layoutMemory.written(linkAddress)
        noBeamFor = null
        if (effective.usesScanner() && !scannerReady) {
            sendTriggerMode(rfid, model, barcode = false)
            val noBeam = runInterimWrite(effective, write = { writeLayoutEntry(rfid, it) }, readBack = { readKeyLayout(rfid) })
            when (noBeam) {
                is InterimWriteOutcome.Accepted -> {
                    noBeamFor = NoBeam(generation, effective)
                    Log.i(
                        TAG,
                        "Trigger layout: ${noBeam.readback.raw} read back, upper ${noBeam.readback.upper}, lower ${noBeam.readback.lower} " +
                            "(the no-beam keys for $effective, until the sled's scanner is ready).",
                    )
                    return LayoutWriteOutcome.Accepted(noBeam.readback)
                }
                InterimWriteOutcome.CheckFailed -> {
                    noBeamFor = NoBeam(generation, effective)
                    Log.w(TAG, "Trigger layout: could not read the no-beam keys for $effective back.")
                    return LayoutWriteOutcome.CheckFailed
                }
                InterimWriteOutcome.LinkTrouble -> {
                    Log.w(TAG, "Trigger layout: the sled stopped answering.")
                    return LayoutWriteOutcome.LinkTrouble
                }
                InterimWriteOutcome.Refused -> Log.w(
                    TAG,
                    "Trigger layout: the sled refused the no-beam layout; the scanner keys are live before the scanner is ready.",
                )
            }
        }
        sendTriggerMode(rfid, model, barcode = effective == SledTriggerLayout.BARCODE)
        val outcome = runLayoutWrite(effective, write = { writeLayoutEntry(rfid, it) }, readBack = { readKeyLayout(rfid) })
        when (outcome) {
            is LayoutWriteOutcome.Accepted -> Log.i(
                TAG,
                "Trigger layout: ${outcome.readback.raw} read back, upper ${outcome.readback.upper}, lower ${outcome.readback.lower} " +
                    "(asked for $effective).",
            )
            LayoutWriteOutcome.CheckFailed -> Log.w(TAG, "Trigger layout: could not read the layout back.")
            LayoutWriteOutcome.LinkTrouble -> Log.w(TAG, "Trigger layout: the sled stopped answering.")
        }
        return outcome
    }

    /** `setTriggerMode(mode, false)`, only for a model whose name contains `RFD8500`: `BARCODE_MODE` when [barcode], else `RFID_MODE`. */
    private fun sendTriggerMode(rfid: RFIDReader, model: String?, barcode: Boolean) {
        if (model?.contains(TRIGGER_MODE_MODEL) != true) return
        try {
            rfid.Config.setTriggerMode(if (barcode) ENUM_TRIGGER_MODE.BARCODE_MODE else ENUM_TRIGGER_MODE.RFID_MODE, false)
        } catch (t: Throwable) {
            errorOf("trigger mode", t)
        }
    }

    /**
     * The scanner engine turned `Ready` for [generation] ([ZebraBarcodeEngine.onReady],
     * on the engine's timer or worker): posts [finishNoBeamLayout] on the RFID
     * worker, behind whatever is queued there, and returns at once.
     */
    private fun scannerReady(generation: Int) {
        try {
            worker.execute {
                try {
                    awaitCleanup()
                    finishNoBeamLayout(generation)
                } catch (t: Throwable) {
                    Log.w(TAG, "Trigger layout: the write after the scanner came up threw.", t)
                }
            }
        } catch (e: RejectedExecutionException) {
            Log.w(TAG, "Trigger layout: the worker refused the write after the scanner came up.", e)
        }
    }

    /**
     * The scanner is ready for [generation]: when the no-beam keys still
     * stand in for the effective layout asked of that generation, now
     * current and `Connected`, and the scanner is still `Ready`, one write of
     * the real keys and its read-back, which updates `info.trigger`. A newer
     * layout or generation, or a scanner that went away meanwhile, writes
     * nothing. While an inventory runs (Both's upper trigger still reads
     * tags) the write waits for the next stop, as the controller's layout
     * jobs never run during a sweep. On the worker.
     */
    private fun finishNoBeamLayout(generation: Int) {
        val pending = noBeamFor ?: return
        var wrote = false
        linkBlock("trigger layout", sentence = SledWords.TRIGGER_CHECK_FAILED) { rfid, current ->
            val info = _info.value
            val due = synchronized(stateLock) {
                val target = effectiveLayout(requestedLayout, zebraHost, info?.hasScanner)
                current == generation && pending == NoBeam(current, target) && scannerEngine.state.value == SledScannerState.Ready
            }
            if (!due) {
                Log.i(TAG, "Trigger layout: the scanner was ready (generation $generation), but a newer layout or link, or the scanner, moved on first; nothing written.")
                return@linkBlock Result.success(Unit)
            }
            if (inventory.running) {
                Log.i(TAG, "Trigger layout: the sled's scanner is ready during a sweep; the keys for ${pending.layout} go in after its stop.")
                noBeamAfterStop = true
                return@linkBlock Result.success(Unit)
            }
            Log.i(TAG, "Trigger layout: the sled's scanner is ready; writing the keys for ${pending.layout}.")
            wrote = true
            val outcome = writeTriggerLayout(rfid, pending.layout, info?.model ?: info?.name, info?.hasScanner, current, scannerReady = true)
            if ((outcome as? LayoutWriteOutcome.Accepted)?.readback?.isInterimFor(pending.layout) == true) {
                Log.w(TAG, "Trigger layout: the sled still reads back the no-beam keys for ${pending.layout}.")
            }
            layoutResult(current, outcome).map { }
        }
        if (wrote) synchronized(stateLock) { syncScannerLocked() }
    }

    /** One layout write; null when it went through. */
    private fun writeLayoutEntry(rfid: RFIDReader, write: LayoutWrite): VendorError? = try {
        when (write) {
            is LayoutWrite.Keys -> rfid.Config.setKeylayoutType(vendorKey(write.upper), vendorKey(write.lower))
            is LayoutWrite.Raw -> rfid.Config.setAttribute(SetAttribute(KEY_LAYOUT_ATTRIBUTE, KEY_LAYOUT_ATTRIBUTE_TYPE, write.digits, 0))
        }
        Log.i(TAG, "Trigger layout: wrote $write.")
        null
    } catch (t: Throwable) {
        errorOf("trigger layout write $write", t)
    }

    /** The key-layout attribute, accepted only when the reply is for that attribute number. */
    private fun readKeyLayout(rfid: RFIDReader): AttributeRead = try {
        val read = readCheckedAttribute(rfid, KEY_LAYOUT_ATTRIBUTE, "Trigger layout read-back")
        val value = read?.value?.trim()?.toIntOrNull()
        when {
            read == null -> AttributeRead.WrongAttribute
            value == null -> {
                Log.w(TAG, "Trigger layout read-back: \"${read.value}\" is not a number.")
                AttributeRead.WrongAttribute
            }
            else -> AttributeRead.Value(value)
        }
    } catch (t: Throwable) {
        AttributeRead.Error(errorOf("trigger layout read-back", t))
    }

    private fun vendorKey(key: SledKey): ENUM_NEW_KEYLAYOUT_TYPE = when (key) {
        SledKey.RFID -> ENUM_NEW_KEYLAYOUT_TYPE.RFID
        SledKey.SLED_SCAN -> ENUM_NEW_KEYLAYOUT_TYPE.SLED_SCAN
        SledKey.TERMINAL_SCAN -> ENUM_NEW_KEYLAYOUT_TYPE.TERMINAL_SCAN
        SledKey.SCAN_NOTIFY -> ENUM_NEW_KEYLAYOUT_TYPE.SCAN_NOTIFY
        SledKey.NO_ACTION -> ENUM_NEW_KEYLAYOUT_TYPE.NO_ACTION
        SledKey.UNKNOWN -> throw IllegalArgumentException("No vendor key for an unknown trigger key.")
    }

    /**
     * Asks for the battery level: one block, the request and its consuming
     * read ([batteryBlock]); the answer arrives as `Connected.batteryPct`.
     * Two timeouts in a row on the read mark the link lost. Does nothing
     * unless `Connected`.
     */
    final override suspend fun requestBattery() {
        try {
            onWorker {
                linkBlock("battery") { rfid, generation ->
                    val ops = VendorSetupOps(rfid, device = null, checkLoss = {}, start = _info.value ?: SledInfo(generation, linkName.orEmpty()))
                    if (batteryBlock(ops, links)) {
                        Log.w(TAG, "Two battery read timeouts in a row: marking the link lost.")
                        onLinkLost(generation)
                    }
                    Result.success(Unit)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Log.w(TAG, "The battery request threw; nothing to report.", t)
        }
    }

    /** The battery request, then the read that consumes its status line; returns the read's error. */
    private fun batteryRequest(rfid: RFIDReader): VendorError? {
        try {
            rfid.Config.getDeviceStatus(true, false, false)
        } catch (t: Throwable) {
            errorOf("battery request", t)
        }
        return try {
            val read = rfid.Config.getAttribute(KEY_LAYOUT_ATTRIBUTE, AttributeInfo())
            Log.i(TAG, "Battery: the consuming read answered for attribute ${read.attNum}.")
            null
        } catch (t: Throwable) {
            errorOf("battery read", t)
        }
    }

    /** The sleds on Android's bonded list (by name prefix). Never builds a `Readers`; empty without Bluetooth or Nearby devices. */
    final override fun pairedSleds(): List<SledCandidate> = pairedSledsOf(bondedDevices())

    /** Turns the vendor's own debug log on or off, for the whole process; not saved. */
    final override fun setVendorLogging(on: Boolean) {
        try {
            RFIDReader.LOGGER.EnableDebugLogs(on)
            vendorLoggingState.value = on
            Log.i(TAG, "Vendor logging ${if (on) "on" else "off"}.")
        } catch (t: Throwable) {
            Log.w(TAG, "Turning vendor logging ${if (on) "on" else "off"} threw; it is as it was.", t)
        }
    }

    // ── the scanner session ──

    /**
     * The sled's Scan button: a trigger pull or release on the scanner's
     * worker. Fails with [SledNotConnected] unless [scanner] is `Ready`; a
     * failed pull makes it `Unavailable(DID_NOT_START)`.
     */
    final override suspend fun softScan(pull: Boolean): Result<Unit> = scannerEngine.softScan(pull)

    /**
     * The Try again button: terminate, then establish once more, queued on
     * the scanner's worker; returns without waiting for it. Needs `Connected`
     * and a layout in force that uses the scanner (otherwise
     * [SledNotConnected]); fails at once while the scanner stopped responding.
     */
    final override suspend fun retryScanner(): Result<Unit> {
        val generation = synchronized(stateLock) {
            if (_connection.value !is RfidConnection.Connected) return Result.failure(SledNotConnected())
            currentGeneration
        }
        return scannerEngine.retry(generation)
    }

    /**
     * Asks the scanner engine for the session `scannerWanted` calls for now
     * (ruling 7), for the current generation. Called under [stateLock], so a
     * loss or a newer call cannot land between reading the state and asking.
     */
    private fun syncScannerLocked() {
        val info = _info.value
        val usesScanner = layoutInForceUsesScanner(info?.trigger, requestedLayout, zebraHost, info?.hasScanner)
        val wanted = scannerWanted(_connection.value is RfidConnection.Connected, usesScanner, zebraHost, info?.hasScanner)
        scannerEngine.want(currentGeneration, wanted, SledIdentity(info?.name, info?.address, info?.serial))
    }

    /**
     * The adapter's own Bluetooth receiver, for the adapter's life: Bluetooth
     * turning off (or off) closes the scanner session at once and drops its
     * cached id. A receiver that cannot be registered is logged; the link
     * loss that follows Bluetooth going off still closes the session.
     */
    private fun registerBluetoothReceiver(engine: ZebraBarcodeEngine) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                try {
                    val state = intent?.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                    if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
                        Log.i(TAG, "Bluetooth is turning off (state $state): closing the sled's scanner session.")
                        engine.bluetoothTurningOff()
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "The Bluetooth receiver threw; carrying on.", t)
                }
            }
        }
        try {
            ContextCompat.registerReceiver(
                context.applicationContext ?: context,
                receiver,
                IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
        } catch (e: RuntimeException) {
            Log.w(TAG, "Registering the Bluetooth receiver threw; the scanner closes on the link loss instead.", e)
        }
    }

    /**
     * Runs [body] against the current link when the state allows it (`Connected`,
     * or `NeedsRegion` with [allowNeedsRegion]) and the link was not lost;
     * otherwise [SledNotConnected] with no vendor call. [body] records its own
     * results toward marking the link lost; a throwable it lets out is logged,
     * recorded and reported with [sentence] (the throwable itself when null).
     */
    private inline fun <T> linkBlock(
        step: String,
        allowNeedsRegion: Boolean = false,
        sentence: String? = null,
        body: (RFIDReader, Int) -> Result<T>,
    ): Result<T> {
        val state = _connection.value
        val stateAllows = state is RfidConnection.Connected || (allowNeedsRegion && state is RfidConnection.NeedsRegion)
        val generation = currentGeneration
        val rfid = linkedReader()
        if (!stateAllows || rfid == null || openGeneration != generation || generation in lostGenerations) {
            return Result.failure(SledNotConnected())
        }
        return try {
            body(rfid, generation)
        } catch (t: Throwable) {
            recordResult(generation, logFailure(step, t))
            Result.failure(if (sentence == null) t else Exception(sentence, t))
        }
    }

    /** Counts one block's result; two link-trouble results in a row mark the link of [generation] lost. */
    private fun recordResult(generation: Int, error: VendorError?) {
        recordClass(generation, error?.let(::classifyResult))
    }

    private fun recordClass(generation: Int, cls: ResultClass?) {
        if (links.record(cls)) {
            Log.w(TAG, "Two link-trouble results in a row: marking the link lost.")
            onLinkLost(generation)
        }
    }

    /** Logs a failed vendor call at [step] and returns its error (a non-vendor throwable is a refusal); notes a region refusal. */
    private fun errorOf(step: String, t: Throwable): VendorError {
        if (isRegionNotSet(t)) sawRegionNotSet = true
        return logFailure(step, t) ?: VendorError(resultName = null, vendorMessage = "${t.javaClass.name}: ${t.message}")
    }

    /** The error a block counts: the first link trouble among [errors], else the first error, else none. */
    private fun worstOf(errors: List<VendorError>): VendorError? =
        errors.firstOrNull { classifyResult(it) == ResultClass.LINK_TROUBLE } ?: errors.firstOrNull()

    private fun Array<String>?.usable(): List<String> = this?.filterNot { it.isBlank() }.orEmpty()

    /** The sled's radio settings through the vendor's `Config`, one push step each. */
    private class ConfigRadio(private val rfid: RFIDReader) : RadioSettingsOps {
        override fun beeper(level: SledBeeper) {
            rfid.Config.setBeeperVolume(
                when (level) {
                    SledBeeper.OFF -> BEEPER_VOLUME.QUIET_BEEP
                    SledBeeper.LOW -> BEEPER_VOLUME.LOW_BEEP
                    SledBeeper.MEDIUM -> BEEPER_VOLUME.MEDIUM_BEEP
                    SledBeeper.HIGH -> BEEPER_VOLUME.HIGH_BEEP
                },
            )
        }

        override fun powerIndex(index: Int) {
            val antenna = rfid.Config.Antennas.getAntennaRfConfig(1)
            antenna.transmitPowerIndex = index
            rfid.Config.Antennas.setAntennaRfConfig(1, antenna)
        }

        /** The session, with inventory state A and SL flag ALL pinned (ruling 24, as Zebra's sample does). */
        override fun session(session: RfidSession) {
            val singulation = rfid.Config.Antennas.getSingulationControl(1)
            singulation.session = when (session) {
                RfidSession.S0 -> SESSION.SESSION_S0
                RfidSession.S1 -> SESSION.SESSION_S1
                RfidSession.S2 -> SESSION.SESSION_S2
                RfidSession.S3 -> SESSION.SESSION_S3
            }
            singulation.Action.inventoryState = INVENTORY_STATE.INVENTORY_STATE_A
            singulation.Action.setSLFlag(SL_FLAG.SL_ALL)
            rfid.Config.Antennas.setSingulationControl(1, singulation)
        }

        override fun tagPopulation(n: Int) {
            val singulation = rfid.Config.Antennas.getSingulationControl(1)
            singulation.tagPopulation = n.toShort()
            rfid.Config.Antennas.setSingulationControl(1, singulation)
        }

        override fun uniqueReport(on: Boolean) {
            rfid.Config.setUniqueTagReport(on)
        }

        override fun dpo(on: Boolean) {
            // The accessors are getDPOState()/setDPOState(...): Kotlin makes no
            // `dpoState` property from a name that starts with two capitals.
            rfid.Config.setDPOState(if (on) DYNAMIC_POWER_OPTIMIZATION.ENABLE else DYNAMIC_POWER_OPTIMIZATION.DISABLE)
        }
    }

    /**
     * Connect steps 8 to 11 against [rfid] ([runBestSteps] decides which run),
     * and the battery block for [requestBattery]. [info] collects what the
     * steps learn: the identity fields, then the trigger read-back. Each step
     * first runs [checkLoss], which throws when the link was lost. [device] is
     * the vendor's list entry, for its capability classification; null
     * outside a connect.
     */
    private inner class VendorSetupOps(
        private val rfid: RFIDReader,
        private val device: ReaderDevice?,
        private val checkLoss: () -> Unit,
        start: SledInfo,
    ) : SetupOps {
        var info: SledInfo = start
            private set

        /** Step 8: model, serial, firmware, scanner name, capability (has-scanner) and the power table. */
        override fun identity(): SledInfo {
            checkLoss()
            val caps = rfid.ReaderCapabilities ?: throw IllegalStateException("The sled reported no capabilities.")
            val model: String? = caps.modelName
            val levels: IntArray? = caps.transmitPowerLevelValues
            val table = powerTable(levels)
            powerTable = table
            val capability = capabilityOf(model).takeIf { hasScannerOf(it) != null } ?: capabilityOf(info.name)
            val hasScanner = hasScannerOf(capability)
            info = info.copy(
                model = model,
                serial = caps.serialNumber,
                firmware = caps.firwareVersion,
                hasScanner = hasScanner,
                powerMinDbm = table?.minDbm,
                powerMaxDbm = table?.maxDbm,
            )
            Log.i(
                TAG,
                "Identity: model $model, serial ${info.serial}, firmware ${info.firmware}, scanner name ${caps.scannerName}, " +
                    "capability $capability (has scanner: ${hasScanner ?: "unknown"}); power table " +
                    (levels?.let { "first ${it.firstOrNull()}, second ${it.getOrNull(1)}, last ${it.lastOrNull()}, size ${it.size}" } ?: "none") +
                    (table?.let { ", ${if (it.inDbm) "dBm" else "tenths"}, ${it.minDbm} to ${it.maxDbm} dBm" } ?: "") + ".",
            )
            return info
        }

        /** The vendor's capability class for a sled [name]; null when it could not tell. */
        private fun capabilityOf(name: String?): String? = try {
            device?.getDeviceCapability(name)
        } catch (e: RuntimeException) {
            Log.i(TAG, "The vendor could not classify \"$name\".", e)
            null
        }

        /**
         * Step 9: attributes 2269, 1587 and 2325 as found; the link profile
         * (the RF mode table index), Tari and pre-filter count the sled is
         * left with (ruling 24: left as the sled has them, and logged); and
         * the external keyboards. Nothing is written. Each read is guarded on
         * its own; link trouble still fails the connect.
         */
        override fun dump() {
            checkLoss()
            for (attribute in DUMP_ATTRIBUTES) {
                dumpRead("attribute $attribute") {
                    readCheckedAttribute(rfid, attribute, "Dump")?.let { read ->
                        Log.i(TAG, "Dump: attribute $attribute reads ${read.value} (type ${read.type}).")
                    }
                }
            }
            dumpRead("antenna 1 link profile and Tari") {
                val rf = rfid.Config.Antennas.getAntennaRfConfig(1)
                Log.i(TAG, "Dump: antenna 1 link profile (RF mode table index) ${rf.getrfModeTableIndex()}, Tari ${rf.tari}.")
            }
            dumpRead("pre-filters") {
                Log.i(TAG, "Dump: ${rfid.Actions.PreFilters.length()} pre-filter(s) as the SDK holds them for the sled.")
            }
            logExternalKeyboards()
            Log.i(TAG, vendorReaderThreadsDump())
        }

        /** One guarded dump read: a failure is logged and the dump goes on, unless it is link trouble. */
        private inline fun dumpRead(what: String, body: () -> Unit) {
            try {
                body()
            } catch (t: Throwable) {
                val error = errorOf("dump: $what", t)
                if (classifyResult(error) == ResultClass.LINK_TROUBLE) throw t
            }
        }

        /** Step 10: the layout write of [layout] and its read-back ([writeLayoutAtConnect]). */
        override fun writeLayout(layout: SledTriggerLayout): LayoutWriteOutcome {
            checkLoss()
            val outcome = writeLayoutAtConnect(rfid, info, layout)
            info = info.afterLayoutWrite(outcome)
            return outcome
        }

        /** Step 11 and [requestBattery]: the battery request and its consuming read. */
        override fun battery(): VendorError? {
            checkLoss()
            return batteryRequest(rfid)
        }
    }

    /** The external keyboard input devices, by name, vendor id and product id (no vendor call). */
    private fun logExternalKeyboards() {
        try {
            val keyboards = InputDevice.getDeviceIds().toList()
                .mapNotNull { InputDevice.getDevice(it) }
                .filter { it.isExternal && it.supportsSource(InputDevice.SOURCE_KEYBOARD) }
            if (keyboards.isEmpty()) Log.i(TAG, "Dump: no external keyboard input devices.")
            keyboards.forEach { Log.i(TAG, "Dump: external keyboard \"${it.name}\", vendor id ${it.vendorId}, product id ${it.productId}.") }
        } catch (t: Throwable) {
            Log.w(TAG, "Dump: listing the input devices threw.", t)
        }
    }

    /** Logs a failed step: the vendor's result name and text, or the throwable. Returns its [VendorError], if it is one. */
    private fun logFailure(step: String, t: Throwable): VendorError? {
        val error = vendorErrorOf(t)
        when {
            error == null -> Log.w(TAG, "$step failed: ${t.javaClass.name}: ${t.message}", t)
            t is OperationFailureException -> Log.w(TAG, "${vendorLogLine(step, error)} (status: ${t.statusDescription})", t)
            else -> Log.w(TAG, vendorLogLine(step, error), t)
        }
        return error
    }

    private fun isRegionNotSet(t: Throwable): Boolean =
        t is OperationFailureException && t.results == RFIDResults.RFID_READER_REGION_NOT_CONFIGURED

    /** The adapter's monotonic clock, in milliseconds: the setup deadline, the stop waits and the last-tag time. A seam for the tests. */
    protected open fun nowMs(): Long = System.nanoTime() / 1_000_000L
}

/**
 * A vendor failure reduced to what the app decides on: an
 * `OperationFailureException`'s result name and vendor text, an
 * `InvalidUsageException` as invalid usage, anything else null.
 */
internal fun vendorErrorOf(t: Throwable): VendorError? = when (t) {
    is OperationFailureException -> VendorError(t.results?.toString(), t.vendorMessage)
    is InvalidUsageException -> VendorError(
        resultName = null,
        vendorMessage = t.vendorMessage?.takeUnless { it.isBlank() } ?: t.info,
        invalidUsage = true,
    )
    else -> null
}

/** [this] with the read-back a layout write left: an accepted one, none after a failed check, unchanged after link trouble. */
internal fun SledInfo.afterLayoutWrite(outcome: LayoutWriteOutcome): SledInfo = when (outcome) {
    is LayoutWriteOutcome.Accepted -> copy(trigger = outcome.readback)
    LayoutWriteOutcome.CheckFailed -> copy(trigger = null)
    LayoutWriteOutcome.LinkTrouble -> this
}

/** Appends [additional] to [existing], so two notes from one connect both reach `connectNote`. A blank [existing] counts as none. */
internal fun combineConnectNotes(existing: String?, additional: String): String =
    if (existing.isNullOrBlank()) additional else "$existing $additional"

/**
 * The cause of the connect failure after a second batch result in a row
 * (ruling 28). Its message is [SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE],
 * the honest end state: it names the one remedy known to work (Zebra's
 * 123RFID Mobile app), says it should be a one-time fix, and says the app
 * keeps batch mode off from then on.
 */
internal class BatchModeUnrecoverableException : Exception(SledWords.BATCH_MODE_UNRECOVERABLE_MESSAGE)

// ── connect step 4 ──

/** How connect step 4 ended ([runTriggerEventSetup]). */
internal sealed interface TriggerEventSetup {
    data object Registered : TriggerEventSetup

    /**
     * Still not registered after two tries. [retryable] when a try or the
     * check after them met link trouble or an open, send or timeout result;
     * [checkError] is the check's own error (null when the sled answered it).
     */
    data class NotRegistered(val retryable: Boolean, val checkError: VendorError?) : TriggerEventSetup
}

/**
 * Connect step 4: [register] (the vendor's `setHandheldEvent(true)`, then
 * `isEventRegistered`) up to twice. The vendor drops the registration's own
 * result: a command timeout, a send error and a refusal all come back only as
 * an event that stayed unregistered, never as a throw. So when the tries saw
 * no retryable error, one command whose result is visible ([check]) tells a
 * sled that stopped answering (link trouble, an open, send or timeout result:
 * retryable) from one that answered and still left the event out (not
 * retryable). [screen] logs a throw and returns its vendor error (null for
 * any other throwable); it may rethrow what must pass through, such as a
 * recorded loss or a region refusal.
 */
internal fun runTriggerEventSetup(
    register: () -> Boolean,
    check: () -> Unit,
    screen: (step: String, t: Throwable) -> VendorError?,
): TriggerEventSetup {
    var retryable = false
    for (attempt in 1..2) {
        try {
            if (register()) return TriggerEventSetup.Registered
            Log.w(ZebraRfidReader.TAG, "Setup: the trigger events are not registered after try $attempt.")
        } catch (t: Throwable) {
            val error = screen("trigger events", t)
            if (error != null && retryableSetupError(error)) retryable = true
        }
    }
    if (retryable) return TriggerEventSetup.NotRegistered(retryable = true, checkError = null)
    val checkError = try {
        check()
        null
    } catch (t: Throwable) {
        screen("trigger events check", t) ?: VendorError(resultName = null, vendorMessage = "${t.javaClass.name}: ${t.message}")
    }
    if (checkError == null) {
        Log.w(ZebraRfidReader.TAG, "Setup: the sled answered the check, so it left the trigger events out; a retry would not help.")
        return TriggerEventSetup.NotRegistered(retryable = false, checkError = null)
    }
    Log.w(ZebraRfidReader.TAG, "Setup: after the trigger events, ${vendorLogLine("the check", checkError)}.")
    return TriggerEventSetup.NotRegistered(retryable = retryableSetupError(checkError), checkError = checkError)
}

/** A setup error worth another connect: link trouble, or an open, send or timeout result. */
internal fun retryableSetupError(error: VendorError): Boolean =
    classifyResult(error) == ResultClass.LINK_TROUBLE ||
        connectFailure(error, name = null, severalPaired = false, classLoading = false).retryable

// ── connect steps 8 to 11 ──

/**
 * Connect steps 8 to 11 (spec, Connect sequence), behind an interface so
 * [runBestSteps] runs without a sled. The real one wraps the reader's
 * capabilities, `Config` and the input-device list. A method throws on a
 * failed vendor call; [battery] instead returns its consuming read's error.
 */
internal interface SetupOps {
    /** Step 8: the identity fields and the power table; returns the info so far. */
    fun identity(): SledInfo

    /** Step 9: the read-only dump. */
    fun dump()

    /** Step 10: the layout write and its read-back. */
    fun writeLayout(layout: SledTriggerLayout): LayoutWriteOutcome

    /** Step 11: the battery request plus its consuming read; the read's error, or null. */
    fun battery(): VendorError?
}

/**
 * Runs identity, dump, the layout write of [request]'s layout and the
 * battery block, in that order, each only while `bestStepDue` holds for
 * [sinceConnectReturned] when it would start; a step past the deadline is
 * skipped and logged, and the names of the skipped steps are returned. A
 * refusal (any other failure) is logged and setup goes on. Link trouble in
 * any step (a link-trouble result, a [LayoutWriteOutcome.LinkTrouble], or
 * [links] reporting two in a row) throws a [SledConnectException] with
 * `couldNotReach(name)`, retryable, [SledFix.CONNECT] (ruling 46). [name] is
 * the chosen sled's name (preflight ruling 6).
 */
internal fun runBestSteps(
    request: SledConnectRequest,
    sinceConnectReturned: () -> Long,
    ops: SetupOps,
    links: LinkTroubleTracker,
    name: String? = null,
): List<String> {
    val skipped = mutableListOf<String>()
    fun linkLost(step: String): Nothing {
        Log.w(ZebraRfidReader.TAG, "Setup: link trouble at $step; the connect fails.")
        throw SledConnectException(RfidConnection.Failed(SledWords.couldNotReach(name), retryable = true, fix = SledFix.CONNECT))
    }
    fun step(step: String, body: () -> ResultClass?) {
        val since = sinceConnectReturned()
        if (!bestStepDue(since)) {
            Log.w(ZebraRfidReader.TAG, "Setup: skipped $step, $since ms after the connect returned.")
            skipped += step
            return
        }
        val cls = try {
            body()
        } catch (e: SledConnectException) {
            throw e
        } catch (t: Throwable) {
            val error = vendorErrorOf(t)
            if (error == null) {
                Log.w(ZebraRfidReader.TAG, "Setup: $step failed: ${t.javaClass.name}: ${t.message}", t)
            } else {
                Log.w(ZebraRfidReader.TAG, vendorLogLine("setup: $step", error), t)
            }
            error?.let(::classifyResult) ?: ResultClass.REFUSAL
        }
        if (links.record(cls) || cls == ResultClass.LINK_TROUBLE) linkLost(step)
        if (cls != null) Log.w(ZebraRfidReader.TAG, "Setup: $step was refused; carrying on.")
    }
    step(ZebraRfidReader.STEP_IDENTITY) {
        ops.identity()
        null
    }
    step(ZebraRfidReader.STEP_DUMP) {
        ops.dump()
        null
    }
    step(ZebraRfidReader.STEP_LAYOUT) {
        if (ops.writeLayout(request.layout) == LayoutWriteOutcome.LinkTrouble) ResultClass.LINK_TROUBLE else null
    }
    val since = sinceConnectReturned()
    if (!bestStepDue(since)) {
        Log.w(ZebraRfidReader.TAG, "Setup: skipped ${ZebraRfidReader.STEP_BATTERY}, $since ms after the connect returned.")
        skipped += ZebraRfidReader.STEP_BATTERY
    } else {
        var cls: ResultClass? = null
        if (batteryBlock(ops, links) { cls = it } || cls == ResultClass.LINK_TROUBLE) linkLost(ZebraRfidReader.STEP_BATTERY)
    }
    return skipped
}

/**
 * The battery block: calls [ops]' `battery()` (a throw counts by its vendor
 * result, else as a refusal), records the result's class on [links], hands
 * it to [seen], and returns true when the link is now lost (two link-trouble
 * results in a row). A [SledConnectException] (a loss the step's own check
 * found) passes through, as in [runBestSteps]. Connect step 11 and
 * `requestBattery` both use it.
 */
internal fun batteryBlock(ops: SetupOps, links: LinkTroubleTracker, seen: (ResultClass?) -> Unit = {}): Boolean {
    val cls = try {
        ops.battery()?.let(::classifyResult)
    } catch (e: SledConnectException) {
        // A loss recorded for this connect (the step's loss check): the connect fails as a loss, not a refusal.
        throw e
    } catch (t: Throwable) {
        Log.w(ZebraRfidReader.TAG, "The battery block threw.", t)
        vendorErrorOf(t)?.let(::classifyResult) ?: ResultClass.REFUSAL
    }
    seen(cls)
    return links.record(cls)
}

// ── inventory ──

/** One start's two vendor calls, behind an interface so [runStart] runs without a sled. */
internal interface InventoryOps {
    /** Clears the sled's unique-tag list; false on failure (never throws). */
    fun purge(): Boolean

    /** `Inventory.perform()`; its error, or null when it returned normally. */
    fun perform(): VendorError?
}

/** One start: when [uniqueReport], [InventoryOps.purge] first (a false result is logged); then the `perform()` outcome. */
internal fun runStart(uniqueReport: Boolean, ops: InventoryOps): PerformOutcome {
    if (uniqueReport && !ops.purge()) {
        Log.w(ZebraRfidReader.TAG, "Start: the purge before the read failed; reading anyway.")
    }
    return performOutcome(ops.perform())
}

/** How often a stop wait looks again. */
private const val STOP_SETTLE_POLL_MS = 10L

/**
 * One stop and its settle: sends [stop]; when [wasRunning] and the stop went
 * through, waits ([pause]) until `stopSettled` holds, the 500 ms cap and the
 * 100 ms quiet gap both measured on [now] from when [stop] returned (the
 * vendor's stop returns before the last tags are delivered, and a stop is
 * slowest during a busy read, when tags trail). Returns the stop's error.
 */
internal fun stopThenSettle(
    wasRunning: Boolean,
    stop: () -> VendorError?,
    now: () -> Long,
    pause: (Long) -> Unit,
    stopEventSeen: () -> Boolean,
    lastTagAtMs: () -> Long,
): VendorError? {
    val error = stop()
    if (error != null || !wasRunning) return error
    // Taken after the stop returned: its own round trip must not come out of the cap.
    val stoppedAt = now()
    while (!stopSettled(now() - stoppedAt, stopEventSeen(), now() - lastTagAtMs())) pause(STOP_SETTLE_POLL_MS)
    Log.i(ZebraRfidReader.TAG, "Stop settled ${now() - stoppedAt} ms after the stop returned (stop event ${if (stopEventSeen()) "seen" else "not seen"}).")
    return null
}

/**
 * Vendor writes that each stand alone: each runs on its own guard, with one
 * more try after a failure that is not link trouble (as connect step 7 does);
 * each write's last result goes to [record], and the writes stop when
 * [record] says the link is now lost. [errorOf] logs a throw and returns its
 * error.
 */
internal fun runGuardedWrites(
    writes: List<SettingStep>,
    errorOf: (String, Throwable) -> VendorError,
    record: (VendorError?) -> Boolean,
) {
    for (write in writes) {
        var error: VendorError? = null
        for (attempt in 1..2) {
            error = try {
                write.run()
                null
            } catch (t: Throwable) {
                errorOf(write.label, t)
            }
            if (error == null || classifyResult(error) == ResultClass.LINK_TROUBLE) break
            if (attempt == 1) Log.w(ZebraRfidReader.TAG, "${write.label}: trying once more.")
        }
        if (error == null) Log.i(ZebraRfidReader.TAG, "${write.label}: done.")
        if (record(error)) {
            Log.w(ZebraRfidReader.TAG, "The link is lost; the writes after ${write.label} are not sent.")
            return
        }
    }
}

/** What one inventory stop event means ([InventoryTracker.stopEvent]). */
internal enum class StopEventKind {
    /** A stop the app asked for is in progress: the stop wait looks for this event. */
    REQUESTED,

    /** The late event of an earlier requested stop whose wait ended without it: swallowed. */
    LATE,

    /** Nothing was running. */
    IDLE,

    /** The sled ended a running read by itself. */
    UNSOLICITED,
}

/** How long a stop event stays owed by a stop whose wait ended without it; after this, a stop event is taken as new. */
internal const val STOP_EVENT_OWED_MS = 2_000L

/** One inventory stop event as [InventoryTracker.stopEvent] classified it, with the counts [InventoryTracker.stillCurrent] compares. */
internal data class StopEvent(val kind: StopEventKind, val sentSweep: Int, val stopsAsked: Int)

/**
 * The inventory state the worker and the vendor's event thread share:
 * whether a read runs, the stop in progress, whether a stop event is still
 * owed by a stop whose wait ended without one (for [STOP_EVENT_OWED_MS] on
 * [now]), the count of starts asked for (the sweep), the sweep whose start
 * last went out, and the count of stops asked for. One small lock, never
 * held around a vendor call.
 */
internal class InventoryTracker(private val now: () -> Long = { System.nanoTime() / 1_000_000L }) {
    private val lock = Any()
    private var stopRequested = false

    /** A requested stop's wait ended without its stop event: the next one that comes with no stop in progress is that one, late. */
    private var stopEventOwed = false
    private var owedSinceMs = 0L

    @Volatile var running = false
        private set

    /** Whether a stop event arrived since the last [beginStop]. */
    @Volatile var stopEventSeen = false
        private set

    /** Counts the starts asked for. */
    private var sweep = 0

    /** The sweep whose start last went out: the read a stop event of the sled's own ends. */
    private var sentSweep = 0

    /** Counts the stops asked for. */
    private var stopsAsked = 0

    /** A new connection: nothing runs and nothing is owed. */
    fun reset() = synchronized(lock) {
        running = false
        stopRequested = false
        stopEventSeen = false
        stopEventOwed = false
        sentSweep = sweep
    }

    /** A start was asked for: a new sweep. */
    fun startAsked() = synchronized(lock) { sweep++ }

    /** A stop was asked for. */
    fun stopAsked() = synchronized(lock) { stopsAsked++ }

    /** The start is about to be sent: any earlier stop request is over, and the read that runs next is this sweep's. */
    fun startSending() = synchronized(lock) {
        stopRequested = false
        sentSweep = sweep
    }

    /** A start went through, or the sled said a read started. */
    fun markRunning() {
        running = true
    }

    /** A stop is about to be sent; returns whether a read was running. */
    fun beginStop(): Boolean = synchronized(lock) {
        stopRequested = true
        stopEventSeen = false
        running
    }

    /**
     * The stop went through and, when [waited], its wait ended: nothing runs,
     * no stop is in progress, and a wait that ended without the stop event
     * leaves that event owed.
     */
    fun stopEnded(waited: Boolean) = synchronized(lock) {
        running = false
        stopRequested = false
        if (waited) {
            stopEventOwed = !stopEventSeen
            owedSinceMs = now()
        }
    }

    /**
     * Classifies one stop event and updates the state for it: noted while a
     * stop is in progress; swallowed as [StopEventKind.LATE] when one is
     * owed and the owing stop ended at most [STOP_EVENT_OWED_MS] ago (an
     * older debt is dropped, so a missing event cannot swallow the sled's own
     * stop of a later sweep); otherwise idle, or the sled's own stop of a
     * running read. The counts are taken under the same lock.
     */
    fun stopEvent(): StopEvent = synchronized(lock) {
        stopEventSeen = true
        if (stopEventOwed && now() - owedSinceMs > STOP_EVENT_OWED_MS) stopEventOwed = false
        val kind = when {
            stopRequested -> StopEventKind.REQUESTED
            stopEventOwed -> {
                stopEventOwed = false
                StopEventKind.LATE
            }
            !running -> StopEventKind.IDLE
            else -> {
                running = false
                StopEventKind.UNSOLICITED
            }
        }
        StopEvent(kind, sentSweep, stopsAsked)
    }

    /**
     * Whether the read [event] ended is still the current sweep: no start
     * was asked for since that read's start went out, and no stop since the
     * event. An unsolicited stop that fails this belongs to a sweep that is
     * over, and must not end the next one.
     */
    fun stillCurrent(event: StopEvent): Boolean = synchronized(lock) {
        sweep == event.sentSweep && stopsAsked == event.stopsAsked
    }
}

// ── the settings push ──

/** The sled's radio settings, one call per push step; the real one wraps `Config`. Each throws on failure. */
internal interface RadioSettingsOps {
    fun beeper(level: SledBeeper)

    fun powerIndex(index: Int)

    /** The session; the real one also pins inventory state A and SL flag ALL. */
    fun session(session: RfidSession)

    fun tagPopulation(n: Int)

    fun uniqueReport(on: Boolean)

    fun dpo(on: Boolean)
}

/**
 * The push steps for [settings], each labeled with its RFID tab row label,
 * in order: beeper, transmit power (an index into [table], `powerIndex`),
 * session, tag population, unique reporting, dynamic power optimization.
 * There is no LED step (ruling 21).
 */
internal fun settingSteps(settings: RfidSettings, table: PowerTable?, ops: RadioSettingsOps): List<SettingStep> = listOf(
    SettingStep(SledWords.ROW_SLED_BEEPER) { ops.beeper(settings.beeper) },
    SettingStep(SledWords.ROW_TRANSMIT_POWER) { ops.powerIndex(powerIndex(table, settings.powerDbm)) },
    SettingStep(SledWords.ROW_SESSION) { ops.session(settings.session) },
    SettingStep(SledWords.ROW_TAG_POPULATION) { ops.tagPopulation(settings.tagPopulation) },
    SettingStep(SledWords.ROW_UNIQUE) { ops.uniqueReport(settings.uniqueTagReport) },
    SettingStep(SledWords.ROW_DPO) { ops.dpo(settings.dpo) },
)

// ── identity ──

/**
 * Whether a sled has a barcode scanner, from the vendor's capability class
 * of its model or name (`ReaderDevice.getDeviceCapability`): true for a
 * class naming SCAN, false for the two classes without an imager ("PREMIUM
 * (WiFi)", "STANDARD"), null (unknown, so treated as having one) for
 * anything else, including the vendor's "RFDXXXX" for a name it cannot place.
 */
internal fun hasScannerOf(capability: String?): Boolean? = when {
    capability == null -> null
    capability.contains("SCAN") -> true
    capability == "PREMIUM (WiFi)" || capability == "STANDARD" -> false
    else -> null
}
