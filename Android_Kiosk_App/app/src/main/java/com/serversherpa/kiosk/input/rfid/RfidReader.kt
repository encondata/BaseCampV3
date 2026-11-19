package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledTriggerReadback
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map

/** The constant flows behind the default members, shared by every reader that keeps a default. */
private val NO_INFO: StateFlow<SledInfo?> = MutableStateFlow<SledInfo?>(null).asStateFlow()
private val SCANNER_OFF: StateFlow<SledScannerState> = MutableStateFlow<SledScannerState>(SledScannerState.Off).asStateFlow()
private val ALWAYS_FALSE: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()

/**
 * Everything the app knows about an RFID reader. One implementation talks to
 * Zebra; the other is a fake. Nothing above this interface knows which it has,
 * which is what lets the whole feature be tested with no sled attached.
 *
 * All calls except [connect] and [disconnect] may be made from any coroutine
 * at any time; the reader queues them on its worker. A call made in the wrong
 * state returns `Result.failure(SledNotConnected())` without a vendor call,
 * and the controller shows nothing for it. Canceling a caller stops its wait
 * and never interrupts a vendor call.
 *
 * A connect failure is `Result.failure(SledConnectException(failed))` whose
 * `failed` equals the [RfidConnection.Failed] state just published, so its
 * message is that state's sentence.
 */
interface RfidReader {
    /** Only the reader writes it. [connect]: `Connecting`, then `Connected`,
     *  `NeedsRegion` or `Failed`. Link loss: `Failed(retryable = true)`,
     *  written only when the loss's generation is current and the state is
     *  `Connecting`, `Connected` or `NeedsRegion`. [disconnect] always ends
     *  `Disconnected`, from any state, idempotent. Nothing writes `Disabled`. */
    val connection: StateFlow<RfidConnection>

    /** A one-line, operator-facing note about something unusual the last
     *  connect handled on its own (for example, stored tags it cleared).
     *  Cleared at the start of each attempt. A note carried over from the
     *  previous attempt (the batch note) is set by the next successful
     *  connect after its own clear. */
    val connectNote: StateFlow<String?>

    /** Null at the start of each connect attempt and after [disconnect]. Set
     *  before `Connected` or `NeedsRegion` is published. Kept through a
     *  `Failed` caused by link loss. `trigger` is updated by
     *  [setTriggerLayout] and at connect. Default body: a constant null flow. */
    val info: StateFlow<SledInfo?> get() = NO_INFO

    /** `Off` whenever the link is not `Connected`, the layout in force does
     *  not use the scanner (`usesScanner()`), or the phone is a Zebra host;
     *  otherwise `Opening`, `Ready` or `Unavailable`. `Ready` only after
     *  establish returned `SUCCESS` and the stale window passed. `Off` at once
     *  on link loss and on [disconnect]. `Unavailable(BLUETOOTH_OFF)` is
     *  published only while the link is still `Connected`; it becomes `Off`
     *  when the link drop is recorded. Default: constant `Off`. */
    val scanner: StateFlow<SledScannerState> get() = SCANNER_OFF

    /** True while a batch-mode recovery runs inside the current attempt (the
     *  controller then extends its connect wait). Default: constant false. */
    val batchRecovery: StateFlow<Boolean> get() = ALWAYS_FALSE

    /** What [setVendorLogging] last set (false at process start). The
     *  Developer switch shows it, so it stays right after the tab recomposes.
     *  Default: constant false. */
    val vendorLogging: StateFlow<Boolean> get() = ALWAYS_FALSE

    /** EPCs, as the reader reported them. Delivered on a coroutine
     *  dispatcher, never on a vendor thread, and only for the current
     *  generation. */
    val tags: Flow<String>

    /** The trigger's presses and releases, kept for existing doubles; a
     *  reader that stamps its events delivers them on [pulls] too. Delivered
     *  on a coroutine dispatcher, never on a vendor thread, and only for the
     *  current generation. */
    val triggers: Flow<TriggerEvent>

    /** Trigger events with the time each arrived. A reader stamps every pull
     *  or none; the controller uses `atMs ?: clock()`. Delivered on a
     *  coroutine dispatcher, never on a vendor thread, and only for the
     *  current generation. Default: [triggers] mapped with `atMs = null`. */
    val pulls: Flow<TriggerPull> get() = triggers.map { TriggerPull(it, null) }

