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
 * All of the state those touch (`_session`, `armed`, `queued`) is therefore
 * only ever read or written under `mutex`, the same idiom `Outbox` uses for
 * its own multi-writer state.
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

    /** Guards every state transition below: `current`, `armed`, `queued`, and
     *  `_session`'s check-then-act moves. Serializing them is also what keeps
     *  `startInventory()`/`stopInventory()` from overlapping on the radio. */
    private val mutex = Mutex()
    private var current: RfidSettings = DEFAULT_RFID_SETTINGS
    private var armed: Boolean = false
    private var queued: Set<String> = emptySet()
    private var pressedAtMs: Long = 0L

    fun start() {
        scope.launch {
            settings.collect { s ->
                val changed = s != current
                current = s
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
                    mutex.withLock { endBurst(stopReader = false, queue = true) }
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
                armed = true
                // `queued` is "what this visit to the screen already sent"; a new
                // visit starts that over, or a repeat-sweep policy would drop
                // every tag on the operator's next sweep forever.
                queued = emptySet()
            }
        }
    }

    /** Leaving the screen ends any read in progress. Its tags are dropped: the
     *  screen that would queue them is gone. */
    fun disarm() {
        scope.launch {
            mutex.withLock {
                armed = false
                endBurst(stopReader = true, queue = false)
            }
        }
    }

    /** The Stop button, for a latched or toggled read. */
    fun stopBurst() {
        scope.launch { mutex.withLock { endBurst(stopReader = true, queue = true) } }
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
        mutex.withLock { endBurst(stopReader = true, queue = true) }
        reader.disconnect()
    }

    private suspend fun onTrigger(event: TriggerEvent) = mutex.withLock {
        if (!armed) return@withLock
        val reading = _session.value != null
        val heldMs = if (event == TriggerEvent.RELEASED) clock() - pressedAtMs else 0L
        if (event == TriggerEvent.PRESSED) pressedAtMs = clock()
        when (nextTriggerAction(current.triggerMode, event, reading, heldMs)) {
            TriggerAction.START -> {
                _session.value = startSession(clock())
                runCatching { reader.startInventory() }
            }
            TriggerAction.STOP -> endBurst(stopReader = true, queue = true)
            TriggerAction.NONE -> Unit
        }
    }

    private suspend fun onTag(epc: String) = mutex.withLock {
        val open = _session.value ?: return@withLock
        _session.value = onTagRead(open, epc, queued, current.repeatPolicy)
    }

    /**
     * Ends whatever burst is open, if any. Caller holds [mutex].
     *
     * Stops the reader (when asked) *before* claiming the session: on real
     * hardware `stopInventory()` is a vendor round trip of tens of
     * milliseconds during which tags can still arrive, and claiming first
     * would have `onTag` drop every one of them as belonging to no session.
     * The claim itself is `getAndUpdate { null }` so exactly one caller — even
     * one racing in from another thread before this suspend fun's caller took
     * the lock — ever gets `done` and emits it.
     */
    private suspend fun endBurst(stopReader: Boolean, queue: Boolean) {
        if (_session.value == null) return
        if (stopReader) {
            try { reader.stopInventory() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { /* the reader is already gone; the tags still count */ }
        }
        val done = _session.getAndUpdate { null } ?: return
        if (queue) {
            queued = queuedAfter(queued, done)
            _bursts.emit(burstToScans(done))
        }
    }
}
