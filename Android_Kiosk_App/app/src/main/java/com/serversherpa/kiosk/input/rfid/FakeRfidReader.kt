package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * A reader with no hardware behind it. It drives every test, and the Developer
 * tab uses it to drive the reader adapter — connect, a trigger press, tag
 * reads, trigger release — as a plumbing smoke test on a phone with no sled.
 * That burst never reaches the Scanning screen's live panel or the outbox:
 * `RfidController` only acts on triggers while armed, and only that screen
 * arms it.
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
        inventoryRunning = false
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

    /** What this fake claims to support. Set it in a test before connecting. */
    var reportedRegions: RfidRegions = RfidRegions(emptyList(), null)

    /** The last region a caller set, for a test to assert on. */
    var lastRegionSet: Pair<String, Boolean?>? = null
        private set

    /** Set this to make the next setRegion fail. */
    var regionResult: Result<Unit> = Result.success(Unit)

    override suspend fun regions(): Result<RfidRegions> {
        if (_connection.value !is RfidConnection.Connected) {
            return Result.failure(IllegalStateException("The reader is not connected."))
        }
        return Result.success(reportedRegions)
    }

    override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> {
        if (_connection.value !is RfidConnection.Connected) {
            return Result.failure(IllegalStateException("The reader is not connected."))
        }
        return regionResult.onSuccess {
            lastRegionSet = code to hopping
            reportedRegions = reportedRegions.copy(active = code)
        }
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
    fun setConnection(c: RfidConnection) {
        // A real sled cannot be running an inventory while disconnected, so clear
        // the flag whenever the connection is anything other than Connected.
        if (c !is RfidConnection.Connected) {
            inventoryRunning = false
        }
        _connection.value = c
    }
}
