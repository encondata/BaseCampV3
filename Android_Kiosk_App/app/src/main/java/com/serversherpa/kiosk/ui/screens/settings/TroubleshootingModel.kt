package com.serversherpa.kiosk.ui.screens.settings

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.BuildConfig
import com.serversherpa.kiosk.core.labels.LabelPick
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.labels.printerUnreachableText
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.DirectoryEntry
import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.PrinterNeedsRestart
import com.serversherpa.kiosk.core.printer.ZebraBluetoothSpec
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.core.printer.isDirectoryListing
import com.serversherpa.kiosk.core.printer.parseDirectoryEntries
import com.serversherpa.kiosk.core.printer.parseGetvar
import com.serversherpa.kiosk.core.printer.parseHostStatus
import com.serversherpa.kiosk.core.printer.sampleTestLabel
import com.serversherpa.kiosk.core.printer.speedTestLabel
import com.serversherpa.kiosk.core.printer.statusProblems
import com.serversherpa.kiosk.data.labels.LabelSettingsSource
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothLinkInfo
import com.serversherpa.kiosk.data.printer.BluetoothPrinterNotFound
import com.serversherpa.kiosk.data.printer.BluetoothPrinting
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.data.printer.LockedZebra
import com.serversherpa.kiosk.data.printer.PrinterClearFailed
import com.serversherpa.kiosk.data.printer.PrinterException
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.PrinterNoReply
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.printer.PrinterUnreachable
import com.serversherpa.kiosk.data.printer.SetupZebra
import com.serversherpa.kiosk.data.printer.WriteProgress
import com.serversherpa.kiosk.data.printer.ZebraNetwork
import com.serversherpa.kiosk.data.printer.bluetoothRefusal
import com.serversherpa.kiosk.data.printer.bluetoothUnavailableText
import com.serversherpa.kiosk.data.printer.replyHasFrames
import com.serversherpa.kiosk.data.printer.replyHasQuotedValue
import com.serversherpa.kiosk.ui.screens.labels.AlignmentSize
import com.serversherpa.kiosk.ui.screens.labels.alignmentSizeFor
import com.serversherpa.kiosk.ui.screens.labels.printerSummary
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A label and its value: the connection and printer details, on the tab and in the report. */
data class DetailLine(val label: String, val value: String)

/** One ask-the-printer button (D13): what it sends, when its reply is whole (the transports'
 *  rules), and what the reply says. */
enum class PrinterAsk(val label: String, val command: String) {
    STATUS("Status", ZebraCommands.HOST_STATUS),
    ALERTS("Error report", "~HQES"),
    DPI("DPI", "! U1 getvar \"head.resolution.in_dpi\"\r\n"),
    PEELER("Peeler", ZebraCommands.PEELER_PRESENT),
    SERIAL("Serial number", ZebraCommands.SERIAL_NUMBER),
    FONTS("Font listing", ZebraCommands.FONT_DIRECTORY);

    /** `~HS` is three frames, `~HQES` and the listing one, a getvar one quoted value. */
    fun complete(reply: ByteArray): Boolean = when (this) {
        STATUS -> replyHasFrames(reply, 3)
        ALERTS, FONTS -> replyHasFrames(reply, 1)
        DPI, PEELER, SERIAL -> replyHasQuotedValue(reply)
    }

    /** The reply in words; null when it doesn't read as this answer (the raw reply still shows). */
    fun meaning(reply: String): String? = when (this) {
        STATUS -> parseHostStatus(reply)?.let(::statusMeaning)
        ALERTS -> null
        DPI -> parseGetvar(reply)?.let { "$it dpi" }
        PEELER, SERIAL -> parseGetvar(reply)
        FONTS -> if (!isDirectoryListing(reply)) null else listingMeaning(parseDirectoryEntries(reply))
    }
}

private fun statusMeaning(s: HostStatus): String {
    val problems = statusProblems(s)
    return (if (problems.isEmpty()) "Ready to print." else problems.joinToString(" ")) +
        " Formats queued ${s.formatsQueued} · label waiting ${yesNo(s.labelWaiting)}" +
        " · partial format ${yesNo(s.partialFormat)} · buffer full ${yesNo(s.bufferFull)} · print mode ${s.printMode}"
}

private fun listingMeaning(entries: List<DirectoryEntry>): String =
    if (entries.isEmpty()) "Nothing stored on E:." else entries.joinToString(", ") { "${it.name} (${it.size} bytes)" }

/** An ask button's or the command box's result: the command, the reply as the printer sent it
 *  (Latin-1), how long it took (inside the printer lock), and what it means or why it failed. */
data class AskResult(
    val id: Int,
    val label: String,
    val command: String,
    val atMs: Long,
    val reply: String = "",
    val milliseconds: Long? = null,
    val meaning: String? = null,
    val error: String? = null,
) {
    /** The reply's length in bytes (Latin-1: one byte a character). */
    val bytes: Int get() = reply.length
}

/** One speed-test label: its size, and how long it took to send (or why it didn't go). */
data class SpeedRow(
    val id: Int,
    val run: Int,
    val targetKb: Int,
    val bytes: Int,
    val seconds: Double? = null,
    val error: String? = null,
) {
    val kbPerSecond: Double? get() = seconds?.takeIf { it > 0 }?.let { bytes / 1024.0 / it }
}

data class TroubleLogLine(val atMs: Long, val text: String)

/** What the tab is doing with the printer (one thing at a time). */
enum class TroubleAction { DETAILS, ASK, COMMAND, SPEED, CUT_SEND }

/** A Bluetooth refusal the crew fixes on the handheld (Bluetooth off, not allowed or missing, a
 *  printer that forgot this device), as the last call met it: its words ([text], which pick its
 *  buttons), shown in the section of the call ([action]) that met it. */
data class TroubleReach(val action: TroubleAction, val text: String)

/** The shared report: its file-style name and its text. */
data class TroubleshootingReport(val name: String, val text: String)

/** The Cut-send test's labels went out (D16). */
const val CUT_SEND_DONE_TEXT = "Sent half a sample label, then a full one with ~JX before it. " +
    "Only the full label should print, with no merged or extra label."
