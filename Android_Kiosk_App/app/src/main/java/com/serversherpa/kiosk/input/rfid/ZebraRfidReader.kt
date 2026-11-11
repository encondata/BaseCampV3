package com.serversherpa.kiosk.input.rfid

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.util.Log
import com.serversherpa.kiosk.core.rfid.BatchRecoveryPlan
import com.serversherpa.kiosk.core.rfid.BondedDevice
import com.serversherpa.kiosk.core.rfid.LinkTroubleTracker
import com.serversherpa.kiosk.core.rfid.Precheck
import com.serversherpa.kiosk.core.rfid.ResultClass
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SLED_BEST_STEP_DEADLINE_MS
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TeardownPlan
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import com.serversherpa.kiosk.core.rfid.VendorError
import com.serversherpa.kiosk.core.rfid.batchRecoveryPlan
import com.serversherpa.kiosk.core.rfid.bestStepDue
import com.serversherpa.kiosk.core.rfid.classifyResult
import com.serversherpa.kiosk.core.rfid.connectFailure
import com.serversherpa.kiosk.core.rfid.powerToTenths
import com.serversherpa.kiosk.core.rfid.precheck as decidePrecheck
import com.serversherpa.kiosk.core.rfid.teardownPlan
import com.serversherpa.kiosk.core.rfid.triggerTypePasses
import com.serversherpa.kiosk.core.rfid.vendorLogLine
import com.zebra.rfid.api3.AttributeInfo
import com.zebra.rfid.api3.BATCH_MODE
import com.zebra.rfid.api3.BEEPER_VOLUME
import com.zebra.rfid.api3.DYNAMIC_POWER_OPTIMIZATION
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.HANDHELD_TRIGGER_EVENT_TYPE
import com.zebra.rfid.api3.IEvents
import com.zebra.rfid.api3.InvalidUsageException
import com.zebra.rfid.api3.OperationFailureException
import com.zebra.rfid.api3.RFIDReader
import com.zebra.rfid.api3.RFIDResults
import com.zebra.rfid.api3.RFID_EVENT_TYPE
import com.zebra.rfid.api3.Readers
import com.zebra.rfid.api3.RegulatoryConfig
import com.zebra.rfid.api3.RfidEventsListener
import com.zebra.rfid.api3.RfidReadEvents
import com.zebra.rfid.api3.RfidStatusEvents
import com.zebra.rfid.api3.SESSION
import com.zebra.rfid.api3.START_TRIGGER_TYPE
import com.zebra.rfid.api3.STATUS_EVENT_TYPE
import com.zebra.rfid.api3.STOP_TRIGGER_TYPE
import com.zebra.rfid.api3.StartTrigger
import com.zebra.rfid.api3.StopTrigger
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

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
 * apply, start, stop, regions, set region) runs on one thread,
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
 * `Failed(couldNotReach(name), retryable = true)` while the state is
 * `Connecting`, `Connected` or `NeedsRegion`, and the link's blocks then
 * return [SledNotConnected].
 *
 * **Connect.** A pre-check over Android's bonded list runs before any
 * vendor object is built ([precheck]); then [openVendorConnection] runs the
 * vendor sequence (spec, Connect sequence). A failed connect's cleanup runs
 * once, on a thread of its own for that attempt; the worker's next block
 * waits for it at most [CLEANUP_BOUND_MS] ([BATCH_CLEANUP_BOUND_MS] after a
 * batch recovery) and then drops that attempt's vendor references.
 *
 * Every operator sentence is a [SledWords] member. Vendor result names and
 * texts go to the log (`adb logcat -s ZebraRfidReader`) through
 * [vendorLogLine], never onto the screen. A `LinkageError` (a class or native
 * library the raw vendor `.aar` needs and the device lacks) is caught beside
 * every `Exception`, so a connect still ends in a sentence.
 *
 * [zebraHost] says whether the phone is a Zebra handheld (`isZebraHost`):
 * there the sled always gets the RFID layout and no scanner session. It is
 * stored for the trigger layout write and the scanner session, which are
 * not in this file yet.
 */
