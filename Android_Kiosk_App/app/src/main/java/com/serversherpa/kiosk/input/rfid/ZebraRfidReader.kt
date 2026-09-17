package com.serversherpa.kiosk.input.rfid

import android.content.Context
import android.os.Build
import android.util.Log
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.powerToTenths
import com.zebra.rfid.api3.BATCH_MODE
import com.zebra.rfid.api3.BEEPER_VOLUME
import com.zebra.rfid.api3.DYNAMIC_POWER_OPTIMIZATION
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.ENUM_TRIGGER_MODE
import com.zebra.rfid.api3.HANDHELD_TRIGGER_EVENT_TYPE
import com.zebra.rfid.api3.InvalidUsageException
import com.zebra.rfid.api3.OperationFailureException
import com.zebra.rfid.api3.RFIDReader
import com.zebra.rfid.api3.RFIDResults
import com.zebra.rfid.api3.Readers
import com.zebra.rfid.api3.RegulatoryConfig
import com.zebra.rfid.api3.RfidEventsListener
import com.zebra.rfid.api3.RfidReadEvents
import com.zebra.rfid.api3.RfidStatusEvents
import com.zebra.rfid.api3.SESSION
import com.zebra.rfid.api3.START_TRIGGER_TYPE
import com.zebra.rfid.api3.STATUS_EVENT_TYPE
import com.zebra.rfid.api3.STOP_TRIGGER_TYPE
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext

/**
 * The only file in this app that knows Zebra exists.
 *
 * The SDK calls back on its own thread ([listener]), so every callback does
 * one thing: push onto a flow. Never call back into the reader from inside a
 * callback.
 *
 * Every outbound SDK call that can block — connecting, disconnecting, a
 * config push, starting or stopping an inventory — runs inside
 * [runInterruptible] on [Dispatchers.IO], never a bare
 * `withContext(Dispatchers.IO) { blockingCall() }`. That distinction matters:
 * `RfidController` wraps this class's `connect()`/`disconnect()` in a 15s
 * `withTimeoutOrNull`, but a plain blocking call inside `withContext` is not
 * itself cancellable — cancelling the coroutine does nothing to a JNI/
 * Bluetooth call already parked inside the vendor stack, so the timeout would
 * be decorative and a hung radio would wedge `RfidController`'s connection
 * command queue forever (see that class's doc for why that queue must never
 * stall). `runInterruptible` registers a cancellation handler that calls
 * `Thread.interrupt()` on the worker thread and turns the resulting
 * `InterruptedException` (or a lingering interrupted flag the blocking call
 * swallowed) into a `CancellationException`, which every call site below
 * rethrows rather than catches — the same `catch (CancellationException) {
 * throw e }` idiom `RfidController` already uses for its own cancellable
 * sections. Wrapping a `runInterruptible` call in `runCatching` would defeat
 * this: `runCatching` treats `CancellationException` as just another failure
 * and returns it as a `Result` instead of letting it propagate, which lets
 * the coroutine complete as if it were never cancelled — exactly the bug this
 * file exists to avoid.
 *
 * Every vendor call site also catches `LinkageError` alongside `Exception`,
 * kept as a belt-and-braces guard even though the specific cause below is
 * fixed: the RFIDAPI3 `.aar` is wired in as a raw local artifact (see
 * `RFIDAPI3Library/build.gradle`), and its `Readers`/`API3Service`/
 * `API3UsbService` classes call four methods (`getInstance`,
 * `registerReceiver`, `unregisterReceiver`, `sendBroadcast`) on the *old*
 * `android.support.v4.content.LocalBroadcastManager` — a class this
 * AndroidX-only app doesn't otherwise have on its classpath. `app/build.
 * gradle.kts` now depends directly on the real
 * `com.android.support:localbroadcastmanager:28.0.0` artifact to supply it
 * (see that dependency's comment for why: Jetifier does transform this raw
 * artifact, but only rewrites the *reference* — it never supplies the
 * androidx class the rewrite would then require, so flipping
 * `enableJetifier` on alone just trades one `NoClassDefFoundError` for
 * another). `ZebraReadersConstructibleTest` asserts `Readers` construction
 * never throws a `LinkageError`/`NoClassDefFoundError`, so a regression here
 * — this dependency going missing, or a future vendor `.aar` update needing
 * some other class this app doesn't have — fails a build-time test, not
 * just a real device. The runtime catch stays anyway: it's what keeps the
 * "connect() never throws, it reports" contract true for any other
 * classloading gap the test doesn't happen to exercise (a different reader
 * model's code path, a different Android version, a future SDK bump) —
 * `NoClassDefFoundError` and `UnsatisfiedLinkError` (a missing native `.so`)
 * are both `LinkageError`, not `Exception`, so a bare `catch (e: Exception)`
 * would let either fall straight through as an uncaught crash.
 */