/** What the Cut-send test does (developers). */
const val CUT_SEND_ABOUT_TEXT = "Developers: sends half a sample label, marks it as a failed send, then sends a full " +
    "sample label, which goes after ~JX. Only the full label should print, with no merged or extra label."
/** Beside the speed test's results. */
const val SPEED_END_TEXT = "Each label must print END at the bottom — a missing END means data was lost."
const val NO_TROUBLESHOOTING_PRINTER_TEXT = "No printer set up yet. Choose one in Label Printing › Printer Setup."
const val NOTHING_HEARD_TEXT = "No Bluetooth devices heard nearby."
/** A scan a printer call cut short (a label going out shares the radio). */
const val SCAN_CUT_SHORT_TEXT = "The scan stopped because the printer was in use. Scan again."
/** A scan that ended early for another reason (the app went to the background, Android refused to
 *  scan again so soon). */
const val SCAN_ENDED_EARLY_TEXT = "The scan stopped early. Scan again."
/** A command box command (a setvar, say) that replied nothing, as it does by design. */
const val COMMAND_SENT_TEXT = "Sent, no reply."
/** The Bluetooth printer answered at another address than the saved one (look-alikes exist, so it
 *  is never saved here). */
const val FOUND_ELSEWHERE_TEXT = "This printer answered at another Bluetooth address than the saved one, which wasn't " +
    "changed. If it's your printer, choose it again in Printer Setup to save the new address."
const val REPORT_COPIED_TEXT = "Report copied."

/** The most a copied or shared report carries (characters): Android hands both to the other app in
 *  one binder transaction, which fails past about 500 KB (the text goes as UTF-16). The oldest log
 *  lines go first. */
const val SHARE_MAX_CHARS = 100_000

/** "Device: Google Pixel 10 Pro XL, Android 16 (API 36)" and "App: version 0.1.0 (build 1)": the
 *  report's first lines. */
fun troubleshootingDeviceText(): String =
    "Device: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\n" +
        "App: version ${BuildConfig.KIOSK_VERSION} (build ${BuildConfig.VERSION_CODE})"

/** What the tab shows (D13). */
data class TroubleshootingUi(
    /** Null until the settings are first read. */
    val settings: LabelSettings? = null,
    /** The label builder's template pick: the speed test's label size. */
    val pick: LabelPick? = null,
    /** The Bluetooth link, as [BluetoothPrinting.link] says (whichever printer it was to). */
    val link: BluetoothLinkInfo = BluetoothLinkInfo(),
    val availability: BluetoothAvailability = BluetoothAvailability.UNKNOWN,
    val running: TroubleAction? = null,
    val hostId: HostId? = null,
    val hostIdMilliseconds: Long? = null,
    val detailsError: String? = null,
    val asks: List<AskResult> = emptyList(),
    val commandText: String = "",
    val speedKb: Int = 10,
    val speedRuns: Int = 1,
    val speedRows: List<SpeedRow> = emptyList(),
    /** The speed-test label going out (0 when none). */
    val speedRunNow: Int = 0,
    /** Stop was tapped: the label going out finishes, then the test stops. */
    val speedStopping: Boolean = false,
    val cutSendMessage: String? = null,
    val cutSendError: Boolean = false,
    /** What the Bluetooth scan heard, strongest first: null until a scan starts. */
    val found: List<FoundBluetoothPrinter>? = null,
    val scanning: Boolean = false,
    /** Under the scan: Bluetooth off, not allowed or missing, Location off, or nothing heard. */
    val scanMessage: String? = null,
    val logCount: Int = 0,
    /** The last call's Bluetooth refusal, with its buttons; null once a call gets through or fails
     *  any other way. */
    val reach: TroubleReach? = null,
) {
    val printer: SavedPrinter? get() = settings?.printer
    val busy: Boolean get() = running != null
    /** A call to the printer can start: there is one, and nothing else here is talking to it. */
    val canCall: Boolean get() = printer != null && !busy
    /** More than one label prints: the tab asks first. */
    val speedNeedsConfirm: Boolean get() = speedRuns > 1
    /** The mean KB/s of the labels that went out. */
    val speedAverage: Double? get() = speedRows.mapNotNull { it.kbPerSecond }.takeIf { it.isNotEmpty() }?.average()

    /** The link's details when they are the saved printer's: the link, up or last up, was to its serial. */
    val printerLink: BluetoothLinkInfo? get() {
        val c = printer?.connection as? PrinterConnection.Bluetooth ?: return null
        return link.takeIf { it.info?.serial.equals(c.serial, ignoreCase = true) }
    }

    /** The saved Bluetooth printer last answered at another address than the saved one. */
    val foundElsewhere: Boolean get() = printerLink?.let { it.savedAddress != null && it.info != null } == true

    /** The scan's message reads as an error (red); nothing heard, or a scan cut short, is information. */
    val scanError: Boolean get() = scanMessage != null && scanMessage !in SCAN_NOTES
}

