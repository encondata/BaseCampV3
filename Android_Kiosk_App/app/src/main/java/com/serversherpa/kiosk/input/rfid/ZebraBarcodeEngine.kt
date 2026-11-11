package com.serversherpa.kiosk.input.rfid

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerFault
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.barcodeTypeLabel
import com.serversherpa.kiosk.core.rfid.decodeBarcode
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_COMMAND_OPCODE
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_EVENT
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_MODE
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_RESULT
import com.zebra.scannercontrol.DCSScannerInfo
import com.zebra.scannercontrol.FirmwareUpdateEvent
import com.zebra.scannercontrol.IDcsSdkApiDelegate
import com.zebra.scannercontrol.SDKHandler
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** A scanner SDK call's result, as the engine decides on it ([scannerResultOf] maps the vendor's). */
internal enum class ScannerResult { SUCCESS, ALREADY_ACTIVE, NOT_AVAILABLE, NOT_ACTIVE, FAILURE }

/** The two operational modes the engine ever sets: off, and classic Bluetooth (the sled's transport). */
internal enum class ScannerMode { DISABLED, BT_NORMAL }

/**
 * The vendor calls the engine makes, with no vendor type in them, so the
 * engine runs against a fake in tests. Only [VendorScannerSdk] talks to the
 * vendor. Every call blocks until the vendor answers and may throw.
 */
internal interface ScannerSdk {
    fun setMode(mode: ScannerMode): ScannerResult

    /** Every scanner the vendor knows of, active first, each once. */
    fun list(): List<ScannerCandidate>

    fun establish(scannerId: Int): ScannerResult

    fun terminate(scannerId: Int): ScannerResult

    fun pullTrigger(scannerId: Int): ScannerResult

    fun releaseTrigger(scannerId: Int): ScannerResult
}

/** What the vendor's callbacks hand on ([scannerDelegate]). They arrive on vendor threads, some inside a vendor call. */
internal interface ScannerEvents {
    fun sessionEstablished(scannerId: Int)

    fun sessionTerminated(scannerId: Int)

    fun barcode(bytes: ByteArray?, type: Int, scannerId: Int)
}

/** A soft scan the scanner did not take. It carries no sentence: the result goes to the log and the scanner state says the rest. */
internal class ScannerCommandFailed(val result: ScannerResult) : Exception()

/**
 * The sled's own barcode scanner, through the vendor's second SDK,
 * `com.zebra.scannercontrol` (spec, Scanner engine). This file and
 * `ZebraRfidReader.kt` are the only two that import a Zebra SDK
 * (`CorePurityTest`). The RFID radio and the scanner are two devices in one
 * housing, each with its own SDK; [ZebraRfidReader] decides when a session is
 * wanted (ruling 7) and says so through [want], [linkLost] and
 * [bluetoothTurningOff].
 *
 * **One worker, one desired value.** Every vendor call runs on [executor],
 * one thread that is never interrupted ([vendorScannerEngine] makes it; a
 * test may run it on the calling thread). Callers only record what they want,
 * a (generation, open) value, and the worker brings the session in line with
 * the latest one after each vendor call, so opens and closes for an older
 * generation are skipped. Each open request (an open after a close or in a
 * new generation, or [retry]) gets a number; a result is published only while
 * its generation and request are current.
 *
 * **Every open** checks Bluetooth (before the SDK is built and before every
 * classic-Bluetooth mode: off is `Unavailable(BLUETOOTH_OFF)` with no vendor
 * call, since the vendor would switch Bluetooth on itself or wait for it),
 * resets the mode, sets the classic-Bluetooth mode, lists the scanners only to
 * find the sled's id ([chooseScanner], cached per sled), and establishes.
 * `ALREADY_ACTIVE` is never a session this engine can use: terminate,
 * establish once more, and a second `ALREADY_ACTIVE` or any other result is
 * `Unavailable(DID_NOT_START)`. Ruling 40's one exception, a session this
 * engine opened in the same generation, cannot be up by then: every close and
 * every open sends the mode reset first, and the vendor's reset stops its
 * Bluetooth manager and closes the scanner's socket, while the vendor keeps
 * the scanner marked active whenever its terminate did not go through.
 * `NOT_AVAILABLE` drops the cached id, lists once and establishes once. A
 * failed open resets the mode when the Bluetooth mode went in.
 *
 * **Ready** comes only once establish returned `SUCCESS` and
 * [STALE_WINDOW_MS] passed since the established callback (the vendor's
 * barcode queue is static and outlives sessions). Each turn to `Ready` is
 * told to [onReady] with its generation, outside the lock: the reader writes
 * the sled's real trigger keys only then. A barcode is emitted only
 * while [state] shows `Ready`; one before that, inside the window or while not
 * Ready is dropped and logged with its length, never its value.
 *
 * **Closing** (not wanted, a termination this engine did not ask for, a link
 * loss, Bluetooth turning off) queues terminate, then the mode reset in a
 * `finally`, and changes what [state] shows at once: `Off`, except after a
 * termination the engine did not ask for while the session is still asked
 * for, which shows `Unavailable(DID_NOT_START)`, so the screens offer Try
 * again while the RFID link stays `Connected`. A termination the engine did
 * not ask for, or Bluetooth turning off, holds the request closed until a new
 * open request or [retry]. Bluetooth turning off shows `Off` (the link drop
 * and the reconnect after it open a new request) and drops the cached id.
 *
 * **Leaked reader threads.** The vendor's Bluetooth reader thread swallows
 * the one interrupt its own cancel sends, so each session the vendor closes
 * (terminate, or the mode reset) leaves that thread polling a closed socket
 * every 50 ms for the life of the process. The worker runs [reap]
 * ([reapLeakedReaderThreads] in the app) right after every mode reset that
 * closes, a close's and a failed open's, and right before every open's first
 * mode reset: the points where it holds no session and the vendor has already
 * dropped its own thread. It never reaps while a session is up or being
 * established. A reap that found any is logged.
 *
 * **Watchdog.** Each vendor call is watched ([COMMAND_WATCHDOG_MS],
 * [ESTABLISH_WATCHDOG_MS] for establish). One that outlives it changes only
 * what [state] shows, to `Unavailable(STOPPED_RESPONDING)`, while a session is
 * wanted; when the call returns, its real result is applied. [watchdog] is the
 * engine's one timer: it also ends the stale window.
 *
 * Logs go to [log] (`adb logcat -s ZebraBarcodeEngine` for the real engine).
 */