open class ZebraRfidReader(private val context: Context, private val scope: CoroutineScope) : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection

    private val _connectNote = MutableStateFlow<String?>(null)
    override val connectNote: StateFlow<String?> = _connectNote

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val tags: SharedFlow<String> = _tags

    private val _triggers = MutableSharedFlow<TriggerEvent>(extraBufferCapacity = 16)
    override val triggers: SharedFlow<TriggerEvent> = _triggers

    private var readers: Readers? = null
    private var reader: RFIDReader? = null

    private val listener = object : RfidEventsListener {
        override fun eventReadNotify(event: RfidReadEvents) {
            // Never touch the reader from in here; just hand the value on.
            val epc = event.readEventData?.tagData?.tagID
            if (epc == null) {
                Log.w(TAG, "Dropped a tag read with no tag ID.")
                return
            }
            if (!_tags.tryEmit(epc)) {
                // The tags flow buffers 512 — this only fires if nothing is
                // draining it fast enough. Silent drops here mean scans the
                // operator thinks were read never reach the outbox.
                Log.w(TAG, "Dropped a tag read: the tags flow's buffer is full.")
            }
        }

        override fun eventStatusNotify(event: RfidStatusEvents) {
            val data = event.StatusEventData ?: return
            when (data.statusEventType) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT -> {
                    val triggerEvent = when (data.HandheldTriggerEventData?.handheldEvent) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> TriggerEvent.PRESSED
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> TriggerEvent.RELEASED
                        else -> null
                    }
                    // A dropped RELEASED is the dangerous one: it can leave a
                    // latched burst running forever with nothing reported
                    // anywhere, so this is worth a log even though it can't
                    // throw — this runs on the vendor's own callback thread.
                    if (triggerEvent != null && !_triggers.tryEmit(triggerEvent)) {
                        Log.w(TAG, "Dropped a trigger $triggerEvent event: the triggers flow's buffer is full.")
                    }
                }
                STATUS_EVENT_TYPE.BATTERY_EVENT -> {
                    val level = data.BatteryData?.level
                    val was = _connection.value
                    if (was is RfidConnection.Connected && level != null) {
                        _connection.value = was.copy(batteryPct = level)
                    }
                }
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> {
                    // Deliberately doesn't touch `reader`/`readers` — this runs on
                    // the vendor's callback thread and must stay free of vendor
                    // calls. They're torn down the next time connect() runs; see
                    // [hasOpenVendorConnection]/[closeVendorConnection].
                    _connection.value = RfidConnection.Failed("The reader disconnected.")
                }
                else -> Unit
            }
        }
    }

    companion object {
        private const val TAG = "ZebraRfidReader"

        /** Set on [connectNote] once a batch-mode recovery (see
         *  [connectRfid]) has actually gotten the operator connected. Not an
         *  error — factual, one line, American English — so the RFID
         *  settings tab renders it in the same plain tone as the connection
         *  line, never the red error tone `connectionError`/`applyError` use. */
        private const val BATCH_MODE_RECOVERY_NOTE =
            "The reader was holding tags from earlier offline use. They were discarded and batch mode is now off."
    }

    final override suspend fun connect(): Result<Unit> = withContext(Dispatchers.IO) {
        _connection.value = RfidConnection.Connecting
        // A note set by a previous attempt (e.g. a batch-mode recovery) must
        // never linger into this one — it only means something about the
        // attempt currently in flight.
        _connectNote.value = null
        try {
            val readerName = runInterruptible {
                // A DISCONNECTION_EVENT sets `_connection` to Failed but never
                // tears the reader down — nothing calls disconnect() from that
                // state — so a stale reader/listener can still be sitting here
                // the next time connect() runs. Tear it down first so the new
                // reader gets a clean listener registration instead of a
                // duplicate one (see IMPORTANT 2 in the class doc's history).
                if (hasOpenVendorConnection()) {
                    closeVendorConnection()
                }
                openVendorConnection()
            }
            _connection.value = RfidConnection.Connected(readerName, null)
            Result.success(Unit)
        } catch (e: CancellationException) {
            // The 15s timeout in RfidController cancelled us mid-connect. This
            // mirrors disconnect()'s NonCancellable cleanup below, but unlike
            // disconnect() — whose whole body already *is* the teardown —
            // connect() can be cancelled before any teardown of what it just
            // built was even attempted, so this has to actually close the
            // connection, not just clear local state. Skipping this would
            // leave `_connection` on Connecting forever (the controller's
            // collector never sees another transition, so the UI is stuck)
            // and, if the interrupt landed after the listener was registered
            // and the reader connected but before `openVendorConnection()`
            // returned, a live, listening reader with nothing left pointing
            // at it — see [openVendorConnection]'s doc for why that reference
            // survives to be torn down here.
            withContext(NonCancellable) {
                runInterruptible { closeVendorConnection() }
                _connection.value = RfidConnection.Failed("Connecting to the reader was canceled.")
            }
            throw e
        } catch (e: Exception) {
            _connection.value = RfidConnection.Failed(readable(e))
            cleanUpAfterFailedConnect()
            Result.failure(e)
        } catch (e: LinkageError) {
            // A vendor .aar this raw can be missing a class the device or the
            // build environment doesn't have wired up (see the class doc's
            // NoClassDefFoundError note) — a classloading gap, not a checked
            // failure, so it surfaces as an Error, not an Exception. Still
            // reported as a sentence rather than crashing the app.
            _connection.value = RfidConnection.Failed(readable(e))
            cleanUpAfterFailedConnect()
            Result.failure(e)
        }
    }

    /** True while `reader`/`readers` still point at a live vendor connection
     *  that hasn't been torn down — the case a DISCONNECTION_EVENT leaves
     *  behind (see [ZebraRfidReader]'s eventStatusNotify). `connect()` checks
     *  this before building a new one. Overridden by tests that fake
     *  [openVendorConnection]/[closeVendorConnection] with no vendor state to
     *  inspect here. */
    protected open fun hasOpenVendorConnection(): Boolean = reader != null || readers != null

    /** The one place a fresh vendor connection is built: construct `Readers`,
     *  obtain the one available `RFIDReader`, connect it, wire up [listener],
     *  and configure the physical trigger. Assumes any previous connection
     *  has already been torn down — `connect()` sequences
     *  [hasOpenVendorConnection]/[closeVendorConnection] ahead of this, so
     *  this is never called with a live `reader`/`readers` still set.
     *
     *  `reader`/`readers` are assigned the instant each vendor object exists,
     *  not only once every step below succeeds: a cancellation (the 15s
     *  timeout in `RfidController`) landing anywhere in here — including
     *  after the listener is registered and the reader is genuinely
     *  connected and receiving events, but before this function returns —
     *  must still find something in these fields for `connect()`'s
     *  `CancellationException` handler to hand to [closeVendorConnection].
     *  Runs inside `runInterruptible` on `Dispatchers.IO`; see the class doc
     *  for why a bare `withContext(Dispatchers.IO)` would not be enough.
     *
     *  Overridden by test doubles (see `ZebraRfidReaderTest`) to exercise the
     *  surrounding cancellation/teardown state machine in [connect] with no
     *  Zebra hardware — real `Readers`/`RFIDReader` objects can't be built or
     *  driven to a connected state under Robolectric (no reader is ever
     *  found), so this seam is what makes that state machine testable at
     *  all.
     *
     *  A real RFD40 that is still holding a batch of tags from an earlier
     *  offline (no host) session refuses to finish `rfid.connect()`: the SDK
     *  throws `OperationFailureException` with
     *  `RFIDResults.RFID_BATCHMODE_IN_PROGRESS` instead. [connectRfid]
     *  recovers from exactly that, in place, against the same `rfid` this
     *  function just obtained — purge the stored tags, disable batch mode,
     *  persist the change — and only falls back to tearing down and building
     *  a second, fresh connection (via [attemptVendorConnection], called
     *  again below) if that in-place recovery leaves the connection
     *  unusable. That second attempt is not itself allowed to recover — see
     *  [connectRfid]'s doc for why one bounded attempt, never a loop, is the
     *  whole of the recovery this function performs. */
    protected open fun openVendorConnection(): String {
        val first = attemptVendorConnection(allowBatchModeRecovery = true)
        val ready = if (first is VendorConnectAttempt.Ready) {
            first
        } else {
            Log.w(
                TAG,
                "Batch-mode recovery left no usable connection; tearing down and attempting one fresh " +
                    "connection (batch mode is now disabled and saved, so this should connect normally).",
            )
            closeVendorConnection()
            val second = attemptVendorConnection(allowBatchModeRecovery = false)
            // allowBatchModeRecovery = false means connectRfid can only return
            // a usable connection or throw — it never asks for a second
            // fallback. See connectRfid's doc: recovery runs at most once.
            check(second is VendorConnectAttempt.Ready) {
                "unreachable: a fallback attempt cannot itself request another fallback"
            }
            // second.recoveredFromBatchMode is always false: it describes only
            // what happened on THIS call to connectRfid, and this call ran
            // with allowBatchModeRecovery = false, so its own plain-success
            // path (return false) is the only way it reaches Ready. But the
            // only way execution reaches this else branch at all is that
            // `first` was NeedsFreshConnection — which connectRfid only
            // returns after the in-place recovery (purgeTags/setBatchMode/
            // saveConfig) already ran against the reader. So recovery did
            // happen in this openVendorConnection() call; it just didn't
            // leave the *first* connection usable. Force the flag rather than
            // reading it off `second`, so the operator note and log below
            // still fire for this path — see the Important #1 fix-review
            // finding this addresses.
            second.copy(recoveredFromBatchMode = true)
        }
        if (ready.recoveredFromBatchMode) {
            _connectNote.value = BATCH_MODE_RECOVERY_NOTE
            Log.w(TAG, "Batch-mode recovery complete: connected to \"${ready.readerName}\".")
        }
        return ready.readerName
    }

    /** What one call to [attemptVendorConnection] produced. */
    private sealed class VendorConnectAttempt {
        /** Connected — either normally, or after [connectRfid] recovered
         *  in place from a batch-mode reader. */
        data class Ready(val readerName: String, val recoveredFromBatchMode: Boolean) : VendorConnectAttempt()

        /** Batch-mode recovery ran but left the connection unusable. The
         *  caller must tear down and try again exactly once — see
         *  [openVendorConnection]. */
        object NeedsFreshConnection : VendorConnectAttempt()
    }

    /** One full attempt to build a vendor connection: construct `Readers`,
     *  obtain the one available `RFIDReader`, connect it (via [connectRfid],
     *  which is where batch-mode recovery happens when
     *  [allowBatchModeRecovery] is true), and — only once connected — wire up
     *  [listener] and the physical trigger config. Pulled out of
     *  [openVendorConnection] so that function can call this twice (the
     *  initial attempt, and — only for the one allowed fallback — a second,
     *  fresh one) without duplicating the `Readers`/`RFIDReader` setup. */
    private fun attemptVendorConnection(allowBatchModeRecovery: Boolean): VendorConnectAttempt {
        // Readers registers a broadcast receiver internally with no
        // RECEIVER_EXPORTED/RECEIVER_NOT_EXPORTED flag. Android 14 (API 34)
        // enforces that one of those flags be supplied and throws
        // SecurityException otherwise; the flags themselves (and the
        // registerReceiver overloads that take them) exist starting API 33,
        // so wrapping from there too is harmless and one guard instead of
        // two. See ExportedReceiverContext's doc for the full story and why
        // RECEIVER_EXPORTED is the right flag to supply on the library's
        // behalf. Below API 33 the flag doesn't exist at all, so the raw
        // context is used unchanged.
        val readerContext =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ExportedReceiverContext(context)
            } else {
                context
            }
        val all = Readers(readerContext, ENUM_TRANSPORT.ALL)
        readers = all
        val device = all.GetAvailableRFIDReaderList()?.firstOrNull()
            ?: error("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")
        // device.getRFIDReader() is the real accessor: the SDK's setter is
        // misspelled setRFIDRReader(...), which breaks Kotlin's usual
        // getX()/setX(X) property synthesis, so the explicit Java call is
        // used here rather than a synthetic `device.rfidReader` property.
        val rfid = device.getRFIDReader()
        reader = rfid
        val recoveredFromBatchMode = connectRfid(rfid, allowBatchModeRecovery)
            ?: return VendorConnectAttempt.NeedsFreshConnection
        configurePostConnectSetup(rfid)
        return VendorConnectAttempt.Ready(device.name ?: "RFID reader", recoveredFromBatchMode)
    }

    /** Calls `rfid.connect()`, recovering in place — at most once — from a
     *  reader that is holding a batch of stored tags from an earlier offline
     *  session. Returns `false` if `connect()` just succeeded normally,
     *  `true` if it succeeded only after recovery, or `null` if recovery ran
     *  but left the connection unusable (the caller must tear down and try a
     *  single fresh connection instead — see [openVendorConnection]).
     *
     *  Recovery is attempted only when [allowBatchModeRecovery] is true —
     *  `false` on the one fallback attempt [openVendorConnection] is allowed
     *  to make, so a second `RFID_BATCHMODE_IN_PROGRESS` (or any other
     *  connect failure) on that attempt propagates straight out to
     *  `connect()`'s own failure handling, exactly like any other connect
     *  failure, rather than looping. */
    private fun connectRfid(rfid: RFIDReader, allowBatchModeRecovery: Boolean): Boolean? {
        try {
            rfid.connect()
            return false
        } catch (e: OperationFailureException) {
            if (!allowBatchModeRecovery || e.results != RFIDResults.RFID_BATCHMODE_IN_PROGRESS) throw e
            Log.w(
                TAG,
                "Connect failed with RFID_BATCHMODE_IN_PROGRESS: the reader is holding tags stored during " +
                    "an earlier offline session. Attempting recovery: purge the stored tags, disable batch " +
                    "mode, and save the change to the reader.",
            )
            val usable = try {
                // The stored tags carry no move/site context and the kiosk has
                // nowhere to file them, so they are discarded rather than
                // retrieved (getBatchedTags() is deliberately not called).
                rfid.Actions.purgeTags()
                rfid.Config.setBatchMode(BATCH_MODE.DISABLE)
                // Persisted, not just set in memory: batch mode is stored in
                // the reader's own non-volatile config, so without saveConfig()
                // a power cycle could restore whatever was last saved there
                // (most likely left on by a prior 123RFID Mobile session) and
                // reproduce this exact failure the next time the sled is used.
                rfid.Config.saveConfig()
                Log.w(TAG, "Batch-mode recovery: stored tags purged, batch mode disabled, saveConfig() ran.")
                rfid.isConnected()
            } catch (interrupt: InterruptedException) {
                // A real cancellation (the 15s timeout in RfidController)
                // landing mid-recovery, not a recovery failure — must reach
                // the enclosing `runInterruptible` in connect() so it becomes
                // a CancellationException there, exactly like every other
                // vendor call site in this file. Swallowing it here the same
                // way as an ordinary recovery failure below would defeat that.
                throw interrupt
            } catch (recoveryError: Exception) {
                // The SDK gives no other signal for "is this connection still
                // usable" than isConnected() — if the recovery calls
                // themselves throw (anything other than the cancellation
                // above), that is treated the same as isConnected() reporting
                // false, not as a reason to keep trying against this same
                // rfid instance.
                Log.w(TAG, "Batch-mode recovery's own calls failed; treating the connection as unusable.", recoveryError)
                false
            }
            return if (usable) {
                Log.w(TAG, "Batch-mode recovery left a usable connection; continuing without a full reconnect.")
                true
            } else {
                null
            }
        }
    }

    /** The post-connect setup every successful attempt needs, whether it
     *  connected normally or after [connectRfid] recovered from batch mode:
     *  wire up [listener] and pin the physical trigger to immediate. Split
     *  out of [attemptVendorConnection] only so that function reads as one
     *  attempt rather than two copies of this block. */
    private fun configurePostConnectSetup(rfid: RFIDReader) {
        rfid.Events.addEventsListener(listener)
        rfid.Events.setHandheldEvent(true)
        rfid.Events.setTagReadEvent(true)
        rfid.Events.setBatteryEvent(true)
        rfid.Events.setAttachTagDataWithReadEvent(true)
        // RFID_MODE with updateScannerPlugin = true puts the physical trigger
        // on the radio rather than the barcode imager.
        rfid.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
        // Pin the reader's own start/stop trigger behavior to immediate: a
        // sled left on HANDHELD (its 123RFID Mobile default) would let its
        // own firmware decide when an inventory starts and stops, defeating
        // RfidTrigger's latch/toggle modes and letting it transmit even
        // while the controller is disarmed. StartTrigger/StopTrigger have no
        // public constructor, so this follows the same get-mutate-set
        // pattern as the antenna/singulation config in apply() below.
        val startTrigger = rfid.Config.getStartTrigger()
        startTrigger.triggerType = START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE
        rfid.Config.setStartTrigger(startTrigger)

        val stopTrigger = rfid.Config.getStopTrigger()
        stopTrigger.triggerType = STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE
        rfid.Config.setStopTrigger(stopTrigger)
    }

    /** Tears down whatever [openVendorConnection] built: removes [listener],
     *  disconnects, and disposes, best-effort. The one function `connect()`
     *  (both its "tear down anything stale first" step and its cancellation
     *  cleanup), `disconnect()`, and [cleanUpAfterFailedConnect] all route
     *  through, so a test double only has to override this once to observe
     *  or fake every teardown path. */
    protected open fun closeVendorConnection() {
        disconnectBlocking()
    }

    // Best-effort cleanup of whatever partially connected before a connect()
    // failure. Still interruptible, and still never swallows a cancellation
    // that lands during the cleanup itself. Deliberately never touches
    // `_connection`: connect()'s catch already set it to `Failed(reason)`
    // before calling this, and clearing the reader refs must not clobber
    // that back to `Disconnected` (a real bug caught by
    // connectingWithNoReaderPresentFailsWithSomethingReadable — this used to
    // share resetState() with disconnect(), which unconditionally set
    // Disconnected and silently overwrote the Failed state on every return
    // path).
    private suspend fun cleanUpAfterFailedConnect() {
        try {
            runInterruptible { closeVendorConnection() }
        } catch (ce: CancellationException) {
            throw ce
        } catch (ignored: Exception) {
            clearReaderRefs()
        } catch (ignored: LinkageError) {
            clearReaderRefs()
        }
    }

    final override suspend fun disconnect() {
        withContext(Dispatchers.IO) {
            try {
                runInterruptible { closeVendorConnection() }
                _connection.value = RfidConnection.Disconnected
            } catch (e: CancellationException) {
                // The interrupt landed mid-cleanup. Leave local state consistent
                // for the next connect() attempt — the same NonCancellable idiom
                // RfidController.endBurst uses to finish its own claim before
                // rethrowing — then let the cancellation keep propagating.
                withContext(NonCancellable) {
                    clearReaderRefs()
                    _connection.value = RfidConnection.Disconnected
                }
                throw e
            } catch (e: Exception) {
                clearReaderRefs()
                _connection.value = RfidConnection.Disconnected
            } catch (e: LinkageError) {
                clearReaderRefs()
                _connection.value = RfidConnection.Disconnected
            }
        }
    }

    /** Only ever called from inside [runInterruptible]; never suspends itself.
     *  Leaves `_connection` untouched — see [cleanUpAfterFailedConnect]'s doc. */
    private fun disconnectBlocking() {
        teardownStep { reader?.Events?.removeEventsListener(listener) }
        teardownStep { reader?.disconnect() }
        teardownStep { readers?.Dispose() }
        clearReaderRefs()
    }

    /** Runs one best-effort vendor teardown call, the way a bare `runCatching`
     *  around each step used to. The difference: an `InterruptedException`
     *  restores the thread's interrupt status before moving on to the next
     *  step, instead of just swallowing it. `runCatching` alone would clear
     *  the flag as a side effect of catching it (throwing
     *  `InterruptedException` clears it), which left every step after the
     *  first one that got interrupted running with a clean flag — no longer
     *  interruptible, and nothing left for the enclosing `runInterruptible`
     *  to see and convert into a `CancellationException` once this whole
     *  teardown finishes. */
    private inline fun teardownStep(action: () -> Unit) {
        try {
            action()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (ignored: Throwable) {
            // Best-effort: the remaining steps still need to run.
        }
    }

    private fun clearReaderRefs() {
        reader = null
        readers = null
    }

    final override suspend fun apply(settings: RfidSettings): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            runInterruptible {
                val rfid = reader ?: error("The reader is not connected.")
                val antenna = rfid.Config.Antennas.getAntennaRfConfig(1)
                antenna.transmitPowerIndex = powerToTenths(settings.powerDbm)
                rfid.Config.Antennas.setAntennaRfConfig(1, antenna)

                val singulation = rfid.Config.Antennas.getSingulationControl(1)
                singulation.session = when (settings.session) {
                    RfidSession.S0 -> SESSION.SESSION_S0
                    RfidSession.S1 -> SESSION.SESSION_S1
                    RfidSession.S2 -> SESSION.SESSION_S2
                    RfidSession.S3 -> SESSION.SESSION_S3
                }
                singulation.tagPopulation = settings.tagPopulation.toShort()
                rfid.Config.Antennas.setSingulationControl(1, singulation)

                rfid.Config.setBeeperVolume(
                    when (settings.beeper) {
                        SledBeeper.OFF -> BEEPER_VOLUME.QUIET_BEEP
                        SledBeeper.LOW -> BEEPER_VOLUME.LOW_BEEP
                        SledBeeper.MEDIUM -> BEEPER_VOLUME.MEDIUM_BEEP
                        SledBeeper.HIGH -> BEEPER_VOLUME.HIGH_BEEP
                    }
                )
                rfid.Config.setLedBlinkEnable(settings.ledOnRead)
                rfid.Config.setUniqueTagReport(settings.uniqueTagReport)
                // Config.dpoState does not resolve: the real accessors are
                // getDPOState()/setDPOState(...) (capital DPO, per javap), which
                // Kotlin does not fold into a `dpoState` property because a
                // getter/setter pair whose base name starts with two uppercase
                // letters (JavaBeans decapitalization rule) keeps its original
                // capitalization. Called explicitly to sidestep the ambiguity.
                rfid.Config.setDPOState(
                    if (settings.dpo) DYNAMIC_POWER_OPTIMIZATION.ENABLE else DYNAMIC_POWER_OPTIMIZATION.DISABLE
                )
            }
            Result.success(Unit)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        } catch (e: LinkageError) {
            Result.failure(e)
        }
    }

    final override suspend fun startInventory(): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            runInterruptible {
                val rfid = reader ?: error("The reader is not connected.")
                rfid.Actions.Inventory.perform()
            }
            Result.success(Unit)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        } catch (e: LinkageError) {
            Result.failure(e)
        }
    }

    final override suspend fun stopInventory(): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            runInterruptible {
                val rfid = reader ?: error("The reader is not connected.")
                rfid.Actions.Inventory.stop()
            }
            Result.success(Unit)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        } catch (e: LinkageError) {
            Result.failure(e)
        }
    }

    /** The regions this reader allows and the one in force. Built from
     *  `ReaderCapabilities.SupportedRegions` (a plain field, like `Config`/
     *  `Events`/`Actions` elsewhere in this file — not a getter) and
     *  `Config.getRegulatoryConfig().getRegion()`. Region is a compliance
     *  setting, never pushed by [apply] and never re-asserted on reconnect —
     *  only read or set on explicit admin action. */
    final override suspend fun regions(): Result<RfidRegions> = withContext(Dispatchers.IO) {
        try {
            val result = runInterruptible {
                val rfid = reader ?: error("The reader is not connected.")
                val supported = rfid.ReaderCapabilities.SupportedRegions
                val regions = (0 until supported.length()).map { i ->
                    val info = supported.getRegionInfo(i)
                    RfidRegion(
                        code = info.regionCode,
                        name = info.name,
                        hoppingConfigurable = info.isHoppingConfigurable,
                        channels = info.supportedChannels?.toList().orEmpty(),
                    )
                }
                val active = rfid.Config.getRegulatoryConfig()?.region
                RfidRegions(regions, active)
            }
            Result.success(result)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        } catch (e: LinkageError) {
            Result.failure(e)
        }
    }

    /** Set the regulatory domain. `RegulatoryConfig` has a public
     *  constructor (unlike `StartTrigger`/`StopTrigger` in
     *  [openVendorConnection]), so this builds a fresh one rather than
     *  get-mutate-set. `hopping` is applied via the explicit
     *  `setIsHoppingOn(boolean)` call — its getter is `isHoppingon()` (note
     *  the lowercase "on"), a case mismatch that keeps Kotlin from
     *  synthesizing a property the way `setDPOState`'s mismatch does in
     *  [apply] — only when non-null, leaving the reader's own hopping state
     *  alone otherwise. */
    final override suspend fun setRegion(code: String, hopping: Boolean?): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            runInterruptible {
                val rfid = reader ?: error("The reader is not connected.")
                val regulatoryConfig = RegulatoryConfig()
                regulatoryConfig.region = code
                if (hopping != null) regulatoryConfig.setIsHoppingOn(hopping)
                rfid.Config.setRegulatoryConfig(regulatoryConfig)
            }
            Result.success(Unit)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        } catch (e: LinkageError) {
            Result.failure(e)
        }
    }

    /** SDK exceptions carry codes, not sentences — `e.message` alone is empty
     *  or useless for Zebra's own exception types, which is why the sled
     *  used to fail with nothing but "Couldn't connect to the reader."
     *  no matter what actually went wrong. This unpacks what the vendor
     *  really gives us — `OperationFailureException.getResults()`/
     *  `getStatusDescription()`/`getVendorMessage()`,
     *  `InvalidUsageException.getInfo()`/`getVendorMessage()` — logs all of
     *  it at warning level so a failure is diagnosable over adb (`adb
     *  logcat -s ZebraRfidReader`) without asking the operator to read the
     *  phone screen, and turns it into an operator-facing sentence that
     *  names the specific failure instead of hiding it. Only ever called
     *  from `connect()`'s failure paths, so logging here already covers
     *  "whenever a connect fails."
     *
     *  The actual formatting is pulled out into [operationFailureMessage]/
     *  [invalidUsageMessage]/[genericMessage] — plain functions over plain
     *  values, not the vendor exception types themselves — because
     *  `OperationFailureException`'s constructor is package-private and
     *  can't be built from a test in the normal way; those functions are
     *  what `ZebraRfidReaderTest` can actually exercise. */
    private fun readable(e: Throwable): String {
        return when (e) {
            is OperationFailureException -> {
                val resultsName = e.results?.toString()
                val statusDescription = e.statusDescription
                val vendorMessage = e.vendorMessage
                Log.w(
                    TAG,
                    "Connect failed: OperationFailureException results=$resultsName " +
                        "statusDescription=$statusDescription vendorMessage=$vendorMessage " +
                        "timeStamp=${e.timeStamp}",
                    e,
                )
                operationFailureMessage(resultsName, statusDescription, vendorMessage)
            }
            is InvalidUsageException -> {
                val info = e.info
                val vendorMessage = e.vendorMessage
                Log.w(
                    TAG,
                    "Connect failed: InvalidUsageException info=$info vendorMessage=$vendorMessage " +
                        "timeStamp=${e.timeStamp}",
                    e,
                )
                invalidUsageMessage(info, vendorMessage)
            }
            else -> {
                Log.w(TAG, "Connect failed: ${e.javaClass.name}", e)
                genericMessage(e.message)
            }
        }
    }
}