    /** Emitted only while [scanner] is `Ready` for the current generation.
     *  Value already decoded and trimmed. Backed by a shared flow with a
     *  buffer of at least 16 (the delegate uses `tryEmit` from a vendor
     *  thread); a failed `tryEmit` is logged. Default: empty flow. */
    val barcodes: Flow<SledBarcode> get() = emptyFlow()

    /** A sweep the sled ended without being asked. The string is a reason
     *  for the log, never shown (ruling 45). Emitted after the same tag wait
     *  a requested stop uses. Default: empty flow. */
    val unsolicitedStops: Flow<String> get() = emptyFlow()

    /** Success when the link is up (`Connected` or `NeedsRegion`). Never
     *  called concurrently with itself or [disconnect] (the controller's
     *  `linkGate`). Tears down a stale link first. Failure carries the same
     *  sentence as `Failed.reason`: a [SledConnectException] whose `failed`
     *  is the state just published. */
    suspend fun connect(request: SledConnectRequest): Result<Unit>

    /** Bumps the generation and publishes `Disconnected` first, then tears
     *  down on the worker. Never throws. */
    suspend fun disconnect()

    /** Needs `Connected`. Tries every step; a refusal does not stop the push;
     *  link trouble does. The failure message is a `SledWords` sentence
     *  naming what was refused. */
    suspend fun apply(settings: RfidSettings): Result<Unit>

    /** Needs `Connected`. Follows the `perform()` outcome table: success for
     *  "started" and "sent, not confirmed"; failure with a sentence
     *  otherwise. */
    suspend fun startInventory(): Result<Unit>

    /** Needs `Connected` (otherwise [SledNotConnected], which the controller
     *  reads as "nothing to stop"). Success when nothing was running. Returns
     *  after the tag wait. */
    suspend fun stopInventory(): Result<Unit>

    /** The regions this reader allows and the one in force; a reader that
     *  reports none yields an empty list rather than a failure. Needs
     *  `Connected` or `NeedsRegion`. */
    suspend fun regions(): Result<RfidRegions>

    /** Set the regulatory domain; `hopping` applies only when the picked
     *  region says hopping is configurable (null leaves it alone). Needs
     *  `Connected` or `NeedsRegion`. Never reconnects. */
    suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit>

    /** Needs `Connected`. Writes the effective layout. Success carries the
     *  read-back even when it differs from the request. A read-back that
     *  could not be accepted is a failure with "Couldn't check the sled's
     *  trigger setting." and leaves `info.trigger` null. Opens or closes the
     *  scanner session to match the layout in force (`usesScanner()`) and
     *  returns without waiting for it. Default:
     *  `Result.failure(SledNotConnected())`. */
    suspend fun setTriggerLayout(layout: SledTriggerLayout): Result<SledTriggerReadback> =
        Result.failure(SledNotConnected())

    /** Fire-and-forget; the answer arrives as `Connected.batteryPct`. Does
     *  nothing unless `Connected`. One gated block with its consuming read.
     *  Default: does nothing. */
    suspend fun requestBattery() {}

    /** The sled's Scan button: pull ([pull] true) or release the scanner's
     *  trigger. Fails unless [scanner] is `Ready`. A failed pull sets
     *  `Unavailable(DID_NOT_START)`. Default:
     *  `Result.failure(SledNotConnected())`. */
    suspend fun softScan(pull: Boolean): Result<Unit> = Result.failure(SledNotConnected())

    /** The Try again button: terminate, then establish once. Needs
     *  `Connected` and a layout that uses the scanner; fails at once in
     *  `STOPPED_RESPONDING` (the worker is stuck). Default:
     *  `Result.failure(SledNotConnected())`. */
    suspend fun retryScanner(): Result<Unit> = Result.failure(SledNotConnected())

    /** Android's bonded list only, by name prefix `RFD40`, `RFD90`,
     *  `RFD8500`. Never builds a `Readers`. Empty when Bluetooth is off or
     *  Nearby devices is not granted (`RfidPermissions.nearbyGranted`). Safe
     *  in any state, on any thread. Default: `emptyList()`. */
    fun pairedSleds(): List<SledCandidate> = emptyList()

    /** Turns the vendor's wire logging on or off. Process-wide, not saved.
     *  The Developer tab calls it and imports no `com.zebra`. Default body
     *  does nothing. */
    fun setVendorLogging(on: Boolean) {}
}