internal class ZebraBarcodeEngine(
    private val sdk: () -> ScannerSdk,
    private val executor: Executor,
    private val bluetoothOn: () -> Boolean,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    private val watchdog: (timeoutMs: Long, onTimeout: () -> Unit) -> () -> Unit,
    private val log: (String) -> Unit,
    private val reap: () -> ReapResult = { reapLeakedReaderThreads() },
) : ScannerEvents {

    private val _state = MutableStateFlow<SledScannerState>(SledScannerState.Off)
    val state: StateFlow<SledScannerState> = _state.asStateFlow()

    private val _barcodes = MutableSharedFlow<SledBarcode>(extraBufferCapacity = 16)
    val barcodes: SharedFlow<SledBarcode> = _barcodes.asSharedFlow()

    /**
     * Called each time [state] turns `Ready`, with the generation it is ready
     * for: when the stale window ends, and when a call that outlived its
     * watchdog returns to a session still up. Called outside the engine's
     * lock, on the thread that saw it (the timer's or the worker's), so it
     * must only post its work. The reader sets it once, when it builds the
     * engine, and writes the sled's real trigger keys from it.
     */
    @Volatile var onReady: (generation: Int) -> Unit = {}

    /** What the reader asked for. [request] numbers each open request; [parked] holds it closed after the engine closed it by itself, and says why. */
    private data class Desire(
        val generation: Int,
        val open: Boolean,
        val target: SledIdentity,
        val request: Int,
        val parked: Parked? = null,
    ) {
        val wanted: Boolean get() = open && parked == null
    }

    /** Why the engine holds an open request closed by itself. */
    private enum class Parked {
        /** The scanner ended the session without being asked: shown as `Unavailable(DID_NOT_START)`, so Try again is offered. */
        ENDED_BY_ITSELF,

        /** Bluetooth is turning off: shown as `Off`. */
        BLUETOOTH_OFF,
    }

    /** The session the engine has up: for [generation] and [request], on scanner [id], its stale window from [windowStart]. */
    private class Session(val generation: Int, val request: Int, val id: Int, val windowStart: Long) {
        @Volatile var cancelWindow: () -> Unit = {}
    }

    private data class CachedId(val target: SledIdentity, val id: Int)

    private sealed interface Action {
        class Close(val session: Session) : Action

        class Open(val desire: Desire) : Action
    }

    private sealed interface Established {
        data class Up(val id: Int) : Established

        data object Failed : Established

        /** The request moved on before a session came up. */
        data object Superseded : Established
    }

    /** Guards everything below it; never held around a vendor call. */
    private val lock = Any()

    private var desire = Desire(NO_GENERATION, open = false, target = NO_TARGET, request = 0)
    private var requests = 0
    private var lostGeneration = NO_GENERATION

    /** The request the last open served; an open runs once per request. */
    private var served = 0

    /** What the open flow last found for the current request; [renderLocked] shows it unless not wanted or stuck. */
    private var found: SledScannerState = SledScannerState.Off
    private var stuck = false
    private var callInFlight = 0L
    private var callCount = 0L
    private var pumpQueued = false
    private var session: Session? = null
    private var cached: CachedId? = null
    private var cacheEpoch = 0

    /** The scanner id of the establish in flight, and when its established callback came. */
    private var establishing: Int? = null
    private var establishedAt: Long? = null
    private var openingFor: Desire? = null

    /** True inside the engine's own terminate, whose terminated callback comes inside the call. */
    private var terminating = false

    /** Worker-confined: the SDK, built on first open. */
    private var vendor: ScannerSdk? = null

    // ── what the reader asks for ──

    /**
     * Asks for the session of [generation] to be [open] (on the sled
     * [target]) or closed. A request for an older generation, or an open for
     * a generation whose link was lost, is skipped. An open after a close, or
     * in a new generation, is a new open request: `Opening` at once.
     */
    fun want(generation: Int, open: Boolean, target: SledIdentity) {
        synchronized(lock) {
            if (generation < desire.generation) {
                log("Scanner: a request for generation $generation (now ${desire.generation}) is skipped.")
                return
            }
            val opening = open && generation > lostGeneration
            val edge = opening && (generation != desire.generation || !desire.open)
            desire = when {
                edge -> Desire(generation, open = true, target = target, request = ++requests)
                opening -> desire.copy(target = target)
                else -> Desire(generation, open = false, target = target, request = desire.request)
            }
            if (edge) found = SledScannerState.Opening
            renderLocked()
        }
        kick()
    }

    /** The RFID link of [generation] was lost: `Off` at once, and that generation never opens again. */
    fun linkLost(generation: Int) {
        synchronized(lock) {
            if (generation < desire.generation) return
            lostGeneration = maxOf(lostGeneration, generation)
            desire = desire.copy(generation = generation, open = false)
            renderLocked()
        }
        log("Scanner: the RFID link of generation $generation was lost; closing.")
        kick()
    }

    /** The adapter's receiver saw Bluetooth turning off: `Off` at once, the session closes, and the cached id is dropped. */
    fun bluetoothTurningOff() {
        synchronized(lock) {
            cached = null
            cacheEpoch++
            if (desire.open) desire = desire.copy(parked = Parked.BLUETOOTH_OFF)
            renderLocked()
        }
        log("Scanner: Bluetooth is turning off; closing, and the scanner id is forgotten.")
        kick()
    }

    /**
     * The Try again button: terminate (when a session is up), then open once
     * more; it also reopens a request held closed after the scanner ended its
     * session by itself. Fails at once while the scanner shows
     * `STOPPED_RESPONDING` (the worker is stuck), and with [SledNotConnected]
     * when no session is asked for in [generation]. Returns once it is
     * queued, without waiting for it.
     */
    suspend fun retry(generation: Int): Result<Unit> {
        synchronized(lock) {
            if (_state.value == STOPPED_RESPONDING) return Result.failure(Exception(SledWords.SCANNER_STOPPED_RESPONDING))
            if (!desire.open || desire.generation != generation) return Result.failure(SledNotConnected())
            desire = desire.copy(request = ++requests, parked = null)
            found = SledScannerState.Opening
            renderLocked()
        }
        log("Scanner: Try again, generation $generation.")
        kick()
        return Result.success(Unit)
    }

    /**
     * The sled's Scan button: a trigger pull or release. Fails at once with
     * [SledNotConnected] unless `Ready`; otherwise runs on the worker and
     * returns its result. A caller that stops waiting leaves the command
     * running. A failed pull is `Unavailable(DID_NOT_START)`.
     */
    suspend fun softScan(pull: Boolean): Result<Unit> {
        val target = synchronized(lock) { session.takeIf { _state.value == SledScannerState.Ready } }
            ?: return Result.failure(SledNotConnected())
        val done = CompletableDeferred<ScannerResult?>()
        try {
            executor.execute {
                val result = try {
                    runSoftScan(target, pull)
                } catch (t: Throwable) {
                    log("Scanner: the soft scan threw ${t.javaClass.name}: ${t.message}")
                    ScannerResult.FAILURE
                }
                done.complete(result)
            }
        } catch (e: RejectedExecutionException) {
            log("Scanner: the worker refused the soft scan.")
            return Result.failure(SledNotConnected())
        }
        return when (val result = done.await()) {
            ScannerResult.SUCCESS -> Result.success(Unit)
            null -> Result.failure(SledNotConnected())
            else -> Result.failure(ScannerCommandFailed(result))
        }
    }

    // ── vendor callbacks ──

    override fun sessionEstablished(scannerId: Int) {
        val inFlight = synchronized(lock) {
            val id = establishing
            if (id != null) establishedAt = clock()
            id
        }
        if (inFlight == null) {
            log("Scanner: an established callback for scanner $scannerId with no establish in flight; ignored.")
        } else {
            log("Scanner: the established callback came for scanner $scannerId (establishing $inFlight); the stale window starts.")
        }
    }

    override fun sessionTerminated(scannerId: Int) {
        val parked = synchronized(lock) {
            if (terminating) return
            val s = session
            val opening = openingFor
            val current = when {
                s != null && s.id == scannerId -> isCurrentLocked(s.generation, s.request)
                opening != null && establishing == scannerId -> isCurrentLocked(opening.generation, opening.request)
                else -> null
            }
            if (current == true) {
                desire = desire.copy(parked = Parked.ENDED_BY_ITSELF)
                renderLocked()
            }
            current
        }
        when (parked) {
            null -> log("Scanner: a terminated callback for scanner $scannerId, which this engine has no session with; ignored.")
            true -> log("Scanner: scanner $scannerId ended its session by itself; closing, and showing that it did not start, so Try again is offered.")
            false -> log("Scanner: scanner $scannerId ended an older session by itself.")
        }
        kick()
    }

    override fun barcode(bytes: ByteArray?, type: Int, scannerId: Int) {
        val length = bytes?.size ?: 0
        val dropped = synchronized(lock) {
            val windowStart = session?.windowStart ?: establishedAt
            when {
                establishing != null && session == null && establishedAt == null -> "before the session was established"
                windowStart != null && clock() - windowStart < STALE_WINDOW_MS -> "inside the stale window"
                _state.value != SledScannerState.Ready -> "while the scanner is ${_state.value}"
                else -> null
            }
        }
        if (dropped != null) {
            log("Scanner: dropped a barcode of length $length from scanner $scannerId $dropped.")
            return
        }
        val value = decodeBarcode(bytes)
        if (value == null) {
            log("Scanner: dropped a blank barcode of length $length from scanner $scannerId.")
            return
        }
        if (!_barcodes.tryEmit(SledBarcode(value, barcodeTypeLabel(type)))) {
            log("Scanner: dropped a barcode of length $length: the barcodes flow's buffer is full.")
        }
    }

    // ── the worker ──

    /** Posts the worker's loop unless it is already queued or has nothing to do. */
    private fun kick() {
        val post = synchronized(lock) {
            if (pumpQueued || !workLocked()) {
                false
            } else {
                pumpQueued = true
                true
            }
        }
        if (!post) return
        try {
            executor.execute(::pump)
        } catch (e: RejectedExecutionException) {
            synchronized(lock) { pumpQueued = false }
            log("Scanner: the worker refused its loop.")
        }
    }

    private fun workLocked(): Boolean {
        val s = session
        return if (s != null) !isCurrentLocked(s.generation, s.request) else desire.wanted && served != desire.request
    }

    /** One step at a time, each decided on the latest desired value: close a session no longer current, or open one. */
    private fun pump() {
        while (true) {
            val action = synchronized(lock) {
                val s = session
                when {
                    s != null && !isCurrentLocked(s.generation, s.request) -> Action.Close(s)
                    s == null && desire.wanted && served != desire.request -> {
                        served = desire.request
                        openingFor = desire
                        Action.Open(desire)
                    }
                    else -> {
                        pumpQueued = false
                        null
                    }
                }
            } ?: return
            try {
                when (action) {
                    is Action.Close -> close(action.session)
                    is Action.Open -> open(action.desire)
                }
            } catch (t: Throwable) {
                log("Scanner: the worker caught ${t.javaClass.name}: ${t.message}")
            } finally {
                if (action is Action.Open) {
                    synchronized(lock) {
                        openingFor = null
                        establishing = null
                        establishedAt = null
                    }
                }
            }
        }
    }

    private fun open(d: Desire) {
        log("Scanner: opening for generation ${d.generation} (request ${d.request}).")
        publish(d, SledScannerState.Opening)
        if (!bluetoothOn()) {
            log("Scanner: Bluetooth is off; nothing is sent.")
            publish(d, BLUETOOTH_OFF)
            return
        }
        val sdk = vendorOrNull() ?: return publish(d, DID_NOT_START)
        var bluetoothModeSent = false
        var up = false
        try {
            reapLeaked()
            mode(sdk, ScannerMode.DISABLED)
            if (!stillWanted(d)) return
            if (!bluetoothOn()) {
                log("Scanner: Bluetooth went off before the Bluetooth mode; it is not sent.")
                publish(d, BLUETOOTH_OFF)
                return
            }
            bluetoothModeSent = true
            if (mode(sdk, ScannerMode.BT_NORMAL) != ScannerResult.SUCCESS) {
                publish(d, DID_NOT_START)
                return
            }
            if (!stillWanted(d)) return
            when (val established = establishFor(sdk, d)) {
                is Established.Up -> {
                    up = true
                    sessionUp(d, established.id)
                }
                Established.Failed -> publish(d, DID_NOT_START)
                Established.Superseded -> Unit
            }
        } finally {
            if (bluetoothModeSent && !up) {
                mode(sdk, ScannerMode.DISABLED)
                reapLeaked()
            }
        }
    }

    /** Finds the sled's id and establishes, by the establish rules in the class doc. */
    private fun establishFor(sdk: ScannerSdk, d: Desire): Established {
        var id = cachedIdFor(d.target) ?: listFor(sdk, d.target) ?: return Established.Failed
        if (!stillWanted(d)) return Established.Superseded
        var result = establish(sdk, id)
        if (result == ScannerResult.NOT_AVAILABLE) {
            log("Scanner: scanner $id is not available; listing again.")
            synchronized(lock) { cached = null }
            if (!stillWanted(d)) return Established.Superseded
            id = listFor(sdk, d.target) ?: return Established.Failed
            if (!stillWanted(d)) return Established.Superseded
            result = establish(sdk, id)
        }
        if (result == ScannerResult.ALREADY_ACTIVE) {
            // The mode reset this open began with closed any socket this
            // engine had, so the vendor's flag is stale or another app holds it.
            log("Scanner: scanner $id is already active, with no session this engine can use; terminating, then one more establish.")
            terminate(sdk, id)
            if (!stillWanted(d)) return Established.Superseded
            result = establish(sdk, id)
            if (result == ScannerResult.ALREADY_ACTIVE) log("Scanner: scanner $id is still already active.")
        }
        return if (result == ScannerResult.SUCCESS) Established.Up(id) else Established.Failed
    }

    private fun establish(sdk: ScannerSdk, id: Int): ScannerResult {
        synchronized(lock) {
            establishing = id
            establishedAt = null
        }
        val result = guarded("establish on scanner $id", ESTABLISH_WATCHDOG_MS) { sdk.establish(id) } ?: ScannerResult.FAILURE
        log("Scanner: establish on scanner $id: $result.")
        return result
    }

    /** Lists the scanners, logs them, and returns this sled's id (cached), or null when none is this sled. */
    private fun listFor(sdk: ScannerSdk, target: SledIdentity): Int? {
        val epoch = synchronized(lock) { cacheEpoch }
        val candidates = guarded("list", COMMAND_WATCHDOG_MS) { sdk.list() }.orEmpty()
        log(
            "Scanner: ${candidates.size} scanner(s) listed: " +
                (if (candidates.isEmpty()) "none" else candidates.joinToString { "id ${it.scannerId} \"${it.name}\" (${it.model}, ${it.serial})" }) +
                "; looking for ${target.name} (address ${target.address}, serial ${target.serial}).",
        )
        if (candidates.any { it.name == null }) {
            log(
                "Scanner: a listed scanner has no name. While the Bluetooth mode is set, the vendor compares every listed " +
                    "name on the main thread when a Bluetooth device disconnects, and a missing name throws there.",
            )
        }
        val chosen = chooseScanner(candidates, target)
        if (chosen == null) {
            log("Scanner: none of the listed scanners is this sled; none is tried.")
            return null
        }
        log("Scanner: chose scanner ${chosen.scannerId} (\"${chosen.name}\").")
        synchronized(lock) { if (cacheEpoch == epoch) cached = CachedId(target, chosen.scannerId) }
        return chosen.scannerId
    }

    private fun cachedIdFor(target: SledIdentity): Int? = synchronized(lock) { cached?.takeIf { it.target == target }?.id }

    /** The session is up: recorded (so a session no longer current is closed next), and shown `Ready` once the stale window has passed. */
    private fun sessionUp(d: Desire, id: Int) {
        val up = synchronized(lock) {
            val s = Session(d.generation, d.request, id, establishedAt ?: clock())
            session = s
            val current = isCurrentLocked(d.generation, d.request)
            if (current) {
                found = SledScannerState.Opening
                renderLocked()
            }
            SessionUp(s, callbackCame = establishedAt != null, rest = if (current) STALE_WINDOW_MS - (clock() - s.windowStart) else null)
        }
        if (!up.callbackCame) log("Scanner: no established callback came for scanner $id; the stale window starts now.")
        val rest = up.rest
        when {
            rest == null -> log("Scanner: the session on scanner $id came up for a request that moved on; it is closed, and nothing is shown.")
            rest <= 0 -> windowEnded(up.session)
            else -> armWindow(up.session, rest)
        }
    }

    /** [sessionUp]'s findings under the lock: the stale window's [rest], or null when the request moved on. */
    private class SessionUp(val session: Session, val callbackCame: Boolean, val rest: Long?)

    private fun armWindow(s: Session, ms: Long) {
        s.cancelWindow = watchdog(ms) { windowEnded(s) }
    }

    /** The stale window's timer: `Ready` once the window has passed by [clock], else armed again for the rest. */
    private fun windowEnded(s: Session) {
        var turnedReady = false
        val rest = synchronized(lock) {
            if (session !== s || !isCurrentLocked(s.generation, s.request)) return
            val untilEnd = STALE_WINDOW_MS - (clock() - s.windowStart)
            if (untilEnd <= 0) {
                found = SledScannerState.Ready
                turnedReady = renderLocked()
            }
            untilEnd
        }
        if (turnedReady) announceReady(s.generation)
        if (rest > 0) armWindow(s, rest)
    }

    /** Tells [onReady] that [state] turned `Ready` for [generation]; a listener that throws is logged. */
    private fun announceReady(generation: Int) {
        try {
            onReady(generation)
        } catch (t: Throwable) {
            log("Scanner: the ready listener threw ${t.javaClass.name}: ${t.message}")
        }
    }

    /** Terminate, then the mode reset in a `finally`, then a reap once the session is gone. */
    private fun close(s: Session) {
        log("Scanner: closing the session on scanner ${s.id} (generation ${s.generation}).")
        s.cancelWindow()
        val sdk = vendor
        try {
            if (sdk != null) terminate(sdk, s.id)
        } finally {
            try {
                if (sdk != null) mode(sdk, ScannerMode.DISABLED)
            } finally {
                synchronized(lock) { if (session === s) session = null }
                reapLeaked()
            }
        }
    }

    /**
     * Stops the vendor reader threads its own closes leaked
     * ([reapLeakedReaderThreads]), and logs the result when it found any.
     * Called on the worker at two points only, where the engine holds no
     * session and the vendor has already dropped its own reader thread: right
     * after a mode reset that closes (a close's, a failed open's), and right
     * before an open's first mode reset. Never while a session is up or being
     * established.
     */
    private fun reapLeaked() {
        val result = try {
            reap()
        } catch (t: Throwable) {
            log("Scanner: reaping leaked reader threads threw ${t.javaClass.name}: ${t.message}")
            return
        }
        if (result.found > 0) {
            log(
                "Scanner: reaped ${result.reaped} of ${result.found} leaked reader thread(s) in ${result.elapsedMs} ms; " +
                    "${result.survivors} still running.",
            )
        }
    }

    private fun terminate(sdk: ScannerSdk, id: Int): ScannerResult {
        synchronized(lock) { terminating = true }
        val result = try {
            guarded("terminate on scanner $id", COMMAND_WATCHDOG_MS) { sdk.terminate(id) } ?: ScannerResult.FAILURE
        } finally {
            synchronized(lock) { terminating = false }
        }
        log("Scanner: terminate on scanner $id: $result.")
        val ended = result == ScannerResult.SUCCESS || result == ScannerResult.NOT_ACTIVE || result == ScannerResult.NOT_AVAILABLE
        if (!ended) log("Scanner: the vendor may still mark scanner $id active; an ALREADY_ACTIVE at the next open is terminated first.")
        return result
    }

    private fun mode(sdk: ScannerSdk, mode: ScannerMode): ScannerResult {
        val result = guarded("mode $mode", COMMAND_WATCHDOG_MS) { sdk.setMode(mode) } ?: ScannerResult.FAILURE
        log("Scanner: mode $mode: $result.")
        return result
    }

    private fun runSoftScan(target: Session, pull: Boolean): ScannerResult? {
        val sdk = vendor
        val ready = synchronized(lock) {
            session === target && isCurrentLocked(target.generation, target.request) && found == SledScannerState.Ready
        }
        val what = if (pull) "pull trigger" else "release trigger"
        if (sdk == null || !ready) {
            log("Scanner: $what skipped: the session is no longer ready.")
            return null
        }
        val result = guarded("$what on scanner ${target.id}", COMMAND_WATCHDOG_MS) {
            if (pull) sdk.pullTrigger(target.id) else sdk.releaseTrigger(target.id)
        } ?: ScannerResult.FAILURE
        log("Scanner: $what on scanner ${target.id}: $result.")
        if (pull && result != ScannerResult.SUCCESS) {
            synchronized(lock) {
                if (session === target && isCurrentLocked(target.generation, target.request)) {
                    found = DID_NOT_START
                    renderLocked()
                }
            }
        }
        return result
    }

    private fun vendorOrNull(): ScannerSdk? {
        vendor?.let { return it }
        return try {
            sdk().also {
                vendor = it
                log("Scanner: the scanner SDK is built.")
            }
        } catch (t: Throwable) {
            log("Scanner: building the scanner SDK threw ${t.javaClass.name}: ${t.message}")
            null
        }
    }

    /**
     * Runs one vendor call under a watchdog of [timeoutMs]; null when it threw
     * (logged). A call that outlives its watchdog shows `STOPPED_RESPONDING`
     * until it returns.
     */
    private inline fun <T : Any> guarded(what: String, timeoutMs: Long, call: () -> T): T? {
        val token = synchronized(lock) { (++callCount).also { callInFlight = it } }
        val cancel = try {
            watchdog(timeoutMs) { watchdogFired(token, what, timeoutMs) }
        } catch (t: Throwable) {
            log("Scanner: arming the watchdog for $what threw ${t.javaClass.name}; going on without it.")
            NO_CANCEL
        }
        try {
            return call()
        } catch (t: Throwable) {
            log("Scanner: $what threw ${t.javaClass.name}: ${t.message}")
            return null
        } finally {
            try {
                cancel()
            } catch (t: Throwable) {
                log("Scanner: cancelling the watchdog for $what threw ${t.javaClass.name}.")
            }
            var readyAgain = NO_GENERATION
            val late = synchronized(lock) {
                callInFlight = 0
                val wasStuck = stuck
                if (wasStuck) {
                    stuck = false
                    if (renderLocked()) readyAgain = desire.generation
                }
                wasStuck
            }
            if (late) log("Scanner: $what returned after its watchdog; its result is applied.")
            if (readyAgain != NO_GENERATION) announceReady(readyAgain)
        }
    }

    private fun watchdogFired(token: Long, what: String, timeoutMs: Long) {
        synchronized(lock) {
            if (callInFlight != token) return
            stuck = true
            renderLocked()
        }
        log("Scanner: $what has not returned after $timeoutMs ms.")
    }

    // ── state ──

    private fun stillWanted(d: Desire): Boolean {
        val current = synchronized(lock) { isCurrentLocked(d.generation, d.request) }
        if (!current) log("Scanner: the request for generation ${d.generation} (request ${d.request}) moved on.")
        return current
    }

    private fun isCurrentLocked(generation: Int, request: Int): Boolean =
        desire.wanted && desire.generation == generation && desire.request == request

    /** Shows the open flow's [found] for [d] while [d] is current. */
    private fun publish(d: Desire, state: SledScannerState) {
        synchronized(lock) {
            if (!isCurrentLocked(d.generation, d.request)) return
            found = state
            renderLocked()
        }
    }

    /**
     * `DID_NOT_START` while an open request is held closed after the scanner
     * ended its session by itself; else `Off` unless a session is wanted;
     * `STOPPED_RESPONDING` while a call is stuck; else what the open flow found.
     * Returns true when this turned [state] to `Ready` (the caller then
     * tells [onReady], once outside the lock).
     */
    private fun renderLocked(): Boolean {
        val shown = when {
            desire.open && desire.parked == Parked.ENDED_BY_ITSELF -> DID_NOT_START
            !desire.wanted -> SledScannerState.Off
            stuck -> STOPPED_RESPONDING
            else -> found
        }
        val before = _state.value
        if (shown == before) return false
        _state.value = shown
        log("Scanner: $before -> $shown (generation ${desire.generation}).")
        return shown == SledScannerState.Ready
    }

    companion object {
        internal const val TAG = "ZebraBarcodeEngine"
        internal const val WORKER_THREAD_NAME = "ZebraScannerWorker"
        internal const val TIMER_THREAD_NAME = "ZebraScannerTimer"

        /** Barcodes this soon after the established callback are left over from before; dropped. */
        const val STALE_WINDOW_MS = 250L

        /** A vendor command that has not returned after this shows `STOPPED_RESPONDING`. */
        const val COMMAND_WATCHDOG_MS = 10_000L

        /** The same for establish, which can properly take about 31 s after the socket opens. */
        const val ESTABLISH_WATCHDOG_MS = 45_000L

        private const val NO_GENERATION = -1
        private val NO_TARGET = SledIdentity(name = null, address = null, serial = null)
        private val NO_CANCEL: () -> Unit = {}
        private val DID_NOT_START = SledScannerState.Unavailable(SledScannerFault.DID_NOT_START)
        private val STOPPED_RESPONDING = SledScannerState.Unavailable(SledScannerFault.STOPPED_RESPONDING)
        private val BLUETOOTH_OFF = SledScannerState.Unavailable(SledScannerFault.BLUETOOTH_OFF)
    }
}