/**
 * Settings › Troubleshooting (D13): the deeper tools for the saved printer, network or Bluetooth,
 * as the iOS kiosk has them (TroubleshootingModel.swift), grown from the Bluetooth test screen Jimmy
 * used on the ZD421 (branch ble-spike).
 *
 * - Connection and printer details: how the handheld reaches the printer (for Bluetooth, the link's
 *   state, address, write size, last use and last drop, and an address it answered at that isn't
 *   the saved one), `~HI`, and for Bluetooth the Device Information read when the link came up.
 * - Ask the printer: status, error report, DPI, peeler, serial and the font listing, each with its
 *   raw reply, its bytes and how long it took; and a free-text command box for admins and
 *   developers only (a raw command can change printer settings; one that replies nothing, as a
 *   setvar does, reads as sent).
 * - A Bluetooth refusal the crew fixes on the handheld (Bluetooth off, not allowed or missing, a
 *   printer that forgot this device) shows with its buttons (`reach`), as on Print Labels, in the
 *   section whose call met it; the next call replaces it.
 * - Speed test: speed-test labels ([speedTestLabel]) on the template's label size at the saved
 *   printer's DPI, with seconds and KB/s for each.
 * - Cut-send test (developers, D16): half a sample label, a failure marked on the guard, then a full
 *   sample label through the normal path, so `~JX` goes first. Only the full label may print.
 * - Bluetooth scan: every named device nearby with its signal, Zebras flagged ("why can't I find my
 *   printer?"). It starts only when Scan is tapped (the screen asks for the permissions first), never
 *   during a speed test (it shares the radio and would lower its KB/s). A scan cut short says so.
 * - Report: all of the above and the last [LOG_CAP] log lines, as text to copy or share.
 *
 * Nothing here saves a printer: [settings] is read only. Every call to the printer goes through
 * [LockedZebra] with the app's [PrinterLock] and [PrinterGuard], so nothing interleaves with Print
 * Labels or Printer Setup, and a printer left needing a clear gets its `~JX` first. The lock isn't
 * reentrant: each action takes it once per call ([LockedZebra.sendCut] takes it once for its half
 * label and mark), never from inside another. Times are taken inside the lock (a wait behind a
 * label isn't counted). Nothing reaches the printer or the radio until a button is tapped, and
 * nothing runs on a timer: the link's details follow its StateFlow.
 *
 * [isAdmin] and [isDeveloper] are read when the command box or the Cut-send test is used, not only
 * when the tab draws them (the signed-in person can change while it is open). [zebraFor] is a
 * printer the way its connection reaches it (the container's on the device). The report never
 * carries anything the tab doesn't hear (it never sees the session, cookies or keys), and what it
 * hears is cleaned: only the app's own words for a failure, never a stray exception's message;
 * secret-looking values ([redactSecrets]); the replies to a secret setting; the printer's own
 * front-panel password in `~HS`; and other Bluetooth devices' names.
 */
