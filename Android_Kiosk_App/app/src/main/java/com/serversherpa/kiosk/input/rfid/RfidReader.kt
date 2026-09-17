package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerPersonality
import com.serversherpa.kiosk.core.rfid.ScannerPluginMode
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
    /** A one-line, operator-facing note about something unusual that
     *  happened during the last connect attempt but wasn't a failure — for
     *  example, the reader holding a stale batch of stored tags that had to
     *  be discarded before it could connect. Null when there's nothing to
     *  say. Cleared at the start of every new connect attempt so a stale
     *  note from a previous attempt never lingers into the next one. */
    val connectNote: StateFlow<String?>
    /** EPCs, as the reader reported them. */
    val tags: Flow<String>
    val triggers: Flow<TriggerEvent>

    /** Connect to the reader. [triggerPersonality] and [scannerPluginMode] are
     *  `RfidSettings`' two connect-time-only knobs (see that class's doc):
     *  unlike every other field, [apply] never reads them — a real sled only
     *  lets its trigger personality and scanner-plugin flag be set while it
     *  is dialing in, not on a live settings push, so `RfidController` reads
     *  them off its own current settings right before calling this rather
     *  than folding them into [apply]'s push (see `RfidController`'s
     *  settings collector, and `ZebraRfidReader.configureTriggerMode` for
     *  how the Zebra implementation actually applies them). */
    suspend fun connect(triggerPersonality: RfidTriggerPersonality, scannerPluginMode: ScannerPluginMode): Result<Unit>
    suspend fun disconnect()
    suspend fun apply(settings: RfidSettings): Result<Unit>
    suspend fun startInventory(): Result<Unit>
    suspend fun stopInventory(): Result<Unit>

    /** The regions this reader allows and the one in force. A reader that
     *  reports none yields an empty list rather than a failure. */
    suspend fun regions(): Result<RfidRegions>

    /** Set the regulatory domain. `hopping` is applied only when the chosen
     *  region says hopping is configurable; pass null to leave it alone. */
    suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>
}