/**
 * The engine the app runs: [VendorScannerSdk] built on the first open, on one
 * scanner worker thread that is never interrupted, with the watchdogs and the
 * stale window's end on one timer thread. Both threads live as long as the
 * process.
 */
internal fun vendorScannerEngine(appContext: Context, bluetoothOn: () -> Boolean): ZebraBarcodeEngine {
    val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, ZebraBarcodeEngine.WORKER_THREAD_NAME).apply { isDaemon = true }
    }
    val timer = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, ZebraBarcodeEngine.TIMER_THREAD_NAME).apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }
    lateinit var engine: ZebraBarcodeEngine
    engine = ZebraBarcodeEngine(
        sdk = { VendorScannerSdk(appContext, engine) },
        executor = worker,
        bluetoothOn = bluetoothOn,
        watchdog = { timeoutMs, onTimeout ->
            val armed = timer.schedule(Runnable { onTimeout() }, timeoutMs, TimeUnit.MILLISECONDS)
            ({ armed.cancel(false) })
        },
        log = { Log.i(ZebraBarcodeEngine.TAG, it) },
    )
    return engine
}

/**
 * The only holder of the vendor's `SDKHandler`: one for the life of the
 * process, built with `SDKHandler(appContext, false)` (no scan-to-connect), its
 * delegate and event subscription set once. The delegate forwards to the
 * [ScannerEvents] of the latest instance. The trigger commands use the
 * four-argument `dcssdkExecuteCommandOpCodeInXMLForScanner` with
 * [scanCommandInXml]; each blocks up to 8 s for the scanner's answer.
 */
