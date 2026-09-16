package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidReadSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerAction
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.burstToScans
import com.serversherpa.kiosk.core.rfid.nextTriggerAction
import com.serversherpa.kiosk.core.rfid.onTagRead
import com.serversherpa.kiosk.core.rfid.queuedAfter
import com.serversherpa.kiosk.core.rfid.startSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Owns one reader. Turns trigger events into inventories using whichever
 * trigger mode is set, accumulates the burst, and emits the tags to queue when
 * it ends.
 *
 * It knows nothing about assets, the roster, or the outbox: it produces tag
 * values and stops there. `ScanViewModel` does the matching and the queueing,
 * so the RFID commit rules sit beside the barcode commit rules.
 *
 * `start()` launches four independent collectors (settings, triggers, tags,
 * connection) on `scope`, which in production is a real thread pool
 * (`Dispatchers.Default`), not a confined dispatcher — so every one of them
 * can run concurrently with every other, and with `arm()`/`disarm()`/
 * `stopBurst()`/`connectNow()`/`disconnectNow()` called from the UI thread.
 * All of the state those touch (`current`, `_session`, `armed`, `queued`,
 * `stoppingBurst`, `queueOnStop`) is therefore only ever read or written
 * under `mutex`, the same idiom `Outbox` uses for its own multi-writer state
 * — every access, not just the ones with something else nearby to protect,
 * since a field a lock only sometimes guards gives no happens-before edge to
 * the accesses that skip it.
 *
 * The one deliberate exception is `reader.stopInventory()` inside
 * [endBurst]: on real hardware that is a vendor round trip of tens of
 * milliseconds during which tags can still arrive, and holding `mutex`
 * across it would make `onTag` block until the burst was already claimed —
 * silently dropping the tail of every sweep. So ending a burst is done in
 * three steps: claim ownership of the stop under the lock (recorded in
 * `stoppingBurst`, so a second, concurrent caller does nothing but fold in
 * its own queue-or-discard preference), stop the reader with the lock
 * released so `onTag` stays free, then re-acquire the lock to claim the
 * session, update `queued`, and decide whether to emit.
 */
