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
        applied = settings
        return applyResult
    }

    override suspend fun startInventory(): Result<Unit> {
        inventoryRunning = true
        return Result.success(Unit)
    }

    override suspend fun stopInventory(): Result<Unit> {
        inventoryRunning = false
        return Result.success(Unit)
    }

    // ── what a test or the Developer tab drives ──
    fun emitTrigger(event: TriggerEvent) { _triggers.tryEmit(event) }
    fun emitTag(epc: String) { _tags.tryEmit(epc) }
    fun setConnection(c: RfidConnection) { _connection.value = c }
}