internal class VendorScannerSdk(appContext: Context, events: ScannerEvents) : ScannerSdk {
    private val handler: SDKHandler = processHandler(appContext, events)

    override fun setMode(mode: ScannerMode): ScannerResult = vendorResult("dcssdkSetOperationalMode($mode)") {
        handler.dcssdkSetOperationalMode(
            when (mode) {
                ScannerMode.DISABLED -> DCSSDK_MODE.DCSSDK_OPMODE_DISABLED
                ScannerMode.BT_NORMAL -> DCSSDK_MODE.DCSSDK_OPMODE_BT_NORMAL
            },
        )
    }

    override fun list(): List<ScannerCandidate> {
        val active = runCatching { handler.dcssdkGetActiveScannersList() }
            .onFailure { Log.w(ZebraBarcodeEngine.TAG, "The active scanner list threw.", it) }
            .getOrNull().orEmpty()
        val available = runCatching { handler.dcssdkGetAvailableScannersList() }
            .onFailure { Log.w(ZebraBarcodeEngine.TAG, "The available scanner list threw.", it) }
            .getOrNull().orEmpty()
        Log.i(ZebraBarcodeEngine.TAG, "The vendor lists ${active.size} active and ${available.size} available scanner(s).")
        return (active + available).map { it.toCandidate() }.distinctBy { it.scannerId }
    }

