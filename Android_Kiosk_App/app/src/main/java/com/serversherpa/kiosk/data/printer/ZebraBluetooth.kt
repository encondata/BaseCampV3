package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.ZebraBluetoothSpec
import java.io.ByteArrayOutputStream
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

// --- What the screens see ---

/** Whether the device can use Bluetooth LE right now. [LOCATION_OFF] stops scans (Android drops
 *  their results while Location is off); a printer whose address is known is still reached without one. */
enum class BluetoothAvailability { UNKNOWN, READY, POWERED_OFF, UNAUTHORIZED, LOCATION_OFF, UNSUPPORTED }

/** A named device a scan heard ([name] from its scan record). */
data class FoundBluetoothPrinter(val address: String, val name: String, val rssi: Int, val advertisesZebra: Boolean) {
    /** Flagged as a Zebra: it advertises Zebra, or its name is a Zebra serial (D9). */
    val isZebra: Boolean get() = advertisesZebra || ZebraBluetoothSpec.looksLikeZebraSerial(name)
}

/** What the printer's Device Information said when the link came up. */
data class BluetoothPrinterInfo(
    val address: String,
    val manufacturer: String?,
    val model: String?,
    val serial: String?,
    val firmware: String?,
    val linkOs: String?,
)

/** The last time the link went down on its own (the printer, the radio, or a send that ran out
 *  of time), and why. */
data class BluetoothDrop(val atMs: Long, val reason: String)

/** Why a screen's scan ended, for its words: only a scan that ran its full length (counted once
 *  Bluetooth was ready and the radio scanned) or was stopped can say nothing was found. */
enum class BluetoothScanEnd {
    /** It ran its full `SCAN_MS` with Bluetooth ready. */
    FINISHED,
    /** [BluetoothPrinting.stopScan] (the screen's Stop). */
    STOPPED,
    /** A connect, write or query took the radio (a label going out, say). */
    INTERRUPTED,
    /** [BluetoothPrinting.close]: the app went to the background, signed out, or the saved printer changed. */
    CLOSED,
    /** Bluetooth is off, not allowed or missing, or Location is off (a scan needs it). */
    REFUSED,
    /** A newer scan started. */
    REPLACED,
    /** Android wouldn't scan: it refused to start one, or ended it with an error (too many scans in
     *  a short time, say). */
    FAILED,
}

/** One thing that happened to the Bluetooth link (Bluetooth's state, a connect's phases, a drop, a
 *  retry), for the Troubleshooting report's log (D13). [atMs] is the link's clock's. */
data class BluetoothLinkEvent(val atMs: Long, val text: String)

/** The one link, for the connection details. [info], [chunkBytes], [mtu] and [savedAddress] stay
 *  from the last link once it is down. Times are the clock's (wall-clock milliseconds on the
 *  device). [savedAddress] is the address the printer was asked for at (the saved one) when the
 *  link came up at another one ([BluetoothPrinterInfo.address]: found by its serial, or at the
 *  address an earlier link used); null when they match or none was given. It is never saved. */
data class BluetoothLinkInfo(
    val connected: Boolean = false,
    val info: BluetoothPrinterInfo? = null,
    val chunkBytes: Int? = null,
    val mtu: Int? = null,
    val connectedAtMs: Long? = null,
    val lastActivityMs: Long? = null,
    val lastDrop: BluetoothDrop? = null,
    val savedAddress: String? = null,
)

/** The link is up to [printer], a saved Bluetooth printer, by its confirmed serial. */
fun BluetoothLinkInfo.isUpTo(printer: SavedPrinter?): Boolean {
    val connection = printer?.connection as? PrinterConnection.Bluetooth ?: return false
    return connected && info?.serial.equals(connection.serial, ignoreCase = true)
}

/** What Printer Setup and Troubleshooting use of [ZebraBluetooth] (so their tests can fake it). */
interface BluetoothPrinting {
    val availability: StateFlow<BluetoothAvailability>
    val link: StateFlow<BluetoothLinkInfo>

    /** Why the last scan ended (set before its flow completes); null before any scan. */
    val lastScanEnd: BluetoothScanEnd?

    /** What happened to the link, oldest first (the newest `ZebraBluetooth.EVENT_CAP` are kept). */
    val events: List<BluetoothLinkEvent>

    /** Every named device nearby, Zebras first, refreshed as the scan hears them; ends after
     *  `SCAN_MS` of scanning (counted from when Bluetooth is ready and the radio scans, so a scan
     *  asked while Bluetooth is turning on waits for it), on [stopScan], when another scan starts,
     *  when Bluetooth stops, on [close], or when a connect, write or query starts. Ends at once when
     *  [availability] refuses a scan. [lastScanEnd] says which. */
    fun scan(): Flow<List<FoundBluetoothPrinter>>
    fun stopScan()

    /** Connects to the printer (by [address], else by scanning for [serial]) or returns the link
     *  already up to it. */
    suspend fun connect(address: String?, serial: String?): BluetoothPrinterInfo

    /** Reads [availability] again (after a permission prompt, say: no broadcast says so). */
    fun refreshAvailability()

    /** Ends the scan and lets the printer go (see [ZebraBluetooth.close]). */
    fun close()
}

/**
 * The app's Bluetooth LE side for Zebra printers: Bluetooth's availability, the scan, and the one
 * link to a printer, which stays up while the app is in use (D4). The sequencing is the iOS spike's
 * (branch ble-spike), which printed to and queried a real ZD421, on Android's GATT.
 *
 * - **Connecting** tries the saved address first (D3), then, when it differs, the address the last
 *   link to this serial used this run (never saved). The addresses share `ADDRESS_TRY_MS`; if
 *   neither comes up, the rest of `CONNECT_READY_MS` scans for the name equal to the serial, and a
 *   printer heard gets a fresh `CONNECT_READY_MS` for the connect itself (D7's 10 s count from the
 *   connect; the search had its own). A link up at another address than the one the call carries
 *   says so in `link.savedAddress`. A call queued behind a connect for its printer shares that
 *   connect's outcome (a label queued during a warm-up that fails fails with it). Ready once:
 *   1. services are discovered (a device without Zebra's parser service is [BluetoothNotZebra]);
 *   2. Device Information is read, one value at a time, each waited for `DEVICE_INFO_READ_MS`;
 *   3. the MTU is requested (`REQUESTED_MTU`; 20-byte chunks when it fails);
 *   4. indications on From Printer Data are on (the CCCD write).
 *   Then it asks for a high connection priority. A manufacturer other than "Zebra Technologies" is
 *   [BluetoothNotZebra], and a serial other than the expected one is [BluetoothSerialMismatch]
 *   (before anything is turned on).
 * - **One GATT operation at a time:** each link's operations go through its [GattQueue], which
 *   issues the next only after Android answers the last.
 * - **Failures.** A first connect that never comes up fails ([BluetoothPairingLost] for a pairing
 *   status, else [PrinterUnreachable]); a failed connect always closes its GATT. A link that came up
 *   and dropped before Ready is retried at most `RECONNECT_TRIES` times, `RECONNECT_SPACING_MS`
 *   apart, each with its own `CONNECT_READY_MS`, never after a lost pairing (D10). A drop after Ready
 *   fails the write or query in flight at once, is kept as `link.lastDrop`, and nothing reconnects
 *   until the next call needs the printer (D4).
 * - **Calls** ([BluetoothZebra]) take turns, in the order asked; each reconnects first when the link
 *   is down and ends any scan. A write goes in acknowledged chunks of `chunkBytes(mtu)`, within
 *   `sendBudgetMs` (it can't hang a caller that can't cancel it); a query drains late bytes, writes,
 *   and reads indications until the reply is whole, `QUERY_IDLE_MS` after its last byte, or
 *   `QUERY_TOTAL_MS`.
 * - **[close]** (background, sign-out, a printer change) ends the scan; fails a connect in progress,
 *   a query in flight and every call waiting for its turn; and lets a write already going out (a
 *   label, test label or font) finish within its budget before the link closes.
 * - **[events]** logs what happened to the link (Bluetooth's state, each connect's phases and
 *   times, the chunk size, drops, retries, pairing errors) for the Troubleshooting report: the
 *   app's own words plus an address or serial, never a reply's bytes.
 *
 * Threading: every bit of state lives on one dispatcher, [scope]'s own limited to one coroutine at
 * a time (any dispatcher but `Unconfined`; the container's `Dispatchers.Default` scope is fine).
 * Android's callbacks arrive on binder threads and are queued onto it in order; each deferred is
 * completed once, there. Timers run on [scope]'s dispatcher (virtual time in tests); [clock] stamps
 * the times shown in [link]. Progress callbacks are called on that dispatcher.
 */