class TroubleshootingModel(
    settings: LabelSettingsSource,
    private val bluetooth: BluetoothPrinting,
    private val zebraFor: (printer: SavedPrinter) -> SetupZebra,
    private val printerLock: PrinterLock,
    private val printerGuard: PrinterGuard,
    private val isAdmin: () -> Boolean,
    private val isDeveloper: () -> Boolean,
    pick: StateFlow<LabelPick?> = MutableStateFlow(null),
    /** Names this device and app for the report. */
    private val device: () -> String = ::troubleshootingDeviceText,
    scopeOverride: CoroutineScope? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    /** The times shown and reported are this zone's. */
    private val zone: ZoneId = ZoneId.systemDefault(),
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(TroubleshootingUi(availability = bluetooth.availability.value))
    val state: StateFlow<TroubleshootingUi> = _state

    /** A raw command can change printer settings: admins and developers only. */
    val showsCommandBox: Boolean get() = isAdmin() || isDeveloper()
    val showsCutSendTest: Boolean get() = isDeveloper()

    private val stopwatch = CallStopwatch()
    private val nextId = AtomicInteger(0)
    @Volatile private var stopRequested = false
    @Volatile private var closed = false
    @Volatile private var scanJob: Job? = null
    /** Bumped by each scan (and by one ended quietly): only the latest writes when it ends. */
    private val scanRun = AtomicInteger(0)
    /** The screen's permission prompt was refused: nothing scans until the permissions are allowed
     *  (on API 31+ the link reads READY without Location, but Android then hides what a scan hears). */
    @Volatile private var promptRefused = false
    /** A scan met Bluetooth refusing: scan again once it reads READY (while the tab is open). */
    @Volatile private var rescanWhenReady = false
    /** Stop ended the scan: it then says when nothing was heard. */
    @Volatile private var stopTapped = false
    private val logLock = Any()
    private val log = ArrayDeque<TroubleLogLine>()

    /** The log the report carries: the last [LOG_CAP] lines. */
    val logLines: List<TroubleLogLine> get() = synchronized(logLock) { log.toList() }

    init {
        scope.launch { settings.settings.collect { s -> _state.update { it.copy(settings = s) } } }
        scope.launch { pick.collect { p -> _state.update { it.copy(pick = p) } } }
        scope.launch { bluetooth.link.collect { l -> _state.update { it.copy(link = l) } } }
        scope.launch {
            bluetooth.availability.collect { a ->
                _state.update { it.copy(availability = a) }
                if (a == BluetoothAvailability.READY) bluetoothReady()
            }
        }
    }

    /** The tab is showing (again). */
    fun open() {
        closed = false
    }

    /** The tab went away: the scan stops, and a speed test stops after the label going out. A query
     *  or label already going out finishes. Nothing starts until it shows again. */
    fun close() {
        closed = true
        stopRequested = true
        endScan()
    }

    // --- What the tab shows ---

    /** How the handheld reaches the saved printer: for Bluetooth, the link's state, address, write
     *  size, last use and last drop when the link (up, or last up) was to this printer. */
    fun connectionLines(ui: TroubleshootingUi = _state.value): List<DetailLine> {
        val printer = ui.printer ?: return emptyList()
        return when (val c = printer.connection) {
            is PrinterConnection.Network -> listOf(
                DetailLine("Type", "Network (port ${ZebraNetwork.PORT})"),
                DetailLine("Address", c.host),
                DetailLine("Link", "None kept: each command opens its own connection"),
            )
            is PrinterConnection.Bluetooth -> buildList {
                val link = ui.printerLink
                add(DetailLine("Type", "Bluetooth LE"))
                add(DetailLine("Serial", c.serial))
                add(DetailLine("Bluetooth address", c.address ?: "Not known yet"))
                // What Bluetooth last reported (reading it starts nothing).
                bluetoothStateText(ui.availability)?.let { add(DetailLine("Bluetooth", it)) }
                val at = link?.info?.address
                if (at != null && link.savedAddress != null) {
                    add(DetailLine("Found at", "$at (saved ${link.savedAddress})"))
                } else if (at != null && c.address == null) {
                    add(DetailLine("Found at", at))
                }
                val since = link?.connectedAtMs
                add(
                    DetailLine(
                        "Link",
                        when {
                            link?.connected != true -> "Idle: connects when the printer is next used"
                            since != null -> "Connected since ${clockText(since)}"
                            else -> "Connected"
                        },
                    ),
                )
                link?.chunkBytes?.let { chunk ->
                    add(DetailLine("Write size", link.mtu?.let { "$chunk bytes per chunk (MTU $it)" } ?: "$chunk bytes per chunk (the MTU request failed)"))
                }
                link?.lastActivityMs?.let { add(DetailLine("Last used", clockText(it))) }
                link?.lastDrop?.let { add(DetailLine("Last drop", "${clockText(it.atMs)}: ${it.reason}")) }
            }
        }
    }

    /** What `~HI` said (Printer details). */
    fun hostIdLines(ui: TroubleshootingUi = _state.value): List<DetailLine> {
        val id = ui.hostId ?: return emptyList()
        return listOf(
            DetailLine("Model", id.model),
            DetailLine("Firmware", id.firmware),
            DetailLine("Resolution", "${id.dotsPerMm} dots/mm (${id.dpi} dpi)"),
            DetailLine("Memory", id.memory),
        )
    }

    /** A Bluetooth printer's Device Information, read when the link to it came up. */
    fun deviceInfoLines(ui: TroubleshootingUi = _state.value): List<DetailLine> {
        val info = ui.printerLink?.info ?: return emptyList()
        return listOf(
            "Manufacturer" to info.manufacturer, "Model number" to info.model, "Serial number" to info.serial,
            "Firmware revision" to info.firmware, "Link-OS" to info.linkOs,
        ).map { (label, value) -> DetailLine(label, value ?: "Not read") }
    }

    /** The speed test's and the Cut-send test's label: the template's size when the builder picked
     *  one at the saved printer's DPI, else 4x2 (Top) or 2x1 (Front), at that DPI. */
    fun speedSize(ui: TroubleshootingUi = _state.value): AlignmentSize? {
        val s = ui.settings ?: return null
        val printer = s.printer ?: return null
        return alignmentSizeFor(s.kind, printer.dpi, ui.pick)
    }

    // --- Printer details and asking ---

    /** `~HI`, for Printer details (and Connect, once a printer that forgot this device is
     *  forgotten too). An answer also lifts a cut font's stop, as Printer Setup's check does. */
    fun readDetails(): Job? = details(reachFrom = TroubleAction.DETAILS)

    /** Connect, beside a printer that forgot this device (once it is forgotten in Android's
     *  Bluetooth settings): reads the printer's details, which connects first. Refused again, the
     *  card stays in its section. */
    fun connectAgain(): Job? = details(reachFrom = _state.value.reach?.action ?: TroubleAction.DETAILS)

    private fun details(reachFrom: TroubleAction): Job? {
        val started = begin(TroubleAction.DETAILS) ?: return null
        _state.update { it.copy(detailsError = null) }
        log("→ Printer details: ${ZebraCommands.HOST_IDENTIFICATION}")
        return scope.launch {
            try {
                val id = started.zebra.identify()
                val ms = stopwatch.milliseconds
                _state.update { it.copy(hostId = id, hostIdMilliseconds = ms) }
                log("← ~HI in ${msText(ms)} ms: ${id.model}, ${id.firmware}, ${id.dotsPerMm} dots/mm, ${id.memory}")
                noteReach(null, reachFrom)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(detailsError = troubleText(e, started.printer)) }
                log("← ~HI failed: ${describe(e)}")
                noteReach(e, reachFrom)
            } finally {
                _state.update { it.copy(running = null) }
            }
        }
    }

    fun ask(which: PrinterAsk): Job? =
        runQuery(which.label, which.command, which::complete, TroubleAction.ASK, which::meaning)

    fun setCommandText(text: String) = _state.update { it.copy(commandText = text) }

    /** The command box (admins and developers, checked now): the text as typed with straight
     *  quotes and CR LF at the end. Its reply has no known end, so it is read until the printer goes
     *  quiet. */
    fun sendCommand(): Job? {
        if (!showsCommandBox) return null
        val typed = _state.value.commandText
            .replace('“', '"').replace('”', '"').replace('‘', '\'').replace('’', '\'')
        if (typed.isBlank()) return null
        val command = if (typed.endsWith("\n")) typed else "$typed\r\n"
        return runQuery("Command", command, { false }, TroubleAction.COMMAND) { null }
    }

    private fun runQuery(
        label: String,
        command: String,
        complete: (ByteArray) -> Boolean,
        action: TroubleAction,
        meaning: (String) -> String?,
    ): Job? {
        val started = begin(action) ?: return null
        val id = nextId.incrementAndGet()
        val at = clock()
        log("→ $label: ${visibleCommand(command)}")
        return scope.launch {
            var result: AskResult? = null
            try {
                result = try {
                    val reply = started.zebra.query(command, complete)
                    AskResult(id, label, command, at, reply = reply, meaning = meaning(reply), milliseconds = stopwatch.milliseconds).also {
                        log("← $label: ${it.bytes} B in ${msText(it.milliseconds)} ms")
                        noteReach(null, action)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: PrinterNoReply) {
                    // A setvar and most raw commands reply nothing by design: it went out.
                    if (action == TroubleAction.COMMAND) {
                        AskResult(id, label, command, at, meaning = COMMAND_SENT_TEXT, milliseconds = stopwatch.milliseconds).also {
                            log("← $label: sent, no reply after ${msText(it.milliseconds)} ms")
                        }
                    } else {
                        AskResult(id, label, command, at, error = troubleText(e, started.printer), milliseconds = stopwatch.milliseconds).also {
                            log("← $label failed after ${msText(it.milliseconds)} ms: ${describe(e)}")
                        }
                    }.also { noteReach(null, action) }
                } catch (e: Exception) {
                    AskResult(id, label, command, at, error = troubleText(e, started.printer), milliseconds = stopwatch.milliseconds).also {
                        log("← $label failed after ${msText(it.milliseconds)} ms: ${describe(e)}")
                        noteReach(e, action)
                    }
                }
            } finally {
                _state.update { s -> s.copy(asks = result?.let { s.asks + it } ?: s.asks, running = null) }
            }
        }
    }

    // --- Speed test ---

    fun setSpeedKb(kb: Int) = _state.update { if (it.running == TroubleAction.SPEED) it else it.copy(speedKb = kb) }
    fun setSpeedRuns(runs: Int) = _state.update { if (it.running == TroubleAction.SPEED) it else it.copy(speedRuns = runs) }

    /** Sends `speedRuns` speed-test labels of `speedKb` KB, one after another, each in its own turn
     *  of the lock (the tab confirms first when that's more than one). A failure stops the test. */
    fun startSpeedTest(): Job? {
        val size = speedSize() ?: return null
        val started = begin(TroubleAction.SPEED) ?: return null
        val kb = _state.value.speedKb
        val runs = _state.value.speedRuns
        stopRequested = false
        _state.update { it.copy(speedStopping = false) }
        log("Speed test: $runs × $kb KB on ${size.label} labels at ${size.dpi} dpi")
        return scope.launch {
            try {
                runSpeed(started, size, kb, runs)
            } finally {
                _state.update { it.copy(speedRunNow = 0, speedStopping = false, running = null) }
            }
        }
    }

    /** Stop: the label going out finishes (cutting it would leave a half label in the printer),
     *  then the test stops. */
    fun stopSpeedTest() {
        if (_state.value.running != TroubleAction.SPEED) return
        stopRequested = true
        _state.update { it.copy(speedStopping = true) }
    }

    private suspend fun runSpeed(started: Started, size: AlignmentSize, kb: Int, runs: Int) {
        for (run in 1..runs) {
            if (stopRequested) {
                log("Speed test stopped before run $run")
                return
            }
            _state.update { it.copy(speedRunNow = run) }
            if (started.printer.isBluetooth && _state.value.printerLink?.connected != true) {
                log("Run $run includes connecting: the Bluetooth link was down")
            }
            val zpl = speedTestLabel(targetBytes = kb * 1024, widthDots = size.widthDots, heightDots = size.heightDots, run = run)
            val bytes = zpl.toByteArray(Charsets.UTF_8).size
            val id = nextId.incrementAndGet()
            stopwatch.reset()
            try {
                started.zebra.send(zpl)
                val row = SpeedRow(id, run, kb, bytes, seconds = stopwatch.seconds)
                _state.update { it.copy(speedRows = it.speedRows + row) }
                log("Run $run: $bytes B in ${decimal(row.seconds)} s, ${decimal(row.kbPerSecond)} KB/s")
                noteReach(null, TroubleAction.SPEED)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(speedRows = it.speedRows + SpeedRow(id, run, kb, bytes, error = troubleText(e, started.printer))) }
                log("Run $run failed: ${describe(e)}")
                noteReach(e, TroubleAction.SPEED)
                return
            }
        }
    }

    // --- Cut-send test ---

    /** D16 on a real printer (developers, checked now): the first half of a sample label, marked as
     *  a failed send in the same turn of the lock, then the full label through the normal path,
     *  which sends `~JX` first (never `~JA`). Only the full label may print. Two turns of the lock,
     *  one after the other: never one inside the other. */
    fun runCutSendTest(): Job? {
        if (!showsCutSendTest) return null
        val size = speedSize() ?: return null
        val started = begin(TroubleAction.CUT_SEND) ?: return null
        _state.update { it.copy(cutSendMessage = null, cutSendError = false) }
        val full = sampleTestLabel(widthDots = size.widthDots, heightDots = size.heightDots, dpi = size.dpi, nowMs = clock(), zone = zone)
        // Plain ASCII: half the characters are half the bytes.
        val half = full.substring(0, full.length / 2)
        log("Cut-send test: ${half.length} of ${full.length} B of a sample label, then all of it")
        return scope.launch {
            try {
                started.zebra.sendCut(half)
                log("Half label sent; the printer is marked for a clear")
                started.zebra.send(full)
                log("Full label sent")
                _state.update { it.copy(cutSendMessage = CUT_SEND_DONE_TEXT) }
                noteReach(null, TroubleAction.CUT_SEND)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(cutSendMessage = troubleText(e, started.printer), cutSendError = true) }
                log("Cut-send test failed: ${describe(e)}")
                noteReach(e, TroubleAction.CUT_SEND)
            } finally {
                _state.update { it.copy(running = null) }
            }
        }
    }

    // --- Bluetooth scan ---

    /**
     * Lists every named device nearby, strongest first, until the scan ends (30 s, Stop, Bluetooth
     * refused, or a printer call taking the radio). [permitted] is false when the screen's
     * permission prompt came back refused: it says so without scanning, and stays so until the
     * permissions are allowed ([appResumed]). Nothing is saved, and nothing connects.
     */
    fun scan(permitted: Boolean = true) {
        if (closed || _state.value.scanning) return
        promptRefused = !permitted
        rescanWhenReady = false
        if (!permitted) {
            _state.update { it.copy(scanMessage = BLUETOOTH_DENIED_TEXT) }
            log("Bluetooth scan: the permission prompt was refused")
            return
        }
        bluetooth.refreshAvailability()
        startScan()
    }

    /** Stop: the scan ends, and what it heard stays listed. */
    fun stopScan() {
        if (_state.value.scanning) stopTapped = true
        bluetooth.stopScan()
    }

    /** The screen came back to the front (from Settings, say). Android sends nothing when a
     *  permission is granted, so Bluetooth is read again; a refused prompt lifts once the
     *  permissions are [permitted], and its scan runs. */
    fun appResumed(permitted: Boolean) {
        bluetooth.refreshAvailability()
        if (!permitted || !promptRefused) return
        promptRefused = false
        if (!closed) startScan()
    }

    /** Bluetooth can be used: a scan it refused runs again (a refused prompt clears that). */
    private fun bluetoothReady() {
        if (!rescanWhenReady || closed) return
        rescanWhenReady = false
        startScan()
    }

    /** Starts the scan unless one runs or a speed test does (a scan shares the radio with the
     *  label's acknowledgments and would lower its KB/s). */
    private fun startScan() {
        var started = false
        _state.update {
            started = !it.scanning && it.running != TroubleAction.SPEED
            if (started) it.copy(scanning = true, found = emptyList(), scanMessage = null) else it
        }
        if (!started) return
        val run = scanRun.incrementAndGet()
        stopTapped = false
        val startedNs = System.nanoTime()
        val startedAtMs = clock()
        log("Bluetooth scan started")
        scanJob = scope.launch {
            try {
                bluetooth.scan().collect { list -> if (run == scanRun.get()) _state.update { it.copy(found = list) } }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("Bluetooth scan failed: ${describe(e)}")
            }
            if (run != scanRun.get()) return@launch
            scanJob = null
            val refused = bluetoothUnavailableText(bluetooth.availability.value)
            if (refused != null) rescanWhenReady = true
            // "Nothing heard" only after the full scan or Stop. One that ended early says why: a
            // printer call took the radio (the link was used since it started), or something else.
            val ranItsCourse = stopTapped || (System.nanoTime() - startedNs) / 1_000_000 >= ZebraBluetoothSpec.SCAN_MS
            val printerUsed = (bluetooth.link.value.lastActivityMs ?: Long.MIN_VALUE) >= startedAtMs
            var devices = emptyList<FoundBluetoothPrinter>()
            _state.update {
                devices = it.found.orEmpty()
                val message = when {
                    refused != null -> refused
                    ranItsCourse -> if (devices.isEmpty()) NOTHING_HEARD_TEXT else null
                    printerUsed -> SCAN_CUT_SHORT_TEXT
                    else -> SCAN_ENDED_EARLY_TEXT
                }
                it.copy(scanning = false, scanMessage = message)
            }
            log(
                "Bluetooth scan ended: ${devices.size} named devices, ${devices.count { it.isZebra }} Zebra" +
                    (refused?.let { " ($it)" } ?: ""),
            )
            for (d in devices) log("  ${scanLine(d)}")
        }
    }

    /** The scan stops quietly, keeping its list (the tab went away). */
    private fun endScan() {
        scanRun.incrementAndGet()
        rescanWhenReady = false
        scanJob?.cancel()
        scanJob = null
        _state.update { it.copy(scanning = false) }
    }

    // --- Report ---

    /**
     * Everything the tab found, as the text Copy and Share send: this device and app, the saved
     * printer, its connection and details, every ask with its reply, the speed rows, the Cut-send
     * test, the Bluetooth scan, then the log. Named `printer-report-<yyyyMMdd-HHmmss>.txt`. Past
     * [maxChars] the oldest log lines are left out (it says how many).
     */
    fun report(nowMs: Long = clock(), maxChars: Int = Int.MAX_VALUE): TroubleshootingReport {
        val ui = _state.value
        val at = Instant.ofEpochMilli(nowMs).atZone(zone)
        val name = "printer-report-${FILE_STAMP.format(at)}.txt"
        val out = ArrayList<String>()
        out += "ServerSherpa Kiosk · Printer troubleshooting report"
        out += "Generated ${DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(at.truncatedTo(ChronoUnit.SECONDS))} (${zone.id})"
        out += device().split("\n")

        out += ""
        out += "== Saved printer =="
        out += ui.printer?.let(::printerSummary) ?: "None set up"

        out += ""
        out += "== Connection =="
        out += connectionLines(ui).map { "${it.label}: ${it.value}" }

        out += ""
        out += "== Printer details =="
        if (ui.hostId != null) {
            out += "~HI (${msText(ui.hostIdMilliseconds)} ms):"
            out += hostIdLines(ui).map { "  ${it.label}: ${it.value}" }
        } else {
            out += "~HI: ${ui.detailsError ?: "not asked"}"
        }
        if (ui.printer?.isBluetooth == true) {
            val info = deviceInfoLines(ui)
            out += if (info.isEmpty()) "Device Information: not read (the link hasn't been up to this printer)" else "Device Information:"
            out += info.map { "  ${it.label}: ${it.value}" }
        }

        out += ""
        out += "== Ask the printer (${ui.asks.size}) =="
        for (ask in ui.asks) {
            out += "[${clockText(ask.atMs)}] ${ask.label} · command ${visibleCommand(ask.command)}"
            out += "  ${ask.bytes} B in ${msText(ask.milliseconds)} ms"
            ask.meaning?.let { out += "  Meaning: $it" }
            ask.error?.let { out += "  Error: $it" }
            if (ask.reply.isNotEmpty()) {
                out += "  Reply:"
                if (asksForASecret(ask.command)) {
                    out += "    [redacted: the reply to a secret setting]"
                } else {
                    out += visibleBytes(withoutPanelPassword(ask.command, ask.reply)).split("\n").map { "    $it" }
                }
            }
        }

        out += ""
        out += "== Speed test (${ui.speedRows.size} labels) =="
        speedSize(ui)?.let { out += "Label: ${it.label} at ${it.dpi} dpi" }
        out += "run | KB | bytes | seconds | KB/s"
        for (row in ui.speedRows) {
            out += row.error?.let { "${row.run} | ${row.targetKb} | ${row.bytes} | failed: $it" }
                ?: "${row.run} | ${row.targetKb} | ${row.bytes} | ${decimal(row.seconds)} | ${decimal(row.kbPerSecond)}"
        }
        ui.speedAverage?.let { average ->
            val count = ui.speedRows.count { it.kbPerSecond != null }
            out += "Average: ${decimal(average)} KB/s over $count label${if (count == 1) "" else "s"}"
        }

        ui.cutSendMessage?.let {
            out += ""
            out += "== Cut-send test =="
            out += it
        }

        out += ""
        out += "== Bluetooth scan =="
        val found = ui.found
        if (found != null) {
            out += "${found.size} named device${if (found.size == 1) "" else "s"}, strongest first${if (ui.scanning) " (still scanning)" else ""}"
            out += found.map { "  ${scanLine(it)}" }
            if (found.any { !it.isZebra }) out += "Devices that aren't Zebras are listed by signal only."
            ui.scanMessage?.let { out += it }
        } else {
            out += "Not run"
        }

        out += ""
        val logs = logLines
        out += "== Log (${logs.size} lines; the last $LOG_CAP are kept) =="
        return TroubleshootingReport(name, fit(out.map(::redactSecrets), logs.map { redactSecrets("${clockText(it.atMs, millis = true)}  ${it.text}") }, maxChars))
    }

    /** [head] and as many of the newest [logs] as fit in [maxChars]; one line says how many were left out. */
    private fun fit(head: List<String>, logs: List<String>, maxChars: Int): String {
        val top = head.joinToString("\n", postfix = "\n")
        val all = top + logs.joinToString("") { "$it\n" }
        if (all.length <= maxChars) return all
        val noteRoom = "(${logs.size} older log lines left out to fit the share limit)\n".length
        var room = maxChars - top.length - noteRoom
        var kept = 0
        for (line in logs.asReversed()) {
            if (line.length + 1 > room) break
            room -= line.length + 1
            kept++
        }
        val text = top + "(${logs.size - kept} older log lines left out to fit the share limit)\n" +
            logs.takeLast(kept).joinToString("") { "$it\n" }
        if (text.length <= maxChars) return text
        // The replies alone are too long: cut them, saying so.
        val cut = "\n(the report was cut here to fit the share limit)\n"
        return text.take(maxOf(0, maxChars - cut.length)) + cut
    }

    /** Adds a line to the log the report carries, keeping the last [LOG_CAP]. */
    fun log(text: String) {
        val count = synchronized(logLock) {
            log.addLast(TroubleLogLine(clock(), text))
            while (log.size > LOG_CAP) log.removeFirst()
            log.size
        }
        _state.update { it.copy(logCount = count) }
    }

    // --- Helpers ---

    /** The saved printer and its locked transport, for a call the tab starts: null while another one
     *  runs, the tab is closed, or there's no printer. */
    private fun begin(action: TroubleAction): Started? {
        if (closed) return null
        var printer: SavedPrinter? = null
        _state.update {
            printer = null
            if (it.running != null || it.printer == null) {
                it
            } else {
                printer = it.printer
                it.copy(running = action)
            }
        }
        val p = printer ?: return null
        stopwatch.reset()
        val timed = TimedZebra(zebraFor(p), stopwatch)
        return Started(p, LockedZebra(timed, p.connection, printerLock, printerGuard))
    }

    /** Each call's outcome replaces the reach card: a Bluetooth refusal the crew fixes on the
     *  handheld shows with its buttons in [section]; a call that got through, or failed another way,
     *  clears it. */
    private fun noteReach(error: Throwable?, section: TroubleAction) {
        val text = error?.let(::bluetoothRefusal)?.message
        _state.update { it.copy(reach = text?.let { t -> TroubleReach(section, t) }) }
    }

    /** What a failed call says: the app's words for what can be fixed (unreachable, Bluetooth off
     *  or not allowed, a printer that forgot this device, a cut font), the app's own printer
     *  messages, and for anything else only its kind: a stray exception's message could carry
     *  anything, and this text goes in the shared report. */
    private fun troubleText(e: Throwable, printer: SavedPrinter): String {
        val refusal = bluetoothRefusal(e)
        return when {
            e is PrinterNoReply -> "No reply."
            e is PrinterNeedsRestart -> FONT_INSTALL_CUT_TEXT
            refusal != null -> refusal.message ?: printerUnreachableText(printer)
            e is PrinterClearFailed -> e.cause?.let { troubleText(it, printer) } ?: printerUnreachableText(printer)
            e is PrinterUnreachable || e is BluetoothPrinterNotFound -> printerUnreachableText(printer)
            e is PrinterTimeout -> "The printer didn't take it in time."
            e is PrinterException -> e.message ?: "Something went wrong (${e.javaClass.simpleName})."
            else -> "Something went wrong (${e.javaClass.simpleName})."
        }
    }

    /** "14:05:09", or "14:05:09.123" with [millis], in the tab's time zone. */
    fun clockText(ms: Long, millis: Boolean = false): String =
        (if (millis) CLOCK_MILLIS else CLOCK).format(Instant.ofEpochMilli(ms).atZone(zone))

    companion object {
        const val LOG_CAP = 5_000
        val SPEED_SIZES_KB = listOf(10, 25, 50)
        val SPEED_RUN_COUNTS = listOf(1, 3, 5)
    }
}