    override fun establish(scannerId: Int): ScannerResult = vendorResult("dcssdkEstablishCommunicationSession($scannerId)") {
        handler.dcssdkEstablishCommunicationSession(scannerId)
    }

    override fun terminate(scannerId: Int): ScannerResult = vendorResult("dcssdkTerminateCommunicationSession($scannerId)") {
        handler.dcssdkTerminateCommunicationSession(scannerId)
    }

    override fun pullTrigger(scannerId: Int): ScannerResult = command(DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_PULL_TRIGGER, scannerId)

    override fun releaseTrigger(scannerId: Int): ScannerResult = command(DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_RELEASE_TRIGGER, scannerId)

    private fun command(opCode: DCSSDK_COMMAND_OPCODE, scannerId: Int): ScannerResult {
        val outXml = StringBuilder()
        val result = vendorResult("$opCode for scanner $scannerId") {
            handler.dcssdkExecuteCommandOpCodeInXMLForScanner(opCode, scanCommandInXml(), outXml, scannerId)
        }
        if (outXml.isNotEmpty()) Log.i(ZebraBarcodeEngine.TAG, "$opCode answered \"$outXml\".")
        return result
    }

    private inline fun vendorResult(what: String, call: () -> DCSSDK_RESULT?): ScannerResult {
        val raw = call()
        Log.i(ZebraBarcodeEngine.TAG, "$what returned $raw.")
        return scannerResultOf(raw)
    }

