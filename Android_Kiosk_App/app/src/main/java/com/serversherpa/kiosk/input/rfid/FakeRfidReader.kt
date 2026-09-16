package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * A reader with no hardware behind it. It drives every test, and the Developer
 * tab uses it to fire a synthetic burst so the live panel and the outbox commit
 * can be exercised on a phone with no sled.
 *
 * It ships in `main`, not `test`, for exactly that reason.
 */
class FakeRfidReader(name: String = "Fake RFD40") : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 256)
    override val tags: SharedFlow<String> = _tags

    private val _triggers = MutableSharedFlow<TriggerEvent>(extraBufferCapacity = 16)
    override val triggers: SharedFlow<TriggerEvent> = _triggers

    private val readerName = name

    /** The settings last handed to the reader, for a test to assert on. */
    var applied: RfidSettings? = null
        private set
    var inventoryRunning: Boolean = false
        private set
    var connectCalls: Int = 0
        private set

    /** Set these to make the next connect or apply fail. */
    var connectResult: Result<Unit> = Result.success(Unit)
    var applyResult: Result<Unit> = Result.success(Unit)

    override suspend fun connect(): Result<Unit> {
        connectCalls++
        _connection.value = RfidConnection.Connecting
        return connectResult.onSuccess { _connection.value = RfidConnection.Connected(readerName, 80) }
            .onFailure { _connection.value = RfidConnection.Failed(it.message ?: "Couldn't connect to the reader.") }
    }

    override suspend fun disconnect() {
        inventoryRunning = false
        _connection.value = RfidConnection.Disconnected
    }

    override suspend fun apply(settings: RfidSettings): Result<Unit> {
        if (_connection.value !is RfidConnection.Connected) {
            return Result.failure(IllegalStateException("Can't apply settings: the reader isn't connected."))
        }
        applied = settings
        return applyResult
    }

    override suspend fun startInventory(): Result<Unit> {
        if (_connection.value !is RfidConnection.Connected) {
            return Result.failure(IllegalStateException("Can't start an inventory: the reader isn't connected."))
        }
        inventoryRunning = true
        return Result.success(Unit)
    }

    // A sled that has just dropped no longer has an inventory to stop, and an
    // operator tapping "stop" after a disconnect shouldn't see an error — so
    // this is a harmless no-op rather than a failure when disconnected.
    override suspend fun stopInventory(): Result<Unit> {
        inventoryRunning = false
        return Result.success(Unit)
    }

    // ── what a test or the Developer tab drives ──
    // MutableSharedFlow buffers up to its extraBufferCapacity even with zero
    // subscribers, so tryEmit alone would only fail once that buffer fills —
    // it would stay silently green for the much more common "no collector
    // yet" case. Checking subscriptionCount first makes that case loud too.
    fun emitTrigger(event: TriggerEvent) {
        check(_triggers.subscriptionCount.value > 0) { "Dropped trigger event $event: nothing was collecting." }
        check(_triggers.tryEmit(event)) { "Dropped trigger event $event: nothing was collecting." }
    }
    fun emitTag(epc: String) {
        check(_tags.subscriptionCount.value > 0) { "Dropped tag $epc: nothing was collecting." }
        check(_tags.tryEmit(epc)) { "Dropped tag $epc: nothing was collecting." }
    }
    fun setConnection(c: RfidConnection) { _connection.value = c }
}