/** A call the tab started: the printer, and the way to it under the lock and the guard. */
private class Started(val printer: SavedPrinter, val zebra: LockedZebra)

/** How long the last call to the printer took. It is timed inside the printer lock, around the
 *  transport's call: a wait behind Print Labels isn't counted, and a `~JX` before it is replaced by
 *  the call itself. */
private class CallStopwatch {
    private val lastNs = AtomicReference<Long?>(null)

    fun reset() = lastNs.set(null)
    fun record(ns: Long) = lastNs.set(ns)

    val seconds: Double? get() = lastNs.get()?.let { it / 1e9 }
    val milliseconds: Long? get() = lastNs.get()?.let { (it + 500_000) / 1_000_000 }
}

/** [inner], each call timed on [stopwatch]. */
private class TimedZebra(private val inner: SetupZebra, private val stopwatch: CallStopwatch) : SetupZebra {
    override suspend fun identify(): HostId = timed { inner.identify() }
    override suspend fun serial(): String? = timed { inner.serial() }
    override suspend fun status(): HostStatus = timed { inner.status() }
    override suspend fun peelerPresent(): Boolean? = timed { inner.peelerPresent() }
    override suspend fun fonts(): List<String> = timed { inner.fonts() }
    override suspend fun fontEntries(): List<DirectoryEntry> = timed { inner.fontEntries() }
    override suspend fun send(zpl: String) = timed { inner.send(zpl) }
    override suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress?) =
        timed { inner.installFont(name, bytes, progress) }
    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String = timed { inner.query(command, complete) }

    private suspend fun <T> timed(call: suspend () -> T): T {
        val start = System.nanoTime()
        try {
            return call()
        } finally {
            stopwatch.record(System.nanoTime() - start)
        }
    }
}