    private companion object {
        private val lock = Any()
        private var shared: SDKHandler? = null

        @Volatile private var sink: ScannerEvents? = null

        private val forwarding = object : ScannerEvents {
            override fun sessionEstablished(scannerId: Int) {
                sink?.sessionEstablished(scannerId)
            }

            override fun sessionTerminated(scannerId: Int) {
                sink?.sessionTerminated(scannerId)
            }

            override fun barcode(bytes: ByteArray?, type: Int, scannerId: Int) {
                sink?.barcode(bytes, type, scannerId)
            }
        }

        private val EVENT_MASK = DCSSDK_EVENT.DCSSDK_EVENT_BARCODE.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SESSION_ESTABLISHMENT.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SESSION_TERMINATION.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SCANNER_APPEARANCE.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SCANNER_DISAPPEARANCE.value

        fun processHandler(appContext: Context, events: ScannerEvents): SDKHandler = synchronized(lock) {
            sink = events
            shared ?: SDKHandler(appContext, false).also { handler ->
                handler.dcssdkSetDelegate(scannerDelegate(forwarding, ::logVendorCallback))
                val subscribed = handler.dcssdkSubsribeForEvents(EVENT_MASK)
                Log.i(ZebraBarcodeEngine.TAG, "The scanner SDK is built for this process; events $EVENT_MASK subscribed: $subscribed.")
                shared = handler
            }
        }
    }
}