class RfidController(
    private val reader: RfidReader,
    private val settings: Flow<RfidSettings>,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    val connection: StateFlow<RfidConnection> = reader.connection

    private val _session = MutableStateFlow<RfidReadSession?>(null)
    /** Non-null only while a burst is running. The Scanning screen's live panel. */
    val session: StateFlow<RfidReadSession?> = _session

    private val _bursts = MutableSharedFlow<List<String>>(extraBufferCapacity = 16)
    /** One emission per finished burst: the tags to queue, in read order. */
    val bursts: SharedFlow<List<String>> = _bursts

    private val _applyError = MutableStateFlow<String?>(null)
    /** Why the reader refused the last settings push, for the RFID tab to show.
     *  Null once a push succeeds. */
    val applyError: StateFlow<String?> = _applyError

    /** Guards every state transition below: `current`, `armed`, `queued`,
     *  `stoppingBurst`/`queueOnStop`, and `_session`'s check-then-act moves.
     *  Serializing them is also what keeps `startInventory()` from
     *  overlapping a concurrent settings push or trigger decision on the
     *  radio. It is deliberately *not* held across `reader.stopInventory()`
     *  — see the class doc. */
    private val mutex = Mutex()
    private var current: RfidSettings = DEFAULT_RFID_SETTINGS
    private var armed: Boolean = false
    private var queued: Set<String> = emptySet()
    private var pressedAtMs: Long = 0L

    /** True while some caller owns stopping the current burst's reader —
     *  i.e. is between claiming ownership in [endBurst] and re-acquiring the
     *  lock afterward. Only that caller may call `reader.stopInventory()` or
     *  claim the session; every other concurrent [endBurst] call is a no-op
     *  beyond possibly downgrading [queueOnStop]. */
    private var stoppingBurst: Boolean = false

    /** Whether the burst currently being stopped should be queued once the
     *  stop finishes. Set by whichever caller claims ownership; any later
     *  caller that wants it discarded (e.g. `disarm()` racing a stop already
     *  in flight) may flip it to false, but never back to true — one caller
     *  wanting to keep the tags can't override another that wants them
     *  dropped. */
    private var queueOnStop: Boolean = false

    fun start() {
        scope.launch {
            settings.collect { s ->
                // The compare-and-write has to happen inside the lock, not
                // just the push: `current` is read by every other collector
                // and by onTrigger/onTag under `mutex`, so a write outside it
                // publishes with no happens-before edge to those readers. A
                // settings change made while disconnected (so `changed` is
                // true but nothing pushes) would otherwise sit unpublished
                // until something else happened to take the lock.
                val changed = mutex.withLock {
                    val c = s != current
                    current = s
                    c
                }
                if (changed && reader.connection.value is RfidConnection.Connected) {
                    mutex.withLock { push(s) }
                }
            }
        }
        scope.launch { reader.triggers.collect { onTrigger(it) } }
        scope.launch { reader.tags.collect { onTag(it) } }
        scope.launch {
            // Tracked locally rather than re-derived from reader.connection.value
            // at call time, so a battery-level update between two Connected
            // states is never mistaken for a fresh connection.
            var wasConnected = reader.connection.value is RfidConnection.Connected
            reader.connection.collect { c ->
                val nowConnected = c is RfidConnection.Connected
                if (!nowConnected) {
                    // A burst cannot survive the reader going away: end it where it
                    // stopped and queue what was read rather than losing it. The
                    // reader is already gone, so there is nothing left to stop.
                    endBurst(stopReader = false, queue = true)
                } else if (!wasConnected) {
                    // Push current settings on every transition into Connected,
                    // including a reconnect the sled did on its own — otherwise it
                    // is left running firmware defaults with nothing on screen
                    // saying so.
                    mutex.withLock { push(current) }
                }
                wasConnected = nowConnected
            }
        }
    }

    /** Only the Scanning screen calls this, while it is composed. */
    fun arm() {
        scope.launch {
            mutex.withLock {
                // `queued` is "what this visit to the screen already sent"; a
                // *new* visit starts that over, or a repeat-sweep policy
                // would drop every tag on the operator's next sweep forever.
                // But a re-arm within the same visit — a lifecycle-aware
                // collector re-firing, or a return from a dialog — must not
                // wipe the sweep history the operator is mid-visit through.
                if (!armed) queued = emptySet()
                armed = true
            }
        }
    }

    /** Leaving the screen ends any read in progress. Its tags are dropped: the
     *  screen that would queue them is gone. */
    fun disarm() {
        scope.launch {
            mutex.withLock { armed = false }
            endBurst(stopReader = true, queue = false)
        }
    }

    /** The Stop button, for a latched or toggled read. */
    fun stopBurst() {
        scope.launch { endBurst(stopReader = true, queue = true) }
    }

    suspend fun connectNow(): Result<Unit> = reader.connect()
    // Settings are pushed by the connection collector on the resulting
    // Connected transition, the same path a self-initiated reconnect uses —
    // so there is exactly one place this happens, not two racing to set
    // `applyError`.

    private suspend fun push(s: RfidSettings) {
        val result = reader.apply(s)
        _applyError.value = if (result.isFailure) {
            result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() }
                ?: "The reader refused the settings."
        } else {
            null
        }
    }

    suspend fun disconnectNow() {
        // An explicit disconnect still queues what was already read, the same
        // rule as an involuntary drop: the operator asked the reader to stop,
        // not for those tags to vanish.
        endBurst(stopReader = true, queue = true)
        reader.disconnect()
    }

    private suspend fun onTrigger(event: TriggerEvent) {
        var stopRequested = false
        mutex.withLock {
            if (!armed) return@withLock
            val reading = _session.value != null
            val heldMs = if (event == TriggerEvent.RELEASED) clock() - pressedAtMs else 0L
            if (event == TriggerEvent.PRESSED) pressedAtMs = clock()
            when (nextTriggerAction(current.triggerMode, event, reading, heldMs)) {
                TriggerAction.START -> {
                    _session.value = startSession(clock())
                    try {
                        reader.startInventory()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // The reader may already be gone; the session stays
                        // open and endBurst()'s own try/catch covers the stop.
                    }
                }
                // Deferred until the lock is released: endBurst() takes
                // `mutex` itself, and it must not hold it across
                // `reader.stopInventory()` (see the class doc), so it can't
                // be called from inside this block.
                TriggerAction.STOP -> stopRequested = true
                TriggerAction.NONE -> Unit
            }
        }
        if (stopRequested) endBurst(stopReader = true, queue = true)
    }

    private suspend fun onTag(epc: String) = mutex.withLock {
        val open = _session.value ?: return@withLock
        _session.value = onTagRead(open, epc, queued, current.repeatPolicy)
    }

    /**
     * Ends whatever burst is open, if any.
     *
     * Does not hold [mutex] across `reader.stopInventory()` — see the class
     * doc for why. The caller that finds a burst open and not already being
     * stopped claims ownership (`stoppingBurst = true`) and records whether
     * the result should be queued (`queueOnStop`); every other concurrent
     * caller sees `stoppingBurst` already true and returns without touching
     * the reader or the session, only possibly downgrading `queueOnStop` to
     * false (never back to true) if it wanted the burst discarded. That
     * keeps two racing enders to exactly one emission, a disconnect arriving
     * mid-stop from producing a second one, and a `disarm()` that lands
     * while another caller's stop is already in flight still discarding the
     * burst instead of letting it be queued.
     */
    private suspend fun endBurst(stopReader: Boolean, queue: Boolean) {
        val owns = mutex.withLock {
            if (_session.value == null) return@withLock false
            if (stoppingBurst) {
                if (!queue) queueOnStop = false
                return@withLock false
            }
            stoppingBurst = true
            queueOnStop = queue
            true
        }
        if (!owns) return

        if (stopReader) {
            try {
                reader.stopInventory()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // the reader is already gone; the tags still count
            }
        }

        val (done, shouldQueue) = mutex.withLock {
            val d = _session.getAndUpdate { null }
            val q = queueOnStop
            stoppingBurst = false
            if (d != null && q) queued = queuedAfter(queued, d)
            d to q
        }
        // Emitting outside the lock: a slow collector on `bursts` must not
        // stall trigger and tag handling for everyone else.
        if (done != null && shouldQueue) _bursts.emit(burstToScans(done))
    }
}