open class ZebraRfidReader(
    private val context: Context,
    private val scope: CoroutineScope,
    @Suppress("unused") private val zebraHost: Boolean = false,
) : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection.asStateFlow()

    private val _connectNote = MutableStateFlow<String?>(null)
    override val connectNote: StateFlow<String?> = _connectNote.asStateFlow()

    private val _info = MutableStateFlow<SledInfo?>(null)
    override val info: StateFlow<SledInfo?> = _info.asStateFlow()

    private val _batchRecovery = MutableStateFlow(false)
    override val batchRecovery: StateFlow<Boolean> = _batchRecovery.asStateFlow()

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val tags: SharedFlow<String> = _tags.asSharedFlow()

    private val _pulls = MutableSharedFlow<TriggerPull>(extraBufferCapacity = 16)
    override val pulls: SharedFlow<TriggerPull> = _pulls.asSharedFlow()
    override val triggers: Flow<TriggerEvent> = _pulls.map { it.event }

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

    /** The vendor objects of the open (or failed, not yet cleaned up) link. Read by the cleanup thread. */
    @Volatile private var link: VendorLink? = null

    // Worker-confined from here down.
    private var openGeneration = NO_GENERATION
    private var wroteLayout = false
    private var links = LinkTroubleTracker()
    private var batchInARow = false
    private var batchNote: String? = null
    private var pendingCleanup: Thread? = null
    private var pendingCleanupBoundMs = CLEANUP_BOUND_MS

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

    companion object {
        internal const val TAG = "ZebraRfidReader"
        internal const val WORKER_THREAD_NAME = "ZebraRfidWorker"
        private const val CLEANUP_THREAD_PREFIX = "ZebraRfidCleanup-"

        /** A best setup step not started this long after the vendor `connect()` returned is skipped. */
        internal const val BEST_STEP_DEADLINE_MS = SLED_BEST_STEP_DEADLINE_MS

        /** How long the worker's next block waits for a failed connect's cleanup. */
        internal const val CLEANUP_BOUND_MS = 5_000L

        /** The same, after a batch recovery (its close). */
        internal const val BATCH_CLEANUP_BOUND_MS = 20_000L

        /** The batch recovery's pause after its stop, and before its one retry of the batch-mode write. */
        internal const val BATCH_PAUSE_MS = 500L

        private const val NO_GENERATION = -1
        private const val BATCH_MODE_ATTRIBUTE = 1500
        private const val BATCH_MODE_OFF_VALUE = "0"
        private const val REGION_NOT_SET_CODE = "NA"
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
            _connectNote.value = null
            _info.value = null
            _connection.update { RfidConnection.Connecting }
            next
        }
        return onWorker { connectOnWorker(request, generation) }
    }

    /** Bumps the generation and publishes `Disconnected` (clearing [info]) first, then tears down on the worker. Idempotent; never throws. */
    final override suspend fun disconnect() {
        synchronized(stateLock) {
            generations.incrementAndGet()
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
        wroteLayout = false
        links = LinkTroubleTracker()
        linkName = null
        val chosen = when (val pre = precheck(request.address)) {
            is Precheck.Refused -> {
                Log.i(TAG, "Pre-check refused the connect: ${pre.failed.reason}")
                return fail(generation, pre.failed)
            }
            is Precheck.Chosen -> pre
        }
        val name = chosen.sled.name
        linkName = name
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
            val linkUp = generation !in lostGenerations && !failed.retryable && vendorLinkUpQuietly()
            cleanUpAfterFailedConnect(teardownPlan(linkUp, wroteLayout), CLEANUP_BOUND_MS, generation)
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
                        if (needsRegion) RfidConnection.NeedsRegion(info.name) else RfidConnection.Connected(info.name, null)
                    }
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
        cleanUpAfterFailedConnect(teardownPlan(linkUp = false, wroteLayout = wroteLayout), CLEANUP_BOUND_MS, generation)
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
     * that attempt's link (captured here, on the worker). Nothing to close:
     * just drops the references.
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

    /** Waits for a failed attempt's cleanup, at most its bound, then drops that attempt's references. */
    private fun awaitCleanup() {
        val thread = pendingCleanup ?: return
        pendingCleanup = null
        try {
            thread.join(pendingCleanupBoundMs)
        } catch (e: InterruptedException) {
            // Nothing interrupts the worker. The flag is left clear on purpose:
            // set, it would make every later vendor wait end at once.
            Log.w(TAG, "The wait for a failed connect's cleanup was interrupted; going on.", e)
        }
        if (thread.isAlive) {
            Log.w(TAG, "The cleanup of a failed connect was still running after ${pendingCleanupBoundMs} ms; going on without it.")
        }
        dropVendorRefs()
    }

    /** Tears down whatever link is open, with the plan its state allows, then drops the references. */
    private fun tearDownOpenLink() {
        if (hasOpenVendorConnection()) {
            closeQuietly(teardownPlan(linkKnownUp(), wroteLayout), "teardown")
        }
        dropVendorRefs()
    }

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
    protected open fun precheck(savedAddress: String?): Precheck {
        val bluetoothOn = try {
            bluetoothAdapter()?.isEnabled == true
        } catch (e: RuntimeException) {
            Log.w(TAG, "Reading whether Bluetooth is on threw; treating it as off.", e)
            false
        }
        return decidePrecheck(bluetoothOn, RfidPermissions.nearbyGranted(context), bondedDevices(), savedAddress)
    }

    /**
     * The whole vendor connect sequence, on the worker. Builds `Readers` with
     * the Bluetooth transport, lists it once and takes the entry whose
     * address is [sled]'s, then: 1 `connect()`; 2 batch-mode prevention
     * (best); 3 this generation's listener and the disconnect event; 4 the
     * trigger events, checked and retried once; 5 tag events; 6 inventory,
     * battery, power and temperature events (best); 7 start and stop triggers
     * IMMEDIATE, one retry each. A best step not started within
     * [BEST_STEP_DEADLINE_MS] of step 1 returning is skipped and logged. A
     * region check (a region reading `NA`) runs right after step 1.
     *
     * Returns [VendorOpen.Up], or [VendorOpen.NoRegion] when the sled has no
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
                    val plan = batchRecoveryPlan(secondInARow = lastOpenWasBatch)
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
            VendorOpen.Up(info)
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
     * after its teardown, or when a failed connect's cleanup outlived its
     * bound (that cleanup keeps the link it captured). On the worker.
     */
    protected open fun forgetVendorConnection() {
        link = null
    }

    /** The vendor's own view of the link (`rfid.isConnected()`). */
    protected open fun vendorLinkUp(): Boolean = link?.reader?.isConnected() == true

    private fun bluetoothAdapter(): BluetoothAdapter? = context.getSystemService(BluetoothManager::class.java)?.adapter

    // ── the connect sequence, steps 2 to 7 ──

    /** One connect's setup: the best-step clock, started when step 1 returned, and the step rules. */
    private inner class LinkSetup(private val name: String, private val generation: Int) {
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
        // Step 2. Its save runs before any layout write, so a layout is never saved.
        setup.best("batch-mode prevention") {
            val value = readAttribute(rfid, BATCH_MODE_ATTRIBUTE)
            Log.i(TAG, "Batch-mode prevention: attribute $BATCH_MODE_ATTRIBUTE reads ${value ?: "(no answer for it)"}.")
            if (value != BATCH_MODE_OFF_VALUE) preventBatchMode(save = true, rfid = rfid)
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
     * twice. A failure is exactly [SledWords.TRIGGER_NOT_SET_UP]: retryable
     * after link trouble, an open, send or timeout result, or a recorded
     * loss; not retryable when the event simply stayed unregistered.
     */
    private fun setUpTriggerEvents(rfid: RFIDReader, setup: LinkSetup) {
        var retryable = false
        for (attempt in 1..2) {
            try {
                rfid.Events.setHandheldEvent(true)
                if (rfid.Events.isEventRegistered(RFID_EVENT_TYPE.HANDHELD_TRIGGER_EVENT)) {
                    setup.checkLoss()
                    return
                }
                Log.w(TAG, "Setup: the trigger events are not registered after try $attempt.")
            } catch (t: Throwable) {
                if (t is SledConnectException) throw t
                if (isRegionNotSet(t)) throw RegionNotConfigured()
                val error = logFailure("trigger events", t)
                if (error != null && retryableSetupError(error)) retryable = true
            }
        }
        throw SledConnectException(
            RfidConnection.Failed(SledWords.TRIGGER_NOT_SET_UP, retryable = retryable || setup.lost(), fix = SledFix.CONNECT),
        )
    }

    private fun retryableSetupError(error: VendorError): Boolean =
        classifyResult(error) == ResultClass.LINK_TROUBLE ||
            connectFailure(error, name = null, severalPaired = false, classLoading = false).retryable

    /** Reads attribute [number]; null when the reply was for another attribute (the vendor keeps one shared slot). */
    private fun readAttribute(rfid: RFIDReader, number: Int): String? {
        val read = rfid.Config.getAttribute(number, AttributeInfo())
        if (read.attNum != number) {
            Log.w(TAG, "Attribute $number: the reply was for attribute ${read.attNum}, so it was not accepted.")
            return null
        }
        return read.value
    }

    /**
     * The batch-mode safety step: batch mode off, saved only when [save]. Connect
     * step 2 saves; teardown saves only when this connection wrote no trigger
     * layout (`teardownPlan(...).saveConfig`), so a layout is never saved.
     * Throws; the caller decides what a failure means.
     */
    private fun preventBatchMode(save: Boolean, rfid: RFIDReader? = link?.reader) {
        val config = rfid?.Config ?: return
        config.setBatchMode(BATCH_MODE.DISABLE)
        if (save) config.saveConfig()
        Log.i(TAG, if (save) "Batch mode set off and saved." else "Batch mode set off, not saved (this connection wrote a trigger layout).")
    }

    /**
     * `connect()` said `RFID_BATCHMODE_IN_PROGRESS`: the link is up, the
     * sled's capabilities were not fetched. Registers only the listener and
     * the disconnect event (asking for trigger events without capabilities
     * would tell the sled to leave them out), then runs the steps [plan]
     * allows, each guarded and logged: stop, a pause, purge (false on
     * failure), batch mode off (once more after a pause when refused as in
     * progress), save. A second batch result in a row gets only the stop
     * (ruling 28). Returns whether a purge cleared the tags. The close runs as
     * the failed connect's cleanup, bounded at [BATCH_CLEANUP_BOUND_MS]; the
     * steps here are bounded by the vendor's own waits.
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
        if (plan.saveConfig) recoveryStep("save") { rfid.Config.saveConfig() }
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
            val name = _info.value?.name ?: linkName
            _connection.update { state ->
                when (state) {
                    is RfidConnection.Connecting, is RfidConnection.Connected, is RfidConnection.NeedsRegion ->
                        RfidConnection.Failed(SledWords.couldNotReach(name), retryable = true)
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
        // The buffer holds 512; a drop here is a tag the operator thinks was read.
        if (!_tags.tryEmit(epc)) Log.w(TAG, "Dropped a tag read: the tags flow's buffer is full.")
    }

    private fun onBattery(generation: Int, level: Int) {
        synchronized(stateLock) {
            if (generation != currentGeneration) return
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
                    val battery = data.BatteryData
                    Log.i(TAG, "Battery event: level ${battery?.level}, cause ${battery?.cause}, generation $generation.")
                    battery?.level?.let { onBattery(generation, it) }
                }
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> {
                    Log.w(TAG, "Disconnection event ${data.DisconnectionEventData?.disconnectionEvent}, generation $generation.")
                    onLinkLost(generation)
                }
                else -> Log.i(TAG, "Status event ${data.statusEventType}, generation $generation.")
            }
        }
    }

    // ── operations ──

    final override suspend fun apply(settings: RfidSettings): Result<Unit> = onWorker {
        onLink("settings push", sentence = SledWords.SETTINGS_NOT_APPLIED) { rfid ->
            val antenna = rfid.Config.Antennas.getAntennaRfConfig(1)
            antenna.transmitPowerIndex = powerToTenths(settings.powerDbm)
            rfid.Config.Antennas.setAntennaRfConfig(1, antenna)

            val singulation = rfid.Config.Antennas.getSingulationControl(1)
            singulation.session = when (settings.session) {
                RfidSession.S0 -> SESSION.SESSION_S0
                RfidSession.S1 -> SESSION.SESSION_S1
                RfidSession.S2 -> SESSION.SESSION_S2
                RfidSession.S3 -> SESSION.SESSION_S3
            }
            singulation.tagPopulation = settings.tagPopulation.toShort()
            rfid.Config.Antennas.setSingulationControl(1, singulation)

            rfid.Config.setBeeperVolume(
                when (settings.beeper) {
                    SledBeeper.OFF -> BEEPER_VOLUME.QUIET_BEEP
                    SledBeeper.LOW -> BEEPER_VOLUME.LOW_BEEP
                    SledBeeper.MEDIUM -> BEEPER_VOLUME.MEDIUM_BEEP
                    SledBeeper.HIGH -> BEEPER_VOLUME.HIGH_BEEP
                }
            )
            rfid.Config.setUniqueTagReport(settings.uniqueTagReport)
            // The accessors are getDPOState()/setDPOState(...): Kotlin makes no
            // `dpoState` property from a name that starts with two capitals.
            rfid.Config.setDPOState(
                if (settings.dpo) DYNAMIC_POWER_OPTIMIZATION.ENABLE else DYNAMIC_POWER_OPTIMIZATION.DISABLE
            )
        }
    }

    final override suspend fun startInventory(): Result<Unit> = onWorker {
        onLink("start", sentence = SledWords.READ_DID_NOT_START) { rfid -> rfid.Actions.Inventory.perform() }
    }

    final override suspend fun stopInventory(): Result<Unit> = onWorker {
        onLink("stop") { rfid -> rfid.Actions.Inventory.stop() }
    }

    /** The regions this reader allows and the one in force. Needs `Connected` or `NeedsRegion`. */
    final override suspend fun regions(): Result<RfidRegions> = onWorker {
        onLink("regions", allowNeedsRegion = true, sentence = SledWords.REGIONS_FAILED) { rfid ->
            val supported = rfid.ReaderCapabilities.SupportedRegions
            val regions = (0 until supported.length()).map { i ->
                val region = supported.getRegionInfo(i)
                RfidRegion(
                    code = region.regionCode,
                    name = region.name,
                    hoppingConfigurable = region.isHoppingConfigurable,
                    channels = region.supportedChannels?.toList().orEmpty(),
                )
            }
            RfidRegions(regions, rfid.Config.getRegulatoryConfig()?.region)
        }
    }

    /** Sets the regulatory domain; [hopping] applies only when not null. Needs `Connected` or `NeedsRegion`. */
    final override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> = onWorker {
        onLink("set region", allowNeedsRegion = true, sentence = SledWords.REGION_NOT_SET) { rfid ->
            val regulatoryConfig = RegulatoryConfig()
            regulatoryConfig.region = code
            // The getter is isHoppingon() (lowercase "on"), so the setter is called by name.
            if (hopping != null) regulatoryConfig.setIsHoppingOn(hopping)
            rfid.Config.setRegulatoryConfig(regulatoryConfig)
        }
    }

    /**
     * Runs [body] against the current link when the state allows it (`Connected`,
     * or `NeedsRegion` with [allowNeedsRegion]) and the link was not lost;
     * otherwise [SledNotConnected] with no vendor call. Each result counts
     * toward marking the link lost. A failure carries [sentence] when given.
     */
    private inline fun <T> onLink(
        step: String,
        allowNeedsRegion: Boolean = false,
        sentence: String? = null,
        body: (RFIDReader) -> T,
    ): Result<T> {
        val state = _connection.value
        val stateAllows = state is RfidConnection.Connected || (allowNeedsRegion && state is RfidConnection.NeedsRegion)
        val generation = currentGeneration
        val rfid = link?.reader
        if (!stateAllows || rfid == null || openGeneration != generation || generation in lostGenerations) {
            return Result.failure(SledNotConnected())
        }
        return try {
            val value = body(rfid)
            recordResult(generation, null)
            Result.success(value)
        } catch (t: Throwable) {
            val error = logFailure(step, t)
            recordResult(generation, error)
            Result.failure(if (sentence == null) t else Exception(sentence, t))
        }
    }

    /** Counts one block's result; two link-trouble results in a row mark the link of [generation] lost. */
    private fun recordResult(generation: Int, error: VendorError?) {
        if (links.record(error?.let(::classifyResult))) {
            Log.w(TAG, "Two link-trouble results in a row: marking the link lost.")
            onLinkLost(generation)
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

    private fun nowMs(): Long = System.nanoTime() / 1_000_000L
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