/** Builds the operator-facing sentence for an `OperationFailureException`
 *  from its already-unpacked detail. Pure and free of any `com.zebra.*`
 *  type, which is what makes it testable without constructing one — see
 *  [ZebraRfidReader.readable] for where the real exception is unpacked into
 *  [resultsName] (`getResults()?.toString()`, the `RFIDResults` constant's
 *  own name — e.g. "RFID_READER_REGION_NOT_CONFIGURED" — the one detail
 *  precise enough to identify the cause), [statusDescription]
 *  (`getStatusDescription()`), and [vendorMessage] (`getVendorMessage()`). */
internal fun operationFailureMessage(
    resultsName: String?,
    statusDescription: String?,
    vendorMessage: String?,
): String {
    if (resultsName == "RFID_READER_REGION_NOT_CONFIGURED") {
        return "The reader hasn't been assigned a regulatory region yet " +
            "(RFID_READER_REGION_NOT_CONFIGURED). Set the reader's region on the Admin tab, then try again."
    }
    val detail = statusDescription.blankToNull() ?: vendorMessage.blankToNull()
    return when {
        resultsName.isNullOrBlank() && detail == null -> "Couldn't connect to the reader."
        resultsName.isNullOrBlank() -> "Couldn't connect to the reader ($detail)."
        detail == null -> "Couldn't connect to the reader ($resultsName)."
        else -> "Couldn't connect to the reader ($resultsName: $detail)."
    }
}

/** Same idea as [operationFailureMessage] but for `InvalidUsageException`,
 *  which carries no `RFIDResults` constant — just `getInfo()` and
 *  `getVendorMessage()`. */
internal fun invalidUsageMessage(info: String?, vendorMessage: String?): String {
    val detail = info.blankToNull() ?: vendorMessage.blankToNull()
    return if (detail == null) "Couldn't connect to the reader." else "Couldn't connect to the reader ($detail)."
}

/** The pre-existing behavior for every other exception, unchanged: these
 *  don't come from `com.zebra.*`, so `e.message` is still all there is. */
internal fun genericMessage(raw: String?): String {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.endsWith(".") && trimmed.length > 12) return trimmed
    return if (trimmed.isEmpty()) "Couldn't connect to the reader." else "Couldn't connect to the reader ($trimmed)."
}

private fun String?.blankToNull(): String? = this?.trim()?.takeUnless { it.isEmpty() }
