package com.serversherpa.kiosk.input.rfid

import android.content.Context
import android.util.Log
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.rfid.powerToTenths
import com.zebra.rfid.api3.BEEPER_VOLUME
import com.zebra.rfid.api3.DYNAMIC_POWER_OPTIMIZATION
import com.zebra.rfid.api3.ENUM_TRANSPORT
import com.zebra.rfid.api3.ENUM_TRIGGER_MODE
import com.zebra.rfid.api3.HANDHELD_TRIGGER_EVENT_TYPE
import com.zebra.rfid.api3.RFIDReader
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
    }

    final override suspend fun connect(): Result<Unit> = withContext(Dispatchers.IO) {
        _connection.value = RfidConnection.Connecting
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
     *  all. */
    protected open fun openVendorConnection(): String {
        val all = Readers(context, ENUM_TRANSPORT.ALL)
        readers = all
        val device = all.GetAvailableRFIDReaderList()?.firstOrNull()
            ?: error("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")
        // device.getRFIDReader() is the real accessor: the SDK's setter is
        // misspelled setRFIDRReader(...), which breaks Kotlin's usual
        // getX()/setX(X) property synthesis, so the explicit Java call is
        // used here rather than a synthetic `device.rfidReader` property.
        val rfid = device.getRFIDReader()
        reader = rfid
        rfid.connect()
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
        return device.name ?: "RFID reader"
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

    /** SDK exceptions carry codes, not sentences. Give the operator a sentence. */
    private fun readable(e: Throwable): String {
        val raw = e.message?.trim().orEmpty()
        if (raw.endsWith(".") && raw.length > 12) return raw
        return if (raw.isEmpty()) "Couldn't connect to the reader." else "Couldn't connect to the reader ($raw)."
    }
}
