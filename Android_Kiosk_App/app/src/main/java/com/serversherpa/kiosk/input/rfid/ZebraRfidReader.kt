package com.serversherpa.kiosk.input.rfid

import android.content.Context
import com.serversherpa.kiosk.core.rfid.RfidConnection
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
import com.zebra.rfid.api3.RfidEventsListener
import com.zebra.rfid.api3.RfidReadEvents
import com.zebra.rfid.api3.RfidStatusEvents
import com.zebra.rfid.api3.SESSION
import com.zebra.rfid.api3.STATUS_EVENT_TYPE
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
class ZebraRfidReader(private val context: Context, private val scope: CoroutineScope) : RfidReader {
    private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
    override val connection: StateFlow<RfidConnection> = _connection

    private val _tags = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val tags: SharedFlow<String> = _tags

    private val _triggers = MutableSharedFlow<TriggerEvent>(extraBufferCapacity = 16)
    override val triggers: SharedFlow<TriggerEvent> = _triggers

    private var readers: Readers? = null
    private var reader: RFIDReader? = null
    private var name: String = "RFID reader"

    private val listener = object : RfidEventsListener {
        override fun eventReadNotify(event: RfidReadEvents) {
            // Never touch the reader from in here; just hand the value on.
            event.readEventData?.tagData?.tagID?.let { _tags.tryEmit(it) }
        }

        override fun eventStatusNotify(event: RfidStatusEvents) {
            val data = event.StatusEventData ?: return
            when (data.statusEventType) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT -> {
                    when (data.HandheldTriggerEventData?.handheldEvent) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> _triggers.tryEmit(TriggerEvent.PRESSED)
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> _triggers.tryEmit(TriggerEvent.RELEASED)
                        else -> Unit
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
                    _connection.value = RfidConnection.Failed("The reader disconnected.")
                }
                else -> Unit
            }
        }
    }

    override suspend fun connect(): Result<Unit> = withContext(Dispatchers.IO) {
        _connection.value = RfidConnection.Connecting
        try {
            runInterruptible {
                val all = Readers(context, ENUM_TRANSPORT.ALL)
                readers = all
                val device = all.GetAvailableRFIDReaderList()?.firstOrNull()
                    ?: error("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")
                // device.getRFIDReader() is the real accessor: the SDK's setter is
                // misspelled setRFIDRReader(...), which breaks Kotlin's usual
                // getX()/setX(X) property synthesis, so the explicit Java call is
                // used here rather than a synthetic `device.rfidReader` property.
                val rfid = device.getRFIDReader()
                rfid.connect()
                rfid.Events.addEventsListener(listener)
                rfid.Events.setHandheldEvent(true)
                rfid.Events.setTagReadEvent(true)
                rfid.Events.setBatteryEvent(true)
                // RFID_MODE with updateScannerPlugin = true puts the physical trigger
                // on the radio rather than the barcode imager.
                rfid.Config.setTriggerMode(ENUM_TRIGGER_MODE.RFID_MODE, true)
                reader = rfid
                name = device.name ?: "RFID reader"
            }
            _connection.value = RfidConnection.Connected(name, null)
            Result.success(Unit)
        } catch (e: CancellationException) {
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
            runInterruptible { disconnectBlocking() }
        } catch (ce: CancellationException) {
            throw ce
        } catch (ignored: Exception) {
            clearReaderRefs()
        } catch (ignored: LinkageError) {
            clearReaderRefs()
        }
    }

    override suspend fun disconnect() {
        withContext(Dispatchers.IO) {
            try {
                runInterruptible { disconnectBlocking() }
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
        runCatching { reader?.Events?.removeEventsListener(listener) }
        runCatching { reader?.disconnect() }
        runCatching { readers?.Dispose() }
        clearReaderRefs()
    }

    private fun clearReaderRefs() {
        reader = null
        readers = null
    }

    override suspend fun apply(settings: RfidSettings): Result<Unit> = withContext(Dispatchers.IO) {
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

    override suspend fun startInventory(): Result<Unit> = withContext(Dispatchers.IO) {
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

    override suspend fun stopInventory(): Result<Unit> = withContext(Dispatchers.IO) {
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

    /** SDK exceptions carry codes, not sentences. Give the operator a sentence. */
    private fun readable(e: Throwable): String {
        val raw = e.message?.trim().orEmpty()
        if (raw.endsWith(".") && raw.length > 12) return raw
        return if (raw.isEmpty()) "Couldn't connect to the reader." else "Couldn't connect to the reader ($raw)."
    }
}