class ZebraBluetooth(
    private val client: BluetoothLeClient,
    scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Why something went wrong inside the link, for the device log. */
    private val log: (String, Throwable) -> Unit = { message, e -> android.util.Log.w(TAG, message, e) },
) : BluetoothPrinting {
    private val confined: CoroutineDispatcher =
        ((scope.coroutineContext[ContinuationInterceptor] as? CoroutineDispatcher) ?: Dispatchers.Default).limitedParallelism(1)
    private val inner = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]) + confined)
    private val eventQueue = Channel<Event>(Channel.UNLIMITED)

    private val availabilityState = MutableStateFlow(client.availability())
    private val linkState = MutableStateFlow(BluetoothLinkInfo())
    override val availability: StateFlow<BluetoothAvailability> = availabilityState.asStateFlow()
    override val link: StateFlow<BluetoothLinkInfo> = linkState.asStateFlow()

    // The link, and the connect in progress.
    private var phase = Phase.IDLE
    private var current: Link? = null
    private var linkIds = 0
    /** The name errors carry: the serial asked for (or found). */
    private var host = ""
    private var attempt: Deferred<BluetoothPrinterInfo>? = null
    private var abortReason: Throwable? = null
    /** Where the connect in progress is, for its deadline's error. */
    private var stage = Stage.WAITING
    private var availabilityWaiter: CompletableDeferred<Unit>? = null
    private var finding: Finding? = null
    /** Numbers each connect, and what the last one that failed was for: a call that queued behind
     *  it for the same printer shares that failure instead of connecting again. */
    private var attempts = 0
    private var attemptTarget: BluetoothTarget? = null
    private var lastFailure: AttemptFailure? = null
    /** The connect the call about to run queued behind (set by [withTurn] for its body). */
    private var joinedAttempt: Int? = null
    /** When the connect in progress started: the event log times its phases from it. */
    private var connectStartedMs = 0L

    // Calls.
    private var turnTaken = false
    private val turnWaiters = ArrayDeque<TurnWaiter>()
    /** A write (not a query) is going out: [close] lets it finish. */
    private var writing = false
    private var closeAfterWrite = false

    // The event log (read from any thread).
    private val eventLog = ArrayDeque<BluetoothLinkEvent>()
    override val events: List<BluetoothLinkEvent> get() = synchronized(eventLog) { eventLog.toList() }
    /** The state the log last noted: it is noted when it changes, not each time it is read. */
    private var notedState: BluetoothAvailability? = null

    // Replies.
    private val rx = ByteArrayOutputStream()
    private var collecting = false
    private var reply: ReplyWait? = null
    /** Running while a byte arrived within the last `DRAIN_QUIET_MS`. */
    private var quietTimer: Job? = null
    private var drainWaiter: CompletableDeferred<Unit>? = null

    // Scanning.
    private var scanning = false
    private var uiScan: UiScan? = null
    private var scanIds = 0
    @Volatile override var lastScanEnd: BluetoothScanEnd? = null
        private set

    init {
        noteState(availabilityState.value)
        client.listen { eventQueue.trySend(Event.Client(it)) }
        inner.launch {
            for (event in eventQueue) {
                try {
                    handle(event)
                } catch (e: RuntimeException) {
                    // One bad event must not stop the link hearing the rest (its calls are bounded anyway).
                    log("a Bluetooth event couldn't be handled: $event", e)
                }
            }
        }
    }

    // --- Public ---

    override fun scan(): Flow<List<FoundBluetoothPrinter>> = callbackFlow {
        val id = withContext(confined) { startUiScan(channel) }
        awaitClose { inner.launch { uiScanAbandoned(id) } }
    }.buffer(Channel.CONFLATED)

    override fun stopScan() {
        inner.launch { endUiScan(BluetoothScanEnd.STOPPED) }
    }

    override fun refreshAvailability() {
        inner.launch { availabilityChanged() }
    }

    override suspend fun connect(address: String?, serial: String?): BluetoothPrinterInfo = withContext(confined) {
        withTurn(serial ?: address.orEmpty()) { ensureReady(BluetoothTarget(address, serial)) }
    }

    /** The transport for a saved Bluetooth printer (its serial, and the address it was saved with).
     *  Callers pick the transport by `printer.connection`: a network printer is refused
     *  (IllegalArgumentException), so it can never be looked for over Bluetooth. */
    fun transport(printer: SavedPrinter): BluetoothZebra {
        val connection = printer.connection
        require(connection is PrinterConnection.Bluetooth) { "${printer.serial} is a network printer; use NetworkZebra" }
        return BluetoothZebra(this, connection.serial, connection.address)
    }

    /** Ends the scan and the link (the app went to the background, signed out, or the saved printer
     *  changed): the connect or query in flight and every call waiting for its turn fail with
     *  [PrinterUnreachable] (none of them reconnects); a write already going out finishes within its
     *  budget, then the link closes. Nothing reconnects until the next call. */
    override fun close() {
        inner.launch { closeNow() }
    }

    // --- Calls (BluetoothZebra) ---

    /** Writes [parts] as one job, reconnecting first when the link is down. [progress] hears
     *  `(0, total)` once the first chunk is about to go out, then the bytes acknowledged so far. */
    internal suspend fun write(target: BluetoothTarget, parts: List<ByteArray>, progress: WriteProgress?) = withContext(confined) {
        withTurn(target.serial.orEmpty()) {
            ensureReady(target)
            endUiScan(BluetoothScanEnd.INTERRUPTED)
            writing = true
            try {
                send(concat(parts), progress)
            } finally {
                writing = false
                if (closeAfterWrite) {
                    closeAfterWrite = false
                    endLink(PrinterUnreachable(host))
                }
            }
        }
    }

    /** Sends [command] and reads the reply, Latin-1; [PrinterNoReply] when nothing came back. */
    internal suspend fun query(target: BluetoothTarget, command: String, complete: (ByteArray) -> Boolean): String =
        withContext(confined) {
            withTurn(target.serial.orEmpty()) {
                ensureReady(target)
                endUiScan(BluetoothScanEnd.INTERRUPTED)
                drain()
                rx.reset()
                collecting = true
                try {
                    send(command.toByteArray(Charsets.UTF_8), null)
                    val answer = collectReply(complete)
                    if (answer.isEmpty()) throw PrinterNoReply(host)
                    String(answer, Charsets.ISO_8859_1)
                } finally {
                    collecting = false
                }
            }
        }

    // --- Turns ---

    /** Runs [body] once every earlier call's body has finished, in the order asked. A call still
     *  waiting when [close] runs fails with [PrinterUnreachable] naming [name]; one canceled while
     *  it waits leaves the line. A call that queued behind a connect in progress is told which
     *  ([joinedAttempt]), so it can share that connect's failure ([ensureReady]). */
    private suspend fun <T> withTurn(name: String, body: suspend () -> T): T {
        var joined: Int? = null
        if (turnTaken) {
            val waiter = TurnWaiter(name)
            joined = attempts.takeIf { attempt != null }
            turnWaiters.addLast(waiter)
            try {
                waiter.turn.await()
            } catch (e: Throwable) {
                // Handed the turn just as it was canceled: pass it on.
                if (!turnWaiters.remove(waiter) && waiter.handed) passTurn()
                throw e
            }
        } else {
            turnTaken = true
        }
        try {
            currentCoroutineContext().ensureActive()
            joinedAttempt = joined
            return body()
        } finally {
            joinedAttempt = null
            passTurn()
        }
    }

    private fun passTurn() {
        while (turnWaiters.isNotEmpty()) {
            val next = turnWaiters.removeFirst()
            if (next.turn.complete(Unit)) {
                next.handed = true
                return
            }
        }
        turnTaken = false
    }

    // --- Connecting ---

    /** The ready link to [target], or a new one: the connect runs as its own job, so [close] or
     *  Bluetooth going off can end it whatever the caller is. A call that queued behind a connect
     *  for this printer that failed meanwhile shares that failure (a label queued during a warm-up
     *  that fails fails with it, at `CONNECT_READY_MS`, not a whole connect later). */
    private suspend fun ensureReady(target: BluetoothTarget): BluetoothPrinterInfo {
        val joined = joinedAttempt
        joinedAttempt = null
        val up = current
        if (phase == Phase.READY && up != null && matches(up, target)) {
            // The address this call carries (the saved one) against the link's is the mismatch
            // record Troubleshooting shows: a printer chosen again at the address it answers at has none.
            if (target.address != null) {
                linkState.update { it.copy(savedAddress = target.address.takeUnless { saved -> saved.equals(up.address, ignoreCase = true) }) }
            }
            return up.info!!
        }
        lastFailure?.let { failed -> if (joined == failed.id && sameTarget(failed.target, target)) throw failed.error }
        if (phase == Phase.READY) endLink(PrinterUnreachable(host)) // one link at a time
        phase = Phase.CONNECTING
        val id = ++attempts
        attemptTarget = target
        val job = inner.async { establish(target) }
        attempt = job
        try {
            return job.await().also { lastFailure = null }
        } catch (e: CancellationException) {
            abortReason?.let { throw connectFailed(id, target, it) }
            job.cancel()
            throw e
        } catch (e: Exception) {
            throw connectFailed(id, target, e)
        } finally {
            attempt = null
            attemptTarget = null
            abortReason = null
            if (phase == Phase.CONNECTING) phase = Phase.IDLE
        }
    }

    /** The connect [id] for [target] failed with [error]: noted for the log and for the calls that
     *  queued behind it. */
    private fun connectFailed(id: Int, target: BluetoothTarget, error: Throwable): Throwable {
        lastFailure = AttemptFailure(id, target, error)
        note("Connect to ${host.ifEmpty { "the printer" }} failed after ${sinceConnect()} s: ${eventText(error)}")
        return error
    }

    private suspend fun establish(target: BluetoothTarget): BluetoothPrinterInfo {
        host = target.serial ?: target.address.orEmpty()
        connectStartedMs = clock()
        note("Connect to ${host.ifEmpty { "a printer" }} started")
        // The saved address first (D3), then the one the last link to this serial used, if it differs.
        val known = knownAddress(target.serial)?.takeUnless { it.equals(target.address, ignoreCase = true) }
        val addresses = listOfNotNull(target.address, known)
        var step: Step = Step.Locate
        var retriesUsed = 0
        while (true) {
            stage = Stage.WAITING
            val outcome = withTimeoutOrNull(ZebraBluetoothSpec.CONNECT_READY_MS) {
                try {
                    Outcome.Ready(
                        when (val s = step) {
                            Step.Locate -> firstTry(target, addresses)
                            is Step.Connect -> reconnect(target, s.address)
                        },
                    )
                } catch (e: HeardLate) {
                    Outcome.Heard(e.address)
                } catch (e: NeverConnected) {
                    Outcome.NeverUp(e)
                } catch (e: DroppedBeforeReady) {
                    Outcome.Dropped(e)
                }
            } ?: run {
                note("No link within ${ZebraBluetoothSpec.CONNECT_READY_MS / 1_000} s (still ${stageText()})")
                throw deadlineError()
            }
            when (outcome) {
                is Outcome.Ready -> return outcome.info
                is Outcome.Heard -> {
                    // The connect gets its own CONNECT_READY_MS from the sighting: D7's 10 s count
                    // from the connect, and the search kept its own until now.
                    step = Step.Connect(outcome.address)
                    continue
                }
                is Outcome.NeverUp -> {
                    note("Connect failed: ${outcome.error.message}")
                    if (outcome.error.pairingLost) throw BluetoothPairingLost(host)
                    if (retriesUsed == 0) throw PrinterUnreachable(host)
                    // A reconnect that failed counts as one of the drop's tries.
                }
                is Outcome.Dropped -> {
                    recordDrop(outcome.error.reason)
                    note("Dropped before ready: ${outcome.error.reason}")
                    if (outcome.error.pairingLost) throw BluetoothPairingLost(host)
                    step = Step.Connect(outcome.error.address)
                }
            }
            retriesUsed++
            if (retriesUsed > ZebraBluetoothSpec.RECONNECT_TRIES) throw PrinterUnreachable(host)
            note("Reconnect try $retriesUsed of ${ZebraBluetoothSpec.RECONNECT_TRIES} in ${ZebraBluetoothSpec.RECONNECT_SPACING_MS / 1_000} s")
            stage = Stage.RETRYING
            delay(ZebraBluetoothSpec.RECONNECT_SPACING_MS)
        }
    }

    /** A first try, within its deadline: each of [addresses] in order (they share `ADDRESS_TRY_MS`
     *  while a scan or another address follows), then a scan for the serial; the scan alone when
     *  no address is known. A printer the scan hears is handed back ([HeardLate]) so that its
     *  connect gets a deadline of its own. */
    private suspend fun firstTry(target: BluetoothTarget, addresses: List<String>): BluetoothPrinterInfo {
        awaitBluetooth(needsScan = addresses.isEmpty())
        if (addresses.isEmpty()) {
            note("No address known: scanning for the name $host")
            throw HeardLate(findBySerial(target, addressKnown = false))
        }
        val canScan = !target.serial.isNullOrEmpty() && availabilityState.value == BluetoothAvailability.READY
        val share = ZebraBluetoothSpec.ADDRESS_TRY_MS / addresses.size
        for ((i, address) in addresses.withIndex()) {
            note(if (address == target.address) "Trying the saved address $address" else "Trying the address the last link used, $address")
            if (i == addresses.lastIndex && !canScan) return connectAndSetUp(address, target, null)
            try {
                return connectAndSetUp(address, target, share)
            } catch (e: NeverConnected) {
                if (e.pairingLost) throw e
                note("No link at $address: ${e.message}")
            }
        }
        note("Not reached by address: scanning for the name $host")
        throw HeardLate(findBySerial(target, addressKnown = true))
    }

    /** A connect to [address] alone, with no scan: a retry after a drop before Ready (the address
     *  that connected), or the printer the search for its serial heard. */
    private suspend fun reconnect(target: BluetoothTarget, address: String): BluetoothPrinterInfo {
        awaitBluetooth(needsScan = false)
        return connectAndSetUp(address, target, null)
    }

    /** Waits for a state Bluetooth can be used in (Location matters only to a scan). */
    private suspend fun awaitBluetooth(needsScan: Boolean) {
        stage = Stage.WAITING
        while (true) {
            when (val now = readAvailability()) {
                BluetoothAvailability.READY -> return
                BluetoothAvailability.LOCATION_OFF -> if (needsScan) throw BluetoothUnavailable(host, now) else return
                BluetoothAvailability.UNKNOWN -> {
                    val waiter = CompletableDeferred<Unit>()
                    availabilityWaiter = waiter
                    try {
                        waiter.await()
                    } finally {
                        availabilityWaiter = null
                    }
                }
                else -> throw BluetoothUnavailable(host, now)
            }
        }
    }

    /** Scans for the device named [target]'s serial; its address. */
    private suspend fun findBySerial(target: BluetoothTarget, addressKnown: Boolean): String {
        val serial = target.serial?.takeIf { it.isNotEmpty() } ?: throw BluetoothPrinterNotFound(host)
        val now = availabilityState.value
        if (now != BluetoothAvailability.READY) throw BluetoothUnavailable(host, now)
        stage = if (addressKnown) Stage.FINDING_KNOWN else Stage.FINDING
        val search = Finding(serial, CompletableDeferred()) {
            if (addressKnown) PrinterUnreachable(host) else BluetoothPrinterNotFound(host)
        }
        finding = search
        try {
            updateScanning()
            return search.found.await().also { note("Heard $serial at $it after ${sinceConnect()} s") }
        } finally {
            if (finding === search) finding = null
            updateScanning()
        }
    }

    /** Opens a GATT connection to [address] and sets it up. [connectWithinMs], when given, is how
     *  long the link may take to come up before this gives up ([NeverConnected]). Any failure closes
     *  the GATT. */
    private suspend fun connectAndSetUp(address: String, target: BluetoothTarget, connectWithinMs: Long?): BluetoothPrinterInfo {
        endUiScan(BluetoothScanEnd.INTERRUPTED)
        stage = Stage.CONNECTING
        val id = ++linkIds
        val gatt = client.connect(address) { eventQueue.trySend(Event.Gatt(id, it)) } ?: throw NeverConnected(NOT_STARTED)
        val link = Link(id, address, gatt)
        current = link
        var ready = false
        try {
            if (connectWithinMs == null) {
                link.connected.await()
            } else {
                withTimeoutOrNull(connectWithinMs) { link.connected.await() } ?: throw NeverConnected(NOT_STARTED)
            }
            note("Connected after ${sinceConnect()} s: reading Device Information")
            stage = Stage.SETTING_UP
            val info = setUp(link, target)
            ready = true
            return info
        } finally {
            if (!ready) {
                link.queue.fail(LinkClosed())
                if (current === link) current = null
                gatt.disconnect()
                gatt.close()
            }
        }
    }

    private suspend fun setUp(link: Link, target: BluetoothTarget): BluetoothPrinterInfo {
        val gatt = link.gatt
        // 1. Services.
        val discovered = link.queue.submit(GattQueue.Op.DiscoverServices).awaitOrUnreachable() as GattEvent.ServicesDiscovered
        if (discovered.status != GattStatus.SUCCESS) throw setUpFailure(discovered.status)
        if (!gatt.hasCharacteristic(PARSER, TO_PRINTER) || !gatt.hasCharacteristic(PARSER, FROM_PRINTER)) {
            throw BluetoothNotZebra(host)
        }
        // 2. Device Information, one value at a time (identity first).
        for (characteristic in DEVICE_INFO) {
            if (gatt.hasCharacteristic(ZebraBluetoothSpec.DEVICE_INFO_UUID, characteristic)) readInfo(link, characteristic)
        }
        verify(link, target)
        // 3. MTU.
        link.mtu = try {
            val changed = link.queue.submit(GattQueue.Op.RequestMtu(ZebraBluetoothSpec.REQUESTED_MTU)).result.await() as GattEvent.MtuChanged
            if (changed.status == GattStatus.SUCCESS) changed.mtu else null
        } catch (_: GattNotIssued) {
            null
        }
        // 4. Indications on (replies, D6).
        val enabled = link.queue.submit(GattQueue.Op.EnableIndications(PARSER, FROM_PRINTER)).awaitOrUnreachable() as GattEvent.IndicationsEnabled
        if (enabled.status != GattStatus.SUCCESS) throw setUpFailure(enabled.status)

        gatt.requestHighPriority()
        val info = infoOf(link)
        link.info = info
        link.ready = true
        phase = Phase.READY
        val at = clock()
        val chunk = ZebraBluetoothSpec.chunkBytes(link.mtu)
        // The idle clock starts here: time spent connecting isn't idle time on a working link.
        linkState.update {
            it.copy(
                connected = true, info = info, mtu = link.mtu, chunkBytes = chunk,
                connectedAtMs = at, lastActivityMs = at,
                savedAddress = target.address?.takeUnless { saved -> saved.equals(link.address, ignoreCase = true) },
            )
        }
        note(
            "Ready in ${sinceConnect()} s: ${info.model ?: "model not read"} · serial ${info.serial ?: "not read"}" +
                " · firmware ${info.firmware ?: "not read"} · Link-OS ${info.linkOs ?: "not read"}" +
                " · $chunk bytes per chunk ${link.mtu?.let { "(MTU $it)" } ?: "(the MTU request failed)"}",
        )
        return info
    }

    /** Reads one Device Information value, waiting at most `DEVICE_INFO_READ_MS` once it went out.
     *  A value that answers later still lands (the next operation waits for that answer anyway). */
    private suspend fun readInfo(link: Link, characteristic: String) {
        val pending = link.queue.submit(GattQueue.Op.Read(ZebraBluetoothSpec.DEVICE_INFO_UUID, characteristic))
        pending.result.invokeOnCompletion { error ->
            val read = pending.answer as? GattEvent.CharacteristicRead
            when {
                error != null || read == null -> Unit
                read.status == GattStatus.SUCCESS -> {
                    decodeInfo(read.value)?.let { link.deviceInfo[characteristic] = it }
                    link.unread -= characteristic
                }
                // Even after its fallback: the printer wants a pairing this device lost, so the
                // setup ends with it as it would on time (no retry, the GATT closed).
                read.status in GattStatus.PAIRING_LOST -> if (link.ready) {
                    recordDrop(describeDisconnect(read.status))
                    endLink(BluetoothPairingLost(host))
                } else {
                    link.queue.fail(BluetoothPairingLost(host))
                }
            }
        }
        val read = try {
            pending.issued.await()
            withTimeoutOrNull(ZebraBluetoothSpec.DEVICE_INFO_READ_MS) { pending.result.await() } as GattEvent.CharacteristicRead?
        } catch (_: GattNotIssued) {
            null
        }
        when {
            read == null -> if (characteristic !in link.deviceInfo) link.unread += characteristic
            read.status in GattStatus.PAIRING_LOST -> throw BluetoothPairingLost(host)
            read.status != GattStatus.SUCCESS -> link.unread += characteristic
        }
    }

    /** Refuses a device that isn't the Zebra asked for. A manufacturer (or expected serial) that
     *  couldn't be read says nothing about the device: unreachable. */
    private fun verify(link: Link, target: BluetoothTarget) {
        val identity = listOfNotNull(MANUFACTURER, SERIAL.takeIf { target.serial != null })
        if (identity.any { it in link.unread && it !in link.deviceInfo }) throw PrinterUnreachable(host)
        if (link.deviceInfo[MANUFACTURER] != ZEBRA_MANUFACTURER) throw BluetoothNotZebra(host)
        val serial = link.deviceInfo[SERIAL]
        val expected = target.serial
        if (expected != null) {
            if (!serial.equals(expected, ignoreCase = true)) throw BluetoothSerialMismatch(expected, serial)
        } else if (serial != null) {
            host = serial
        }
    }

    /** The error a connect's deadline ends it with, by where it got to. */
    private fun deadlineError(): PrinterException = when (stage) {
        Stage.WAITING -> if (availabilityState.value == BluetoothAvailability.READY) {
            PrinterUnreachable(host)
        } else {
            BluetoothUnavailable(host, availabilityState.value)
        }
        // Still looking: a printer never found by its address or its name is "not found"; one whose
        // address was tried first is the saved printer not answering.
        Stage.FINDING -> BluetoothPrinterNotFound(host)
        Stage.FINDING_KNOWN, Stage.CONNECTING, Stage.SETTING_UP, Stage.RETRYING -> PrinterUnreachable(host)
    }

    private fun setUpFailure(status: Int): PrinterException =
        if (status in GattStatus.PAIRING_LOST) BluetoothPairingLost(host) else PrinterUnreachable(host)

    /** The connect in progress ends with [reason] (its finally blocks close its GATT). */
    private fun abort(reason: PrinterException) {
        val job = attempt ?: return
        abortReason = reason
        job.cancel()
    }

    /** The ready link ends: the write, drain or reply in flight fails with [error]. Nothing reconnects. */
    private fun endLink(error: Throwable) {
        val link = current ?: return
        current = null
        link.ready = false
        if (phase == Phase.READY) phase = Phase.IDLE
        link.queue.fail(error)
        failReplies(error)
        link.gatt.disconnect()
        link.gatt.close()
        linkState.update { it.copy(connected = false, connectedAtMs = null) }
    }

    private fun recordDrop(reason: String) {
        linkState.update { it.copy(lastDrop = BluetoothDrop(clock(), reason)) }
    }

    /** The address the last link to [serial] used (it may have moved since it was saved). */
    private fun knownAddress(serial: String?): String? {
        val info = linkState.value.info ?: return null
        return info.address.takeIf { serial != null && info.serial.equals(serial, ignoreCase = true) }
    }

    /** Whether the ready [link] is the printer asked for: by its confirmed serial when the target
     *  names one (an address is only how a printer is found), else by address. */
    private fun matches(link: Link, target: BluetoothTarget): Boolean {
        val serial = target.serial
        val address = target.address
        return when {
            serial != null -> link.info?.serial.equals(serial, ignoreCase = true)
            address != null -> link.address.equals(address, ignoreCase = true)
            else -> true
        }
    }

    private fun infoOf(link: Link) = BluetoothPrinterInfo(
        address = link.address,
        manufacturer = link.deviceInfo[MANUFACTURER],
        model = link.deviceInfo[gattUuid(ZebraBluetoothSpec.MODEL_UUID)],
        serial = link.deviceInfo[SERIAL],
        firmware = link.deviceInfo[gattUuid(ZebraBluetoothSpec.FIRMWARE_UUID)],
        linkOs = link.deviceInfo[gattUuid(ZebraBluetoothSpec.LINK_OS_UUID)],
    )

    // --- Writing and reading ---

    /** Writes [bytes] in acknowledged chunks within `sendBudgetMs(bytes)`. A budget that runs out
     *  ends the send with [PrinterTimeout] and ends the link (a late acknowledgment must never be
     *  taken for the next write's). */
    private suspend fun send(bytes: ByteArray, progress: WriteProgress?) {
        val link = current ?: throw PrinterUnreachable(host)
        val total = bytes.size.toLong()
        val sent = withTimeoutOrNull(ZebraBluetoothSpec.sendBudgetMs(bytes.size)) {
            val chunk = ZebraBluetoothSpec.chunkBytes(link.mtu)
            var offset = 0
            progress?.invoke(0, total)
            while (offset < bytes.size) {
                if (current !== link) throw PrinterUnreachable(host)
                val end = minOf(offset + chunk, bytes.size)
                val ack = link.queue.submit(GattQueue.Op.Write(PARSER, TO_PRINTER, bytes.copyOfRange(offset, end)))
                    .awaitOrUnreachable() as GattEvent.CharacteristicWritten
                when {
                    ack.status in GattStatus.PAIRING_LOST -> {
                        val reason = "The printer refused a write: it wants a pairing this device no longer has (status ${ack.status})"
                        recordDrop(reason)
                        note("Link dropped: $reason (the printer forgot this device)")
                        endLink(BluetoothPairingLost(host))
                        throw BluetoothPairingLost(host)
                    }
                    ack.status != GattStatus.SUCCESS -> throw PrinterUnreachable(host)
                }
                offset = end
                linkState.update { it.copy(lastActivityMs = clock()) }
                progress?.invoke(offset.toLong(), total)
            }
            true
        }
        if (sent == null) {
            if (current === link) {
                recordDrop("A send ran past its time limit")
                note("A send of $total bytes ran past its ${ZebraBluetoothSpec.sendBudgetMs(bytes.size) / 1_000} s limit: link closed")
                endLink(PrinterTimeout(host))
            }
            throw PrinterTimeout(host)
        }
    }

    /** Waits until no byte has arrived for `DRAIN_QUIET_MS` (at most `DRAIN_MAX_MS`), so the rest of
     *  an earlier reply isn't taken for this one's (D6). */
    private suspend fun drain() {
        if (quietTimer == null) return
        val waiter = CompletableDeferred<Unit>()
        drainWaiter = waiter
        try {
            withTimeoutOrNull(ZebraBluetoothSpec.DRAIN_MAX_MS) { waiter.await() }
        } finally {
            drainWaiter = null
        }
    }

    private suspend fun collectReply(complete: (ByteArray) -> Boolean): ByteArray {
        val already = rx.toByteArray()
        if (isWhole(already, complete)) return already
        if (current?.ready != true) throw PrinterUnreachable(host) // dropped as the write ended
        val wait = ReplyWait(CompletableDeferred(), complete)
        reply = wait
        wait.total = inner.launch {
            delay(ZebraBluetoothSpec.QUERY_TOTAL_MS)
            finishReply()
        }
        restartIdle()
        try {
            return wait.answer.await()
        } finally {
            if (reply === wait) reply = null
            wait.idle?.cancel()
            wait.total?.cancel()
        }
    }

    private fun received(bytes: ByteArray) {
        linkState.update { it.copy(lastActivityMs = clock()) }
        quietTimer?.cancel()
        quietTimer = inner.launch {
            delay(ZebraBluetoothSpec.DRAIN_QUIET_MS)
            quietTimer = null
            drainWaiter?.complete(Unit)
        }
        if (!collecting) return // a late byte of an earlier reply
        val room = ZebraNetwork.MAX_REPLY - rx.size()
        if (room > 0) rx.write(bytes, 0, minOf(room, bytes.size))
        val wait = reply ?: return // the command is still going out
        if (isWhole(rx.toByteArray(), wait.complete)) finishReply() else restartIdle()
    }

    private fun restartIdle() {
        val wait = reply ?: return
        wait.idle?.cancel()
        wait.idle = inner.launch {
            delay(ZebraBluetoothSpec.QUERY_IDLE_MS)
            finishReply()
        }
    }

    private fun finishReply() {
        val wait = reply ?: return
        reply = null
        wait.idle?.cancel()
        wait.total?.cancel()
        wait.answer.complete(rx.toByteArray())
    }

    /** The drain or reply in flight fails with [error]. */
    private fun failReplies(error: Throwable) {
        drainWaiter?.completeExceptionally(error)
        val wait = reply ?: return
        reply = null
        wait.idle?.cancel()
        wait.total?.cancel()
        wait.answer.completeExceptionally(error)
    }

    // --- Closing ---

    private fun closeNow() {
        endUiScan(BluetoothScanEnd.CLOSED)
        while (turnWaiters.isNotEmpty()) {
            val waiter = turnWaiters.removeFirst()
            waiter.turn.completeExceptionally(PrinterUnreachable(waiter.name))
        }
        if (phase != Phase.IDLE) note("Link closed by the app (background, sign-out or another printer)")
        when (phase) {
            Phase.IDLE -> Unit
            Phase.CONNECTING -> abort(PrinterUnreachable(host))
            Phase.READY -> if (writing) closeAfterWrite = true else endLink(PrinterUnreachable(host))
        }
    }

    // --- Scanning ---

    /** A screen's scan: it ends at once when Bluetooth refuses one; while Bluetooth is turning on
     *  (or off) it waits, and its clock starts once the radio scans ([startScanClock]). */
    private fun startUiScan(out: SendChannel<List<FoundBluetoothPrinter>>): Int {
        endUiScan(BluetoothScanEnd.REPLACED)
        val scan = UiScan(++scanIds, out)
        uiScan = scan
        if (isRefusal(readAvailability())) {
            endUiScan(BluetoothScanEnd.REFUSED)
        } else {
            updateScanning()
        }
        return scan.id
    }

    private fun endUiScan(why: BluetoothScanEnd) {
        val scan = uiScan ?: return
        uiScan = null
        scan.timer?.cancel()
        scan.refresh?.cancel()
        lastScanEnd = why
        if (scan.unpublished) scan.out.trySend(sorted(scan.seen.values))
        scan.out.close()
        updateScanning()
    }

    /** The screen stopped listening to its scan. */
    private fun uiScanAbandoned(id: Int) {
        val scan = uiScan?.takeIf { it.id == id } ?: return
        uiScan = null
        scan.timer?.cancel()
        scan.refresh?.cancel()
        updateScanning()
    }

    /** The adapter scans while a screen's scan or a connect's search for a serial wants it. */
    private fun updateScanning() {
        val wanted = (uiScan != null || finding != null) && availabilityState.value == BluetoothAvailability.READY
        if (wanted && !scanning) {
            scanning = client.startScan()
            if (!scanning) {
                scanFailed()
                return
            }
        } else if (!wanted && scanning) {
            scanning = false
            client.stopScan()
        }
        startScanClock()
    }

    /** A screen's scan runs `SCAN_MS` from when Bluetooth is ready and the radio scans for it, not
     *  from the tap (a scan asked while Bluetooth is turning on waits for it; through a reset the
     *  clock starts over). */
    private fun startScanClock() {
        val scan = uiScan ?: return
        if (scan.timer != null || !scanning || availabilityState.value != BluetoothAvailability.READY) return
        scan.timer = inner.launch {
            delay(ZebraBluetoothSpec.SCAN_MS)
            if (uiScan === scan) endUiScan(BluetoothScanEnd.FINISHED)
        }
    }

    private fun scanFailed() {
        if (scanning) client.stopScan()
        scanning = false
        finding?.let {
            finding = null
            it.found.completeExceptionally(it.notFound())
        }
        endUiScan(BluetoothScanEnd.FAILED)
    }

    private fun advertised(ad: BluetoothLeEvent.Advertised) {
        finding?.let { if (ad.name != null && ad.name.equals(it.serial, ignoreCase = true)) it.found.complete(ad.address) }
        val scan = uiScan ?: return
        val name = ad.name?.takeIf { it.isNotBlank() } ?: return
        val old = scan.seen[ad.address]
        scan.seen[ad.address] = FoundBluetoothPrinter(ad.address, name, ad.rssi, ad.advertisesZebra || old?.advertisesZebra == true)
        if (old == null || old.name != name) {
            publish(scan) // a new device shows at once
        } else {
            // Advertisements come many times a second: signal changes show at most every SCAN_REFRESH_MS.
            scan.unpublished = true
            if (scan.refresh == null) {
                scan.refresh = inner.launch {
                    delay(SCAN_REFRESH_MS)
                    scan.refresh = null
                    if (uiScan === scan) publish(scan)
                }
            }
        }
    }

    private fun publish(scan: UiScan) {
        scan.refresh?.cancel()
        scan.refresh = null
        scan.unpublished = false
        scan.out.trySend(sorted(scan.seen.values))
    }

    // --- Events ---

    private fun handle(event: Event) {
        when (event) {
            is Event.Gatt -> onGatt(event.linkId, event.event)
            is Event.Client -> when (val e = event.event) {
                BluetoothLeEvent.AvailabilityChanged -> availabilityChanged()
                is BluetoothLeEvent.Advertised -> advertised(e)
                is BluetoothLeEvent.ScanFailed -> scanFailed()
                is BluetoothLeEvent.BondLost -> bondLost(e.address)
            }
        }
    }

    private fun onGatt(linkId: Int, event: GattEvent) {
        val link = current?.takeIf { it.id == linkId } ?: return // a link already closed
        when (event) {
            is GattEvent.ConnectionChanged -> connectionChanged(link, event)
            is GattEvent.Indication -> if (link.ready && sameUuid(event.characteristic, FROM_PRINTER)) received(event.value)
            else -> {
                val answered = link.queue.onEvent(event)
                // The printer may renegotiate the MTU itself.
                if (!answered && event is GattEvent.MtuChanged && event.status == GattStatus.SUCCESS && link.ready) {
                    link.mtu = event.mtu
                    linkState.update { it.copy(mtu = event.mtu, chunkBytes = ZebraBluetoothSpec.chunkBytes(event.mtu)) }
                }
            }
        }
    }

    private fun connectionChanged(link: Link, event: GattEvent.ConnectionChanged) {
        val pairingLost = event.status in GattStatus.PAIRING_LOST_ON_DISCONNECT
        when {
            event.connected && event.status == GattStatus.SUCCESS -> {
                link.everConnected = true
                link.connected.complete(Unit)
            }
            !link.everConnected -> link.connected.completeExceptionally(NeverConnected(event.status, pairingLost))
            link.ready -> {
                val reason = describeDisconnect(event.status)
                recordDrop(reason)
                note("Link dropped: $reason" + if (pairingLost) " (the printer forgot this device)" else "")
                endLink(if (pairingLost) BluetoothPairingLost(host) else PrinterUnreachable(host))
            }
            else -> link.queue.fail(DroppedBeforeReady(link.address, describeDisconnect(event.status), pairingLost))
        }
    }

    private fun bondLost(address: String) {
        val link = current?.takeIf { it.address.equals(address, ignoreCase = true) } ?: return
        when {
            link.ready -> {
                recordDrop(BOND_LOST_REASON)
                note("Link dropped: $BOND_LOST_REASON (the printer forgot this device)")
                endLink(BluetoothPairingLost(host))
            }
            !link.everConnected -> link.connected.completeExceptionally(NeverConnected(NOT_STARTED, pairingLost = true))
            else -> link.queue.fail(DroppedBeforeReady(link.address, BOND_LOST_REASON, pairingLost = true))
        }
    }

    /** Bluetooth's state changed (or was read again): a connect waiting for it goes on; one in
     *  progress, or the link, ends when Bluetooth is off, not allowed or missing; Location going off
     *  ends only scans. A screen's scan waits through Bluetooth turning on or off, its clock
     *  starting over once Bluetooth is back. */
    private fun availabilityChanged() {
        val now = readAvailability()
        availabilityWaiter?.complete(Unit)
        when (now) {
            BluetoothAvailability.READY -> updateScanning() // a scan asked for before Bluetooth was on starts now
            BluetoothAvailability.UNKNOWN -> {
                // Turning on or off: the next state decides. A scan keeps waiting, its clock stopped.
                uiScan?.let {
                    it.timer?.cancel()
                    it.timer = null
                }
                updateScanning()
            }
            BluetoothAvailability.LOCATION_OFF -> {
                if (finding != null) abort(BluetoothUnavailable(host, now))
                endUiScan(BluetoothScanEnd.REFUSED)
                updateScanning()
            }
            BluetoothAvailability.POWERED_OFF, BluetoothAvailability.UNAUTHORIZED, BluetoothAvailability.UNSUPPORTED -> {
                endUiScan(BluetoothScanEnd.REFUSED)
                updateScanning()
                when (phase) {
                    Phase.IDLE -> Unit
                    Phase.CONNECTING -> abort(BluetoothUnavailable(host, now))
                    Phase.READY -> {
                        recordDrop("Bluetooth stopped on this device")
                        note("Link dropped: Bluetooth stopped on this device")
                        endLink(BluetoothUnavailable(host, now))
                    }
                }
            }
        }
    }

    private fun readAvailability(): BluetoothAvailability = client.availability().also {
        availabilityState.value = it
        noteState(it)
    }

    // --- The event log ---

    /** Adds [text] to the link's log, keeping the newest [EVENT_CAP]. */
    private fun note(text: String) {
        synchronized(eventLog) {
            eventLog.addLast(BluetoothLinkEvent(clock(), text))
            while (eventLog.size > EVENT_CAP) eventLog.removeFirst()
        }
    }

    /** Bluetooth's state, noted when it changes. */
    private fun noteState(state: BluetoothAvailability) {
        if (state == notedState) return
        notedState = state
        note(stateText(state))
    }

    /** "1.15": seconds since the connect in progress started. */
    private fun sinceConnect(): String = String.format(java.util.Locale.US, "%.2f", (clock() - connectStartedMs) / 1_000.0)

    private fun stageText(): String = when (stage) {
        Stage.WAITING -> "waiting for Bluetooth"
        Stage.FINDING, Stage.FINDING_KNOWN -> "scanning for its name"
        Stage.CONNECTING -> "connecting"
        Stage.SETTING_UP -> "setting up"
        Stage.RETRYING -> "waiting to retry"
    }

    // --- Pieces ---

    private enum class Phase { IDLE, CONNECTING, READY }

    private enum class Stage { WAITING, FINDING, FINDING_KNOWN, CONNECTING, SETTING_UP, RETRYING }

    /** What a connect's try does next: locate the printer (addresses, then its name), or connect
     *  to one address (a retry after a drop, or the printer its search heard). */
    private sealed interface Step {
        data object Locate : Step
        class Connect(val address: String) : Step
    }

    /** The connect numbered [id], for [target], failed with [error]. */
    private class AttemptFailure(val id: Int, val target: BluetoothTarget, val error: Throwable)

    private sealed interface Event {
        class Client(val event: BluetoothLeEvent) : Event {
            override fun toString() = event.toString()
        }
        class Gatt(val linkId: Int, val event: GattEvent) : Event {
            override fun toString() = "link $linkId: $event"
        }
    }

    /** One GATT connection and what its setup learned. */
    private class Link(val id: Int, val address: String, val gatt: GattLink) {
        val queue = GattQueue(gatt)
        val connected = CompletableDeferred<Unit>()
        var everConnected = false
        var ready = false
        var mtu: Int? = null
        var info: BluetoothPrinterInfo? = null
        /** Device Information by full characteristic UUID. */
        val deviceInfo = HashMap<String, String>()
        /** Device Information reads that failed or weren't answered in time. */
        val unread = HashSet<String>()
    }

    private class TurnWaiter(val name: String) {
        val turn = CompletableDeferred<Unit>()
        /** [turn] was completed by [passTurn]: this waiter holds the turn. */
        var handed = false
    }

    private class Finding(val serial: String, val found: CompletableDeferred<String>, val notFound: () -> PrinterException)

    private class ReplyWait(val answer: CompletableDeferred<ByteArray>, val complete: (ByteArray) -> Boolean) {
        var idle: Job? = null
        var total: Job? = null
    }

    private class UiScan(val id: Int, val out: SendChannel<List<FoundBluetoothPrinter>>) {
        val seen = LinkedHashMap<String, FoundBluetoothPrinter>()
        var timer: Job? = null
        var refresh: Job? = null
        var unpublished = false
    }

    private sealed interface Outcome {
        class Ready(val info: BluetoothPrinterInfo) : Outcome
        /** The search for the serial heard the printer at [address]: the connect comes next. */
        class Heard(val address: String) : Outcome
        class NeverUp(val error: NeverConnected) : Outcome
        class Dropped(val error: DroppedBeforeReady) : Outcome
    }

    /** The search for the serial heard the printer at [address] (thrown out of the locate step, so
     *  the connect gets a deadline of its own). */
    private class HeardLate(val address: String) : Exception("Heard at $address")

    /** The link never came up ([status] is Android's, when it said). */
    private class NeverConnected(val status: Int, val pairingLost: Boolean = status in GattStatus.PAIRING_LOST_ON_DISCONNECT) :
        Exception("the link never came up (status $status)")

    /** The link came up and dropped before it was Ready. */
    private class DroppedBeforeReady(val address: String, val reason: String, val pairingLost: Boolean) : Exception(reason)

    /** A link closed by the link itself (a failed setup). */
    private class LinkClosed : Exception("The link closed")

    /** The operation's event; a refused one ([GattNotIssued]) is [PrinterUnreachable]. */
    private suspend fun GattQueue.Pending.awaitOrUnreachable(): GattEvent = try {
        result.await()
    } catch (_: GattNotIssued) {
        throw PrinterUnreachable(host)
    }

    companion object {
        /** How many of the newest events the log keeps (iOS's cap). */
        const val EVENT_CAP = 500
        private const val TAG = "ZebraBluetooth"
        private val PARSER = gattUuid(ZebraBluetoothSpec.SERVICE_UUID)
        private val TO_PRINTER = gattUuid(ZebraBluetoothSpec.TO_PRINTER_UUID)
        private val FROM_PRINTER = gattUuid(ZebraBluetoothSpec.FROM_PRINTER_UUID)
        private val MANUFACTURER = gattUuid(ZebraBluetoothSpec.MANUFACTURER_UUID)
        private val SERIAL = gattUuid(ZebraBluetoothSpec.SERIAL_UUID)
        /** Identity first, so a refusal comes before the rest is read. */
        private val DEVICE_INFO = listOf(
            ZebraBluetoothSpec.MANUFACTURER_UUID, ZebraBluetoothSpec.SERIAL_UUID, ZebraBluetoothSpec.MODEL_UUID,
            ZebraBluetoothSpec.FIRMWARE_UUID, ZebraBluetoothSpec.LINK_OS_UUID,
        ).map(::gattUuid)
        private const val ZEBRA_MANUFACTURER = "Zebra Technologies"
        private const val NOT_STARTED = -1
        private const val SCAN_REFRESH_MS = 500L
        private const val BOND_LOST_REASON = "The printer's pairing with this device was removed"

        /** Zebras first, then serial-like names, then signal in 10 dB steps (rows don't jump on
         *  every advertisement), then name. */
        private val ORDER: Comparator<FoundBluetoothPrinter> = compareByDescending<FoundBluetoothPrinter> { it.isZebra }
            .thenByDescending { ZebraBluetoothSpec.looksLikeZebraSerial(it.name) }
            .thenByDescending { Math.floorDiv(it.rssi, 10) }
            .thenBy { it.name }

        private fun sorted(found: Collection<FoundBluetoothPrinter>): List<FoundBluetoothPrinter> = found.sortedWith(ORDER)

        private fun concat(parts: List<ByteArray>): ByteArray {
            val all = ByteArray(parts.sumOf { it.size })
            var at = 0
            for (part in parts) {
                part.copyInto(all, at)
                at += part.size
            }
            return all
        }

        private fun isWhole(reply: ByteArray, complete: (ByteArray) -> Boolean): Boolean =
            reply.isNotEmpty() && (reply.size >= ZebraNetwork.MAX_REPLY || complete(reply))

        /** A Device Information value: UTF-8 without padding NULs or spaces; null when empty. */
        private fun decodeInfo(value: ByteArray?): String? =
            value?.toString(Charsets.UTF_8)?.trim { it == '\u0000' || it.isWhitespace() }?.takeIf { it.isNotEmpty() }

        /** Bluetooth off, not allowed or missing, or Location off: a scan ends at once. */
        private fun isRefusal(state: BluetoothAvailability): Boolean = when (state) {
            BluetoothAvailability.POWERED_OFF, BluetoothAvailability.UNAUTHORIZED,
            BluetoothAvailability.UNSUPPORTED, BluetoothAvailability.LOCATION_OFF -> true
            BluetoothAvailability.READY, BluetoothAvailability.UNKNOWN -> false
        }

        /** Two calls are for the same printer: by serial when both name one, else by address. */
        private fun sameTarget(a: BluetoothTarget, b: BluetoothTarget): Boolean = when {
            a.serial != null && b.serial != null -> a.serial.equals(b.serial, ignoreCase = true)
            a.serial == null && b.serial == null -> a.address != null && a.address.equals(b.address, ignoreCase = true)
            else -> a.address != null && a.address.equals(b.address, ignoreCase = true)
        }

        private fun stateText(state: BluetoothAvailability): String = when (state) {
            BluetoothAvailability.READY -> "Bluetooth is on"
            BluetoothAvailability.POWERED_OFF -> "Bluetooth is off"
            BluetoothAvailability.UNAUTHORIZED -> "Bluetooth isn't allowed for ServerSherpa Kiosk"
            BluetoothAvailability.UNSUPPORTED -> "Bluetooth isn't supported on this device"
            BluetoothAvailability.LOCATION_OFF -> "Bluetooth is on; Location is off, so nothing can be scanned for"
            BluetoothAvailability.UNKNOWN -> "Bluetooth is turning on or off"
        }

        /** Why a connect failed, in a few words for the log. */
        private fun eventText(error: Throwable): String = when (error) {
            is BluetoothPairingLost -> "the printer forgot this device (pairing lost)"
            is BluetoothUnavailable -> bluetoothUnavailableText(error.availability) ?: "Bluetooth wasn't ready"
            is BluetoothSerialMismatch -> "another printer answered (serial ${error.found ?: "not read"})"
            is BluetoothNotZebra -> "not a Zebra printer"
            is BluetoothPrinterNotFound -> "not heard nearby"
            is PrinterUnreachable -> "no link"
            else -> error.toString()
        }
    }
}