/** The scan's notes that aren't errors. */
private val SCAN_NOTES = setOf(NOTHING_HEARD_TEXT, SCAN_CUT_SHORT_TEXT, SCAN_ENDED_EARLY_TEXT)

/** "On", "Off", … for the Connection lines; null while Bluetooth hasn't said. */
private fun bluetoothStateText(availability: BluetoothAvailability): String? = when (availability) {
    BluetoothAvailability.UNKNOWN -> null
    BluetoothAvailability.READY -> "On"
    BluetoothAvailability.POWERED_OFF -> "Off"
    BluetoothAvailability.UNAUTHORIZED -> "Not allowed for ServerSherpa Kiosk"
    BluetoothAvailability.LOCATION_OFF -> "On (Location is off, so scans can't find printers)"
    BluetoothAvailability.UNSUPPORTED -> "Not supported on this device"
}

/** "D8J224508535 · -52 dBm · Zebra": a device the scan heard, for the log and the report. A device
 *  that isn't a Zebra goes by its signal alone: its name is often a person's ("Jimmy's AirPods"). */
private fun scanLine(d: FoundBluetoothPrinter): String =
    if (d.isZebra) "${d.name} · ${d.rssi} dBm · Zebra${if (d.advertisesZebra) " (advertises Zebra)" else ""}"
    else "Other device · ${d.rssi} dBm"

