package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
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
import com.serversherpa.kiosk.core.scan.rfidKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Owns one reader. Turns trigger events into inventories using whichever
 * trigger mode is set, accumulates the burst, and emits the tags to queue when
 * it ends.
 *
 * It knows nothing about assets, the roster, or the outbox: it produces tag
 * values and stops there. `ScanViewModel` does the matching and the queueing,
 * so the RFID commit rules sit beside the barcode commit rules.
 *
 * `start()` launches six independent collectors (settings, triggers, tags,
 * connection, the [commands] consumer, and the [connectionCommands]
 * consumer) on `scope`, which in production is a real thread pool
 * (`Dispatchers.Default`), not a confined dispatcher — so every one of them
 * can run concurrently with every other, and with `arm()`/`disarm()`/
 * `stopBurst()`/`connectNow()`/`disconnectNow()` called from the UI thread.
 * All of the state those touch (`current`, `_session`, `armed`, `queued`,
 * `stoppingBurst`, `queueOnStop`) is therefore only ever read or written
 * under `mutex`, the same idiom `Outbox` uses for its own multi-writer state
 * — every access, not just the ones with something else nearby to protect,
 * since a field a lock only sometimes guards gives no happens-before edge to
 * the accesses that skip it.
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
 * those only ever need `mutex`, which [push] never holds. A trigger START is
 * the one exception: it deliberately serializes against a concurrent push on
 * the vendor link by waiting on `applyGate` *while still holding `mutex`*
 * (see the nesting in [onTrigger]'s `TriggerAction.START` branch), so a start
 * can be delayed — bounded by `VENDOR_TIMEOUT_MS` in the worst case — behind
 * an in-flight push. Nothing that holds `applyGate` (i.e. [push]) ever tries
 * to acquire `mutex`, so nesting `mutex` outside `applyGate` at that one call
 * site cannot deadlock.
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
 * [connectForLifecycle] and [disconnectForLifecycle] are the same idiom
 * applied to `ProcessLifecycleOwner`'s observer: `AppContainer` used to fire
 * `connectNow()`/`disconnectNow()` from two independent `scope.launch`
 * blocks in `onStart`/`onStop`, with nothing ordering one against the other
 * — a quick background/foreground/background flurry could let an earlier
 * disconnect finish after a later connect, or the reverse. Both are queued
 * for strict ordering the same way `arm()`/`disarm()`/`stopBurst()` are, but
 * onto a *second*, separate channel — [connectionCommands], drained by its
 * own single consumer coroutine — not [commands]. The two were merged for
 * one fix and then split apart for this one: routing everything through one
 * channel gave lifecycle connect/disconnect the ordering guarantee they
 * needed, but it also meant a slow `reader.connect()` — on real hardware, a
 * Bluetooth vendor call that can take seconds when the sled is out of range,
 * the radio is busy, or the stack soft-hangs — blocked whatever
 * arm()/disarm()/stopBurst() happened to be queued behind it. A phone
 * returning to the foreground enqueues a connect; the operator opening the
 * Scanning screen a beat later enqueues an arm that then sat stuck behind
 * it, `armed` stayed false, and every trigger pull was a silent no-op with
 * nothing on screen explaining it. Two queues keep both orderings — connect/
 * disconnect strictly in lifecycle order, arm/disarm/stop strictly in
 * screen-issued order — while removing any way for one kind to delay the
 * other. The caller enqueues *synchronously* — `connectForLifecycle`/
 * `disconnectForLifecycle` never suspend, so `AppContainer` can call them
 * directly from the lifecycle callback body instead of a nested
 * `scope.launch` — which is what actually fixes the ordering race: two
 * lifecycle callbacks never overlap (Android runs `onStart`/`onStop`
 * strictly in turn, on the main thread), so a synchronous enqueue in each
 * preserves that order into the channel regardless of how long the *effect*
 * of an earlier one takes to run. `connectForLifecycle`'s `gate` — the
 * enabled-and-permitted check, which needs a suspending prefs read — is
 * deliberately evaluated by the consumer, not the caller, once that
 * command's turn comes up: running it before enqueueing would reintroduce
 * exactly the race this fixes, since the gate's own suspension is what let
 * a later `onStop`'s call get ahead of an earlier `onStart`'s in the first
 * place.
 *
 * [connectWithTimeout] and [disconnectWithTimeout] wrap `reader.connect()`
 * and `reader.disconnect()` in `withTimeoutOrNull(VENDOR_TIMEOUT_MS)` —
 * defense against a vendor stack that never returns at all, which nothing
 * described above helps with: splitting the queues stops a slow connect
 * from blocking *other* commands, but does nothing for the connect command
 * itself, which would otherwise wait on the consumer forever. A timeout is
 * reported the same way every other connect/disconnect outcome is —
 * [connectionError] is set to a readable reason, mirroring how [applyError]
 * reports a settings push failure — rather than the connection command
 * silently never finishing. [connection] is a plain read-through of
 * `reader.connection`, which only the reader implementation can write, so a
 * timeout (the one failure mode the reader itself never sees, since the
 * controller gave up waiting on it, not the reader) has nowhere else to
 * surface. `connectNow()`/`disconnectNow()` route through the same two
 * helpers, so the Settings screen's direct calls get the same timeout
 * defense and the same `connectionError` reporting as the lifecycle path.
 *
 * `connectNow()`/`disconnectNow()` are otherwise unchanged: the Settings
 * screen calls them directly, synchronously, wanting their own `Result`,
 * and does not need — and must not lose — the ability to cancel a
 * disconnect it kicked off from a screen that then navigated away (see
 * [endBurst]'s cancellation handling). Routing them through
 * [connectionCommands] as well would run their real work on the consumer
 * coroutine instead of the caller's, breaking that direct cancellability.
 * Only the fire-and-forget lifecycle path needs queuing, so only it uses
 * [connectionCommands].
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

    private val _connectionError = MutableStateFlow<String?>(null)
    /** Why the last `connect()`/`disconnect()` attempt failed, including a
     *  timeout — [applyError]'s counterpart for the connection itself. It
     *  exists because [connection] is a plain read-through of
     *  `reader.connection`, which only the reader implementation can write:
     *  a normal connect failure still reaches the operator that way (the
     *  reader sets its own state to `Failed` before returning), but a
     *  timeout is exactly the case where the reader never gets to do that —
     *  the controller gave up waiting on it, the reader did not fail on its
     *  own — so this is the only place left to report it. Null once a later
     *  attempt succeeds. */
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
     *  `apply()` against `startInventory()` on the vendor link (the nesting
     *  in [onTrigger]'s `TriggerAction.START` branch): a slow or hung
     *  settings push can delay a later push, and can delay a trigger START
     *  specifically (bounded by `VENDOR_TIMEOUT_MS` in the worst case, since
     *  START waits on `applyGate` while holding `mutex`), but nothing else —
     *  not a tag report, an arm/disarm, or `endBurst`, all of which only
     *  ever need `mutex`, which [push] never holds. Nothing that holds
     *  `applyGate` ever tries to acquire `mutex`, so nesting `mutex` outside
     *  it at that one call site cannot deadlock. */
    private val applyGate = Mutex()

    private sealed interface Command {
        data object Arm : Command
        data object Disarm : Command
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
        /** [gate] is the caller's enabled-and-permitted check; it runs on the
         *  consumer (see [connectForLifecycle]), never on the caller. */
        class Connect(val gate: suspend () -> Boolean) : ConnectionCommand
        data object Disconnect : ConnectionCommand
    }

    /** [commands]'s sibling for `connectForLifecycle()`/
     *  `disconnectForLifecycle()` — same unlimited-capacity, never-lost,
     *  buffered-before-`start()` reasoning, but its own channel and its own
     *  single consumer (started in [start]) so lifecycle connect/disconnect
     *  order among themselves without ever blocking arm/disarm/stop, or
     *  being blocked by them. See the class doc for why the two were split. */
    private val connectionCommands = Channel<ConnectionCommand>(Channel.UNLIMITED)

    private companion object {
        /** Ceiling on how long `reader.connect()`/`reader.disconnect()` may
         *  suspend before the controller gives up on them — defense against
         *  a vendor stack that never returns at all, not a tuning knob for
         *  normal connects. 15s is comfortably above Android's own ~12s
         *  RFCOMM connect timeout and the multi-second scan/pair negotiation
         *  a Bluetooth sled can genuinely need when it is out of range or
         *  the radio is busy, so a legitimate slow connect is never cut off
         *  early; it is still short enough that a soft-hung stack leaves the
         *  operator waiting seconds, not indefinitely, for [connectionError]
         *  to explain what happened. The same value covers `disconnect()`
         *  too: it calls into the same vendor stack and can wedge on the
         *  same soft hang, and there is no data suggesting disconnect
         *  deserves a different number than connect. */
        const val VENDOR_TIMEOUT_MS = 15_000L
    }

    fun start() {
        scope.launch {
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
                    // RFID panel's switch does exactly this, alongside a
                    // disconnectNow() call — and `apply()` never reads
                    // `enabled` at all, so it is not worth a push: comparing
                    // with `enabled` forced to match `current`'s isolates
                    // that one field without hand-listing every other one of
                    // RfidSettings. `current` itself must still hold the
                    // true, current `enabled` value.
                    val c = s.copy(enabled = current.enabled) != current
                    current = s
                    c
                }
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
        // Single consumer of `commands`, so arm()/disarm()/stopBurst() all
        // run in exactly the order they were sent — see the class doc.
        // Nothing here ever waits on `connectionCommands` or its consumer
        // below, so a slow or hung connect/disconnect on the *other* queue
        // can never delay any of these three.
        scope.launch {
            for (command in commands) {
                when (command) {
                    Command.Arm -> armNow()
                    Command.Disarm -> disarmNow()
                    Command.Stop -> endBurst(stopReader = true, queue = true)
                }
            }
        }
        // Single consumer of `connectionCommands`, so connectForLifecycle()/
        // disconnectForLifecycle() run in exactly the order they were sent —
        // see the class doc. Neither `gate()` below nor
        // [connectWithTimeout]/[disconnectWithTimeout] is ever called under
        // `mutex` — the same discipline `endBurst` already follows for
        // `reader.stopInventory()` — so a slow vendor call parks only this
        // loop (delaying a later connect/disconnect, exactly as intended),
        // never a collector or caller that is waiting on `mutex`, and never
        // the `commands` consumer above. Nothing else in this class ever
        // waits *on either consumer* to make progress, and neither consumer
        // ever sends to or awaits the other's channel, so there is no cycle
        // between them either: a slow gate/connect/disconnect can only ever
        // delay a later command on its own queue, never deadlock against the
        // other queue.
        scope.launch {
            for (command in connectionCommands) {
                when (command) {
                    is ConnectionCommand.Connect -> if (command.gate()) connectWithTimeout()
                    ConnectionCommand.Disconnect -> disconnectNowImpl()
                }
            }
        }
    }

    /** Only the Scanning screen calls this, while it is composed. */
    fun arm() {
        check(commands.trySend(Command.Arm).isSuccess) {
            "Couldn't queue arm(): the command channel is closed."
        }
    }

    /** Leaving the screen ends any read in progress. Its tags are dropped: the
     *  screen that would queue them is gone. */
    fun disarm() {
        check(commands.trySend(Command.Disarm).isSuccess) {
            "Couldn't queue disarm(): the command channel is closed."
        }
    }

    /** The Stop button, for a latched or toggled read. */
    fun stopBurst() {
        check(commands.trySend(Command.Stop).isSuccess) {
            "Couldn't queue stopBurst(): the command channel is closed."
        }
    }

    /** `ProcessLifecycleOwner`'s observer calls this from `onStart` — see the
     *  class doc for why it must be called directly there, not from inside
     *  its own `scope.launch`. [gate] runs on the consumer once this
     *  command's turn comes up, not here: evaluating it before enqueueing
     *  would let its suspension reorder this call behind a later
     *  [disconnectForLifecycle], the exact race this exists to close. */
    fun connectForLifecycle(gate: suspend () -> Boolean) {
        check(connectionCommands.trySend(ConnectionCommand.Connect(gate)).isSuccess) {
            "Couldn't queue connectForLifecycle(): the connection command channel is closed."
        }
    }

    /** `ProcessLifecycleOwner`'s observer calls this from `onStop` — the
     *  mirror of [connectForLifecycle]; see the class doc. */
    fun disconnectForLifecycle() {
        check(connectionCommands.trySend(ConnectionCommand.Disconnect).isSuccess) {
            "Couldn't queue disconnectForLifecycle(): the connection command channel is closed."
        }
    }

    private suspend fun armNow() = mutex.withLock {
        // `queued` is "what this visit to the screen already sent"; a
        // *new* visit starts that over, or a repeat-sweep policy
        // would drop every tag on the operator's next sweep forever.
        // But a re-arm within the same visit — a lifecycle-aware
        // collector re-firing, or a return from a dialog — must not
        // wipe the sweep history the operator is mid-visit through.
        if (!armed) queued = emptySet()
        armed = true
    }

    private suspend fun disarmNow() {
        mutex.withLock { armed = false }
        endBurst(stopReader = true, queue = false)
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

    suspend fun connectNow(): Result<Unit> = connectWithTimeout()
    // Settings are pushed by the connection collector on the resulting
    // Connected transition, the same path a self-initiated reconnect uses —
    // so there is exactly one place this happens, not two racing to set
    // `applyError`.

    /** The one place `reader.connect()` is actually called — by
     *  `connectNow()` directly and by the [connectionCommands] consumer for
     *  `connectForLifecycle()` — so the timeout defense and
     *  [connectionError] reporting apply identically to both callers. Never
     *  called under `mutex`; see the class doc. */
    private suspend fun connectWithTimeout(): Result<Unit> {
        val result = withTimeoutOrNull(VENDOR_TIMEOUT_MS) { reader.connect() }
            ?: Result.failure(IllegalStateException("Connecting to the reader timed out."))
        _connectionError.value = if (result.isFailure) {
            result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() }
                ?: "Couldn't connect to the reader."
        } else {
            null
        }
        return result
    }

    /** [connectWithTimeout]'s mirror for `reader.disconnect()`, shared by
     *  [disconnectNowImpl] — so `disconnectNow()` and
     *  `disconnectForLifecycle()` both get the same timeout defense and
     *  [connectionError] reporting. `disconnect()` returns no `Result`, so a
     *  timeout is the only failure this can observe or report. Never called
     *  under `mutex`; see the class doc. */
    private suspend fun disconnectWithTimeout() {
        val completed = withTimeoutOrNull(VENDOR_TIMEOUT_MS) { reader.disconnect() }
        _connectionError.value = if (completed == null) {
            "Disconnecting from the reader timed out."
        } else {
            null
        }
    }

    /** The one place `reader.apply()` is actually called — always under
     *  [applyGate], never under `mutex`; see the class doc. Wrapped in the
     *  same `VENDOR_TIMEOUT_MS` defense [connectWithTimeout]/
     *  [disconnectWithTimeout] use, since `apply()` otherwise has no timeout
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

    suspend fun disconnectNow() = disconnectNowImpl()

    // Shared by disconnectNow() (runs in the caller's own coroutine, so a
    // caller that gets cancelled — e.g. a screen's viewModelScope cleared on
    // navigation away — cancels this directly, same as before this class
    // grew a command queue; see endBurst's cancellation handling) and the
    // consumer's Command.Disconnect case (runs fire-and-forget on the
    // consumer, for disconnectForLifecycle()). Extracting this avoids two
    // copies of the same three lines, not a change in what either caller
    // experiences.
    private suspend fun disconnectNowImpl() {
        // An explicit disconnect still queues what was already read, the same
        // rule as an involuntary drop: the operator asked the reader to stop,
        // not for those tags to vanish.
        endBurst(stopReader = true, queue = true)
        disconnectWithTimeout()
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
                        } catch (e: Exception) {
                            // The reader may already be gone; the session stays
                            // open and endBurst()'s own try/catch covers the stop.
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
     * suspended in `reader.stopInventory()` — e.g. `disconnectNow()` called
     * from a screen's `viewModelScope` that gets cleared on navigation away —
     * plain cancellation would unwind straight past the claim below,
     * leaving `stoppingBurst` stuck true and `_session` stuck non-null.
     * Every later `endBurst` would then return early forever, the live
     * panel would never close, the radio would keep inventorying, `bursts`
     * would never emit again, and in HOLD mode a new trigger press would
     * evaluate as NONE because a session still looks open — wedged until
     * the process restarts. The `catch (CancellationException)` below
     * finishes the same claim `withContext(NonCancellable)` (a cancelled
     * coroutine cannot otherwise suspend to take `mutex`), the same idiom
     * `Outbox.sendBatch` uses to persist a batch's outcome under
     * cancellation, before rethrowing — so a cancelled stop still leaves
     * the controller consistent for the next trigger pull. It queues the
     * tags folded in so far exactly when the caller that owned the stop
     * wanted them queued (`queueOnStop`, unchanged by the cancellation):
     * the operator genuinely read those tags, so a cancelled
     * `disconnectNow()` (`queue = true`) still queues them, the same as an
     * uncancelled one, while a cancelled `disarm()` (`queue = false`) still
     * discards them, the same as an uncancelled one.
     */
    private suspend fun endBurst(stopReader: Boolean, queue: Boolean) {
        val owns = mutex.withLock {
            if (_session.value == null) return@withLock false
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
                    d to q
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
                    d to q
                }
                if (d != null && q) _bursts.emit(burstToScans(d))
            }
            throw e
        }
        // Emitting outside the lock: a slow collector on `bursts` must not
        // stall trigger and tag handling for everyone else.
        if (done != null && shouldQueue) _bursts.emit(burstToScans(done))
    }
}
