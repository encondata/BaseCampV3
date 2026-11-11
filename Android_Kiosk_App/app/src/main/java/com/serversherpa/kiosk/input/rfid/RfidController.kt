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
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledNudge
import com.serversherpa.kiosk.core.rfid.SledRetry
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerAction
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.TriggerPull
import com.serversherpa.kiosk.core.rfid.burstToScans
import com.serversherpa.kiosk.core.rfid.effectiveLayout
import com.serversherpa.kiosk.core.rfid.isNudgeFromOurSled
import com.serversherpa.kiosk.core.rfid.layoutInForceReadsTags
import com.serversherpa.kiosk.core.rfid.layoutInForceUsesScanner
import com.serversherpa.kiosk.core.rfid.nextTriggerAction
import com.serversherpa.kiosk.core.rfid.onTagRead
import com.serversherpa.kiosk.core.rfid.queuedAfter
import com.serversherpa.kiosk.core.rfid.sledNudgeAddress
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
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
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
 * `start()` launches its collectors (settings, trigger pulls, tags, the sled's
 * own stops, the connection collector that queues each new generation's push
 * and layout check, the link-state collector that notices a drop, the sled
 * collector, the battery timer, and the [commands] consumer) and the
 * [connectionCommands] and job-queue consumers on `scope`, which in production
 * is a real thread pool (`Dispatchers.Default`), not a confined dispatcher —
 * so every one of them can run concurrently with every other, and with
 * `arm()`/`disarm()`/`stopBurst()`/`connectNow()`/`disconnectNow()` called
 * from the UI thread. All of the sweep state those touch (`current`,
 * `_session`, `armed`, `queued`, `stoppingBurst`, `queueOnStop`) is therefore
 * only ever read or written under `mutex`, the same idiom `Outbox` uses for
 * its own multi-writer state — every access, not just the ones with something
 * else nearby to protect, since a field a lock only sometimes guards gives no
 * happens-before edge to the accesses that skip it.
 *
 * Two deliberate exceptions to "every access happens under `mutex`" are
 * `reader.stopInventory()` inside [endBurst] and the reader call each queued
 * job makes (a settings push, a layout write, a battery request, a region
 * load) — vendor round trips long enough that holding `mutex` across them
 * would starve `onTag`/`onTrigger` for the duration. The one reader call made
 * under `mutex` is a trigger START's `startInventory()`, bounded by
 * [START_WAIT_MS].
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
 * [applyGate], a second, narrow `Mutex`, is held across every radio call the
 * controller makes (not the scanner's soft trigger or its retry): each queued
 * job's call, a START's `startInventory()`, every `stopInventory()`, a region
 * write, and the link calls. That is what puts one call at a time on the sled while
 * keeping the jobs off `mutex` entirely: a slow settings push never blocks a
 * tag report, an arm/disarm, or [endBurst]'s session claim — those only ever
 * need `mutex`. A trigger START and [setRegion] deliberately acquire
 * `applyGate` *while still holding `mutex`* (see the nesting in [onTrigger]'s
 * `TriggerAction.START` branch and in [setRegion]), so a start or a region
 * write can wait behind a call already in flight, at most [CALL_WAIT_MS] for
 * a job. Nothing that holds `applyGate` ever tries to acquire `mutex`,
 * `stopGate` or `linkGate`, so there is no cycle for two callers to deadlock
 * on: the lock order is `linkGate`, `stopGate`, `mutex`, `applyGate`, the
 * adapter's worker, outermost first.
 *
 * **Sweeps** (spec, Controller › Sweeps; rulings 27, 29 and 45). A pull starts
 * a read only while armed, `Connected`, and the layout in force has a trigger
 * assigned to tags: the sled's accepted read-back, else the effective layout
 * of [requestedLayout] (else the setting, for a link that came up without a
 * controller connect). The latch window is measured from the pull's own
 * stamp. A start waits [START_WAIT_MS]; a failed, timed-out or thrown start
 * is followed by one stop, closes the sweep after `mutex` is released, and
 * sets [readError]. A stop the sled answers with a failure is sent once more;
 * if that fails too, the sled may still be reading: [readError] says so and
 * the next pull sends one stop first. The sled ending a sweep by itself ends
 * it here too, with its tags queued and no sentence.
 *
 * **The job queue** (spec, Controller › Job queue, Battery). Settings pushes,
 * layout writes, battery requests and region loads are jobs on one queue
 * with one consumer, and the collectors only ever enqueue. Pushes coalesce to
 * the latest settings and layout writes to the latest layout, up to the
 * moment the call is made; a battery job is dropped when a sweep is open; a
 * region load is awaited by its caller. Each job first waits until no sweep
 * is open (a layout write first ends the open one, its tags queued), then
 * takes `applyGate` with `tryLock()` under `mutex`, so no job call lands
 * between a START's `startInventory()` and the stop that ends that sweep.
 * Each call waits [CALL_WAIT_MS]. A new generation reaching `Connected`
 * queues one push and, when the sled's read-back does not match the setting,
 * one layout write. Battery is asked after each sweep and after
 * [BATTERY_IDLE_MS] with no sweep and no other job while `Connected`.
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
 * reader reported a batch-mode recovery in the attempt, and for the immediate
 * try after a first batch clear). When it runs out the caller is answered and,
 * while the link is still wanted and no schedule is trying, [connectionError]
 * says the sled couldn't be reached; `linkGate` stays held until the reader's
 * own call returns, so the next link call never overlaps it. A disconnect
 * waits [DISCONNECT_WAIT_MS] the same way and only logs when it runs out.
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
 * ignored during an attempt, the link appearing also for [NUDGE_QUIET_MS]
 * after one (Bluetooth turning on is not: ruling 41 as amended), and a try it
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
     *  reader is still `Connecting` then) while the link is wanted and no
     *  schedule is trying, or when the reconnect schedule gave up, else the
     *  failure's own sentence. Null while the schedule is still trying (the
     *  loss shows once, on the connection line; a schedule that starts clears
     *  what was there), once an attempt succeeds, after a disconnect, and when
     *  a failure arrives after the link stopped being wanted. */
    val connectionError: StateFlow<String?> = _connectionError

    private val _readError = MutableStateFlow<String?>(null)
    /** Why the last read did not start, or that the sled may still be reading
     *  after a stop it did not confirm. Null once a start succeeds. */
    val readError: StateFlow<String?> = _readError

    private val _layoutError = MutableStateFlow<String?>(null)
    /** Why the last trigger-layout write failed. Null once one succeeds, once a
     *  write the controller stopped waiting for finishes with an accepted
     *  read-back, on each new generation (its connect wrote the layout again)
     *  and after a disconnect. */
    val layoutError: StateFlow<String?> = _layoutError

    private val _lastActivityMs = MutableStateFlow(clock())
    /** The [clock] time of the last trigger pull, tag, or [noteActivity],
     *  in steps of [ACTIVITY_STEP_MS] (an activity less than that after the
     *  last stamp leaves it as it is); the display effect's idle timer reads it. */
    val lastActivityMs: StateFlow<Long> = _lastActivityMs

    private val _requestedLayout = MutableStateFlow<SledTriggerLayout?>(null)
    /** The layout the controller last asked of this generation's sled: its
     *  connect request's, then the last layout write's. Null while `info` is
     *  null, and for a link that came up without a controller connect until
     *  a layout write runs. */
    val requestedLayout: StateFlow<SledTriggerLayout?> = _requestedLayout

    private val _layoutInForceUsesScanner = MutableStateFlow(false)
    /** Whether the layout in force uses the sled's scanner: the accepted
     *  read-back, else the effective layout of [requestedLayout] (else the
     *  setting). False while `info` is null. */
    val layoutInForceUsesScanner: StateFlow<Boolean> = _layoutInForceUsesScanner

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
    /** The reader generation the open burst started in (`info.generation`). */
    private var sessionGeneration: Int? = null
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
     *  across anything `onTag` needs. The "may still be reading" stop at the
     *  top of [onTrigger] holds it too. */
    private val stopGate = Mutex()

    /** One radio call at a time — see the class doc. Held across each queued
     *  job's call, a START's `startInventory()` (taken under `mutex`), every
     *  `stopInventory()`, a region write (taken under `mutex`, the call made
     *  after `mutex` is released) and the link calls under [linkGate].
     *  Nothing that holds it ever tries to acquire `mutex`, `stopGate` or
     *  `linkGate`, so taking it inside any of them cannot deadlock. */
    private val applyGate = Mutex()

    /** A stop the sled answered with a failure twice: the next pull sends one
     *  stop before anything else. Written and read under [stopGate]. */
    @Volatile private var mayStillBeReading = false

    // ── the layout in force (see requestedLayout) ──

    /** A layout the controller asked for, and the generation it was asked of;
     *  a null [generation] is a connect still in flight, which owns whatever
     *  generation comes up. */
    private class Requested(val generation: Int?, val layout: SledTriggerLayout)

    /** The connect replaces only its own in-flight instance when its call
     *  returns (`compareAndSet`): a layout write can run between the link
     *  coming up and that return, and the write is the later request. */
    private val requested = AtomicReference<Requested?>(null)

    /** `current.triggerLayout`, readable without `mutex`. */
    @Volatile private var settingLayout: SledTriggerLayout = DEFAULT_RFID_SETTINGS.triggerLayout

    /** True once the settings collector has seen its first value. */
    @Volatile private var settingsSeen = false

    /** The generation of the last layout write the controller stopped
     *  waiting for, until the next write starts or its read-back arrives. */
    @Volatile private var lateLayoutWrite: Int? = null

    private val layoutStateLock = Any()

    // ── the job queue (see the class doc) ──

    private enum class JobKind { PUSH, LAYOUT, BATTERY, REGIONS }

    /** What a job takes when its call is made. */
    private sealed interface JobCall {
        class Push(val settings: RfidSettings) : JobCall
        class Layout(val layout: SledTriggerLayout) : JobCall
        data object Battery : JobCall
        class Regions(val reply: CompletableDeferred<Result<RfidRegions>>) : JobCall
    }

    /** Guards the queue below. Held only for plain reads and writes, never
     *  across a suspension. A job stays at the head of [jobs] until its call
     *  is made, so a change arriving meanwhile coalesces into it. */
    private val jobLock = Any()
    private val jobs = ArrayDeque<JobKind>()
    private var layoutWanted: SledTriggerLayout? = null
    private val regionReplies = ArrayDeque<CompletableDeferred<Result<RfidRegions>>>()
    private val jobWake = Channel<Unit>(Channel.CONFLATED)
    private val jobConsumerStarted = AtomicBoolean(false)
    /** Counts finished jobs, so the battery timer restarts after each. */
    private val jobsDone = MutableStateFlow(0)

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
         *  the attempt, and for the immediate try after a first batch clear,
         *  which on the reader first waits for that attempt's cleanup (up to
         *  20 s) before it dials. */
        const val CONNECT_WAIT_BATCH_MS = 60_000L

        /** How long a disconnect may take before the controller logs it. */
        const val DISCONNECT_WAIT_MS = 10_000L

        /** A link-appeared nudge within this long of an attempt ending is ignored. */
        const val NUDGE_QUIET_MS = 2_000L

        /** How long a trigger START waits for `startInventory()`, counted from
         *  when the call is made. Then one stop, and the sweep closes. */
        const val START_WAIT_MS = 5_000L

        /** Added to [START_WAIT_MS] while "Report each tag once" is on: the
         *  reader clears the sled's tag list before each start, a round trip
         *  of its own with its own status wait, inside the same call. */
        const val PURGE_WAIT_MS = 5_000L

        /** How long each `stopInventory()` is waited for. */
        const val STOP_WAIT_MS = 4_000L

        /** How long every other call is waited for: each queued job's, and a
         *  region write. The reader's own work still finishes; the controller
         *  stops waiting and says so. */
        const val CALL_WAIT_MS = 10_000L

        /** With no sweep and no other job for this long while `Connected`,
         *  the controller asks for the battery level. */
        const val BATTERY_IDLE_MS = 60_000L

        /** How long the Scan button holds the sled's soft trigger when no
         *  barcode arrives. */
        const val SOFT_SCAN_HOLD_MS = 3_000L

        /** [lastActivityMs] moves only when it would move by at least this
         *  much: a sweep reads hundreds of tags a second, and the display's
         *  10-minute idle timer restarts on every change. */
        const val ACTIVITY_STEP_MS = 1_000L

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
                    // its own layout-write job below; the address only says
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
                settingLayout = s.triggerLayout
                settingsSeen = true
                savedAddress = s.readerAddress
                previous?.let { onSettingsChange(it, s) }
                val layoutChanged = previous != null && previous?.triggerLayout != s.triggerLayout
                previous = s
                // Only enqueues: the job queue waits for any open sweep and
                // for `applyGate`, never this collector.
                if (reader.connection.value is RfidConnection.Connected) {
                    if (changed) enqueuePush()
                    if (layoutChanged) enqueueLayout(s.triggerLayout)
                }
                refreshLayoutState()
            }
        }
        scope.launch { reader.pulls.collect { onTrigger(it) } }
        scope.launch { reader.tags.collect { onTag(it) } }
        scope.launch {
            reader.unsolicitedStops.collect { reason ->
                // Ruling 45: no sentence; the tags queue and one stop goes out.
                Log.i(TAG, "The sled ended the sweep by itself ($reason).")
                endBurst(stopReader = true, queue = true)
            }
        }
        scope.launch {
            // Seeded "not connected", not from reader.connection.value: a
            // reader that is already Connected before start() runs must still
            // have its first observed Connected treated as a new generation,
            // or its settings are never pushed and it is left running
            // firmware defaults until an unrelated setting happens to change.
            // Keyed on the state's class and the generation only, so a
            // battery update (a new Connected value) is not a new link.
            var wasConnected = false
            var lastGeneration: Int? = null
            combine(reader.connection, reader.info) { c, i -> c to i }
                .distinctUntilChangedBy { (c, i) -> c::class to i?.generation }
                .collect { (c, i) ->
                    val connected = c is RfidConnection.Connected
                    val generation = i?.generation
                    if (!connected || generation != lastGeneration) {
                        // A burst cannot survive its link: end it where it
                        // stopped and queue what was read. The link is already
                        // gone, so there is nothing left to stop. A burst a pull
                        // opened on the link that is up now (before this
                        // collector got to it) is kept.
                        endBurst(stopReader = false, queue = true, keepLiveLink = true)
                    }
                    // A Connected with no info (a hand-written double) is a new
                    // generation on each transition into Connected.
                    val newGeneration = connected && (!wasConnected || (generation != null && generation != lastGeneration))
                    wasConnected = connected
                    lastGeneration = generation
                    if (newGeneration) {
                        // One push and one layout check per generation, so a
                        // sled that refuses the layout is not written in a loop.
                        enqueuePush()
                        // A failed write belongs to the link it was made on: this
                        // generation's connect wrote the layout again, and a
                        // layout job queued below says so again if it fails.
                        _layoutError.value = null
                        val layout = settingLayoutFor(i)
                        val want = effectiveLayout(layout, zebraHost, i?.hasScanner)
                        if (i?.trigger?.layout != want) enqueueLayout(layout)
                    }
                }
        }
        scope.launch {
            // The battery poll: after BATTERY_IDLE_MS with no sweep and no job
            // finishing while Connected. Every change of the three restarts it.
            combine(
                reader.connection.map { it is RfidConnection.Connected }.distinctUntilChanged(),
                _session.map { it != null }.distinctUntilChanged(),
                jobsDone,
            ) { connected, sweeping, _ -> connected && !sweeping }
                .collectLatest { idle ->
                    if (!idle) return@collectLatest
                    delay(BATTERY_IDLE_MS)
                    enqueueBattery()
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
        scope.launch {
            var seen: SledInfo? = null
            reader.info.collect { i ->
                i?.address?.let { lastSledAddress = it }
                // A layout write the controller stopped waiting for, finishing
                // later with an accepted read-back: the sled took a layout, so
                // the failure that timeout showed no longer stands.
                val trigger = i?.trigger
                if (trigger != null && trigger != seen?.trigger && i.generation == lateLayoutWrite) clearLateLayoutError()
                seen = i
                refreshLayoutState()
            }
        }
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
        ensureJobConsumer()
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
     * [SledNudge.LINK_APPEARED] counts only for the sled [nudgeAddress] names
     * or, when it names none, a device whose [name] is a sled's. A nudge
     * shortens a reconnect wait in progress, or starts one try when the link
     * is wanted and down; see the class doc for when it is ignored.
     */
    fun nudge(reason: SledNudge, address: String? = null, name: String? = null) {
        if (reason == SledNudge.LINK_APPEARED && !isNudgeFromOurSled(address, name, nudgeAddress())) return
        synchronized(retryLock) {
            if (dialing) return
            // The quiet window is for the link appearing, which also fires for
            // the app's own outgoing connect. Bluetooth turning on cannot be an
            // echo of an attempt (none dials while it is off), and after a
            // "Bluetooth is off" failure it is the only way back by itself.
            if (reason == SledNudge.LINK_APPEARED) lastAttemptEndMs?.let { if (clock() - it < NUDGE_QUIET_MS) return }
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

    /** The regions this reader allows and the one in force. Region is a
     *  compliance setting, not part of [RfidSettings]: it is never pushed
     *  automatically, only read or set on explicit admin action, and never
     *  read at connect (the Admin tab asks). A job like the others: it waits
     *  for any open sweep and runs alone on the radio, on the queue's one
     *  consumer, and its caller awaits its result. Cancelling the caller
     *  never cuts the read short. The reader reports "not connected" when
     *  there is nothing to read; a read that never answers fails with
     *  [SledWords.REGIONS_FAILED]. */
    suspend fun loadRegions(): Result<RfidRegions> {
        val reply = CompletableDeferred<Result<RfidRegions>>()
        synchronized(jobLock) {
            regionReplies.addLast(reply)
            jobs.addLast(JobKind.REGIONS)
        }
        wakeJobs()
        return reply.await()
    }

    /** The sled's Scan button on a scan screen (ruling 12): pulls the sled's
     *  soft trigger, then lets go on the first sled barcode or after
     *  [SOFT_SCAN_HOLD_MS], whichever is first. A pull that failed is not
     *  released. Runs on the controller's scope, so leaving the screen
     *  never leaves the trigger pulled; the caller only awaits. */
    suspend fun softScanOnce() {
        scope.launch {
            // Listening before the pull, so a fast barcode is not missed. A
            // reader with no barcode flow (the interface's empty default) lets
            // go at once.
            val first = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeoutOrNull(SOFT_SCAN_HOLD_MS) {
                    try {
                        reader.barcodes.firstOrNull()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        Log.w(TAG, "The barcode flow failed during a soft scan.", e)
                        null
                    }
                }
            }
            val pulled = guarded { reader.softScan(true) }
            if (pulled.isFailure) {
                first.cancel()
                Log.i(TAG, "The soft trigger was not pulled: ${pulled.exceptionOrNull()?.javaClass?.simpleName}.")
                return@launch
            }
            first.await()
            guarded { reader.softScan(false) }.onFailure { Log.w(TAG, "Releasing the soft trigger failed.", it) }
        }.join()
    }

    /** The scanner line's Try again: a plain pass-through. */
    suspend fun retryScanner(): Result<Unit> = guarded { reader.retryScanner() }

    /** A typed scan character or a sled barcode: activity, for the display's
     *  idle timer (pulls and tags count by themselves). */
    fun noteActivity() {
        stampActivity()
    }

    /** Moves [lastActivityMs] to now when that is [ACTIVITY_STEP_MS] or more
     *  after it (or before it: a clock set back), so a sweep's tags change it
     *  about once a second, not once per tag. */
    private fun stampActivity() {
        val now = clock()
        _lastActivityMs.update { last -> if (now - last >= ACTIVITY_STEP_MS || now < last) now else last }
    }

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
     *  The write is waited for [CALL_WAIT_MS], like a job's call: without a
     *  bound, a soft-hung vendor stack would wedge `applyGate` — and
     *  therefore every later trigger START and job — forever, not just this
     *  call. A write that never answers fails with [SledWords.REGION_NOT_SET];
     *  one refused because a sweep is open, with [SledWords.FINISH_READ_FIRST].
     *
     *  A sled in `NeedsRegion` has to be set up again once it has a region:
     *  after a successful write there, `applyGate` is released first, then
     *  the sled is disconnected and connected under [linkGate] (a manual
     *  attempt), and this returns once that connect has finished. The result
     *  is the region write's.
     *
     *  The write, [afterSet] (the caller's own follow-up to a successful
     *  write, such as saving the code) and that reconnect run on the
     *  controller's scope; the caller only awaits. Leaving the Admin tab
     *  mid-write therefore never leaves a sled that took its region stuck in
     *  `NeedsRegion`. */
    suspend fun setRegion(code: String, hopping: Boolean?, afterSet: suspend () -> Unit = {}): Result<Unit> =
        scope.async { setRegionNow(code, hopping, afterSet) }.await()

    private suspend fun setRegionNow(code: String, hopping: Boolean?, afterSet: suspend () -> Unit): Result<Unit> {
        val holdingGate = mutex.withLock {
            if (_session.value != null) return@withLock false
            applyGate.lock()
            true
        }
        if (!holdingGate) {
            return Result.failure(IllegalStateException(SledWords.FINISH_READ_FIRST))
        }
        val result = try {
            withTimeoutOrNull(CALL_WAIT_MS) { guarded { reader.setRegion(code, hopping) } }
                ?: Result.failure(IllegalStateException(SledWords.REGION_NOT_SET))
        } finally {
            applyGate.unlock()
        }
        if (result.isSuccess) {
            // Its failure is the caller's to log; it never skips the reconnect.
            guarded { afterSet(); Result.success(Unit) }.onFailure { Log.w(TAG, "The follow-up to a region write failed.", it) }
        }
        if (result.isSuccess && reader.connection.value is RfidConnection.NeedsRegion) {
            val reply = CompletableDeferred<Unit>()
            send(ConnectionCommand.Reconnect(forAddress = false, reply), "setRegion()")
            ensureLinkConsumer()
            reply.await()
        }
        return result
    }

    // ── the job queue (see the class doc) ──

    /** Starts the single consumer of the job queue, once: from [start], or
     *  from the first job queued. */
    private fun ensureJobConsumer() {
        if (!jobConsumerStarted.compareAndSet(false, true)) return
        scope.launch {
            while (true) {
                jobWake.receive()
                drainJobs()
            }
        }
    }

    private fun wakeJobs() {
        ensureJobConsumer()
        jobWake.trySend(Unit)
    }

    /** A settings push, of whatever the settings are when its call is made,
     *  so pushes waiting together are one push of the latest. */
    private fun enqueuePush() {
        synchronized(jobLock) { if (JobKind.PUSH !in jobs) jobs.addLast(JobKind.PUSH) }
        wakeJobs()
    }

    /** A layout write. One already waiting writes [layout] instead; one whose
     *  call is already made is followed by another. */
    private fun enqueueLayout(layout: SledTriggerLayout) {
        synchronized(jobLock) {
            layoutWanted = layout
            if (JobKind.LAYOUT !in jobs) jobs.addLast(JobKind.LAYOUT)
        }
        wakeJobs()
    }

    /** A battery request, unless a sweep is open or the link is not up. */
    private fun enqueueBattery() {
        if (reader.connection.value !is RfidConnection.Connected || _session.value != null) return
        synchronized(jobLock) { if (JobKind.BATTERY !in jobs) jobs.addLast(JobKind.BATTERY) }
        wakeJobs()
    }

    /** The consumer's loop body: runs the queued jobs, oldest first, until none is left. */
    private suspend fun drainJobs() {
        while (true) {
            val kind = synchronized(jobLock) { jobs.firstOrNull() } ?: return
            val taken = AtomicBoolean(false)
            try {
                runJob(kind, taken)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Anything escaping would kill the one consumer and leave every
                // later job, and every region load's caller, waiting forever.
                Log.e(TAG, "A $kind job failed.", e)
                if (!taken.get()) {
                    val call = synchronized(jobLock) { takeHead(kind) { current } }
                    (call as? JobCall.Regions)?.reply?.complete(Result.failure(IllegalStateException(SledWords.REGIONS_FAILED)))
                }
            }
        }
    }

    /** The head job, [kind]: a layout write first ends the open sweep (its
     *  tags queued, holding no lock); then the job waits for no sweep and a
     *  free `applyGate`, and makes its call. A battery job finding a sweep
     *  open is dropped. */
    private suspend fun runJob(kind: JobKind, taken: AtomicBoolean) {
        if (kind == JobKind.LAYOUT) endBurst(stopReader = true, queue = true)
        val call = claimForJob(dropIfSweeping = kind == JobKind.BATTERY) {
            taken.set(true)
            synchronized(jobLock) { takeHead(kind) { current } }
        }
        if (call == null) {
            taken.set(true)
            synchronized(jobLock) { takeHead(kind) { current } }
            Log.i(TAG, "Battery request dropped: a sweep is open.")
            return
        }
        runCall(call)
    }

    /** Holding [jobLock]: removes the head job, which is [kind], and returns
     *  its call; a push takes [settings] as they are now. */
    private fun takeHead(kind: JobKind, settings: () -> RfidSettings): JobCall {
        check(jobs.removeFirst() == kind) { "The job queue's head changed under its consumer." }
        return when (kind) {
            JobKind.PUSH -> JobCall.Push(settings())
            JobKind.LAYOUT -> JobCall.Layout(layoutWanted ?: settingLayout).also { layoutWanted = null }
            JobKind.BATTERY -> JobCall.Battery
            JobKind.REGIONS -> JobCall.Regions(regionReplies.removeFirst())
        }
    }

    /**
     * Waits until no sweep is open, then under `mutex` checks again and takes
     * `applyGate` with `tryLock()`: if a sweep opened meanwhile it waits for
     * that one to end; if `applyGate` is taken it waits, holding nothing,
     * until it is free, and tries again. Returns [take]'s value (run under
     * `mutex`) holding `applyGate`, or null holding nothing when
     * [dropIfSweeping] and a sweep is open. `mutex` is never held while
     * waiting for `applyGate` here: only START and [setRegion] do that.
     */
    private suspend fun <T : Any> claimForJob(dropIfSweeping: Boolean, take: () -> T): T? {
        while (true) {
            if (dropIfSweeping && _session.value != null) return null
            _session.first { it == null }
            var busy = false
            val got = mutex.withLock {
                when {
                    _session.value != null -> null
                    !applyGate.tryLock() -> {
                        busy = true
                        null
                    }
                    else -> try {
                        take()
                    } catch (e: Throwable) {
                        applyGate.unlock()
                        throw e
                    }
                }
            }
            if (got != null) return got
            if (busy) applyGate.withLock {}
        }
    }

    /** Makes [call]'s reader call, holding `applyGate`, and releases it. */
    private suspend fun runCall(call: JobCall) {
        try {
            when (call) {
                is JobCall.Push -> push(call.settings)
                is JobCall.Layout -> writeLayout(call.layout)
                JobCall.Battery -> requestBattery()
                is JobCall.Regions -> call.reply.complete(readRegions())
            }
        } finally {
            applyGate.unlock()
            // Answers a region load's caller whatever happened (a no-op when
            // it already has its result).
            (call as? JobCall.Regions)?.reply?.complete(Result.failure(IllegalStateException(SledWords.REGIONS_FAILED)))
            jobsDone.update { it + 1 }
        }
    }

    /** A settings push, while `Connected` only: in `NeedsRegion` or with the
     *  link gone, the next generation pushes again. */
    private suspend fun push(s: RfidSettings) {
        if (reader.connection.value !is RfidConnection.Connected) return
        val result = withTimeoutOrNull(CALL_WAIT_MS) { guarded { reader.apply(s) } }
        _applyError.value = when {
            result == null -> {
                Log.w(TAG, "apply() gave no answer within $CALL_WAIT_MS ms.")
                SledWords.PUSH_STOPPED
            }
            result.isSuccess -> null
            result.exceptionOrNull() is SledNotConnected -> return
            else -> result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() } ?: SledWords.SETTINGS_NOT_APPLIED
        }
    }

    /** A trigger-layout write, while `Connected` only. It becomes this
     *  generation's [requestedLayout] when the call is made. A write that
     *  gives no answer in time sets [layoutError] and is remembered
     *  ([lateLayoutWrite]) until the next write starts: the reader's call still
     *  finishes, and an accepted read-back it publishes then clears the error. */
    private suspend fun writeLayout(layout: SledTriggerLayout) {
        if (reader.connection.value !is RfidConnection.Connected) return
        val info = reader.info.value
        lateLayoutWrite = null
        requested.set(Requested(info?.generation, layout))
        refreshLayoutState()
        val result = withTimeoutOrNull(CALL_WAIT_MS) { guarded { reader.setTriggerLayout(layout) } }
        when {
            result == null -> {
                Log.w(TAG, "setTriggerLayout($layout) gave no answer within $CALL_WAIT_MS ms.")
                _layoutError.value = SledWords.TRIGGER_CHECK_FAILED
                lateLayoutWrite = info?.generation
                // Finished between the timeout and the line above: the info
                // collector may already have passed its read-back.
                val now = reader.info.value
                if (now != null && now.generation == info?.generation && now.trigger != null && now.trigger != info.trigger) {
                    clearLateLayoutError()
                }
            }
            result.isSuccess -> {
                Log.i(TAG, "Trigger layout $layout written; the sled reads back ${result.getOrNull()}.")
                _layoutError.value = null
            }
            result.exceptionOrNull() is SledNotConnected -> Unit
            else -> _layoutError.value =
                result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() } ?: SledWords.TRIGGER_CHECK_FAILED
        }
        refreshLayoutState()
    }

    /** The timed-out write's read-back arrived: the sled took a layout. */
    private fun clearLateLayoutError() {
        lateLayoutWrite = null
        _layoutError.value = null
    }

    private suspend fun requestBattery() {
        if (reader.connection.value !is RfidConnection.Connected) return
        val answered = withTimeoutOrNull(CALL_WAIT_MS) {
            guarded {
                reader.requestBattery()
                Result.success(Unit)
            }
        }
        if (answered == null) Log.w(TAG, "requestBattery() gave no answer within $CALL_WAIT_MS ms.")
    }

    private suspend fun readRegions(): Result<RfidRegions> =
        withTimeoutOrNull(CALL_WAIT_MS) { guarded { reader.regions() } }
            ?: Result.failure(IllegalStateException(SledWords.REGIONS_FAILED))

    /** [body]'s result, or a failure carrying whatever it threw. */
    private suspend fun <T> guarded(body: suspend () -> Result<T>): Result<T> = try {
        body()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Result.failure(e)
    }

    // ── the layout in force ──

    /** The layout asked of [info]'s generation, or null. */
    private fun requestedFor(info: SledInfo?): SledTriggerLayout? {
        if (info == null) return null
        val r = requested.get() ?: return null
        return if (r.generation == null || r.generation == info.generation) r.layout else null
    }

    private fun refreshLayoutState() {
        synchronized(layoutStateLock) {
            val info = reader.info.value
            val asked = requestedFor(info)
            _requestedLayout.value = asked
            _layoutInForceUsesScanner.value =
                info != null && layoutInForceUsesScanner(info.trigger, asked ?: settingLayout, zebraHost, info.hasScanner)
        }
    }

    /** The trigger-layout setting. Before the settings collector's first
     *  value, the layout of [info]'s connect request (built from the saved
     *  settings) stands in for it. Never suspends: the connection collector
     *  must not wait on a settings read. */
    private fun settingLayoutFor(info: SledInfo?): SledTriggerLayout =
        if (settingsSeen) settingLayout else requestedFor(info) ?: settingLayout

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
        // The request's layout belongs to whatever generation this attempt
        // brings up (see requestedLayout). Once the call returns it is bound
        // to that generation, unless a layout write already replaced it: the
        // generation's jobs resume with this call's return and can run first.
        val inFlight = Requested(null, request.layout)
        requested.set(inFlight)
        val result = try {
            // The immediate try after a first batch clear first waits for that
            // attempt's own cleanup on the reader, so it gets the batch wait.
            awaitConnect(request, batchWait = attempt.origin == Origin.BATCH) { sentence ->
                // Only while the link is still wanted and no schedule is trying:
                // a switch turned off or Stop tapped meanwhile wants no failure
                // sentence, and a schedule shows its loss once, on its own line.
                val wanted = linkWanted.get()
                if (wanted && synchronized(retryLock) { schedule == null }) _connectionError.value = sentence
                reply?.complete(
                    if (wanted) Result.failure(SledConnectException(RfidConnection.Failed(sentence, retryable = true)))
                    else Result.failure(SledNotConnected()),
                )
            }
        } catch (e: Throwable) {
            synchronized(retryLock) { dialing = false }
            requested.compareAndSet(inFlight, null)
            throw e
        }
        requested.compareAndSet(inFlight, if (result.isSuccess) Requested(reader.info.value?.generation, request.layout) else null)
        refreshLayoutState()
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
     *  and waits for it: [CONNECT_WAIT_BATCH_MS] with [batchWait] or once the
     *  reader reported a batch-mode recovery in the attempt, else
     *  [CONNECT_WAIT_MS]. When the wait runs out, [onTimeout] gets the
     *  couldn't-reach sentence and the wait goes on: the reader's call always
     *  returns (every vendor wait inside it is bounded), and the gate held by
     *  the caller must outlast it. */
    private suspend fun awaitConnect(request: SledConnectRequest, batchWait: Boolean, onTimeout: (String) -> Unit): Result<Unit> =
        withContext(NonCancellable) {
            val call = scope.async { applyGate.withLock { guarded { reader.connect(request) } } }
            val batchSeen = AtomicBoolean(batchWait)
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

    /** Called holding [linkGate]: ends any open sweep (its tags are queued:
     *  the operator asked the reader to stop, not for those tags to vanish),
     *  waits for a stop another caller already had in flight, then
     *  disconnects under [applyGate]. */
    private suspend fun disconnectLocked(reply: CompletableDeferred<Unit>?) {
        try {
            endBurst(stopReader = true, queue = true)
            stopGate.withLock {}
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
            // A failed layout write belonged to the link that is gone now.
            _layoutError.value = null
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
        if (!before.readerAddress.equals(after.readerAddress, ignoreCase = true)) {
            if (reconnectsFor(after.readerAddress)) {
                send(ConnectionCommand.Reconnect(forAddress = true), "the saved sled")
            } else if (after.readerAddress != null && waitingForAChoice()) {
                // The operator chose the sled the last connect asked for: that
                // connect does not retry by itself, so the choice dials (a manual
                // attempt, as Connect would).
                send(ConnectionCommand.Connect(Attempt(Origin.MANUAL, manual = true)), "the chosen sled")
            }
        }
    }

    /** The last connect failed because more than one sled is paired and none
     *  was chosen, and the link is still wanted. */
    private fun waitingForAChoice(): Boolean =
        linkWanted.get() && (reader.connection.value as? RfidConnection.Failed)?.fix == SledFix.CHOOSE_SLED

    /** A new saved address reconnects while a connect runs, or while the link
     *  is up with a sled at another address. */
    private fun reconnectsFor(address: String?): Boolean = when (reader.connection.value) {
        RfidConnection.Connecting -> true
        is RfidConnection.Connected, is RfidConnection.NeedsRegion ->
            !reader.info.value?.address.equals(address, ignoreCase = true)
        else -> false
    }

    /** Whose link appearing nudges: the last connected sled's address, else
     *  the saved one, the first of them still paired ([sledNudgeAddress]).
     *  The app's receiver filters with it too. */
    fun nudgeAddress(): String? = sledNudgeAddress(lastSledAddress, savedAddress, reader.pairedSleds())

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
            if (attempt.fromJob && attempt.epoch != epoch) {
                // A try the schedule's end overtook (Stop while it was dialing):
                // nothing more to do, and no failure sentence once the link is unwanted.
                if (!linkWanted.get()) _connectionError.value = null
                return
            }
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
     *  a drop, and starts the schedule once the stored gate passes (every try
     *  would be skipped with it closed: the reader off, or a permission
     *  missing, and the failure line says so at once); a connect that never
     *  came up has no `info`, and its attempt applies the rules itself. */
    private fun onLinkLost(c: RfidConnection.Failed) {
        val sled = reader.info.value ?: return
        if (!synchronized(retryLock) { dropScheduleDue() }) return
        scope.launch { startScheduleForADrop(sled, c) }
    }

    private suspend fun startScheduleForADrop(sled: SledInfo, c: RfidConnection.Failed) {
        val gate = storedGate.get()
        if (gate == null || !gateOpen(gate)) {
            Log.i(TAG, "The link dropped; not reconnecting: the reader is off or a permission is missing.")
            return
        }
        synchronized(retryLock) {
            // Re-checked: anything that happened during the gate (an attempt,
            // the link coming back, a disconnect) decides instead.
            if (!dropScheduleDue() || reader.connection.value != c) return
            Log.i(TAG, "The link dropped; reconnecting.")
            publish(Schedule(afterDrop = true, name = sled.name, tries = 0, lastReason = c.reason))
            launchTry(Origin.RETRY, OutboxMachine.BACKOFF[0], manual = false)
        }
    }

    /** Holding [retryLock]: nothing is dialing or scheduled and the link is wanted. */
    private fun dropScheduleDue(): Boolean = !dialing && schedule == null && retryJob == null && linkWanted.get()

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
            // The failure's sentence is the connection line's now; the schedule
            // raises none of its own while it tries.
            _connectionError.value = null
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

    private suspend fun onTrigger(pull: TriggerPull) {
        stampActivity()
        // Wait for any in-flight stop to finish before evaluating anything.
        // `endBurst` releases `mutex` across `reader.stopInventory()` (see
        // the class doc), so without this a trigger landing in that window
        // would see the session as still open and read a would-be START as
        // NONE or STOP — the operator's next pull would do nothing. This
        // only gates trigger evaluation: `onTag` never touches `stopGate`,
        // so tags keep folding into the still-open session for the whole
        // vendor round trip.
        stopGate.withLock {
            if (mayStillBeReading) {
                // A stop the sled answered with a failure twice: one more
                // before anything else, holding applyGate for the call only
                // (released before `mutex` is taken), so it never overlaps a
                // queued job.
                mayStillBeReading = false
                Log.i(TAG, "The last stop was not confirmed; stopping again before this pull.")
                stopOnce()
            }
        }
        var stopRequested = false
        var closeFailedStart = false
        mutex.withLock {
            if (!armed) return@withLock
            val event = pull.event
            val at = pull.atMs ?: clock()
            val reading = _session.value != null
            val heldMs = if (event == TriggerEvent.RELEASED) at - pressedAtMs else 0L
            if (event == TriggerEvent.PRESSED) pressedAtMs = at
            when (nextTriggerAction(current.triggerMode, event, reading, heldMs)) {
                TriggerAction.START -> {
                    if (!mayStartRead()) return@withLock
                    _session.value = startSession(clock())
                    sessionOwner = owner
                    sessionGeneration = reader.info.value?.generation
                    // applyGate nested inside mutex (mutex outer, applyGate
                    // inner) so a start can never race a queued job or a
                    // region write on the vendor link. Nothing that holds
                    // applyGate ever tries to acquire mutex, so this ordering
                    // cannot deadlock — see the class doc.
                    when (val outcome = applyGate.withLock { startOnce() }) {
                        StartOutcome.Started -> _readError.value = null
                        // Shows nothing: the link is going or gone.
                        StartOutcome.NotConnected -> closeFailedStart = true
                        is StartOutcome.Failed -> {
                            _readError.value = outcome.sentence
                            closeFailedStart = true
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
        // Ruling 29: every failed or timed-out start is followed by one stop,
        // and the sweep is closed after `mutex` is released.
        if (closeFailedStart) endBurst(stopReader = true, queue = true, retryStop = false)
        if (stopRequested) endBurst(stopReader = true, queue = true)
    }

    /** Holding `mutex`: the link is `Connected` and the layout in force has a
     *  trigger assigned to tags (ruling 27). */
    private fun mayStartRead(): Boolean {
        if (reader.connection.value !is RfidConnection.Connected) return false
        val info = reader.info.value
        val layout = requestedFor(info) ?: current.triggerLayout
        val reads = layoutInForceReadsTags(info?.trigger, layout, zebraHost, info?.hasScanner)
        if (!reads) Log.d(TAG, "A pull with no trigger assigned to tags (layout $layout, read-back ${info?.trigger}).")
        return reads
    }

    /** How a START's `startInventory()` went. */
    private sealed interface StartOutcome {
        /** Started, or sent and not yet confirmed (the reader returns success for that). */
        data object Started : StartOutcome
        /** The reader turned it away as not connected. */
        data object NotConnected : StartOutcome
        /** Refused, unanswered within [START_WAIT_MS], or thrown; [sentence] says so. */
        class Failed(val sentence: String) : StartOutcome
    }

    /**
     * Holding `mutex` and `applyGate`: `startInventory()`, waited for
     * [START_WAIT_MS] from when the call is made, plus [PURGE_WAIT_MS] while
     * "Report each tag once" is on (the reader clears the sled's tag list
     * first, a second round trip in the same call). A thrown `Throwable` is a
     * failure too: `Throwable` rather than `Exception` because this runs
     * inside the single pulls collector launched in start(), so anything
     * escaping here kills that collector and leaves every later trigger
     * event undelivered for the rest of the process's life.
     */
    private suspend fun startOnce(): StartOutcome = try {
        val wait = if (current.uniqueTagReport) START_WAIT_MS + PURGE_WAIT_MS else START_WAIT_MS
        val result = withTimeoutOrNull(wait) { reader.startInventory() }
        when {
            result == null -> {
                Log.w(TAG, "startInventory() gave no answer within $wait ms.")
                StartOutcome.Failed(SledWords.READ_DID_NOT_START)
            }
            result.isSuccess -> StartOutcome.Started
            result.exceptionOrNull() is SledNotConnected -> StartOutcome.NotConnected
            else -> StartOutcome.Failed(
                result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() } ?: SledWords.READ_DID_NOT_START,
            )
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Log.w(TAG, "startInventory() threw.", e)
        StartOutcome.Failed(SledWords.READ_DID_NOT_START)
    }

    private enum class StopOutcome { STOPPED, NOT_CONNECTED, FAILED, THREW }

    /**
     * One `stopInventory()`, holding `applyGate` for the call alone, waited
     * for [STOP_WAIT_MS]. A wait that runs out counts as a failed stop: the
     * sled may still be reading. A thrown `Throwable` is caught (see
     * [endBurst]) and logged.
     */
    private suspend fun stopOnce(): StopOutcome = applyGate.withLock {
        try {
            val result = withTimeoutOrNull(STOP_WAIT_MS) { reader.stopInventory() }
            when {
                result == null -> {
                    Log.w(TAG, "stopInventory() gave no answer within $STOP_WAIT_MS ms.")
                    StopOutcome.FAILED
                }
                result.isSuccess -> StopOutcome.STOPPED
                result.exceptionOrNull() is SledNotConnected -> StopOutcome.NOT_CONNECTED
                else -> {
                    Log.w(TAG, "stopInventory() failed: ${result.exceptionOrNull()?.message}")
                    StopOutcome.FAILED
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // The reader is already gone, or something worse went wrong (e.g.
            // an Error during a large sweep): the tags still count, and the
            // claim after the stop must still run or the controller wedges for
            // the process's remaining lifetime.
            Log.w(TAG, "stopInventory() threw.", e)
            StopOutcome.THREW
        }
    }

    private suspend fun onTag(epc: String) {
        stampActivity()
        mutex.withLock {
            val open = _session.value ?: return@withLock
            _session.value = onTagRead(open, epc, queued, current.repeatPolicy)
        }
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
     *
     * The stop (spec, Controller › Sweeps): a failure the sled returns (not
     * "not connected", not a throw) is sent once more when [retryStop]; if
     * that fails too the sled may still be reading, [readError] says so, and
     * the next pull sends one stop first. A failed start's own stop is not
     * retried (ruling 29: one stop). With [keepLiveLink], a burst opened on
     * the link that is `Connected` now (same generation) is left open. After
     * a burst ends, a battery request is queued.
     */
    private suspend fun endBurst(
        stopReader: Boolean,
        queue: Boolean,
        unlessOwnedBy: String? = null,
        retryStop: Boolean = true,
        keepLiveLink: Boolean = false,
    ) {
        val owns = mutex.withLock {
            if (_session.value == null) return@withLock false
            if (unlessOwnedBy != null && sessionOwner == unlessOwnedBy) return@withLock false
            if (keepLiveLink && onTheLiveLink()) return@withLock false
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
                    var outcome = stopOnce()
                    if (retryStop && outcome == StopOutcome.FAILED) {
                        Log.i(TAG, "The stop was not confirmed; sending it once more.")
                        outcome = stopOnce()
                        if (outcome == StopOutcome.FAILED) {
                            mayStillBeReading = true
                            _readError.value = SledWords.MAY_STILL_BE_READING
                        }
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
        if (done != null) enqueueBattery()
    }

    /** Holding `mutex`: the open burst was started on the link that is
     *  `Connected` now (`info.generation`, null for a reader with no `info`). */
    private fun onTheLiveLink(): Boolean =
        reader.connection.value is RfidConnection.Connected && reader.info.value?.generation == sessionGeneration
}
