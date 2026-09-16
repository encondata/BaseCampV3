package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Everything the app knows about an RFID reader. One implementation talks to
 * Zebra; the other is a fake. Nothing above this interface knows which it has,
 * which is what lets the whole feature be tested with no sled attached.
 *
 * Implementations must deliver `tags` and `triggers` on a normal coroutine
 * dispatcher, never on a vendor callback thread.
 */
interface RfidReader {
    val connection: StateFlow<RfidConnection>
    /** EPCs, as the reader reported them. */
    val tags: Flow<String>
    val triggers: Flow<TriggerEvent>

    suspend fun connect(): Result<Unit>
    suspend fun disconnect()
    suspend fun apply(settings: RfidSettings): Result<Unit>
    suspend fun startInventory(): Result<Unit>
    suspend fun stopInventory(): Result<Unit>
}
