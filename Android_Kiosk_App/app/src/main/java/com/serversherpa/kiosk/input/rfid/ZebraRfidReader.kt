package com.serversherpa.kiosk.input.rfid

import android.content.Context
import android.os.Build
import android.util.Log
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerPersonality
import com.serversherpa.kiosk.core.rfid.ScannerPluginMode
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.powerToTenths
import com.serversherpa.kiosk.input.datawedge.DataWedge
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
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
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
 * Until `ZebraBarcodeEngine.kt` was added alongside this file, this was the
 * only file in this app that knew Zebra existed;
 * `CorePurityTest.onlyDesignatedFilesImportTheZebraSdk` (renamed from
 * `onlyZebraRfidReaderImportsTheZebraSdk`) now enforces the two-file version
 * of that rule instead of the one-file version. This file talks to
 * `com.zebra.rfid.api3` — the RFID radio. `ZebraBarcodeEngine` talks to the
 * separate `com.zebra.scannercontrol` SDK, for the sled's barcode imager —
 * a different physical device inside the same RFD40 housing; see that
 * file's class doc for why a second Zebra SDK is needed at all.
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
 * a belt-and-braces guard against a future vendor `.aar` update referencing
 * some class this app doesn't have on its classpath — the RFIDAPI3 `.aar` is
 * wired in as a raw local artifact (see `RFIDAPI3Library/build.gradle`), not
 * a real Maven/AAR dependency, so a bad reference fails silently at runtime
 * instead of at build time. As of the 2.0.5.292 upgrade (see the `.aar`'s
 * own history for the version this replaced) the vendor code no longer
 * touches `android.support.v4.content.LocalBroadcastManager` at all —
 * confirmed via `javap` against the new `classes.jar`, which is why the
 * `com.android.support:localbroadcastmanager:28.0.0` dependency this
 * comment used to explain was removed. `ZebraReadersConstructibleTest`
 * asserts `Readers` construction never throws a `LinkageError`/
 * `NoClassDefFoundError`, so a regression here — a future vendor `.aar`
 * update needing some class this app doesn't have — fails a build-time
 * test, not just a real device. The runtime catch stays anyway: it's what
 * keeps the "connect() never throws, it reports" contract true for any
 * other classloading gap the test doesn't happen to exercise (a different
 * reader model's code path, a different Android version, a future SDK
 * bump) — `NoClassDefFoundError` and `UnsatisfiedLinkError` (a missing
 * native `.so`) are both `LinkageError`, not `Exception`, so a bare
 * `catch (e: Exception)` would let either fall straight through as an
 * uncaught crash.
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

    /** Wraps the separate `com.zebra.scannercontrol` SDK to stand the
     *  sled's barcode imager down — see [ZebraBarcodeEngine]'s class doc for
     *  why the RFID SDK's own [configureTriggerMode] cannot do this alone.
     *  Built fresh in [standDownBarcodeImager] for a connection whose
     *  [RfidTriggerPersonality] is RFID, the same "new vendor object per
     *  connect" shape `readers`/`reader` use; null otherwise (disconnected,
     *  or the personality is BARCODE and this was never built), so
     *  [disconnectBlocking] has something to tear down only when there is
     *  something to tear down. */
    private var barcodeEngine: ZebraBarcodeEngine? = null

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

        /** Wall-clock bound for [runBarcodeStandDownWithTimeout] — see that
         *  function's doc for the mechanism. `RfidController` wraps the
         *  entire `connect()` call in a 15s `withTimeoutOrNull`
         *  (`RfidController.VENDOR_TIMEOUT_MS`), and everything that runs
         *  ahead of [standDownBarcodeImager] inside [configurePostConnectSetup]
         *  — `rfid.connect()` itself (inside [attemptVendorConnection]),
         *  [recoverFromBatchMode] if a batch-mode recovery happened,
         *  [preventBatchMode], [configureTriggerMode]'s up-to-two
         *  `setTriggerMode` attempts, and the start/stop trigger pinning —
         *  is ordinary RFID-radio SDK traffic that has always finished comfortably
         *  inside that 15s budget on real hardware. 5 seconds leaves that
         *  work generous headroom while still giving a real but slow
         *  *correct* sled (the scenario this bound exists for, now that Bug
         *  1 no longer wastes ~13s reaching a wrong one) a fair chance to
         *  finish rather than being cut off almost immediately — deliberately
         *  well under half the overall 15s budget, not a value tuned against
         *  real hardware (none was available to tune it against; see this
         *  task's report). */
        private const val BARCODE_STAND_DOWN_TIMEOUT_MS = 5_000L
    }

    /** [triggerPersonality]/[scannerPluginMode] are `RfidSettings`' two
     *  connect-time-only knobs (see that class's doc and
     *  [configureTriggerMode]'s): the caller — in production,
     *  `RfidController`, reading its own current settings — decides what to
     *  ask for; this function is what actually asks for it, once the vendor
     *  reader exists (see [openVendorConnection]/[configurePostConnectSetup]/
     *  [configureTriggerMode]). */
    final override suspend fun connect(
        triggerPersonality: RfidTriggerPersonality,
        scannerPluginMode: ScannerPluginMode,
    ): Result<Unit> = withContext(Dispatchers.IO) {
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
                openVendorConnection(triggerPersonality, scannerPluginMode)
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
     *  recovers from exactly that, against the same `rfid` this function
     *  just obtained — see [recoverFromBatchMode] for the sequence and why
     *  it is an unverified hypothesis, not documented Zebra behavior.
     *  Recovery either leaves this connection usable (`connectRfid` returns
     *  `true`) or throws [BatchModeUnrecoverableException], which propagates
     *  straight out of this function to `connect()`'s ordinary failure
     *  handling. There is deliberately no further fallback attempt here: an
     *  earlier version of this function tore down and tried one bare, fresh
     *  `connect()` when in-place recovery failed, but that just repeated
     *  `RFID_BATCHMODE_IN_PROGRESS` — the batch was never actually cleared,
     *  because that recovery dereferenced `Actions`/`Config` while they were
     *  still null and crashed before doing anything (see
     *  `.superpowers/sdd/batchmode-report.md`) — so a second bare attempt
     *  had nothing to gain. */
    protected open fun openVendorConnection(triggerPersonality: RfidTriggerPersonality, scannerPluginMode: ScannerPluginMode): String {
        val result = attemptVendorConnection(triggerPersonality, scannerPluginMode)
        if (result.recoveredFromBatchMode) {
            // Append rather than overwrite: attemptVendorConnection() runs
            // configurePostConnectSetup() — and so configureTriggerMode() —
            // before this returns, so _connectNote already carries
            // configureTriggerMode()'s own outcome note (see its doc: it
            // sets one every time, success or failure). Both are
            // independently true facts about this connection and the
            // operator should see whichever ones apply, not just whichever
            // was set last.
            _connectNote.value = combineConnectNotes(_connectNote.value, BATCH_MODE_RECOVERY_NOTE)
            Log.w(TAG, "Batch-mode recovery complete: connected to \"${result.readerName}\".")
        }
        return result.readerName
    }

    /** What [attemptVendorConnection] produced: the reader's display name,
     *  and whether getting there required [connectRfid] to recover from
     *  batch mode. */
    private data class VendorConnectResult(val readerName: String, val recoveredFromBatchMode: Boolean)

    /** The one attempt to build a vendor connection: construct `Readers`,
     *  obtain the one available `RFIDReader`, connect it (via [connectRfid],
     *  which is where batch-mode recovery happens), and — only once
     *  connected — wire up [listener] and the physical trigger config via
     *  [configurePostConnectSetup]. Pulled out of [openVendorConnection] so
     *  that function reads as orchestration rather than mixing in the
     *  `Readers`/`RFIDReader` setup. */
    private fun attemptVendorConnection(triggerPersonality: RfidTriggerPersonality, scannerPluginMode: ScannerPluginMode): VendorConnectResult {
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
        // The identity ZebraBarcodeEngine's chooseScanner() matches candidate
        // scanners against — see that function's doc for why: without this,
        // the barcode engine has no way to tell its own sled apart from some
        // other Bluetooth device the phone happens to be paired with.
        val sledIdentity = SledIdentity(name = device.name, address = device.address, serial = device.serialNumber)
        val recoveredFromBatchMode = connectRfid(rfid)
        configurePostConnectSetup(rfid, triggerPersonality, scannerPluginMode, sledIdentity)
        return VendorConnectResult(device.name ?: "RFID reader", recoveredFromBatchMode)
    }

    /** Calls `rfid.connect()`. Returns `false` if it just succeeds normally,
     *  or `true` if it succeeded only after [recoverFromBatchMode] recovered
     *  from a reader holding a batch of stored tags from an earlier offline
     *  session. Any other failure — including a batch-mode recovery that
     *  exhausted every avenue it knows — propagates straight out, through
     *  [attemptVendorConnection] and [openVendorConnection], to `connect()`'s
     *  own failure handling. */
    private fun connectRfid(rfid: RFIDReader): Boolean {
        try {
            rfid.connect()
            return false
        } catch (e: OperationFailureException) {
            if (e.results != RFIDResults.RFID_BATCHMODE_IN_PROGRESS) throw e
            Log.w(
                TAG,
                "Connect failed with RFID_BATCHMODE_IN_PROGRESS: the reader is holding tags stored during " +
                    "an earlier offline session. connect() throws before populating Actions/Config/Events/" +
                    "ReaderCapabilities (see the class doc), so those fields are null right now and cannot " +
                    "be used directly. Attempting recovery via PostConnectReaderUpdate() instead.",
            )
            recoverFromBatchMode(rfid)
            return true
        }
    }

    /**
     * An unverified recovery sequence for a reader stuck reporting
     * `RFID_BATCHMODE_IN_PROGRESS`, derived from `RFIDReader`'s public
     * surface (`PostConnectReaderUpdate()`, `reconnect()`, `connect()`,
     * `isConnected()`, `isCapabilitiesReceived()` — all confirmed present,
     * with the exception signatures below, via `javap` against the shipped
     * `.aar`), **not from any Zebra documentation** — nobody on this team has
     * seen Zebra's own account of what a host is supposed to do here. The
     * hypothesis: `PostConnectReaderUpdate()` is a method on the reader
     * object itself, callable even though `Actions`/`Config` are still null,
     * and its name suggests it finishes whatever setup `connect()` left
     * undone — including, maybe, populating those fields. Tried first; if it
     * throws, or leaves the reader still unusable, `reconnect()` is tried as
     * a second avenue, then — if that also fails — a bare second
     * `rfid.connect()` on the same object that just threw
     * `RFID_BATCHMODE_IN_PROGRESS`, with nothing torn down first, is tried
     * as a third. This has never been tried before: the earlier fallback
     * this file used to have (see `.superpowers/sdd/batchmode-report.md`)
     * tore the connection down and rebuilt it from scratch before retrying,
     * which is a different thing entirely. If none of the three avenues
     * works, this throws [BatchModeUnrecoverableException] and stops — no
     * fourth avenue, no loop. [BatchModeUnrecoverableException]'s message is
     * the *supported* remedy: Zebra's own 123RFID Mobile app is known to be
     * able to connect to a sled in this state and clear it, which is
     * genuinely useful for the operator to hear instead of a generic connect
     * failure inviting another doomed retry.
     *
     * Every step is logged at warning level with exactly what the reader
     * reported — `isConnected()`, `isCapabilitiesReceived()`, and whether
     * `Actions`/`Config` are null — because that is how this hypothesis gets
     * checked against real hardware; this logging is as much the point of
     * this function as the recovery itself. Never dereferences
     * `Actions`/`Config` without checking them first — that is exactly how
     * the previous recovery attempt crashed (a `NullPointerException` on
     * `Actions.purgeTags()`; see `.superpowers/sdd/batchmode-report.md`).
     *
     * Now that [preventBatchMode] runs on every successful connect — and, as
     * of [disconnectBlocking]'s own batch-mode-safe teardown, on every
     * disconnect too — and leaves `BATCH_MODE.DISABLE` persisted both ways,
     * hitting `RFID_BATCHMODE_IN_PROGRESS` here at all is expected to become
     * rare — this app no longer routinely leaves a reader in a state that
     * causes it, so a real hit is more likely a sled that arrived already
     * batching from some other source (e.g. Zebra's own 123RFID Mobile app)
     * than anything this app itself did. This recovery path stays exactly as
     * it is functionally either way: [preventBatchMode] is prevention, not a
     * replacement for having a recovery path at all.
     */
    private fun recoverFromBatchMode(rfid: RFIDReader) {
        if (tryBatchModeRecoveryAvenue("PostConnectReaderUpdate()", rfid) { rfid.PostConnectReaderUpdate() }) return
        if (tryBatchModeRecoveryAvenue("reconnect()", rfid) { rfid.reconnect() }) return
        if (tryBatchModeRecoveryAvenue("connect()", rfid) { rfid.connect() }) return
        Log.w(
            TAG,
            "Batch-mode recovery exhausted all three avenues (PostConnectReaderUpdate(), reconnect(), and a " +
                "bare second connect()); the reader is still unusable. Stopping rather than retrying the same " +
                "calls forever.",
        )
        throw BatchModeUnrecoverableException()
    }

    /**
     * Runs one batch-mode recovery avenue: [action] (`PostConnectReaderUpdate()`,
     * `reconnect()`, or a bare `connect()`, named by [label] for logging),
     * then checks and logs whether the reader now looks usable
     * ([logAndCheckUsable]), then — only if it does — purges the stored
     * tags and disables/persists batch mode ([purgeAndDisableBatchMode]).
     * Returns `true` only once all of that has actually succeeded. Any
     * failure at any step — [action] itself throwing, the reader still not
     * reporting `Actions`/`Config` as populated, or the purge/disable/save
     * calls throwing — returns `false` so [recoverFromBatchMode] can move on
     * to the next avenue or give up. `InterruptedException` (a real
     * cancellation, not a recovery failure) is deliberately excluded from
     * "failure" and rethrown immediately, exactly like every other vendor
     * call site in this file.
     */
    private fun tryBatchModeRecoveryAvenue(label: String, rfid: RFIDReader, action: () -> Unit): Boolean {
        try {
            action()
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (e: Exception) {
            Log.w(TAG, "Batch-mode recovery: $label threw; treating this avenue as failed.", e)
            return false
        }
        if (!logAndCheckUsable(label, rfid)) return false
        return try {
            purgeAndDisableBatchMode(rfid)
            true
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (e: Exception) {
            Log.w(TAG, "Batch-mode recovery: $label left the reader looking usable, but purge/disable/save failed.", e)
            false
        }
    }

    /** Logs exactly what [avenue] left behind — `isConnected()`,
     *  `isCapabilitiesReceived()`, and whether `Actions`/`Config` are null —
     *  and returns whether that is enough to purge/configure through: per
     *  the recovery hypothesis, connected with both `Actions` and `Config`
     *  non-null (see [batchModeRecoveryUsable]). `isCapabilitiesReceived()`
     *  is logged only; it is not part of the usability decision — this
     *  whole function exists to learn what the SDK actually does in this
     *  state, and that field is part of what there is to learn. */
    private fun logAndCheckUsable(avenue: String, rfid: RFIDReader): Boolean {
        val connected = rfid.isConnected()
        val capabilitiesReceived = rfid.isCapabilitiesReceived()
        val actionsPresent = rfid.Actions != null
        val configPresent = rfid.Config != null
        Log.w(
            TAG,
            "Batch-mode recovery via $avenue: isConnected()=$connected " +
                "isCapabilitiesReceived()=$capabilitiesReceived " +
                "Actions=${if (actionsPresent) "present" else "null"} " +
                "Config=${if (configPresent) "present" else "null"}",
        )
        return batchModeRecoveryUsable(connected, actionsPresent, configPresent)
    }

    /** Purges the stored tags and turns batch mode off, persisted. Only
     *  ever called once [logAndCheckUsable] has confirmed `Actions`/`Config`
     *  are non-null, but re-checks them here rather than trusting that call
     *  site — never dereference a possibly-null vendor field without
     *  checking it first, which is exactly how the previous recovery
     *  attempt crashed (see `.superpowers/sdd/batchmode-report.md`). */
    private fun purgeAndDisableBatchMode(rfid: RFIDReader) {
        val actions = rfid.Actions
        val config = rfid.Config
        checkNotNull(actions) { "unreachable: caller already confirmed Actions is non-null" }
        checkNotNull(config) { "unreachable: caller already confirmed Config is non-null" }
        // The stored tags carry no move/site context and the kiosk has
        // nowhere to file them, so they are discarded rather than retrieved
        // (getBatchedTags() is deliberately not called).
        actions.purgeTags()
        config.setBatchMode(BATCH_MODE.DISABLE)
        // Persisted, not just set in memory: batch mode is stored in the
        // reader's own non-volatile config, so without saveConfig() a power
        // cycle could restore whatever was last saved there (most likely
        // left on by a prior 123RFID Mobile session) and reproduce this
        // exact failure the next time the sled is used.
        config.saveConfig()
        Log.w(TAG, "Batch-mode recovery: stored tags purged, batch mode disabled, saveConfig() ran.")
    }

    /**
     * Prevention, not just recovery: until now, the only defense against
     * `RFID_BATCHMODE_IN_PROGRESS` was [recoverFromBatchMode] — reached only
     * *after* a connect had already failed once. This runs on every
     * successful connect instead, unconditionally, from
     * [configurePostConnectSetup] — which itself already runs on every
     * successful [connectRfid], whether that was the plain path or the
     * batch-mode-recovery path — so from here on, this app leaves every
     * reader it connects to with batch mode off and that turned-off state
     * persisted, instead of only fixing it reactively the one time it's
     * already caused a failure.
     *
     * Runs first in [configurePostConnectSetup] — before the event-listener
     * wiring, [configureTriggerMode], and the start/stop trigger pinning
     * that can throw — precisely so a throw anywhere after it still leaves
     * the sled batch-mode-safe; see that function's doc for the full
     * reasoning. [disconnectBlocking] is this function's teardown-side
     * counterpart: it leaves the sled just as batch-mode-safe on the way
     * *out* of a connection as this leaves it on the way *in*, which closes
     * the one gap this function alone can't — a session that ends without
     * ever calling `connect()` again.
     *
     * Logged with a distinctive, greppable `"Batch-mode prevention: "`
     * prefix — parallel to [purgeAndDisableBatchMode]'s own
     * `"Batch-mode recovery: "` prefix — so this step's evidence (the
     * before value, and, once changed, the after value) is easy to find in
     * a device log (`adb logcat -s ZebraRfidReader`); that evidence is what
     * proves this fix actually runs and actually works, the same reasoning
     * behind nearly every other log line in this file.
     *
     * Never fails `connect()`: wrapped exactly the way every other
     * non-essential vendor call in this file already is —
     * `InterruptedException` rethrown as a real cancellation, `Exception`/
     * `LinkageError` logged and degraded — the same idiom
     * [tryBatchModeRecoveryAvenue] uses for its own vendor calls. A failure
     * to read/set/save the batch-mode config here must never break an
     * otherwise-successful connect.
     */
    private fun preventBatchMode(rfid: RFIDReader) {
        try {
            val config = rfid.Config
            val before = config.getBatchModeConfig()
            Log.w(TAG, "Batch-mode prevention: current batch mode is $before.")
            if (before == BATCH_MODE.DISABLE) return
            config.setBatchMode(BATCH_MODE.DISABLE)
            // Persisted, not just set in memory — the same reasoning
            // purgeAndDisableBatchMode's own saveConfig() call documents:
            // batch mode is stored in the reader's own non-volatile config,
            // so without this a power cycle could restore whatever was last
            // saved there (most likely left on by a prior 123RFID Mobile
            // session) and reintroduce RFID_BATCHMODE_IN_PROGRESS on some
            // future connect despite this step having run.
            config.saveConfig()
            val after = config.getBatchModeConfig()
            Log.w(TAG, "Batch-mode prevention: batch mode was $before, now disabled and saved (now reads $after).")
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (e: Exception) {
            Log.w(TAG, "Batch-mode prevention: reading/setting/saving batch mode threw; leaving it as-is.", e)
        } catch (e: LinkageError) {
            Log.w(TAG, "Batch-mode prevention: reading/setting/saving batch mode threw; leaving it as-is.", e)
        }
    }

    /** The post-connect setup every successful attempt needs, whether it
     *  connected normally or after [connectRfid] recovered from batch mode:
     *  prevent batch mode from recurring, wire up [listener], pin the
     *  physical trigger to immediate, and — last, and only for
     *  [RfidTriggerPersonality.RFID] — stand the barcode imager down. Split
     *  out of [attemptVendorConnection] only so that function reads as one
     *  attempt rather than two copies of this block.
     *
     *  [preventBatchMode] runs first, before anything else here, and
     *  deliberately does not wait for the event-listener wiring or
     *  [configureTriggerMode] to run first — it depends on neither, only on
     *  `rfid.Config`, which is already usable the instant `rfid.connect()`
     *  returns, so there is no reason to delay it behind steps it doesn't
     *  need. The point of running it first: a sled that connects this far —
     *  far enough for this function to have started — is left batch-mode-
     *  safe even if the start/stop trigger pinning further down throws and
     *  fails the rest of this `connect()` attempt (that pinning is
     *  unguarded on purpose — see its own comment below — so a throw there
     *  is expected to happen sometimes). Before this reordering,
     *  [preventBatchMode] ran after that pinning, so a throw there meant it
     *  never ran at all, and an otherwise-healthy sled was left armed for
     *  the next `RFID_BATCHMODE_IN_PROGRESS`. [disconnectBlocking] is this
     *  function's teardown-side counterpart — see its doc for the other
     *  half of this same fix.
     *
     *  Ordering for everything else here is deliberate, not incidental —
     *  see [standDownBarcodeImager]'s doc for the field evidence:
     *  [standDownBarcodeImager] talks to a *different* Zebra SDK over the
     *  *same* shared Bluetooth stack this function's own RFID calls use,
     *  and a slow/failed attempt on that second SDK was observed tying the
     *  stack up long enough to break the unguarded start/stop trigger
     *  pinning below — RFID setup that had already succeeded. So every
     *  piece of setup this function treats as safety-relevant and lets fail
     *  the whole connect (`configureTriggerMode`, the start/stop trigger
     *  pinning) runs — and is fully settled — before [standDownBarcodeImager]
     *  ever touches the Bluetooth stack, and [standDownBarcodeImager] is
     *  bounded by its own wall-clock timeout (see its doc) so it can never
     *  again tie that stack up for as long as it did in that log. */
    private fun configurePostConnectSetup(
        rfid: RFIDReader,
        triggerPersonality: RfidTriggerPersonality,
        scannerPluginMode: ScannerPluginMode,
        sledIdentity: SledIdentity,
    ) {
        // Runs before anything else in this function — see this function's
        // doc for why: it only needs rfid.Config, which is already usable,
        // so there is no reason to delay it behind the event-listener
        // wiring, configureTriggerMode(), or the start/stop trigger pinning
        // (the one step below that can throw and fail this whole attempt).
        preventBatchMode(rfid)

        rfid.Events.addEventsListener(listener)
        rfid.Events.setHandheldEvent(true)
        rfid.Events.setTagReadEvent(true)
        rfid.Events.setBatteryEvent(true)
        rfid.Events.setAttachTagDataWithReadEvent(true)
        // configureTriggerMode() never throws (see its doc) — every avenue it
        // tries is caught and logged internally, except a real
        // InterruptedException/CancellationException, which every other
        // vendor call site in this file also lets through unchanged. That is
        // deliberate: it guarantees the start/stop trigger pinning below
        // still runs whether or not the radio/barcode switch actually took,
        // instead of one failed avenue aborting setup partway through.
        configureTriggerMode(rfid, triggerPersonality, scannerPluginMode)
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
        // Unlike configureTriggerMode(), these four calls are left
        // unguarded on purpose: they are pinning safety-relevant behavior
        // (see above — RfidTrigger's latch/toggle modes depend on it), not
        // a best-effort convenience, so a throw here should fail the whole
        // connect() attempt exactly as it always has, via the ordinary
        // Exception/LinkageError handling in connect(). That is unchanged
        // by this function's configureTriggerMode() step: it runs first and
        // never throws except a genuine cancellation, so a failure here can
        // never be mistaken for a trigger-mode failure, and
        // configureTriggerMode()'s own logging/connectNote work is already
        // complete by the time any of this can throw. preventBatchMode()
        // above has already run and completed by this point too, for the
        // same reason — see this function's doc — so a throw here still
        // leaves the sled batch-mode-safe even though it fails the rest of
        // this connect() attempt. Only the barcode imager stand-down below
        // still depends on everything above having actually succeeded — see
        // the class-level ordering note on this function's doc.
        // Only when the operator has the physical trigger driving the RFID
        // radio does the barcode imager firing on the same pull actually
        // corrupt anything — with BARCODE personality the imager firing is
        // the point, so standing it down here would be actively wrong. This
        // is deliberately the *last* thing this function does — see the
        // ordering note on this function's own doc and [standDownBarcodeImager]'s
        // doc for why.
        if (triggerPersonality == RfidTriggerPersonality.RFID) {
            standDownBarcodeImager(sledIdentity)
        }
    }

    /** Builds a [ZebraBarcodeEngine] — identified by [sledIdentity] so it
     *  matches candidates against this app's own sled rather than any other
     *  paired Bluetooth device (see [chooseScanner]'s doc) — and asks it to
     *  stand the sled's barcode imager down; see that class's doc for the
     *  full story of why a second Zebra SDK is needed at all. Only called
     *  from [configurePostConnectSetup], last, and only when
     *  [RfidTriggerPersonality] is RFID — see that function's ordering note
     *  for why "last" matters here specifically.
     *
     *  [ZebraBarcodeEngine.standDown] never throws — it reduces every
     *  outcome, success included, to an operator-facing sentence — so
     *  nothing it does can fail the RFID connect it runs alongside *by
     *  throwing*. But the real field bug this function exists to prevent
     *  was never a thrown exception: a real device log showed
     *  [ZebraBarcodeEngine]'s attempt to reach the wrong device (see Bug 1)
     *  taking roughly 13 seconds and tying up the phone's shared Bluetooth
     *  stack for that whole time, which then made *separate,
     *  already-succeeded* RFID SDK calls fail with
     *  `RFID_OPERATION_IN_PROGRESS`. Bug 1 removes the "wrong device" half
     *  of that (a sled this app can't positively identify is never
     *  attempted at all), and [configurePostConnectSetup]'s reordering
     *  removes the "breaks already-succeeded RFID setup" half by running
     *  this after that setup is done — but a genuine, *correct*-device sled
     *  can still be slow to answer, so [standDown] runs via
     *  [runBarcodeStandDownWithTimeout] rather than being called directly
     *  here: a plain, uninterruptible vendor call has no way to be bounded
     *  by coroutine cancellation alone (see the class doc's
     *  `runInterruptible` discussion — the same reasoning applies to a
     *  second, nested blocking call like this one), so a real wall-clock
     *  bound, independent of that, is what actually prevents a repeat of
     *  the 13-second stall — see that function's doc for the mechanism and
     *  the reasoning behind its exact timeout value.
     *
     *  Appends to [_connectNote] via [combineConnectNotes] rather than
     *  overwriting it, the same reasoning [configureTriggerMode]'s own
     *  note-writing uses: this and [configureTriggerMode] each leave an
     *  independently true fact about the same connect attempt, and the
     *  operator should see both. */
    private fun standDownBarcodeImager(sledIdentity: SledIdentity) {
        val engine = ZebraBarcodeEngine(context, sledIdentity)
        barcodeEngine = engine
        val note = runBarcodeStandDownWithTimeout(engine)
        _connectNote.value = combineConnectNotes(_connectNote.value, note)
    }

    /**
     * Runs [engine]'s [ZebraBarcodeEngine.standDown] off this thread's own
     * call stack, on a dedicated single-thread executor, and waits for it
     * with a bounded `Future.get(timeoutMs, TimeUnit.MILLISECONDS)` — the
     * `java.util.concurrent` mechanism [standDownBarcodeImager]'s doc
     * points to instead of `withTimeout`/`withTimeoutOrNull`.
     * [configurePostConnectSetup] (and everything that calls it, up to
     * `connect()` itself) runs inside [runInterruptible] on [Dispatchers.IO]
     * — a plain blocking call chain, not a suspend function — so a
     * coroutine-based timeout cannot wrap it here without bridging back
     * into a coroutine via `runBlocking` from already-blocking code, which
     * this file's own `runInterruptible`/cancellation discipline (see the
     * class doc) is built specifically to avoid needing. Running [engine]'s
     * call on its own thread and bounding the wait with `Future.get`'s
     * timeout sidesteps that entirely: it is a hard wall-clock bound with
     * no dependency on coroutine machinery at all.
     *
     * [BARCODE_STAND_DOWN_TIMEOUT_MS] (see its own doc for the exact value
     * and reasoning) is how long this function waits before giving up on
     * [engine]. On a timeout, this deliberately does **not** call
     * `future.cancel(true)`/interrupt the worker thread: this app has no
     * way to know whether interrupting a vendor call mid-flight — inside a
     * `.aar` it does not control the internals of — is safe, and getting
     * that wrong risks a worse failure than the one this function exists to
     * bound. Instead the executor is shut down with the ordinary
     * (non-forcing) `shutdown()`, which lets an already-submitted task keep
     * running to completion on its own thread even after this function has
     * returned; whatever state that leaves in [engine] gets reconciled the
     * conservative way — by [ZebraBarcodeEngine.tearDown], the next time
     * this connection is torn down (see [disconnectBlocking]) — exactly the
     * same "best-effort, never blocks the primary connect" contract this
     * file already applies everywhere else a vendor call is not
     * essential.
     *
     * `InterruptedException` from `future.get()` (this thread itself being
     * interrupted — a real cancellation, e.g. `RfidController`'s 15s
     * timeout landing here) is rethrown immediately, exactly like every
     * other vendor call site in this file; it is deliberately not treated
     * as a stand-down failure. `ExecutionException` — [engine.standDown]
     * throwing despite its own contract that it never does — is handled
     * only as a belt-and-braces guard, the same reasoning every other
     * vendor call site in this file already uses for an `Exception`/
     * `LinkageError` it doesn't expect either; `FutureTask` wraps both
     * `Exception`s and `Error`s (including `LinkageError`) thrown from the
     * submitted task the same way, as `ExecutionException`, so one catch
     * covers both.
     */
    private fun runBarcodeStandDownWithTimeout(engine: ZebraBarcodeEngine): String {
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "ZebraBarcodeEngine-standDown").apply { isDaemon = true }
        }
        val future = executor.submit<String> { engine.standDown() }
        // Non-forcing: see this function's doc for why a timeout here must
        // not try to interrupt/cancel the in-flight vendor call.
        executor.shutdown()
        return try {
            future.get(BARCODE_STAND_DOWN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (timeout: TimeoutException) {
            Log.w(
                TAG,
                "standDownBarcodeImager: timed out after ${BARCODE_STAND_DOWN_TIMEOUT_MS}ms waiting for " +
                    "ZebraBarcodeEngine.standDown() to finish; letting connect() proceed. This is a real, " +
                    "expected outcome for a slow-to-answer (but correctly identified) sled now that Bug 1 no " +
                    "longer wastes time reaching the wrong device — the attempt keeps running in the " +
                    "background and whatever it leaves behind is reconciled by tearDown()/the next standDown().",
            )
            "The sled's barcode imager's stand-down is taking longer than expected; it may still fire on a trigger pull."
        } catch (e: ExecutionException) {
            val cause = e.cause ?: e
            Log.w(TAG, "standDownBarcodeImager: ZebraBarcodeEngine.standDown() itself threw unexpectedly.", cause)
            "The sled's barcode imager couldn't be reached (${cause.javaClass.simpleName}); it may still fire on a trigger pull."
        }
    }

    /**
     * Puts the physical trigger on whichever engine [triggerPersonality]
     * asks for — the RFID radio, or the sled's barcode imager — and tells
     * the SDK whether to also stand down the host's barcode scanner plugin
     * via [scannerPluginMode]'s resolved [resolveScannerPluginFlag] value
     * (Zebra's `updateScannerPlugin` flag on `Config.setTriggerMode`). Both
     * are operator-configurable settings (see `RfidSettings`' doc) precisely
     * because this combination cannot be verified from a desk: a device log
     * proved `setTriggerMode(RFID_MODE, updateScannerPlugin = false)`
     * returns **true** — the reader accepts RFID mode — while the sled's
     * imager keeps firing, on a Pixel host with no DataWedge to reconfigure.
     * [ScannerPluginMode.AUTO] follows [DataWedge.isPresent], the same guess
     * this app always made; `ON`/`OFF` let an operator try the flag that
     * guess gets wrong, on the device, with no rebuild.
     *
     * [Config.setTriggerMode] **returns a boolean** (confirmed via `javap`
     * against the shipped `API3_LIB-release.aar`) that this app's original,
     * hardcoded call discarded, and there is no getter to read the mode back
     * afterward — that boolean, and the note this function leaves on
     * [_connectNote] via [triggerModeOutcomeNote], are the only signal
     * available about whether the switch actually took.
     *
     * The sequence below is **not documented Zebra behavior** — nobody on
     * this team has seen Zebra's own account of what a host is supposed to
     * do here; see [recoverFromBatchMode]'s doc for the same caveat about
     * this SDK's public surface generally. It tries the resolved
     * `updateScannerPlugin` flag first, then — only if that returns `false`
     * — the opposite flag once, since a wrong guess costs nothing but one
     * extra call. There is deliberately no third avenue: an earlier version
     * of this function also tried `RFIDReader.switchMode()` (a plausible
     * RFD40-specific personality toggle) followed by one more
     * `setTriggerMode` retry, but the device log that diagnosed this feature
     * showed the *first* `setTriggerMode` attempt already returning `true`
     * — the trigger-mode call itself was never the problem, so
     * `switchMode()` was never reached and added nothing but an unverified
     * extra vendor call, so it was removed rather than kept as untested dead
     * weight.
     *
     * Every attempt and its result is logged at warning level with the
     * `ZebraRfidReader` tag, because that logging — not the fix itself — is
     * how the team learns which combination an RFD40 actually accepts; see
     * [recoverFromBatchMode]'s doc for the same reasoning. The final outcome
     * — which combination was actually used, and whether the reader accepted
     * it — is also written to [_connectNote] every time this function
     * finishes, not only on failure: that is what lets the RFID settings tab
     * show the operator what happened, on the device, with no computer or
     * log puller needed. Never throws except a real `InterruptedException`
     * (propagated, exactly like every other vendor call site in this file)
     * — see [configurePostConnectSetup] for why that matters to the
     * start/stop trigger pinning that follows.
     */
    private fun configureTriggerMode(
        rfid: RFIDReader,
        triggerPersonality: RfidTriggerPersonality,
        scannerPluginMode: ScannerPluginMode,
    ) {
        Log.w(
            TAG,
            "Trigger-mode setup starting: isConnected()=${rfid.isConnected()} " +
                "isCapabilitiesReceived()=${rfid.isCapabilitiesReceived()}",
        )
        val dataWedgePresent = DataWedge.isPresent(context)
        val mode = triggerPersonality.toVendorTriggerMode()
        val flag = resolveScannerPluginFlag(scannerPluginMode, dataWedgePresent)
        val firstReason = "1st attempt: $triggerPersonality trigger, updateScannerPlugin=$flag " +
            "(scannerPluginMode=$scannerPluginMode, DataWedge.isPresent()=$dataWedgePresent)"
        if (trySetTriggerMode(rfid, mode, flag, firstReason)) {
            _connectNote.value =
                combineConnectNotes(_connectNote.value, triggerModeOutcomeNote(triggerPersonality, flag, accepted = true))
            return
        }
        val secondReason = "2nd attempt: $triggerPersonality trigger, opposite updateScannerPlugin=${!flag}"
        if (trySetTriggerMode(rfid, mode, !flag, secondReason)) {
            _connectNote.value =
                combineConnectNotes(_connectNote.value, triggerModeOutcomeNote(triggerPersonality, !flag, accepted = true))
            return
        }
        Log.w(
            TAG,
            "Trigger-mode setup: both updateScannerPlugin flags failed for $triggerPersonality trigger mode. " +
                "The reader stays on its current trigger personality.",
        )
        _connectNote.value =
            combineConnectNotes(_connectNote.value, triggerModeOutcomeNote(triggerPersonality, flag, accepted = false))
    }

    /** One `Config.setTriggerMode(mode, updateScannerPlugin)` attempt,
     *  logged either way: the boolean it returned, or — belt-and-braces,
     *  since a vendor call can always surprise this app the way
     *  `Actions.purgeTags()` once did (see [purgeAndDisableBatchMode]'s
     *  doc) — that it threw. [reason] names which combination this is, for
     *  [configureTriggerMode]'s caller-side logging story. A real
     *  cancellation (`InterruptedException`) is not a failed attempt; it is
     *  rethrown immediately, exactly like every other vendor call site in
     *  this file. */
    private fun trySetTriggerMode(rfid: RFIDReader, mode: ENUM_TRIGGER_MODE, updateScannerPlugin: Boolean, reason: String): Boolean {
        val took = try {
            rfid.Config.setTriggerMode(mode, updateScannerPlugin)
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (e: Exception) {
            Log.w(
                TAG,
                "Trigger-mode setup: setTriggerMode($mode, updateScannerPlugin=$updateScannerPlugin) " +
                    "[$reason] threw; treating this attempt as failed.",
                e,
            )
            return false
        }
        Log.w(
            TAG,
            "Trigger-mode setup: setTriggerMode($mode, updateScannerPlugin=$updateScannerPlugin) " +
                "[$reason] returned $took.",
        )
        return took
    }

    /** Tears down whatever [openVendorConnection] built: leaves the sled
     *  batch-mode-safe, removes [listener], disconnects, and disposes,
     *  best-effort — see [disconnectBlocking]'s doc for the exact order. The
     *  one function `connect()` (both its "tear down anything stale first"
     *  step and its cancellation cleanup), `disconnect()`, and
     *  [cleanUpAfterFailedConnect] all route through, so a test double only
     *  has to override this once to observe or fake every teardown path —
     *  and so [disconnectBlocking]'s batch-mode-safe steps run
     *  unconditionally on every one of them, including the one path
     *  (`RfidController`'s `endBurst(stopReader = false, ...)` reacting to a
     *  `DISCONNECTION_EVENT` — see [ZebraRfidReader]'s `eventStatusNotify`
     *  comment) that never calls `reader.stopInventory()` itself before the
     *  stale connection is finally torn down here, the next time
     *  `connect()` runs. */
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

    /** Teardown counterpart to [preventBatchMode], run from the opposite end
     *  of a connection's life: stops any inventory the sled might still be
     *  running before its connection goes away. Called first thing in
     *  [disconnectBlocking], while the connection is still healthy — this
     *  is the same `Actions.Inventory.stop()` call [stopInventory] makes
     *  elsewhere in this file, just guarded individually here (via
     *  [teardownStep] at the call site) so a failure in this one step can
     *  never stop the rest of teardown from running.
     *
     *  **Null safety:** unlike [preventBatchMode], which only ever runs
     *  against a freshly-connected, guaranteed non-null `RFIDReader`, this
     *  runs on every teardown path — including ones where `reader` was
     *  never fully set up (e.g. cleanup after a failed connect) — so it
     *  reads the nullable `reader` field directly through a null-safe `?.`
     *  chain rather than taking a non-null parameter.
     *
     *  `InterruptedException` is rethrown rather than logged, exactly like
     *  every other vendor call site in this file: it is a real cancellation
     *  (`disconnectBlocking()` runs inside [runInterruptible]), not a
     *  teardown failure, and must not be swallowed as if it were one — the
     *  enclosing [teardownStep] is what actually catches it and restores
     *  the thread's interrupt status so the cancellation still propagates
     *  once [disconnectBlocking] returns. */
    private fun stopInventoryForTeardown() {
        try {
            reader?.Actions?.Inventory?.stop()
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (e: Exception) {
            // Expected, routine noise on most disconnects: Inventory.stop()
            // throws whenever there was no inventory actually running to
            // stop, which is the common case (a disconnect that never
            // started scanning). Logged at a lower level than a genuine
            // teardown problem so this line doesn't drown out real failures
            // when grepping `adb logcat -s ZebraRfidReader` for teardown
            // trouble — if this step is ever the actual cause of a bad
            // disconnect, look here first, but expect to see it fire often
            // and harmlessly.
            Log.i(TAG, "Teardown: stopping the inventory before disconnect threw (expected when none was running); continuing teardown anyway.", e)
        } catch (e: LinkageError) {
            Log.w(TAG, "Teardown: stopping the inventory before disconnect threw; continuing teardown anyway.", e)
        }
    }

    /** [stopInventoryForTeardown]'s sibling: reads the current batch mode
     *  via `reader?.Config` and, if it is anything other than
     *  `BATCH_MODE.DISABLE`, turns it off and persists the change — the
     *  exact sequence [preventBatchMode] already uses on the way *in* to a
     *  connection, reused here rather than reinvented (steals its
     *  structure and logging shape on purpose). Called right after
     *  [stopInventoryForTeardown] in [disconnectBlocking], guarded the same
     *  way (via [teardownStep] at the call site, individually — a failure
     *  here must not stop the rest of teardown, and must not be blamed on
     *  [stopInventoryForTeardown] or vice versa).
     *
     *  Logs the before value unconditionally (that is the evidence this
     *  step actually ran on hardware) and the after value only once a
     *  change was actually made, under a distinctive, greppable
     *  `"Teardown: "` prefix — parallel to [preventBatchMode]'s own
     *  `"Batch-mode prevention: "` prefix and [purgeAndDisableBatchMode]'s
     *  `"Batch-mode recovery: "` prefix, so all three are easy to tell
     *  apart in a device log (`adb logcat -s ZebraRfidReader`) while still
     *  reading naturally alongside them.
     *
     *  Same null-safety and `InterruptedException`-rethrown-first,
     *  `Exception`/`LinkageError`-logged-and-swallowed idiom as
     *  [stopInventoryForTeardown] — see that function's doc for why both
     *  matter here. */
    private fun disableBatchModeForTeardown() {
        try {
            val config = reader?.Config ?: return
            val before = config.getBatchModeConfig()
            Log.w(TAG, "Teardown: batch mode before disconnect is $before.")
            if (before == BATCH_MODE.DISABLE) return
            config.setBatchMode(BATCH_MODE.DISABLE)
            config.saveConfig()
            val after = config.getBatchModeConfig()
            Log.w(TAG, "Teardown: batch mode was $before, now disabled and saved before disconnect (now reads $after).")
        } catch (interrupt: InterruptedException) {
            throw interrupt
        } catch (e: Exception) {
            Log.w(TAG, "Teardown: reading/setting/saving batch mode threw; leaving it as-is.", e)
        } catch (e: LinkageError) {
            Log.w(TAG, "Teardown: reading/setting/saving batch mode threw; leaving it as-is.", e)
        }
    }

    /** Only ever called from inside [runInterruptible]; never suspends
     *  itself. Leaves `_connection` untouched — see
     *  [cleanUpAfterFailedConnect]'s doc.
     *
     *  Runs [stopInventoryForTeardown] and [disableBatchModeForTeardown]
     *  first, ahead of everything else — while the connection is still
     *  healthy, before `reader?.disconnect()` below makes any further
     *  vendor call meaningless — so a sled that completes one healthy
     *  session with this app is never left armed to fail its next
     *  `connect()` with `RFID_BATCHMODE_IN_PROGRESS`; see those two
     *  functions' docs for the detail. Each is wrapped in its own
     *  [teardownStep] call, exactly like the four pre-existing steps below,
     *  so a failure in either one — or in any of the four — can never stop
     *  the rest of teardown from running. */
    private fun disconnectBlocking() {
        teardownStep { stopInventoryForTeardown() }
        teardownStep { disableBatchModeForTeardown() }
        // Runs before the RFID teardown below, not after: ZebraBarcodeEngine
        // re-enables the imager itself (see its tearDown() doc for why),
        // and there is no ordering reason to make that wait on the RFID
        // radio being torn down first.
        teardownStep { barcodeEngine?.tearDown() }
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
        barcodeEngine = null
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
     *  values, not the vendor exception types themselves — because building
     *  a real `OperationFailureException`/`InvalidUsageException` from a
     *  test means constructing a meaningful `RFIDResults`/status-code
     *  argument the vendor SDK itself normally supplies, not this app; those
     *  functions are what `ZebraRfidReaderTest` can actually exercise. (The
     *  2.0.5.292 `.aar` made `OperationFailureException`'s constructor
     *  `public` — confirmed via `javap` — where the previous 2.0.2.82 `.aar`
     *  had it package-private; that alone doesn't make constructing one from
     *  this app's test package any more meaningful, so the plain-function
     *  split stays.) */
    private fun readable(e: Throwable): String {
        return when (e) {
            // BatchModeUnrecoverableException falls through to the `else`
            // branch below on purpose: its message is already the exact
            // operator-facing sentence (see BATCH_MODE_UNRECOVERABLE_MESSAGE),
            // and genericMessage() passes an already-well-formed sentence
            // through unchanged, so a dedicated branch here would be an
            // untestable no-op — recoverFromBatchMode() already logs the
            // step-by-step recovery detail this exception summarizes.
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

/** Maps the operator-facing [RfidTriggerPersonality] to the vendor's own
 *  enum. A private top-level function rather than a method on
 *  [RfidTriggerPersonality] itself, because `ENUM_TRIGGER_MODE` is a
 *  `com.zebra.*` type — see [ZebraRfidReader]'s class doc for why this file
 *  alone may import those, and `core.rfid` (where [RfidTriggerPersonality]
 *  lives) must not. */
private fun RfidTriggerPersonality.toVendorTriggerMode(): ENUM_TRIGGER_MODE = when (this) {
    RfidTriggerPersonality.RFID -> ENUM_TRIGGER_MODE.RFID_MODE
    RfidTriggerPersonality.BARCODE -> ENUM_TRIGGER_MODE.BARCODE_MODE
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

/** Pure decision logic behind [ZebraRfidReader]'s batch-mode recovery: is
 *  the reader connected, with both `Actions` and `Config` populated? Pulled
 *  out of `logAndCheckUsable` so it is directly testable — unlike the rest
 *  of the recovery sequence, which calls real vendor methods and so can
 *  only be proven on hardware (see [ZebraRfidReader.recoverFromBatchMode]'s
 *  doc). */
internal fun batchModeRecoveryUsable(isConnected: Boolean, actionsPresent: Boolean, configPresent: Boolean): Boolean =
    isConnected && actionsPresent && configPresent

/** Pure resolution behind [ZebraRfidReader.configureTriggerMode]: what
 *  `updateScannerPlugin` should be for a given [ScannerPluginMode].
 *  [ScannerPluginMode.AUTO] resolves against whether DataWedge is actually
 *  installed on this host — the same guess this app always made before this
 *  setting existed. `ON`/`OFF` ignore [dataWedgePresent] entirely: an
 *  operator picking one of those explicitly is overriding the guess, not
 *  asking for it. Pulled out of [ZebraRfidReader.configureTriggerMode] so
 *  this resolution is directly testable, unlike the vendor call it feeds,
 *  which needs a real `RFIDReader` and so can only be proven on hardware. */
internal fun resolveScannerPluginFlag(mode: ScannerPluginMode, dataWedgePresent: Boolean): Boolean = when (mode) {
    ScannerPluginMode.AUTO -> dataWedgePresent
    ScannerPluginMode.ON -> true
    ScannerPluginMode.OFF -> false
}

/** Pure text behind [ZebraRfidReader.configureTriggerMode]'s operator-facing
 *  note: what combination was actually tried ([triggerPersonality],
 *  [updateScannerPlugin]) and whether the reader accepted it. Written to
 *  [ZebraRfidReader.connectNote] every time `configureTriggerMode` finishes
 *  — success or failure — not only on failure: the point of these two
 *  settings is to let a hardware problem be diagnosed on the device instead
 *  of through rebuild cycles, so a combination that worked needs to be just
 *  as visible as one that didn't. Pulled out into a plain function over
 *  plain values, the same way [operationFailureMessage] is, so it is
 *  directly testable without a real `RFIDReader`. */
internal fun triggerModeOutcomeNote(
    triggerPersonality: RfidTriggerPersonality,
    updateScannerPlugin: Boolean,
    accepted: Boolean,
): String {
    val personalityWord = when (triggerPersonality) {
        RfidTriggerPersonality.RFID -> "RFID"
        RfidTriggerPersonality.BARCODE -> "barcode"
    }
    val pluginWord = if (updateScannerPlugin) "on" else "off"
    return if (accepted) {
        "The reader's trigger is set to $personalityWord mode (scanner plugin flag $pluginWord)."
    } else {
        "The reader refused every trigger-mode combination tried for $personalityWord mode (scanner plugin " +
            "flag on and off). Its trigger may not behave as expected."
    }
}

/** Appends [additional] to [existing] rather than overwriting it, so two
 *  independently true operator-facing notes set during the same connect()
 *  — for example [triggerModeOutcomeNote]'s result from
 *  [ZebraRfidReader.configureTriggerMode] and
 *  [ZebraRfidReader.BATCH_MODE_RECOVERY_NOTE] from batch-mode recovery —
 *  both reach [ZebraRfidReader.connectNote] instead of the second one
 *  silently clobbering the first. A blank or absent [existing] is treated
 *  as nothing to append to. */
internal fun combineConnectNotes(existing: String?, additional: String): String =
    if (existing.isNullOrBlank()) additional else "$existing $additional"

/** The message [ZebraRfidReader]'s batch-mode recovery surfaces to the
 *  operator once every avenue it knows (`PostConnectReaderUpdate()`, then
 *  `reconnect()`, then a bare second `connect()`) has failed to leave the
 *  reader usable. This is the honest end state, not a placeholder: this app
 *  has tried everything its vendor SDK's public surface offers, so the
 *  message names the one remedy known to actually work — Zebra's own
 *  123RFID Mobile app connecting to the sled and clearing it — instead of
 *  inviting another retry that would just fail the same way.
 *
 *  Also tells the operator two things a plain "couldn't clear it" sentence
 *  doesn't: that this should be a one-time fix, not a routine step to
 *  expect again, and that this app now prevents the sled from returning to
 *  this state once it has completed a single healthy session with it — see
 *  [preventBatchMode] (made more resilient by [configurePostConnectSetup]'s
 *  reordering) and [disconnectBlocking]'s teardown-side counterpart. Both
 *  are true regardless of why this particular sled ended up batching (this
 *  app's own earlier teardown, or some other source such as a prior
 *  123RFID Mobile session), so the message states them unconditionally. */
internal const val BATCH_MODE_UNRECOVERABLE_MESSAGE =
    "This reader is holding tags stored during an earlier offline session, and this app couldn't clear " +
        "them. Open Zebra's 123RFID Mobile app and connect to the sled there — it can clear the stored " +
        "batch; once that's done, reconnect here. This should only be a one-time fix: once this app " +
        "completes one healthy connection with this sled, it turns batch mode off and keeps it off on " +
        "every disconnect, so the sled should not return to this state on its own again."

/** Thrown by [ZebraRfidReader.recoverFromBatchMode] when none of the three
 *  avenues — `PostConnectReaderUpdate()`, `reconnect()`, or a bare second
 *  `connect()` — leaves the reader usable.
 *  Unlike `OperationFailureException`/`InvalidUsageException`, this is a
 *  plain Kotlin exception this app defines itself — constructible from a
 *  test, which is what makes a real end-to-end test of this failure message
 *  possible without a `com.zebra.*` type (see `ZebraRfidReaderTest`). */
internal class BatchModeUnrecoverableException : Exception(BATCH_MODE_UNRECOVERABLE_MESSAGE)
