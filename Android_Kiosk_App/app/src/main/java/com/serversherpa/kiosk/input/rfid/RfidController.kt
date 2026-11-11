package com.serversherpa.kiosk.input.rfid

import android.util.Log
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidReadSession
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledNudge
import com.serversherpa.kiosk.core.rfid.SledRetry
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerAction
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.burstToScans
import com.serversherpa.kiosk.core.rfid.isSledName
import com.serversherpa.kiosk.core.rfid.nextTriggerAction
import com.serversherpa.kiosk.core.rfid.onTagRead
import com.serversherpa.kiosk.core.rfid.queuedAfter
import com.serversherpa.kiosk.core.rfid.startSession
import com.serversherpa.kiosk.core.scan.rfidKey
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Who holds the sled's trigger. Each screen that reads RFID arms with its own
 * key, so a leaving screen's late `disarm` can't switch off the arriving
 * screen's trigger, and a sweep only reaches the screen it was read for.
 */
object RfidOwner {
    const val SCANNING = "scanning"
    const val LOOKUP = "lookup"
}

/**
 * Owns one reader. Turns trigger events into inventories using whichever
 * trigger mode is set, accumulates the burst, and emits the tags to queue when
 * it ends. It also owns the link to the sled: when to connect and disconnect,
 * and when to try again after a drop.
 *
 * It knows nothing about assets, the roster, or the outbox: it produces tag
 * values and stops there. `ScanViewModel` does the matching and the queueing,
 * so the RFID commit rules sit beside the barcode commit rules.
 *
 * `start()` launches its collectors (settings, triggers, tags, the connection
 * collector that pushes settings, the link-state collector that notices a
 * drop, the sled-address collector, and the [commands] consumer) and the
 * [connectionCommands] consumer on `scope`, which in production is a real
 * thread pool (`Dispatchers.Default`), not a confined dispatcher — so every
 * one of them can run concurrently with every other, and with `arm()`/
 * `disarm()`/`stopBurst()`/`connectNow()`/`disconnectNow()` called from the UI
 * thread. All of the sweep state those touch (`current`, `_session`, `armed`,
 * `queued`, `stoppingBurst`, `queueOnStop`) is therefore only ever read or
 * written under `mutex`, the same idiom `Outbox` uses for its own multi-writer
 * state — every access, not just the ones with something else nearby to
 * protect, since a field a lock only sometimes guards gives no happens-before
 * edge to the accesses that skip it.
 *
 * Two deliberate exceptions to "every access happens under `mutex`" are
 * `reader.stopInventory()` inside [endBurst] and `reader.apply()` inside
 * [push] — both vendor round trips long enough (or, for `apply()`, unbounded
 * enough) that holding `mutex` across them would starve `onTag`/`onTrigger`
 * for the duration, or forever if the vendor stack soft-hangs.
 *
 * `reader.stopInventory()`: on real hardware that is a vendor round trip of
 * tens of milliseconds during which tags can still arrive, and holding
 * `mutex` across it would make `onTag` block until the burst was already
 * claimed — silently dropping the tail of every sweep. So ending a burst is
 * done in three steps: claim ownership of the stop under the lock (recorded
 * in `stoppingBurst`, so a second, concurrent caller does nothing but fold in
 * its own queue-or-discard preference), stop the reader with the lock
 * released so `onTag` stays free, then re-acquire the lock to claim the
 * session, update `queued`, and decide whether to emit.
 *
 * `reader.apply()`: on real hardware (`ZebraRfidReader.apply()`) that is eight
 * sequential vendor round trips, and unlike `connect()`/`disconnect()` it
 * used to have no timeout at all — a soft-hung vendor stack would wedge
 * whatever held the lock across it forever. [applyGate], a second, narrow
 * `Mutex`, is what lets [push] stay off `mutex` entirely: a slow or hung
 * settings push never blocks a tag report, an arm/disarm, or [endBurst] —
 * those only ever need `mutex`, which [push] never holds. A trigger START and
 * [setRegion] are the two exceptions: each deliberately serializes against a
 * concurrent push — and against each other — on the vendor link by acquiring
 * `applyGate` *while still holding `mutex`* (see the nesting in [onTrigger]'s
 * `TriggerAction.START` branch and in [setRegion]), so a start or a region
 * write can be delayed — bounded by `VENDOR_TIMEOUT_MS` in the worst case —
 * behind an in-flight push or region write. Nothing that holds `applyGate`
 * (i.e. [push] or [setRegion]) ever tries to acquire `mutex`, so nesting
 * `mutex` outside `applyGate` at either call site cannot deadlock: the lock
 * order is always `mutex` before `applyGate`, never the reverse, so there is
 * no cycle for two callers to deadlock on.
 *
 * `arm()`, `disarm()` and `stopBurst()` are called from the UI thread and
 * must stay non-suspending, but their real work still has to happen on
 * `scope`. Dispatching each with its own `scope.launch` gives no ordering
 * guarantee between two calls — a fast appear-then-disappear pair could run
 * disarm's body before arm's — so instead all three are just enqueued onto
 * [commands], a single unlimited-capacity `Channel` drained by one consumer
 * coroutine started in [start]. One consumer processing one queue in
 * receive order is what makes "arm() then disarm()" and "disarm() then
 * arm()" deterministic regardless of how the dispatcher happens to schedule
 * things. Unlimited capacity means `trySend` never suspends and never
 * fails for lack of room, so a command can never be silently dropped under
 * load, and the channel exists as a constructor property (not something
 * `start()` creates) so a command sent before `start()` runs is buffered,
 * not lost.
 *
 * **The link** (spec, Controller › Link management). Every connect and
 * disconnect — [connectForLifecycle]/[disconnectForLifecycle] from
 * `ProcessLifecycleOwner`, [connectNow]/[disconnectNow] from the RFID tab, the
 * reader switch's edges, a newly chosen sled, the reconnect after a region is
 * set — is a command on [connectionCommands], a *second* queue with its own
 * single consumer, so a slow `reader.connect()` (on real hardware, a Bluetooth
 * call that can take seconds when the sled is out of range) never delays
 * arm/disarm/stop, and the link calls run strictly in the order they were
 * issued: the caller enqueues *synchronously*, so a quick background/
 * foreground/background flurry lands in lifecycle order whatever each call
 * then takes. `connectNow()`/`disconnectNow()` only await their command's
 * answer, so cancelling the caller (leaving the RFID tab) never cancels the
 * attempt; they start the consumer themselves when [start] has not run, so a
 * screen that only ever calls them still works. The retry schedule's own
 * tries take [linkGate] directly.
 *
 * [linkGate] serializes every connect and disconnect; it is outermost in the
 * lock order (`linkGate`, `stopGate`, `mutex`, `applyGate`, the adapter).
 * Each reader call it guards also holds [applyGate] for the call alone, so a
 * settings push never overlaps a connect or a disconnect on the reader.
 * [linkWanted] is written without suspending, on the caller's thread, before
 * anything is queued: true from [connectForLifecycle] (which stores its gate
 * for every automatic attempt), [connectNow] and the reader switch turning
 * on; false from [disconnectForLifecycle], [disconnectNow], [stopReconnecting]
 * and the switch turning off, which also cancel the retry schedule. Once they
 * hold `linkGate`, automatic attempts (lifecycle, the switch, a retry, a
 * nudge) re-read `linkWanted` and run the stored gate (`enabled` and the
 * permissions, ruling 32); a manual one (Connect, a new sled, the region
 * reconnect) re-reads only `linkWanted`. So whichever link call was issued
 * last decides where the link ends up. A connect that finds the link up
 * (`Connected` or `NeedsRegion`) succeeds without dialing.
 *
 * The connect wait is [CONNECT_WAIT_MS] ([CONNECT_WAIT_BATCH_MS] once the
 * reader reported a batch-mode recovery in the attempt). When it runs out the
 * caller is answered and [connectionError] says the sled couldn't be reached,
 * but `linkGate` stays held until the reader's own call returns, so the next
 * link call never overlaps it. A disconnect waits [DISCONNECT_WAIT_MS] the
 * same way and only logs when it runs out.
 *
 * **Reconnect** (spec, Controller › Reconnect; rulings 4 and 41). One
 * schedule at a time; [reconnecting] is true while it runs and [retry] says
 * what it is about. It starts on a retryable failure while the link is
 * wanted: after a drop (the link was up, so `info` is kept), or after a
 * connect that never came up while a sled screen is open
 * ([setSledScreenOpen]). Tries wait `OutboxMachine.BACKOFF` (2, 4, 15, 60 s);
 * the fourth failure gives up with the couldn't-reach sentence. The first
 * batch clear gets one more try at once, uncounted. Any other attempt cancels
 * a pending wait and takes its place; Connect failing retryably on a sled
 * screen starts the count over. A failure the operator has to fix
 * (`retryable = false`, every pre-check) ends it. No try starts while
 * [printerBusy] is true. A [nudge] shortens a wait or starts one try; it is
 * ignored during an attempt and for [NUDGE_QUIET_MS] after one, and a try it
 * starts after giving up leaves the schedule given up when it fails.
 *
 * [stopGate] is a second, narrower lock than `mutex`: it is held by
 * [endBurst] for the entire window it owns a stop, `reader.stopInventory()`
 * included, and [onTrigger] waits on it before evaluating anything. Without
 * it, a trigger event landing in the gap where `mutex` is released around
 * `reader.stopInventory()` would see the still-open session and read a
 * would-be START as NONE or STOP, so the operator's next pull does nothing.
 * `onTag` never touches `stopGate` — only trigger evaluation waits for a
 * stop to finish; tags keep folding into the still-open session for the
 * whole vendor round trip, same as before.
 *
 * Arming is owner-aware (see [RfidOwner]): two screens read RFID (Scanning
 * and Asset Lookup), and NavHost's exit transition can run the leaving
 * screen's `disarm` after the arriving screen's `arm`. `arm(owner)` with a
 * different owner than the armed one starts a new visit — it drops any
 * open burst and resets `queued` — and `disarm(owner)` does nothing unless
 * that owner is the one armed. Each burst carries the owner that was armed
 * when it started; [burstsFor] delivers a burst only to that owner's screen.
 */