/** What the log says about [e]: its kind, and its message only when it is the app's own printer
 *  words (or a socket's, for its cause): any other message could carry anything. */
private fun describe(e: Throwable): String {
    val own = e is PrinterException || e is PrinterNeedsRestart
    val cause = e.cause?.let { c ->
        val said = if (c is IOException || c is PrinterException) c.message?.let { ": $it" }.orEmpty() else ""
        " (cause ${c.javaClass.simpleName}$said)"
    }.orEmpty()
    return (if (own) "${e.javaClass.simpleName}: ${e.message}" else e.javaClass.simpleName) + cause
}

/** `text` (a command, or a reply read as Latin-1) with its control bytes made visible: STX ␂,
 *  ETX ␃, CR ␍, LF ␊ plus a line break, any other control byte as `<XX>`. */
fun visibleBytes(text: String): String = buildString {
    for (ch in text) {
        when (val code = ch.code) {
            0x02 -> append('␂')
            0x03 -> append('␃')
            0x0D -> append('␍')
            0x0A -> append("␊\n")
            in 0x00..0x1F, in 0x7F..0x9F -> append(String.format(Locale.US, "<%02X>", code))
            else -> append(ch)
        }
    }
}

/** A command on one line, its control bytes visible ("~HI␍␊"). */
fun visibleCommand(command: String): String = visibleBytes(command).replace("\n", "")