/** The vendor's result as one of the engine's five; everything else is a failure. */
internal fun scannerResultOf(raw: DCSSDK_RESULT?): ScannerResult = when (raw) {
    DCSSDK_RESULT.DCSSDK_RESULT_SUCCESS -> ScannerResult.SUCCESS
    DCSSDK_RESULT.DCSSDK_RESULT_SCANNER_ALREADY_ACTIVE -> ScannerResult.ALREADY_ACTIVE
    DCSSDK_RESULT.DCSSDK_RESULT_SCANNER_NOT_AVAILABLE -> ScannerResult.NOT_AVAILABLE
    DCSSDK_RESULT.DCSSDK_RESULT_SCANNER_NOT_ACTIVE -> ScannerResult.NOT_ACTIVE
    else -> ScannerResult.FAILURE
}

private fun logVendorCallback(message: String, t: Throwable?) {
    if (t == null) Log.i(ZebraBarcodeEngine.TAG, message) else Log.w(ZebraBarcodeEngine.TAG, message, t)
}

/**
 * The vendor's delegate. Its callbacks arrive on the vendor's threads (some
 * inside a vendor call), so every body catches everything and only hands
 * values on to [events]. A null or empty barcode array is dropped.
 */
internal fun scannerDelegate(events: ScannerEvents, log: (String, Throwable?) -> Unit): IDcsSdkApiDelegate =
    object : IDcsSdkApiDelegate {
        private fun guard(what: String, body: () -> Unit) {
            try {
                body()
            } catch (t: Throwable) {
                try {
                    log("The scanner callback \"$what\" threw; carrying on.", t)
                } catch (_: Throwable) {
                    // Nothing more can be done from a vendor thread.
                }
            }
        }

        override fun dcssdkEventScannerAppeared(scanner: DCSScannerInfo?) = guard("scanner appeared") {
            log("Scanner appeared: ${scanner.describe()}.", null)
        }

        override fun dcssdkEventScannerDisappeared(scannerId: Int) = guard("scanner disappeared") {
            log("Scanner disappeared: id $scannerId.", null)
        }

        override fun dcssdkEventCommunicationSessionEstablished(scanner: DCSScannerInfo?) = guard("session established") {
            log("Session established: ${scanner.describe()}.", null)
            events.sessionEstablished(scanner?.getScannerID() ?: UNKNOWN_SCANNER_ID)
        }

        override fun dcssdkEventCommunicationSessionTerminated(scannerId: Int) = guard("session terminated") {
            log("Session terminated: id $scannerId.", null)
            events.sessionTerminated(scannerId)
        }

        override fun dcssdkEventBarcode(barcode: ByteArray?, type: Int, fromScannerId: Int) = guard("barcode") {
            if (barcode == null || barcode.isEmpty()) {
                log("Dropped an empty barcode event from scanner $fromScannerId (type $type).", null)
            } else {
                events.barcode(barcode, type, fromScannerId)
            }
        }

        override fun dcssdkEventImage(image: ByteArray?, scannerId: Int) = Unit

        override fun dcssdkEventVideo(video: ByteArray?, scannerId: Int) = Unit

        override fun dcssdkEventBinaryData(data: ByteArray?, scannerId: Int) = Unit

        override fun dcssdkEventFirmwareUpdate(event: FirmwareUpdateEvent?) = Unit

        override fun dcssdkEventAuxScannerAppeared(auxScanner: DCSScannerInfo?, parentScanner: DCSScannerInfo?) = Unit
    }

/** The id the delegate passes on when the vendor's established callback names no scanner. */
private const val UNKNOWN_SCANNER_ID = -1

/** Log-friendly one-liner for a possibly-null [DCSScannerInfo]. */
private fun DCSScannerInfo?.describe(): String {
    if (this == null) return "null"
    return "id=${getScannerID()} name=${getScannerName()} model=${getScannerModel()} serial=${getScannerHWSerialNumber()}"
}

private fun DCSScannerInfo.toCandidate() =
    ScannerCandidate(scannerId = getScannerID(), name = getScannerName(), model = getScannerModel(), serial = getScannerHWSerialNumber())

/** What [chooseScanner] picks from: the plain fields of a `DCSScannerInfo`, with no vendor type, so the choice is testable. */
internal data class ScannerCandidate(val scannerId: Int, val name: String?, val model: String?, val serial: String?)

/**
 * The sled [chooseScanner] matches candidates against: the name, address and
 * serial of the RFID link's sled (`SledInfo`), with no vendor type.
 */
internal data class SledIdentity(val name: String?, val address: String?, val serial: String?)

/**
 * Strips `:`/`-`/whitespace separators and lowercases what's left, so two
 * representations of the same hardware token compare equal, e.g.
 * `"48:A4:93:BD:15:DB"` and `"48a493bd15db"`. Null in, null out, including
 * for a value that is all separators, so two absent fields never compare
 * equal.
 */