class RfidController(
    private val reader: RfidReader,
    private val settings: Flow<RfidSettings>,
    private val scope: CoroutineScope,
    private val zebraHost: Boolean = false,
    private val printerBusy: () -> Boolean = { false },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    val connection: StateFlow<RfidConnection> = reader.connection
    /** A plain read-through of the reader's own note — see [RfidReader.connectNote]. */
    val connectNote: StateFlow<String?> = reader.connectNote
    /** A plain read-through of [RfidReader.info]. */
    val info: StateFlow<SledInfo?> = reader.info
    /** A plain read-through of [RfidReader.scanner]. */
    val scanner: StateFlow<SledScannerState> = reader.scanner

    private val _reconnecting = MutableStateFlow(false)
    /** True while the reconnect schedule runs (see the class doc). */
    val reconnecting: StateFlow<Boolean> = _reconnecting

    private val _retry = MutableStateFlow<SledRetry?>(null)
    /** What the running reconnect is about; non-null exactly while [reconnecting]
     *  (set before it turns true, cleared after it turns false). */
    val retry: StateFlow<SledRetry?> = _retry

    private val _session = MutableStateFlow<RfidReadSession?>(null)
    /** Non-null only while a burst is running. Scanning's and Asset Lookup's live panel. */
    val session: StateFlow<RfidReadSession?> = _session

    private class OwnedBurst(val owner: String?, val tags: List<String>)

    private val _bursts = MutableSharedFlow<OwnedBurst>(extraBufferCapacity = 16)
    /** One emission per finished burst, whoever it was read for: the tags to
     *  queue, in read order. Screens collect [burstsFor] instead. */
    val bursts: Flow<List<String>> = _bursts.map { it.tags }

    /** The bursts read while [owner] held the trigger, and no one else's. */
    fun burstsFor(owner: String): Flow<List<String>> =
        _bursts.filter { it.owner == owner }.map { it.tags }

    private val _applyError = MutableStateFlow<String?>(null)
    /** Why the reader refused the last settings push, for the RFID tab to show.
     *  Null once a push succeeds. */
    val applyError: StateFlow<String?> = _applyError

    private val _connectionError = MutableStateFlow<String?>(null)
    /** Why the last connect failed, when the connection line alone does not
     *  say it: the couldn't-reach sentence when the connect wait ran out (the
     *  reader is still `Connecting` then) or when the reconnect schedule gave
     *  up, else the failure's own sentence. Null while the schedule is still
     *  trying (the loss shows once, on the connection line), once an attempt
     *  succeeds, after a disconnect, and when a failure arrives after the link
     *  stopped being wanted. */
    val connectionError: StateFlow<String?> = _connectionError

    /** Guards every state transition below: `current`, `armed`, `queued`,
     *  `stoppingBurst`/`queueOnStop`, and `_session`'s check-then-act moves.
     *  Serializing them is also what keeps `startInventory()` from
     *  overlapping a concurrent settings push or trigger decision on the
     *  radio. It is deliberately *not* held across `reader.stopInventory()`
     *  — see the class doc. */
    private val mutex = Mutex()
    private var current: RfidSettings = DEFAULT_RFID_SETTINGS
    private var armed: Boolean = false
    /** The screen that armed the trigger, or null once it disarmed. */
    private var owner: String? = null
    /** The owner armed when the open burst started; its emission carries it. */
    private var sessionOwner: String? = null
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

    /** Serializes `reader.stopInventory()` (and the session claim right
     *  after it) against trigger evaluation — see the class doc. Never held
     *  across anything `onTag` needs. */
    private val stopGate = Mutex()

    /** A second, narrow lock so [push] never has to hold `mutex` across
     *  `reader.apply()` — see the class doc. It exists purely to serialize
     *  `apply()` against `startInventory()` and against [setRegion] on the
     *  vendor link (the nesting in [onTrigger]'s `TriggerAction.START`
     *  branch, and in [setRegion] itself): a slow or hung settings push can
     *  delay a later push, and can delay a trigger START or a region write
     *  specifically (bounded by `VENDOR_TIMEOUT_MS` in the worst case, since
     *  both wait on `applyGate` while holding `mutex`), but nothing else —
     *  not a tag report, an arm/disarm, or `endBurst`, all of which only
     *  ever need `mutex`, which [push] never holds. Nothing that holds
     *  `applyGate` (`push()` or `setRegion()`) ever tries to acquire
     *  `mutex`, so nesting `mutex` outside it at either call site cannot
     *  deadlock: `mutex` is always acquired first and `applyGate` second,
     *  by every caller, so there is no cycle. The link calls under [linkGate]
     *  also hold it, for the reader call alone, so a push never overlaps a
     *  connect or a disconnect. */
    private val applyGate = Mutex()

    // ── the link (see the class doc) ──

    /** Serializes every connect and disconnect; outermost in the lock order. */
    private val linkGate = Mutex()

    /** Whether the last link call wanted the link up. Written without
     *  suspending, before the matching command is queued. */
    private val linkWanted = AtomicBoolean(false)

    /** [connectForLifecycle]'s gate, run by every automatic attempt. Null
     *  until the first lifecycle connect, and a null gate does not dial. */
    private val storedGate = AtomicReference<(suspend () -> Boolean)?>(null)

    @Volatile private var sledScreenOpen = false

    /** The address of the last sled the link was up with, for [nudge]. */
    @Volatile private var lastSledAddress: String? = null

    /** The saved `readerAddress`, as the settings collector last saw it. */
    @Volatile private var savedAddress: String? = null

    /** A reconnect schedule in progress: [tries] made so far (the drop or the
     *  first failure is not one), and what [retry] publishes. */
    private data class Schedule(val afterDrop: Boolean, val name: String?, val tries: Int, val lastReason: String?)

    /** Where an attempt came from. RETRY, NUDGE and BATCH run as the retry job. */
    private enum class Origin { LIFECYCLE, SWITCH, MANUAL, RETRY, NUDGE, BATCH }

    /** One connect attempt. A manual one re-reads only [linkWanted]; an
     *  automatic one also runs [storedGate]. [epoch] is the retry epoch a
     *  retry-job attempt was launched in. */
    private class Attempt(val origin: Origin, val manual: Boolean, val epoch: Int = 0) {
        val fromJob: Boolean get() = origin == Origin.RETRY || origin == Origin.NUDGE || origin == Origin.BATCH
    }

    private enum class LinkOutcome { SKIPPED, ALREADY_UP, DIALED }

    /** Guards the retry fields below. Held only for plain reads and writes,
     *  never across a suspension. */
    private val retryLock = Any()
    private var schedule: Schedule? = null
    /** The one pending or running retry-job try, if any. */
    private var retryJob: Job? = null
    /** Completed by [nudge] to end the retry job's wait early. Non-null only during that wait. */
    private var wake: CompletableDeferred<Unit>? = null
    /** Bumped by [cancelRetry]; a retry job launched in an earlier epoch never dials. */
    private var epoch = 0
    /** True from the moment an attempt dials until its outcome is handled. */
    private var dialing = false
    private var lastAttemptEndMs: Long? = null
    private var givenUp = false
    private var giveUpSentence: String? = null

    private sealed interface Command {
        data class Arm(val owner: String) : Command
        data class Disarm(val owner: String) : Command
        data object Stop : Command
    }

    /** Unlimited so `arm()`/`disarm()`/`stopBurst()` can never block their UI
     *  caller and never drop a command for lack of buffer room; a
     *  constructor property, not something `start()` allocates, so a
     *  command sent before `start()` runs is queued, not lost. Deliberately
     *  separate from [connectionCommands] — see the class doc — so a slow
     *  or hung `reader.connect()`/`reader.disconnect()` can never delay
     *  arm/disarm/stop. */
    private val commands = Channel<Command>(Channel.UNLIMITED)

    private sealed interface ConnectionCommand {
        /** Answers the caller when the command could not run at all. */
        fun abandon()

        class Connect(val attempt: Attempt, val reply: CompletableDeferred<Result<Unit>>? = null) : ConnectionCommand {
            override fun abandon() { reply?.complete(Result.failure(SledNotConnected())) }
        }

        class Disconnect(val reply: CompletableDeferred<Unit>? = null) : ConnectionCommand {
            override fun abandon() { reply?.complete(Unit) }
        }

        /** A disconnect and a manual connect: for a newly chosen sled
         *  ([forAddress]) or after a region was set in `NeedsRegion`. */
        class Reconnect(val forAddress: Boolean, val reply: CompletableDeferred<Unit>? = null) : ConnectionCommand {
            override fun abandon() { reply?.complete(Unit) }
        }
    }

    /** [commands]'s sibling for every link call — same unlimited-capacity,
     *  never-lost, buffered-before-`start()` reasoning, but its own channel
     *  and its own single consumer so link calls order among themselves
     *  without ever blocking arm/disarm/stop, or being blocked by them. */
    private val connectionCommands = Channel<ConnectionCommand>(Channel.UNLIMITED)
    private val linkConsumerStarted = AtomicBoolean(false)

    companion object {
        /** How long a connect may take before the caller is told the sled
         *  couldn't be reached. Every vendor wait inside is bounded, so the
         *  reader's own call still returns, later. */
        const val CONNECT_WAIT_MS = 30_000L

        /** The connect wait once the reader reported a batch-mode recovery in
         *  the attempt (its own cleanup takes up to 20 s). */
        const val CONNECT_WAIT_BATCH_MS = 60_000L

        /** How long a disconnect may take before the controller logs it. */
        const val DISCONNECT_WAIT_MS = 10_000L

        /** A nudge within this long of an attempt ending is ignored. */
        const val NUDGE_QUIET_MS = 2_000L

        /** Ceiling on how long `reader.apply()`, `reader.regions()` and
         *  `reader.setRegion()` may suspend before the controller gives up on
         *  them — defense against a vendor stack that never returns at all,
         *  not a tuning knob. */
        private const val VENDOR_TIMEOUT_MS = 15_000L

        /** How often a retry waiting for the printer checks it again. */
        private const val PRINTER_POLL_MS = 500L

        private const val TAG = "RfidController"
    }

    fun start() {
        scope.launch {
            // The first collected value is not a change: the reader switch's
            // edges and a newly chosen sled are both changes between two
            // collected values (prefs.rfid re-emits on every DataStore write).
            var previous: RfidSettings? = null
            settings.collect { s ->
                // The compare-and-write has to happen inside the lock, not
                // just the push: `current` is read by every other collector
                // and by onTrigger/onTag under `mutex`, so a write outside it
                // publishes with no happens-before edge to those readers. A
                // settings change made while disconnected (so `changed` is
                // true but nothing pushes) would otherwise sit unpublished
                // until something else happened to take the lock.
                val changed = mutex.withLock {
                    // Toggling only `enabled` is a real, common event — the
                    // RFID panel's switch does exactly this — and `apply()`
                    // never reads `enabled` at all, so it is not worth a push
                    // (its edges connect and disconnect instead, below):
                    // comparing with `enabled` forced to match `current`'s
                    // isolates that one field without hand-listing every other
                    // one of RfidSettings. `current` itself must still hold
                    // the true, current `enabled` value.
                    //
                    // `region` is excluded the same way, for the same
                    // reason: [setRegion] writes the picked code straight
                    // into `RfidSettings.region` (via `prefs.setRfid`) so
                    // this row — and the RFID tab's read-only line — can
                    // say something useful while disconnected, but `apply()`
                    // never reads `region` either. Without this exclusion,
                    // every region change would also fire a full eight-round-
                    // trip settings push for nothing: region is a compliance
                    // setting, pushed only on explicit admin action via
                    // [setRegion], never folded into the ordinary settings
                    // push.
                    //
                    // `triggerLayout`/`readerAddress` are excluded for the
                    // same reason: `apply()` never reads either. The layout
                    // reaches the sled through the connect request (built
                    // from `settings.first()` right before every connect) and
                    // the reader's own layout write; the address only says
                    // which sled to dial. Neither should fire an eight-round-
                    // trip settings push on its own.
                    val c = s.copy(
                        enabled = current.enabled,
                        region = current.region,
                        triggerLayout = current.triggerLayout,
                        readerAddress = current.readerAddress,
                    ) != current
                    current = s
                    c
                }
                savedAddress = s.readerAddress
                previous?.let { onSettingsChange(it, s) }
                previous = s
                if (changed && reader.connection.value is RfidConnection.Connected) {
                    // No `mutex` involved: `s` is already a plain value from
                    // the collected flow, and `push()` must never run under
                    // `mutex` — see the class doc and [applyGate].
                    applyGate.withLock { push(s) }
                }
            }
        }
        scope.launch { reader.triggers.collect { onTrigger(it) } }
        scope.launch { reader.tags.collect { onTag(it) } }
        scope.launch {
            // Seeded false, not from reader.connection.value: a reader that
            // is already Connected before start() runs must still have its
            // first observed Connected treated as a transition, or its
            // settings are never pushed and it is left running firmware
            // defaults until an unrelated setting happens to change.
            // StateFlow.collect always replays the current value first, so
            // this costs nothing when the reader really is starting
            // disconnected — that first replay just reads as "no change."
            var wasConnected = false
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
                    // saying so. Read `current` under `mutex`, then release it
                    // before pushing — `push()` must never run under `mutex` —
                    // see the class doc and [applyGate].
                    val toPush = mutex.withLock { current }
                    applyGate.withLock { push(toPush) }
                }
                wasConnected = nowConnected
            }
        }
        // Its own collector, never suspending, so a push in flight above
        // never delays noticing a drop.
        scope.launch {
            reader.connection.collect { c ->
                when (c) {
                    is RfidConnection.Connected, is RfidConnection.NeedsRegion -> onLinkUp()
                    is RfidConnection.Failed -> if (c.retryable) onLinkLost(c)
                    else -> Unit
                }
            }
        }
        scope.launch { reader.info.collect { i -> i?.address?.let { lastSledAddress = it } } }
        // Single consumer of `commands`, so arm()/disarm()/stopBurst() all
        // run in exactly the order they were sent — see the class doc.
        // Nothing here ever waits on `connectionCommands` or its consumer,
        // so a slow or hung connect/disconnect on the *other* queue can
        // never delay any of these three.
        scope.launch {
            for (command in commands) {
                when (command) {
                    is Command.Arm -> armNow(command.owner)
                    is Command.Disarm -> disarmNow(command.owner)
                    Command.Stop -> endBurst(stopReader = true, queue = true)
                }
            }
        }
        ensureLinkConsumer()
    }

    /** A screen that reads RFID calls this while it is composed, with its own
     *  [RfidOwner] key (Scanning's by default). Another owner than the armed
     *  one takes the trigger over as a new visit: see the class doc. */
    fun arm(owner: String = RfidOwner.SCANNING) {
        check(commands.trySend(Command.Arm(owner)).isSuccess) {
            "Couldn't queue arm(): the command channel is closed."
        }
    }

    /** Leaving the screen ends any read in progress. Its tags are dropped: the
     *  screen that would queue them is gone. A no-op unless [owner] is the one
     *  armed, so a leaving screen's late dispose can't disarm the next one. */
    fun disarm(owner: String = RfidOwner.SCANNING) {
        check(commands.trySend(Command.Disarm(owner)).isSuccess) {
            "Couldn't queue disarm(): the command channel is closed."
        }
    }

    /** The Stop button, for a latched or toggled read. */
    fun stopBurst() {
        check(commands.trySend(Command.Stop).isSuccess) {
            "Couldn't queue stopBurst(): the command channel is closed."
        }
    }

    /** `ProcessLifecycleOwner`'s observer calls this from `onStart`, directly,
     *  never from inside its own `scope.launch` — see the class doc. [gate]
     *  (`enabled` and the permissions, which needs a suspending prefs read) is
     *  stored for every automatic attempt and runs once the command's turn
     *  comes up, not here: evaluating it before enqueueing would let its
     *  suspension reorder this call behind a later [disconnectForLifecycle]. */
    fun connectForLifecycle(gate: suspend () -> Boolean) {
        storedGate.set(gate)
        linkWanted.set(true)
        send(ConnectionCommand.Connect(Attempt(Origin.LIFECYCLE, manual = false)), "connectForLifecycle()")
    }

    /** `ProcessLifecycleOwner`'s observer calls this from `onStop` — the
     *  mirror of [connectForLifecycle]. It also ends any reconnect schedule. */
    fun disconnectForLifecycle() {
        linkWanted.set(false)
        cancelRetry()
        send(ConnectionCommand.Disconnect(), "disconnectForLifecycle()")
    }

    /** The Connect button: a manual attempt, which ignores `enabled` (ruling
     *  32). Runs on the controller's scope; the caller only awaits the answer,
     *  which comes at the connect wait at the latest. Settings are pushed by
     *  the connection collector on the resulting Connected transition, the
     *  same path a self-initiated reconnect uses. */
    suspend fun connectNow(): Result<Unit> {
        linkWanted.set(true)
        val reply = CompletableDeferred<Result<Unit>>()
        send(ConnectionCommand.Connect(Attempt(Origin.MANUAL, manual = true), reply), "connectNow()")
        ensureLinkConsumer()
        return reply.await()
    }

    /** The Disconnect button. Ends any reconnect schedule, then disconnects
     *  on the controller's scope; the caller only awaits. An explicit
     *  disconnect still queues what was already read. */
    suspend fun disconnectNow() {
        linkWanted.set(false)
        cancelRetry()
        val reply = CompletableDeferred<Unit>()
        send(ConnectionCommand.Disconnect(reply), "disconnectNow()")
        ensureLinkConsumer()
        reply.await()
    }

    /** The RFID tab's Stop while reconnecting: the link is no longer wanted
     *  and the schedule ends. Nothing is disconnected. */
    fun stopReconnecting() {
        linkWanted.set(false)
        cancelRetry()
    }

    /**
     * Whether a sled screen is in front (Scanning, Asset Lookup, RFID Enroll,
     * Print Labels, Settings › RFID). While one is, a connect that never came
     * up gets the reconnect schedule; opening one while the link is in such a
     * retryable failure starts it, once.
     */
    fun setSledScreenOpen(open: Boolean) {
        sledScreenOpen = open
        if (open) scope.launch { startScheduleForANeverUpFailure() }
    }

    /**
     * The app's Bluetooth receiver: Bluetooth came on, or a link appeared.
     * [SledNudge.LINK_APPEARED] counts only for the last connected sled's
     * address or, when none is known, a device whose [name] is a sled's. A
     * nudge shortens a reconnect wait in progress, or starts one try when the
     * link is wanted and down; see the class doc for when it is ignored.
     */
    fun nudge(reason: SledNudge, address: String? = null, name: String? = null) {
        if (reason == SledNudge.LINK_APPEARED && !isOurSled(address, name)) return
        synchronized(retryLock) {
            if (dialing) return
            lastAttemptEndMs?.let { if (clock() - it < NUDGE_QUIET_MS) return }
            wake?.let {
                Log.i(TAG, "Nudge ($reason): trying the sled now instead of at the end of the wait.")
                it.complete(Unit)
                wake = null
                return
            }
            if (retryJob != null || !linkWanted.get()) return
            when (reader.connection.value) {
                is RfidConnection.Connected, is RfidConnection.NeedsRegion, RfidConnection.Connecting -> return
                else -> Unit
            }
            Log.i(TAG, "Nudge ($reason): one try.")
            launchTry(Origin.NUDGE, waitMs = 0, manual = false)
        }
    }

    private suspend fun armNow(owner: String) {
        val takeover = mutex.withLock {
            // `queued` is "what this visit to the screen already sent"; a
            // *new* visit starts that over, or a repeat-sweep policy
            // would drop every tag on the operator's next sweep forever.
            // But a re-arm within the same visit — a lifecycle-aware
            // collector re-firing, or a return from a dialog — must not
            // wipe the sweep history the operator is mid-visit through.
            // Another owner arming is always a new visit, even before the
            // previous owner's disarm has landed.
            val takeover = armed && this.owner != owner
            if (!armed || takeover) queued = emptySet()
            armed = true
            this.owner = owner
            takeover
        }
        // The previous owner's open burst is dropped, as its own disarm would
        // have done: the screen it was read for is leaving. A burst the new
        // owner started in between (a trigger pulled in that gap) is kept.
        if (takeover) endBurst(stopReader = true, queue = false, unlessOwnedBy = owner)
    }

    private suspend fun disarmNow(owner: String) {
        val mine = mutex.withLock {
            if (this.owner != owner) return@withLock false
            armed = false
            this.owner = null
            true
        }
        if (mine) endBurst(stopReader = true, queue = false)
    }

    /** Removes tags whose write to the outbox failed from `queued`, so a tag
     *  that never actually persisted is not silently treated as
     *  already-sent on the next sweep. `values` are raw EPCs — the same
     *  shape [bursts] emits and `ScanViewModel.onBurst` receives — not the
     *  normalized keys `queued` stores internally; this does that
     *  translation so callers never need to know about key normalization. */
    suspend fun forgetQueued(values: List<String>) = mutex.withLock {
        queued = queued - values.mapNotNull { rfidKey(it) }.toSet()
    }

    /** The one place `reader.apply()` is actually called — always under
     *  [applyGate], never under `mutex`; see the class doc. Wrapped in the
     *  `VENDOR_TIMEOUT_MS` defense, since `apply()` otherwise has no timeout
     *  of its own and a soft-hung vendor stack would wedge `applyGate`
     *  forever. */
    private suspend fun push(s: RfidSettings) {
        val result = withTimeoutOrNull(VENDOR_TIMEOUT_MS) { reader.apply(s) }
            ?: Result.failure(IllegalStateException("Pushing settings to the reader timed out."))
        _applyError.value = if (result.isFailure) {
            result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() }
                ?: "The reader refused the settings."
        } else {
            null
        }
    }

    /** The regions this reader allows and the one in force — a plain
     *  passthrough to [RfidReader.regions]. Region is a compliance setting,
     *  not part of [RfidSettings]/[push]: it is never pushed automatically,
     *  only read or set on explicit admin action. No controller state guards
     *  it, so this never touches `mutex` or `applyGate`; the reader itself
     *  reports "not connected" when there is nothing to read (see
     *  `neitherCallWorksWhileDisconnected`). Wrapped in the same
     *  `VENDOR_TIMEOUT_MS` defense [push]/[setRegion] use for their own
     *  vendor calls, so a soft-hung vendor stack is reported rather than
     *  leaving the caller suspended forever. */
    suspend fun loadRegions(): Result<RfidRegions> =
        withTimeoutOrNull(VENDOR_TIMEOUT_MS) { reader.regions() }
            ?: Result.failure(IllegalStateException("Loading the reader's regions timed out."))

    /** Set the regulatory domain. Refused while a burst is open — changing
     *  the radio's regulatory domain mid-sweep is not something to find out
     *  about experimentally — in which case [RfidReader.setRegion] is never
     *  called.
     *
     *  The open-burst check and the [applyGate] acquisition both happen
     *  under `mutex` — `applyGate` inner, `mutex` outer, exactly the nesting
     *  [onTrigger]'s `TriggerAction.START` branch uses for
     *  `startInventory()` — then `mutex` is released and the vendor round
     *  trip runs under `applyGate` alone. A check-then-act refusal that
     *  released `mutex` before the vendor call (the previous shape) left a
     *  gap where a trigger START could land in between: it would see no
     *  session open, open one, and call `startInventory()` while this call's
     *  `reader.setRegion()` was still in flight — the radio would begin
     *  transmitting while its regulatory domain was being rewritten
     *  underneath it, the exact hazard the open-burst refusal exists to
     *  prevent, and the same gap let a region write interleave with
     *  [push]'s own sequence of vendor round trips. Acquiring `applyGate`
     *  before releasing `mutex` closes it: START's own `applyGate.withLock`
     *  (taken after this call has already moved `_session` past the check
     *  and released `mutex`, so START still opens its session) cannot
     *  proceed to `startInventory()` until this call's `applyGate.unlock()`
     *  runs, and a concurrent [push] is held off the same way. Nothing that
     *  holds `applyGate` — [push] or this call itself — ever tries to
     *  acquire `mutex`, and every caller acquires `mutex` before `applyGate`,
     *  never the reverse, so there is no cycle and this cannot deadlock —
     *  see the class doc.
     *
     *  Wrapped in the same `VENDOR_TIMEOUT_MS` defense [push] uses: without
     *  it, a soft-hung vendor stack would wedge `applyGate` — and therefore
     *  every later trigger START and settings push — forever, not just this
     *  call.
     *
     *  A sled in `NeedsRegion` has to be set up again once it has a region:
     *  after a successful write there, `applyGate` is released first, then
     *  the sled is disconnected and connected under [linkGate] (a manual
     *  attempt), and this returns once that connect has finished. The result
     *  is the region write's. */
    suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> {
        val holdingGate = mutex.withLock {
            if (_session.value != null) return@withLock false
            applyGate.lock()
            true
        }
        if (!holdingGate) {
            return Result.failure(IllegalStateException("Finish the current read before changing the region."))
        }
        val result = try {
            withTimeoutOrNull(VENDOR_TIMEOUT_MS) { reader.setRegion(code, hopping) }
                ?: Result.failure(IllegalStateException("Setting the region timed out."))
        } finally {
            applyGate.unlock()
        }
        if (result.isSuccess && reader.connection.value is RfidConnection.NeedsRegion) {
            val reply = CompletableDeferred<Unit>()
            send(ConnectionCommand.Reconnect(forAddress = false, reply), "setRegion()")
            ensureLinkConsumer()
            reply.await()
        }
        return result
    }

    // ── link internals ──

    private fun send(command: ConnectionCommand, caller: String) {
        check(connectionCommands.trySend(command).isSuccess) {
            "Couldn't queue $caller: the connection command channel is closed."
        }
    }

    /** Starts the single consumer of [connectionCommands], once: from [start],
     *  or from the first call that awaits a link command. */
    private fun ensureLinkConsumer() {
        if (!linkConsumerStarted.compareAndSet(false, true)) return
        scope.launch {
            for (command in connectionCommands) {
                try {
                    linkGate.withLock {
                        when (command) {
                            is ConnectionCommand.Connect -> connectLocked(command.attempt, command.reply)
                            is ConnectionCommand.Disconnect -> disconnectLocked(command.reply)
                            is ConnectionCommand.Reconnect -> reconnectLocked(command.forAddress, command.reply)
                        }
                    }
                } catch (e: CancellationException) {
                    command.abandon()
                    throw e
                } catch (e: Throwable) {
                    // Anything escaping here would kill the one consumer and
                    // leave every later link call unanswered.
                    Log.e(TAG, "A link command failed.", e)
                    command.abandon()
                }
            }
        }
    }

    /** Called holding [linkGate]. Dials unless the attempt is not wanted any
     *  more or its gate is closed, or the link is already up. Answers [reply]
     *  at the connect wait at the latest, and returns only once the reader's
     *  own call has returned. */
    private suspend fun connectLocked(attempt: Attempt, reply: CompletableDeferred<Result<Unit>>?): LinkOutcome {
        val skip = whyNotDial(attempt)
        if (skip != null) {
            Log.i(TAG, "Not connecting (${attempt.origin}): $skip.")
            reply?.complete(Result.failure(SledNotConnected()))
            return LinkOutcome.SKIPPED
        }
        val state = reader.connection.value
        if (state is RfidConnection.Connected || state is RfidConnection.NeedsRegion) {
            reply?.complete(Result.success(Unit))
            return LinkOutcome.ALREADY_UP
        }
        // From the saved settings, not `current`: a lifecycle connect issued
        // before the settings collector's first value still carries the saved
        // sled and trigger layout.
        val request = settings.first().let { SledConnectRequest(it.readerAddress, it.triggerLayout) }
        if (!beginAttempt(attempt)) {
            reply?.complete(Result.failure(SledNotConnected()))
            return LinkOutcome.SKIPPED
        }
        val result = try {
            awaitConnect(request) { sentence ->
                _connectionError.value = sentence
                reply?.complete(Result.failure(SledConnectException(RfidConnection.Failed(sentence, retryable = true))))
            }
        } catch (e: Throwable) {
            synchronized(retryLock) { dialing = false }
            throw e
        }
        endAttempt(attempt, request, result)
        reply?.complete(result)
        return LinkOutcome.DIALED
    }

    private suspend fun whyNotDial(attempt: Attempt): String? {
        if (!linkWanted.get()) return "the link is not wanted"
        if (attempt.manual) return null
        val gate = storedGate.get() ?: return "no lifecycle gate yet"
        if (!gateOpen(gate)) return "the reader is off or a permission is missing"
        return if (linkWanted.get()) null else "the link is not wanted"
    }

    private suspend fun gateOpen(gate: suspend () -> Boolean): Boolean = try {
        gate()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Log.w(TAG, "The connect gate failed.", e)
        false
    }

    /** Marks the attempt as dialing and cancels a pending retry wait (any
     *  attempt takes the place of the next try). False when the attempt is
     *  a retry job's from an earlier epoch, or the link stopped being wanted. */
    private fun beginAttempt(attempt: Attempt): Boolean = synchronized(retryLock) {
        if (!linkWanted.get()) return false
        if (attempt.fromJob && attempt.epoch != epoch) return false
        dialing = true
        if (!attempt.fromJob) {
            retryJob?.cancel()
            retryJob = null
            wake = null
        }
        if (attempt.manual) givenUp = false
        true
    }

    /** Runs `reader.connect()` on the controller's scope, under [applyGate],
     *  and waits for it. When the connect wait runs out, [onTimeout] gets the
     *  couldn't-reach sentence and the wait goes on: the reader's call always
     *  returns (every vendor wait inside it is bounded), and the gate held by
     *  the caller must outlast it. */
    private suspend fun awaitConnect(request: SledConnectRequest, onTimeout: (String) -> Unit): Result<Unit> =
        withContext(NonCancellable) {
            val call = scope.async { applyGate.withLock { readerCall { reader.connect(request) } } }
            val batchSeen = AtomicBoolean(false)
            val watch = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                reader.batchRecovery.first { it }
                batchSeen.set(true)
            }
            try {
                var answer = withTimeoutOrNull(CONNECT_WAIT_MS) { call.await() }
                if (answer == null && batchSeen.get()) {
                    answer = withTimeoutOrNull(CONNECT_WAIT_BATCH_MS - CONNECT_WAIT_MS) { call.await() }
                }
                if (answer == null) {
                    Log.w(TAG, "connect() gave no answer within the connect wait; holding the link until it returns.")
                    onTimeout(couldNotReach(request))
                }
                call.await()
            } finally {
                watch.cancel()
            }
        }

    private suspend fun readerCall(body: suspend () -> Result<Unit>): Result<Unit> = try {
        body()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Result.failure(e)
    }

    /** Called holding [linkGate]: ends any open sweep (its tags are queued:
     *  the operator asked the reader to stop, not for those tags to vanish),
     *  then disconnects under [applyGate]. */
    private suspend fun disconnectLocked(reply: CompletableDeferred<Unit>?) {
        try {
            endBurst(stopReader = true, queue = true)
            val call = scope.async {
                applyGate.withLock {
                    try {
                        reader.disconnect()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        Log.w(TAG, "disconnect() threw.", e)
                    }
                }
            }
            if (withTimeoutOrNull(DISCONNECT_WAIT_MS) { call.await() } == null) {
                Log.w(TAG, "disconnect() gave no answer within $DISCONNECT_WAIT_MS ms; holding the link until it returns.")
                reply?.complete(Unit)
            }
            call.await()
            _connectionError.value = null
        } finally {
            reply?.complete(Unit)
        }
    }

    /** Called holding [linkGate]: a disconnect and a manual connect, while
     *  the link is wanted. For a newly chosen sled, nothing happens when the
     *  link is already up with the saved sled. */
    private suspend fun reconnectLocked(forAddress: Boolean, reply: CompletableDeferred<Unit>?) {
        try {
            if (!linkWanted.get()) {
                Log.i(TAG, "Not reconnecting: the link is not wanted.")
                return
            }
            if (forAddress && upWithTheSavedSled()) return
            disconnectLocked(null)
            connectLocked(Attempt(Origin.MANUAL, manual = true), null)
        } finally {
            reply?.complete(Unit)
        }
    }

    private suspend fun upWithTheSavedSled(): Boolean {
        val state = reader.connection.value
        val up = state is RfidConnection.Connected || state is RfidConnection.NeedsRegion
        return up && reader.info.value?.address.equals(settings.first().readerAddress, ignoreCase = true)
    }

    /** The reader switch's edges and a newly chosen sled. Only enqueues. */
    private fun onSettingsChange(before: RfidSettings, after: RfidSettings) {
        if (!before.enabled && after.enabled) {
            linkWanted.set(true)
            send(ConnectionCommand.Connect(Attempt(Origin.SWITCH, manual = false)), "the reader switch")
        } else if (before.enabled && !after.enabled) {
            linkWanted.set(false)
            cancelRetry()
            send(ConnectionCommand.Disconnect(), "the reader switch")
        }
        if (!before.readerAddress.equals(after.readerAddress, ignoreCase = true) && reconnectsFor(after.readerAddress)) {
            send(ConnectionCommand.Reconnect(forAddress = true), "the saved sled")
        }
    }

    /** A new saved address reconnects while a connect runs, or while the link
     *  is up with a sled at another address. */
    private fun reconnectsFor(address: String?): Boolean = when (reader.connection.value) {
        RfidConnection.Connecting -> true
        is RfidConnection.Connected, is RfidConnection.NeedsRegion ->
            !reader.info.value?.address.equals(address, ignoreCase = true)
        else -> false
    }

    private fun isOurSled(address: String?, name: String?): Boolean {
        val known = lastSledAddress ?: savedAddress
        return if (known != null) address.equals(known, ignoreCase = true) else isSledName(name)
    }

    private fun failureOf(e: Throwable?): RfidConnection.Failed =
        (e as? SledConnectException)?.failed
            ?: RfidConnection.Failed(e?.message?.takeIf { it.isNotBlank() } ?: SledWords.couldNotReach(null))

    private fun pairedName(address: String?, paired: List<SledCandidate>): String? =
        address?.let { a -> paired.firstOrNull { it.address.equals(a, ignoreCase = true) }?.name }

    private fun couldNotReach(request: SledConnectRequest): String {
        val paired = reader.pairedSleds()
        val name = synchronized(retryLock) { schedule?.name } ?: pairedName(request.address, paired)
        return SledWords.couldNotReach(name, severalPaired = paired.size >= 2)
    }

    /** The reconnect rules, applied to an attempt that dialed. */
    private fun endAttempt(attempt: Attempt, request: SledConnectRequest, result: Result<Unit>) {
        val paired = if (result.isFailure) reader.pairedSleds() else emptyList()
        synchronized(retryLock) {
            dialing = false
            lastAttemptEndMs = clock()
            if (attempt.fromJob && attempt.epoch == epoch) {
                // This job is finishing (an epoch still current means the slot
                // holds it); a next try is a new job.
                retryJob = null
                wake = null
            }
            if (result.isSuccess) {
                endSchedule()
                givenUp = false
                _connectionError.value = null
                return
            }
            if (attempt.fromJob && attempt.epoch != epoch) return
            if (!linkWanted.get()) {
                endSchedule()
                _connectionError.value = null
                return
            }
            val failed = failureOf(result.exceptionOrNull())
            val running = schedule
            when {
                failed.retryable && failed.reason == SledWords.BATCH_CLEARED_RETRYING && attempt.origin != Origin.BATCH -> {
                    // One more try at once, on any screen; the count stays.
                    running?.let { publish(it.copy(lastReason = failed.reason)) }
                    _connectionError.value = null
                    launchTry(Origin.BATCH, waitMs = 0, manual = attempt.manual)
                }
                !failed.retryable -> {
                    endSchedule()
                    _connectionError.value = failed.reason
                }
                attempt.manual && sledScreenOpen -> {
                    givenUp = false
                    publish(
                        Schedule(
                            afterDrop = running?.afterDrop ?: false,
                            name = running?.name ?: pairedName(request.address, paired),
                            tries = 0,
                            lastReason = failed.reason,
                        ),
                    )
                    _connectionError.value = null
                    launchTry(Origin.RETRY, OutboxMachine.BACKOFF[0], manual = false)
                }
                running != null -> {
                    val next = running.copy(tries = running.tries + 1, lastReason = failed.reason)
                    if (next.tries >= OutboxMachine.BACKOFF.size) {
                        giveUp(next, paired)
                    } else {
                        publish(next)
                        _connectionError.value = null
                        launchTry(Origin.RETRY, OutboxMachine.BACKOFF[next.tries], manual = false)
                    }
                }
                // A nudge's try after giving up: still given up.
                givenUp -> _connectionError.value = giveUpSentence
                sledScreenOpen -> {
                    publish(Schedule(afterDrop = false, name = pairedName(request.address, paired), tries = 0, lastReason = failed.reason))
                    _connectionError.value = null
                    launchTry(Origin.RETRY, OutboxMachine.BACKOFF[0], manual = false)
                }
                else -> _connectionError.value = failed.reason
            }
        }
    }

    /** Holding [retryLock]. */
    private fun giveUp(last: Schedule, paired: List<SledCandidate>) {
        endSchedule()
        givenUp = true
        val sentence = SledWords.couldNotReach(last.name, severalPaired = paired.size >= 2)
        giveUpSentence = sentence
        _connectionError.value = sentence
        Log.i(TAG, "Stopped reconnecting after ${OutboxMachine.BACKOFF.size} tries.")
    }

    /** Holding [retryLock]: [s] is the running schedule; [retry] first, so a
     *  reader that sees [reconnecting] true always finds it. */
    private fun publish(s: Schedule) {
        schedule = s
        _retry.value = SledRetry(s.afterDrop, s.name, s.lastReason)
        _reconnecting.value = true
    }

    /** Holding [retryLock]. */
    private fun endSchedule() {
        if (schedule == null) return
        schedule = null
        _reconnecting.value = false
        _retry.value = null
    }

    /** Holding [retryLock]: one retry-job try after [waitMs]. */
    private fun launchTry(origin: Origin, waitMs: Long, manual: Boolean) {
        val attempt = Attempt(origin, manual, epoch)
        retryJob = scope.launch { runTry(attempt, waitMs) }
    }

    private suspend fun runTry(attempt: Attempt, waitMs: Long) {
        if (waitMs > 0) {
            val w = CompletableDeferred<Unit>()
            synchronized(retryLock) {
                if (attempt.epoch != epoch) return
                wake = w
            }
            withTimeoutOrNull(waitMs) { w.await() }
            synchronized(retryLock) { if (wake === w) wake = null }
        }
        while (printerBusy()) delay(PRINTER_POLL_MS)
        linkGate.lock()
        val outcome = try {
            // Once it holds the gate the try runs to the end: cancelling the
            // schedule (Stop, Disconnect, the reader off, the background) never
            // cuts a vendor call short, and the attempt re-reads linkWanted.
            withContext(NonCancellable) { connectLocked(attempt, null) }
        } finally {
            linkGate.unlock()
        }
        if (outcome != LinkOutcome.DIALED) {
            synchronized(retryLock) {
                if (attempt.epoch == epoch) {
                    // The gate was closed, or the link was up already: the
                    // schedule has nothing left to do.
                    retryJob = null
                    wake = null
                    endSchedule()
                    if (outcome == LinkOutcome.ALREADY_UP) givenUp = false
                }
            }
        }
    }

    /** The link is no longer wanted: end the schedule and its pending try. */
    private fun cancelRetry() {
        synchronized(retryLock) {
            epoch++
            retryJob?.cancel()
            retryJob = null
            wake = null
            endSchedule()
            givenUp = false
        }
    }

    /** The link came up outside an attempt (a test double, the Developer tab):
     *  nothing is left to retry. */
    private fun onLinkUp() {
        synchronized(retryLock) {
            if (dialing) return
            // A try already past its wait must not dial after this.
            if (retryJob != null) epoch++
            retryJob?.cancel()
            retryJob = null
            wake = null
            endSchedule()
            givenUp = false
        }
    }

    /** A retryable failure seen on the connection flow. With `info` kept it is
     *  a drop, and starts the schedule; a connect that never came up has no
     *  `info`, and its attempt applies the rules itself. */
    private fun onLinkLost(c: RfidConnection.Failed) {
        val sled = reader.info.value ?: return
        synchronized(retryLock) {
            if (dialing || schedule != null || retryJob != null || !linkWanted.get()) return
            Log.i(TAG, "The link dropped; reconnecting.")
            publish(Schedule(afterDrop = true, name = sled.name, tries = 0, lastReason = c.reason))
            launchTry(Origin.RETRY, OutboxMachine.BACKOFF[0], manual = false)
        }
    }

    private suspend fun startScheduleForANeverUpFailure() {
        if (!synchronized(retryLock) { neverUpScheduleDue() }) return
        val gate = storedGate.get() ?: return
        if (!gateOpen(gate)) return
        val address = settings.first().readerAddress
        val paired = reader.pairedSleds()
        synchronized(retryLock) {
            if (!neverUpScheduleDue()) return
            val failed = reader.connection.value as? RfidConnection.Failed ?: return
            publish(Schedule(afterDrop = false, name = pairedName(address, paired), tries = 0, lastReason = failed.reason))
            launchTry(Origin.RETRY, OutboxMachine.BACKOFF[0], manual = false)
        }
    }

    /** Holding [retryLock]: a sled screen is open on a retryable failure from a
     *  connect that never came up, with nothing running and not given up. */
    private fun neverUpScheduleDue(): Boolean {
        val state = reader.connection.value
        return sledScreenOpen && state is RfidConnection.Failed && state.retryable && reader.info.value == null &&
            linkWanted.get() && !dialing && schedule == null && retryJob == null && !givenUp
    }

    private suspend fun onTrigger(event: TriggerEvent) {
        // Wait for any in-flight stop to finish before evaluating anything.
        // `endBurst` releases `mutex` across `reader.stopInventory()` (see
        // the class doc), so without this a trigger landing in that window
        // would see the session as still open and read a would-be START as
        // NONE or STOP — the operator's next pull would do nothing. This
        // only gates trigger evaluation: `onTag` never touches `stopGate`,
        // so tags keep folding into the still-open session for the whole
        // vendor round trip.
        stopGate.withLock {}
        var stopRequested = false
        mutex.withLock {
            if (!armed) return@withLock
            val reading = _session.value != null
            val heldMs = if (event == TriggerEvent.RELEASED) clock() - pressedAtMs else 0L
            if (event == TriggerEvent.PRESSED) pressedAtMs = clock()
            when (nextTriggerAction(current.triggerMode, event, reading, heldMs)) {
                TriggerAction.START -> {
                    _session.value = startSession(clock())
                    sessionOwner = owner
                    // applyGate nested inside mutex (mutex outer, applyGate
                    // inner) so a start can never race a settings push on
                    // the vendor link. Nothing that holds applyGate (i.e.
                    // push()) ever tries to acquire mutex, so this ordering
                    // cannot deadlock — see the class doc.
                    applyGate.withLock {
                        try {
                            reader.startInventory()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Throwable) {
                            // The reader may already be gone, or something worse
                            // went wrong (e.g. an Error from the vendor stack) —
                            // the session stays open and endBurst()'s own
                            // try/catch covers the stop. `Throwable` rather than
                            // `Exception` for the same reason endBurst catches
                            // `Throwable` around its own vendor call: this runs
                            // inside the single `reader.triggers` collector
                            // launched in start(), so anything escaping here
                            // kills that collector and leaves every later
                            // trigger event undelivered for the rest of the
                            // process's life.
                        }
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
     *
     * The ownership window (`stoppingBurst = true` through the claim at the
     * bottom) is also the one place a cancelled caller could otherwise leak
     * state forever: if the coroutine running this call is cancelled while
     * suspended in `reader.stopInventory()`, plain cancellation would unwind
     * straight past the claim below, leaving `stoppingBurst` stuck true and
     * `_session` stuck non-null. Every later `endBurst` would then return
     * early forever, the live panel would never close, the radio would keep
     * inventorying, `bursts` would never emit again, and in HOLD mode a new
     * trigger press would evaluate as NONE because a session still looks
     * open — wedged until the process restarts. Every caller now runs on the
     * controller's own scope (a disconnect included: its caller only awaits),
     * so only the scope's end can cancel one, but the `catch
     * (CancellationException)` below still finishes the same claim
     * `withContext(NonCancellable)` (a cancelled coroutine cannot otherwise
     * suspend to take `mutex`), the same idiom `Outbox.sendBatch` uses to
     * persist a batch's outcome under cancellation, before rethrowing. It
     * queues the tags folded in so far exactly when the caller that owned
     * the stop wanted them queued (`queueOnStop`, unchanged by the
     * cancellation).
     */
    private suspend fun endBurst(stopReader: Boolean, queue: Boolean, unlessOwnedBy: String? = null) {
        val owns = mutex.withLock {
            if (_session.value == null) return@withLock false
            if (unlessOwnedBy != null && sessionOwner == unlessOwnedBy) return@withLock false
            if (stoppingBurst) {
                if (!queue) queueOnStop = false
                return@withLock false
            }
            stoppingBurst = true
            queueOnStop = queue
            true
        }
        if (!owns) return

        // Held for the whole ownership window — the vendor stop plus the
        // session claim right after it — so a trigger racing this call (see
        // onTrigger) waits until the burst has genuinely finished before it
        // evaluates anything. Released before the emit below, since a slow
        // `bursts` collector must not hold up a trigger that was only
        // waiting on the stop, not on delivery.
        val (done, shouldQueue) = try {
            stopGate.withLock {
                if (stopReader) {
                    try {
                        reader.stopInventory()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        // the reader is already gone, or something worse went
                        // wrong (e.g. an Error during a large sweep) — the
                        // tags still count; the claim below must still run or
                        // the controller wedges for the process's remaining
                        // lifetime.
                    }
                }

                mutex.withLock {
                    val d = _session.getAndUpdate { null }
                    val q = queueOnStop
                    stoppingBurst = false
                    // Under ALWAYS_QUEUE, `queued` is read nowhere — onTagRead
                    // ignores `alreadyQueued` for that policy — so growing it
                    // forever would be pure waste for a kiosk that sits on
                    // this screen for days.
                    if (d != null && q && current.repeatPolicy != RepeatSweepPolicy.ALWAYS_QUEUE) {
                        queued = queuedAfter(queued, d)
                    }
                    d?.let { OwnedBurst(sessionOwner, burstToScans(it)) } to q
                }
            }
        } catch (e: CancellationException) {
            // See the class/method docs: finish the claim this call already
            // owns so the next trigger pull finds a clean controller, then
            // still rethrow — a cancelled coroutine must not look like it
            // finished normally.
            withContext(NonCancellable) {
                val (d, q) = mutex.withLock {
                    val d = _session.getAndUpdate { null }
                    val q = queueOnStop
                    stoppingBurst = false
                    // See the same guard above: ALWAYS_QUEUE never reads
                    // `queued`, so there is nothing to gain by growing it here.
                    if (d != null && q && current.repeatPolicy != RepeatSweepPolicy.ALWAYS_QUEUE) {
                        queued = queuedAfter(queued, d)
                    }
                    d?.let { OwnedBurst(sessionOwner, burstToScans(it)) } to q
                }
                if (d != null && q) _bursts.emit(d)
            }
            throw e
        }
        // Emitting outside the lock: a slow collector on `bursts` must not
        // stall trigger and tag handling for everyone else.
        if (done != null && shouldQueue) _bursts.emit(done)
    }
}