// --- Keeping secrets out of the shared report ---

/** Names that say a setting or value is a secret. */
private const val SECRET_WORDS =
    "password|passwd|passphrase|psk|token|secret|cookie|authorization|api[_-]?key|station[_-]?key|" +
        "private[_-]?key|session[_-]?(?:id|key)|community|wep[_.-]?key"

private val BEARER = Regex("""(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+""")
private val JWT = Regex("""\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}""")
/** A name that says it is a secret, and what comes between it and its value: `=` or `:` (after a
 *  JSON key's closing quote), or SGD's `" "`. The value's own opening quote isn't part of it. */
private const val SECRET_NAME_AND_SEPARATOR =
    """([A-Za-z0-9_.\-]*(?:$SECRET_WORDS)[A-Za-z0-9_.\-]*(?:"?\s*[:=]\s*|"\s+))"""
/** A quoted secret (`name: "a b c"`, `'a b c'`, JSON's `"name": "a b c"`, SGD's `"name" "a b c"`):
 *  everything up to the matching closing quote goes, spaces and all; a backslash escapes a quote,
 *  and one that never closes runs to the end of the line. */
private val SECRET_QUOTED = Regex(
    """(?im)$SECRET_NAME_AND_SEPARATOR(?:"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$))""",
)
/** An unquoted secret (`name=value`, `name: value`): up to a space or a delimiter. */
private val SECRET_BARE = Regex("""(?i)$SECRET_NAME_AND_SEPARATOR([^\s"';,&␍␊␂␃<>]+)""")
private val GETVAR = Regex("""(?i)getvar\s+"([^"]*)"""")
private val SECRET_NAME = Regex("(?i)$SECRET_WORDS")
/** `~HS`'s third string: the printer's front-panel password (4 digits), then a flag. */
private val PANEL_PASSWORD = Regex("""\u0002\d{4},(\d)\u0003""")

/** [text] with secret-looking values masked: bearer tokens, JSON web tokens, and the value of any
 *  `name=value`, `name: value`, `"name": "value"` or `"name" "value"` whose name says it is a secret
 *  (a password, PSK, token, key, cookie, …), a quoted one whole up to its closing quote. A backstop,
 *  not the defense: the report is built from what the tab hears, which never includes the app's own
 *  secrets (session, cookies, keys, move passwords); this catches the free text that can hold one,
 *  what an admin types into the command box and what a printer sends back. An unquoted value with
 *  spaces in it (`password: a b c`) loses only its first word. */
internal fun redactSecrets(text: String): String {
    if (text.isEmpty()) return text
    return text
        .replace(BEARER, "Bearer [redacted]")
        .replace(JWT, "[redacted]")
        .replace(SECRET_QUOTED) { m -> m.groupValues[1] + m.value[m.groupValues[1].length].let { q -> "$q[redacted]$q" } }
        .replace(SECRET_BARE) { m -> m.groupValues[1] + "[redacted]" }
}

/** [command] reads a setting whose name says it is a secret (`getvar "wlan.wpa.psk"`): its reply is
 *  that secret. */
private fun asksForASecret(command: String): Boolean =
    GETVAR.findAll(command).any { SECRET_NAME.containsMatchIn(it.groupValues[1]) }

/** A `~HS` reply with the printer's front-panel password masked. */
private fun withoutPanelPassword(command: String, reply: String): String =
    if (command.trim() != ZebraCommands.HOST_STATUS) reply
    else reply.replace(PANEL_PASSWORD) { "\u0002****,${it.groupValues[1]}\u0003" }

private fun msText(ms: Long?): String = ms?.toString() ?: "?"

/** "3.90", or "-" when there's no value. */
private fun decimal(value: Double?): String = value?.let { String.format(Locale.US, "%.2f", it) } ?: "-"

private fun yesNo(flag: Boolean) = if (flag) "yes" else "no"

private val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss", Locale.US)
private val CLOCK_MILLIS: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss.SSS", Locale.US)
private val FILE_STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss", Locale.US)
