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
import kotlinx.coroutines.launch

/**
 * Owns one reader. Turns trigger events into inventories using whichever
 * trigger mode is set, accumulates the burst, and emits the tags to queue when
 * it ends.
 *
 * It knows nothing about assets, the roster, or the outbox: it produces tag
 * values and stops there. `ScanViewModel` does the matching and the queueing,
 * so the RFID commit rules sit beside the barcode commit rules.
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

    @Volatile private var current: RfidSettings = DEFAULT_RFID_SETTINGS
    @Volatile private var armed: Boolean = false
    private var queued: Set<String> = emptySet()
    private var pressedAtMs: Long = 0L

    fun start() {
        scope.launch {
            settings.collect { s ->
                val changed = s != current
                current = s
                if (changed && reader.connection.value is RfidConnection.Connected) push(s)
            }
        }
        scope.launch { reader.triggers.collect { onTrigger(it) } }
        scope.launch { reader.tags.collect { onTag(it) } }
        scope.launch {
            reader.connection.collect { c ->
                // A burst cannot survive the reader going away: end it where it
                // stopped and queue what was read rather than losing it.
                if (c !is RfidConnection.Connected && _session.value != null) endBurst(stopReader = false)
            }
        }
    }

    /** Only the Scanning screen calls this, while it is composed. */
    fun arm() { armed = true }

    /** Leaving the screen ends any read in progress. Its tags are dropped: the
     *  screen that would queue them is gone. */
    fun disarm() {
        armed = false
        if (_session.value != null) {
            _session.value = null
            scope.launch { runCatching { reader.stopInventory() } }
        }
    }

    /** The Stop button, for a latched or toggled read. */
    fun stopBurst() { if (_session.value != null) scope.launch { endBurst(stopReader = true) } }

    suspend fun connectNow(): Result<Unit> {
        val result = reader.connect()
        if (result.isSuccess) push(current)
        return result
    }

    private suspend fun push(s: RfidSettings) {
        _applyError.value = reader.apply(s).exceptionOrNull()?.message?.takeIf { it.isNotBlank() }
    }

    suspend fun disconnectNow() {
        _session.value = null
        reader.disconnect()
    }

    private suspend fun onTrigger(event: TriggerEvent) {
        if (!armed) return
        val reading = _session.value != null
        val heldMs = if (event == TriggerEvent.RELEASED) clock() - pressedAtMs else 0L
        if (event == TriggerEvent.PRESSED) pressedAtMs = clock()
        when (nextTriggerAction(current.triggerMode, event, reading, heldMs)) {
            TriggerAction.START -> {
                _session.value = startSession(clock())
                runCatching { reader.startInventory() }
            }
            TriggerAction.STOP -> endBurst(stopReader = true)
            TriggerAction.NONE -> Unit
        }
    }

    private fun onTag(epc: String) {
        val open = _session.value ?: return
        _session.value = onTagRead(open, epc, queued, current.repeatPolicy)
    }

    private suspend fun endBurst(stopReader: Boolean) {
        val done = _session.value ?: return
        _session.value = null
        if (stopReader) {
            try { reader.stopInventory() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { /* the reader is already gone; the tags still count */ }
        }
        queued = queuedAfter(queued, done)
        _bursts.tryEmit(burstToScans(done))
    }
}