private fun normalizeSledToken(value: String?): String? =
    value?.replace(Regex("[:\\-\\s]"), "")?.lowercase()?.takeUnless { it.isEmpty() }

/**
 * Which listed scanner, if any, is this kiosk's own sled. A phone's pairing
 * list is evidence of pairing only: a field log showed a bare `firstOrNull()`
 * choosing a stranger's dive computer (`id=1 name=HSLT_a844`) over the
 * kiosk's RFD40 further down the list. So a candidate is trusted only when,
 * after [normalizeSledToken] on both sides, its `serial` equals the target's
 * address or serial. `serial` is the field to compare with an address: for a
 * classic-Bluetooth scanner, `DCSScannerInfo` has no address, and
 * `getScannerHWSerialNumber()` carries the Bluetooth MAC. The name is never
 * used to choose (it is not exact); it is logged only.
 *
 * Null (no session is tried with anyone) when nothing matches, when
 * [candidates] is empty, or when [target] has neither an address nor a
 * serial.
 */
internal fun chooseScanner(candidates: List<ScannerCandidate>, target: SledIdentity): ScannerCandidate? {
    val targetAddress = normalizeSledToken(target.address)
    val targetSerial = normalizeSledToken(target.serial)
    if (targetAddress == null && targetSerial == null) return null
    return candidates.firstOrNull { candidate ->
        val candidateSerial = normalizeSledToken(candidate.serial) ?: return@firstOrNull false
        (targetAddress != null && candidateSerial == targetAddress) ||
            (targetSerial != null && candidateSerial == targetSerial)
    }
}

/**
 * The XML body of the trigger commands: empty, since the pull and release
 * opcodes take no parameters and the scanner is addressed by its id
 * argument. One name, so a test can pin it.
 */
internal fun scanCommandInXml(): String = ""

/**
 * The class of the scanner SDK's Bluetooth reader thread: the private
 * `ConnectedThread` inside its `BluetoothManager`, one per scanner session.
 * [reapLeakedReaderThreads] and the connect dump know it by this name alone;
 * `ZebraVendorPinTest` pins that the bundled `.aar` has it and that it is a
 * `Thread`. The RFID SDK's own reader thread is another class, never matched.
 */
internal const val VENDOR_READER_THREAD = "com.zebra.scannercontrol.BluetoothManager\$ConnectedThread"

/** How long one reap may go on, shared by every leaked thread it found. */
internal const val REAP_BOUND_MS = 500L

/** One reap: the leaked threads [found], how many [reaped], how many [survivors] still run, in [elapsedMs]. */
internal data class ReapResult(val found: Int, val reaped: Int, val survivors: Int, val elapsedMs: Long)

/** Whether [thread] is one of the scanner SDK's reader threads ([VENDOR_READER_THREAD]). The reaper and the connect dump share this one test. */
internal fun isVendorReaderThread(thread: Thread): Boolean = thread.javaClass.name == VENDOR_READER_THREAD

/**
 * Stops the scanner SDK's leaked reader threads and says what it found.
 *
 * The vendor's reader thread loops while it is not interrupted. Each pass
 * polls its socket and then sleeps 50 ms inside a catch that swallows the
 * interrupt (it prints the stack trace), and the throw has already cleared
 * the flag. The vendor's own cancel interrupts once, which nearly always lands
 * in that sleep and is swallowed, and then closes the socket. So every session
 * the vendor closes leaves its thread polling a closed socket every 50 ms for
 * the life of the process (`available called on closed socket!` in the log).
 * The thread ends only when the flag is set at its loop check, and a steady
 * stream of interrupts does that: one wakes it from the sleep, and the next
 * lands while the catch prints.
 *
 * So every alive thread that [isVendorReader] accepts, never the calling one,
 * is interrupted again and again, with a yield between rounds, until it has
 * ended or [boundMs], shared by all of them, runs out. A yield, not a timed
 * wait: Android stretches short timed waits of a background process by tens of
 * milliseconds, and then each interrupt would land in a sleep again. A thread
 * that never ends (one blocked in a read) costs one bound of spinning on the
 * worker, then is left running and counted among the survivors. The default
 * clock is `System.nanoTime`, because `SystemClock` stands still in unit
 * tests and the bound would never run out.
 *
 * Run it only where no vendor reader thread is in use: on the scanner worker
 * while the engine holds no session, after the vendor has dropped its own
 * thread. Never `Thread.stop()`, and nothing reaches into vendor fields. It
 * never throws: when the threads cannot be listed or tested it finds none,
 * `ReapResult(0, 0, 0, …)`.
 */
internal fun reapLeakedReaderThreads(
    threads: () -> Collection<Thread> = { Thread.getAllStackTraces().keys },
    isVendorReader: (Thread) -> Boolean = ::isVendorReaderThread,
    boundMs: Long = REAP_BOUND_MS,
    now: () -> Long = { System.nanoTime() / 1_000_000L },
): ReapResult {
    var start = 0L
    var found: List<Thread> = emptyList()
    try {
        start = now()
        val self = Thread.currentThread()
        found = threads().filter { it !== self && it.isAlive && isVendorReader(it) }
        val running = found.toMutableList()
        while (running.isNotEmpty() && now() - start < boundMs) {
            running.forEach { it.interrupt() }
            Thread.yield()
            running.removeAll { !it.isAlive }
        }
    } catch (_: Throwable) {
        // Nothing to report from here; what has ended is counted below.
    }
    val reaped = found.count { !it.isAlive }
    val elapsed = try {
        now() - start
    } catch (_: Throwable) {
        0L
    }
    return ReapResult(found = found.size, reaped = reaped, survivors = found.size - reaped, elapsedMs = elapsed)
}

/**
 * The connect dump's line about the scanner SDK's reader threads: how many
 * are alive, by the reaper's own test. Never throws.
 */
internal fun vendorReaderThreadsDump(
    threads: () -> Collection<Thread> = { Thread.getAllStackTraces().keys },
    isVendorReader: (Thread) -> Boolean = ::isVendorReaderThread,
): String = try {
    "Dump: ${threads().count { it.isAlive && isVendorReader(it) }} vendor scanner reader thread(s) alive."
} catch (_: Throwable) {
    "Dump: the app's threads could not be listed, so the vendor scanner reader threads were not counted."
}
