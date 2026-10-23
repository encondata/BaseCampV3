package com.serversherpa.kiosk.ui.screens.labels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.labels.DEVICE_UNSUPPORTED_TEXT
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelGenArgs
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelPick
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.NEEDS_UPDATE_TEXT
import com.serversherpa.kiosk.core.labels.NO_TEMPLATE_AT_DPI
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.labels.TEMPLATE_FAILED
import com.serversherpa.kiosk.core.labels.TEMPLATE_UNSUPPORTED
import com.serversherpa.kiosk.core.labels.parseSample
import com.serversherpa.kiosk.core.labels.parseZpl
import com.serversherpa.kiosk.core.labels.printerUnreachableText
import com.serversherpa.kiosk.core.model.KioskLabelFont
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.FontFix
import com.serversherpa.kiosk.core.printer.PrinterNeedsRestart
import com.serversherpa.kiosk.core.printer.SCAN_ENDED_EARLY_TEXT
import com.serversherpa.kiosk.core.printer.ZebraBluetoothSpec
import com.serversherpa.kiosk.core.printer.builtInFontText
import com.serversherpa.kiosk.core.printer.damagedFonts
import com.serversherpa.kiosk.core.printer.fontFixFor
import com.serversherpa.kiosk.core.printer.isIpv4
import com.serversherpa.kiosk.core.printer.missingFonts
import com.serversherpa.kiosk.core.printer.noTemplateText
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.core.printer.statusProblems
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelEngineTimeoutException
import com.serversherpa.kiosk.data.labels.LabelEngineUnsupportedException
import com.serversherpa.kiosk.data.labels.LabelSettingsStore
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothNotZebra
import com.serversherpa.kiosk.data.printer.BluetoothPairingLost
import com.serversherpa.kiosk.data.printer.BluetoothLinkInfo
import com.serversherpa.kiosk.data.printer.BluetoothPrinting
import com.serversherpa.kiosk.data.printer.BluetoothScanEnd
import com.serversherpa.kiosk.data.printer.BluetoothUnavailable
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.data.printer.FoundPrinter
import com.serversherpa.kiosk.data.printer.LockedZebra
import com.serversherpa.kiosk.data.printer.PrinterException
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.printer.SetupZebra
import com.serversherpa.kiosk.data.printer.WriteProgress
import com.serversherpa.kiosk.data.printer.bluetoothRefusal
import com.serversherpa.kiosk.data.printer.bluetoothUnavailableText
import com.serversherpa.kiosk.data.sync.Sync
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.ceil
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** The Peeler check's detail: what the printer said, and how labels print (PrinterStep's words). */
fun peelerDetail(present: Boolean?, peel: Boolean): String {
    val mode = if (peel) "printing in peel-off mode" else "printing in tear-off mode"
    return when (present) {
        true -> "Peeler detected · $mode"
        false -> "No peeler · $mode"
        null -> "Printer doesn't report a peeler · $mode"
    }
}

/** The checks, in the order they run (the web kiosk's PrinterStep rows). */
enum class CheckKey(val label: String) {
    ANSWERS("Printer answers"),
    DPI("DPI matches the templates"),
    STATUS("Ready to print"),
    PEELER("Peeler"),
    FONTS("Fonts installed"),
}

/** WARN informs (amber); FAIL is something to fix (red). Neither blocks anything. */
enum class CheckState { RUNNING, OK, WARN, FAIL }

data class CheckRow(val key: CheckKey, val state: CheckState, val detail: String? = null, val notes: List<String> = emptyList())

enum class TestLabel { ALIGNMENT, SAMPLE }

/** The alignment label's size: [widthIn] x [heightIn] inches at [dpi]. */
data class AlignmentSize(val widthIn: Double, val heightIn: Double, val dpi: Int) {
    val widthDots: Int get() = (widthIn * dpi).roundToInt()
    val heightDots: Int get() = (heightIn * dpi).roundToInt()
    /** "4x2", "2.25x1.5". */
    val label: String get() = "${inches(widthIn)}x${inches(heightIn)}"

    private fun inches(v: Double): String = if (v == Math.floor(v)) v.toLong().toString() else v.toString()
}

/** The picked template's size, else 4x2 for Top and 2x1 for Front (the web kiosk's test labels). */
fun alignmentSizeFor(kind: LabelKind, dpi: Int, pick: LabelPick?): AlignmentSize {
    val w = pick?.widthIn
    val h = pick?.heightIn
    if (pick != null && pick.kind == kind && pick.dpi == dpi && w != null && h != null) return AlignmentSize(w, h, dpi)
    return if (kind == LabelKind.FRONT) AlignmentSize(2.0, 1.0, dpi) else AlignmentSize(4.0, 2.0, dpi)
}

/** How the operator is finding a printer: a network scan, a typed IP, or a Bluetooth scan. */
enum class FindMode { SCAN, IP, BLUETOOTH }

/** A font install's font going out: its name, and which of how many it is. */
data class InstallingFont(val name: String, val number: Int, val count: Int)

data class PrinterSetupUi(
    /** Null until one is picked. */
    val findMode: FindMode? = null,
    val scanning: Boolean = false,
    /** Null until a scan finishes. */
    val found: List<FoundPrinter>? = null,
    val scanMessage: String? = null,
    val ipText: String = "",
    /** The host being identified and saved, or the Bluetooth address of the printer being chosen. */
    val choosing: String? = null,
    val chooseError: String? = null,
    /** Every named device the Bluetooth scan heard, Zebras first: null until a scan starts. */
    val bluetoothFound: List<FoundBluetoothPrinter>? = null,
    val bluetoothScanning: Boolean = false,
    /** Under the Bluetooth list: Bluetooth off, not allowed or missing, Location off, or no Zebra heard. */
    val bluetoothMessage: String? = null,
    /** The printer forgot this device: the steps that fix it (the screen adds Bluetooth settings and Connect). */
    val pairingLost: String? = null,
    /** Bluetooth couldn't be used (off, not allowed, missing, Location off), as the last scan,
     *  choice, check or test label found; null when it could. */
    val bluetoothUnavailable: BluetoothAvailability? = null,
    val checks: List<CheckRow> = emptyList(),
    val checking: Boolean = false,
    /** How many check runs have finished. */
    val checkRuns: Int = 0,
    val fontFix: FontFix? = null,
    /** Fonts on the printer at another size than the library's (a download cut short): [fontFix]
     *  installs them again, and the button says so. */
    val damagedFonts: List<String> = emptyList(),
    val installing: Boolean = false,
    /** Cancel was tapped: the font going out finishes, then the install stops. */
    val installStopping: Boolean = false,
    /** The font going out. */
    val installFont: InstallingFont? = null,
    /** While a font is going out: how much of it has (0..1), and about how long the install has
     *  left (null until a speed is measured). */
    val installProgress: Float? = null,
    val installEta: String? = null,
    val fontMessage: String? = null,
    val fontError: Boolean = false,
    /** What the peeler check found: true, false, or null (unknown or not checked). */
    val peeler: Boolean? = null,
    val offsetXText: String = "0",
    val offsetYText: String = "0",
    val testing: Boolean = false,
    val testMessage: String? = null,
    val testError: Boolean = false,
) {
    /** Peel-off can be chosen unless the printer said it has no peeler. */
    val peelAllowed: Boolean get() = peeler != false
    val busy: Boolean get() = choosing != null || installing || testing
    /** The Bluetooth card (and its Scan again) can be tapped: not while a check is asking the
     *  printer, whose query would end the scan without a word. */
    val bluetoothScanAllowed: Boolean get() = !busy && !checking
    /** The Bluetooth list's Zebras (named like a Zebra serial, or advertising Zebra), in the scan's order. */
    val bluetoothZebras: List<FoundBluetoothPrinter> get() = bluetoothFound.orEmpty().filter { it.isZebra }
    /** Every other named device the scan heard. */
    val bluetoothOthers: List<FoundBluetoothPrinter> get() = bluetoothFound.orEmpty().filterNot { it.isZebra }
    /** The Bluetooth message reads as an error (red); no Zebra heard, or a scan Android wouldn't
     *  run, is information. */
    val bluetoothError: Boolean get() =
        bluetoothMessage != null && bluetoothMessage != NO_BLUETOOTH_PRINTERS_TEXT && bluetoothMessage != SCAN_ENDED_EARLY_TEXT
    /** "Installing ROBOTO.TTF (1 of 3)…" (no count for one font), "Stopping after ROBOTO.TTF…". */
    val installStatus: String get() {
        val font = installFont ?: return if (installStopping) "Stopping…" else "Installing fonts…"
        if (installStopping) return "Stopping after ${font.name}…"
        return if (font.count > 1) "Installing ${font.name} (${font.number} of ${font.count})…" else "Installing ${font.name}…"
    }
}

const val NO_PRINTERS_FOUND_TEXT = "No Zebra printers found on this network."
const val NO_BLUETOOTH_PRINTERS_TEXT = "No Zebra printers found nearby."
const val SCAN_FAILED_TEXT = "Couldn't scan the network."
const val INVALID_IP_TEXT = "That isn't a valid IP address."
const val NO_PEELER_TEXT = "This printer has no peeler."
const val FONTS_INSTALLED_TEXT = "Fonts installed."
/** "No Zebra printer answered at 10.0.0.5." / "No Zebra printer answered over Bluetooth as D8J224508535." */
fun noZebraAnswerText(c: PrinterConnection): String = when (c) {
    is PrinterConnection.Network -> "No Zebra printer answered at ${c.host}."
    is PrinterConnection.Bluetooth -> "No Zebra printer answered over Bluetooth as ${c.serial}."
}
fun fontInstallFailedText(name: String) = "Couldn't install $name."
/** The install button's words (iOS's): "Install 2 missing fonts", "Reinstall 1 damaged font", or
 *  "Install 1 missing font, reinstall 1 damaged font" ([damaged]: upper-case names). */
fun fontInstallButtonText(installable: List<KioskLabelFont>, damaged: List<String>): String {
    fun fonts(n: Int, kind: String) = "$n $kind font${if (n == 1) "" else "s"}"
    val reinstall = installable.count { it.name.uppercase() in damaged }
    val install = installable.size - reinstall
    return when {
        reinstall == 0 -> "Install ${fonts(install, "missing")}"
        install == 0 -> "Reinstall ${fonts(reinstall, "damaged")}"
        else -> "Install ${fonts(install, "missing")}, reinstall ${fonts(reinstall, "damaged")}"
    }
}
/** A device picked from the Bluetooth list that isn't a Zebra (its Device Information says so). */
fun notAZebraText(name: String) = "$name isn't a Zebra printer."
/** A device picked from the Bluetooth list whose Device Information gave no serial (iOS's words). */
const val NO_BLUETOOTH_SERIAL_TEXT = "This printer didn't report a serial number, so it can't be saved over Bluetooth."

/** "about 40 s left", "about 4 min left": the time [remainingBytes] take at [bytesPerSecond]; null
 *  when nothing is left (or no rate is known). */
fun installEtaText(remainingBytes: Long, bytesPerSecond: Double): String? {
    if (remainingBytes <= 0 || bytesPerSecond <= 0) return null
    val seconds = ceil(remainingBytes / bytesPerSecond)
    if (seconds < 60) return "about ${seconds.toLong()} s left"
    return "about ${(seconds / 60).roundToLong()} min left"
}

/**
 * Printer Setup (the laptop's PrinterStep, kiosk/src/components/setup/PrinterStep.tsx): pick a
 * Zebra (a network scan, a typed IP, or a Bluetooth scan), check it, install missing or damaged
 * fonts, print test labels, and set the offsets and peel/tear. Choosing a printer saves it; the
 * label builder rebuilds by itself when its DPI changes, and offsets and peel never rebuild (they
 * apply at send time).
 *
 * Bluetooth (D4, D9–D11) goes through [bluetooth] (the container's `ZebraBluetooth`). Opening the
 * screen with a saved Bluetooth printer starts its link in the background ([open]: nothing waits
 * for it, nothing is checked), so the first check or test label needn't wait for the connect. The
 * permissions are asked for the first time Bluetooth is picked ([pickBluetooth]). Picking a printer
 * from the list connects to the address picked, asks `~HI` under the lock and the guard as a
 * network choice does, and saves it by Device Information's serial and that address: never an
 * address the link found it at (a device that reports no serial is refused). Bluetooth off, not
 * allowed, missing or Location off says so; once Bluetooth can be used again, a scan it stopped
 * runs again, and a check it stopped loses its stale row while the link warms up again in the
 * background (the checks themselves run only on a tap). A refused permission prompt stays refused
 * until the permissions are allowed. A printer that forgot this device gets the forget-it steps,
 * and Connect tries again once that's done.
 *
 * The checks inform and never block, and run only when a printer is saved or Check printer / Check
 * again is tapped: nothing is checked on open, polled, or checked when Bluetooth comes back. The
 * DPI and font checks read the builder's own template pick for the saved printer ([pick]), waiting
 * for the build a DPI change starts.
 *
 * Every call to a printer goes through the container's [PrinterLock] and [PrinterGuard], shared
 * with Print Labels' queue: one connection to the printer at a time, app-wide, a `~JX` before the
 * next call after a failed send, and no sends after a cut font install until a check gets an
 * answer. [zebraFor] is a printer the way its connection reaches it (the container's on the device).
 */
class PrinterSetupViewModel(
    private val store: LabelSettingsStore,
    private val pick: StateFlow<LabelPick?>,
    private val build: StateFlow<LabelBuildStatus>,
    private val engine: LabelEngine,
    private val db: KioskDatabase,
    private val fontsDir: File,
    private val scanner: suspend () -> List<FoundPrinter>,
    private val bluetooth: BluetoothPrinting,
    zebraFor: (printer: SavedPrinter) -> SetupZebra,
    printerLock: PrinterLock,
    private val printerGuard: PrinterGuard,
    scopeOverride: CoroutineScope? = null,
    /** Finishes an offsets save that is still waiting when the screen closes. */
    private val saveScope: CoroutineScope? = null,
    private val pickWaitMs: Long = PICK_WAIT_MS,
    /** The clock the install's time left is measured by (tests drive it). */
    private val nanoTime: () -> Long = System::nanoTime,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(PrinterSetupUi())
    val state: StateFlow<PrinterSetupUi> = _state
    /** Null until the settings are first read. */
    val settings: StateFlow<LabelSettings?> = store.settings.stateIn(scope, SharingStarted.Eagerly, null)
    val currentPick: StateFlow<LabelPick?> = pick
    /** The Bluetooth link, so the screen can say when the saved printer is connected. */
    val bluetoothLink: StateFlow<BluetoothLinkInfo> = bluetooth.link

    /** The saved printer: every call (checks, font installs, test labels) under the app-wide lock
     *  and guard, so a test label never opens a second connection while a check or a label is
     *  talking to the printer. */
    private val printerAt: (SavedPrinter) -> SetupZebra = { p -> LockedZebra(zebraFor(p), p.connection, printerLock, printerGuard) }
    /** A printer being chosen, before it is saved: under the lock and the guard (a pending clear
     *  still goes first), but its answer never lifts a cut font's stop (the check after saving does). */
    private val unsavedPrinterAt: (SavedPrinter) -> SetupZebra = { p ->
        LockedZebra(zebraFor(p), p.connection, printerLock, printerGuard, liftsStop = false)
    }
    /** Cancel was tapped during a font install: checked between fonts only. */
    @Volatile private var installCanceled = false
    /** The font going out (its number, the bytes of the fonts after it, whether it goes over
     *  Bluetooth, and its first progress report): only its progress is shown. */
    private class FontGoingOut(val id: Int, val bytesAfter: Long, val overBluetooth: Boolean) {
        @Volatile var firstReport: FirstReport? = null
    }
    /** When a font's bytes started moving, and how many had gone by then. */
    private class FirstReport(val atNs: Long, val sent: Long)
    private val fontGoingOut = AtomicReference<FontGoingOut?>(null)
    private var fontsStarted = 0
    /** The bytes per second this install measured so far: the next font's guess until it measures its own. */
    @Volatile private var installRate: Double? = null
    private var bluetoothScanJob: Job? = null
    /** Bumped by each Bluetooth scan (and by one ended quietly): only the latest writes when it ends. */
    private val bluetoothScanRun = AtomicInteger(0)
    /** What Connect (beside the pairing-lost steps) tries again. */
    @Volatile private var pairingRetry: PairingRetry? = null
    /** The screen's permission prompt was refused: nothing scans until the permissions are allowed
     *  (on API 31+ the link reads READY without Location, but Android then hides what a scan hears). */
    @Volatile private var promptRefused = false
    /** The prompt's answer arrived while the checks were asking the printer: applied once they end. */
    @Volatile private var pendingPermission: Boolean? = null
    /** A scan (or a choice) met Bluetooth refusing: scan again once it reads READY. */
    @Volatile private var rescanWhenReady = false
    /** The checks met Bluetooth refusing: once it reads READY their stale row goes and the link
     *  warms up again in the background (no check runs by itself). */
    @Volatile private var relinkWhenReady = false
    /** The background connect to the saved Bluetooth printer that opening the screen starts (D4). */
    private var linkJob: Job? = null
    /** The screen has shown once ([open] ran): later resumes are returns. */
    @Volatile private var opened = false
    private var checksJob: Job? = null
    /** Bumped by each check run started and by one canceled (iOS's `checkRun`): only the latest
     *  run ends the checking state and settles what waited for it. */
    private val checkRun = AtomicInteger(0)
    private var offsetsJob: Job? = null
    @Volatile private var pendingOffsets: Pair<Int, Int>? = null
    @Volatile private var offsetsTouched = false

    init {
        // The saved offsets fill the fields once, unless someone already typed.
        scope.launch {
            val s = settings.filterNotNull().first()
            if (!offsetsTouched) _state.update { it.copy(offsetXText = s.offsetX.toString(), offsetYText = s.offsetY.toString()) }
        }
        // Bluetooth coming on, Location turned on, or a permission allowed (read again when the app
        // comes back): what Bluetooth stopped runs again.
        scope.launch { bluetooth.availability.collect { if (it == BluetoothAvailability.READY) bluetoothReady() } }
    }

    /** Bluetooth can be used again. A check it stopped loses its stale Answers row and the link
     *  warms up in the background (the checks run only on a tap); a link refusal from opening the
     *  screen connects again; a scan it stopped runs again, in Bluetooth mode, unless the permission
     *  prompt was refused. While something holds the screen busy, [settle] looks again when it ends. */
    private fun bluetoothReady() {
        val s = _state.value
        if (s.busy || s.checking) return
        when {
            relinkWhenReady -> {
                relinkWhenReady = false
                _state.update { ui ->
                    ui.copy(
                        checks = ui.checks.filterNot { it.key == CheckKey.ANSWERS && it.state == CheckState.FAIL && bluetoothFixFor(it.detail) != null },
                        bluetoothUnavailable = null,
                    )
                }
                // A scan Bluetooth also stopped runs once the link's connect ends, not beside it
                // (the connect would end the scan): settle looks again then.
                val link = connectSavedPrinter() ?: linkJob
                scope.launch {
                    link?.join()
                    settle()
                }
            }
            linkRefusalShowing -> connectSavedPrinter()
            rescanWhenReady && !promptRefused && s.findMode == FindMode.BLUETOOTH && !s.bluetoothScanning -> startBluetoothScan()
        }
    }

    /** Something that held the screen busy (a choice, a check run, an install, a test label) ended:
     *  a permission answer that arrived meanwhile is applied, and what Bluetooth coming back asked
     *  for runs if it reads ready. */
    private fun settle() {
        pendingPermission?.let { permitted ->
            pendingPermission = null
            scanBluetooth(permitted)
            return
        }
        if (bluetooth.availability.value == BluetoothAvailability.READY) bluetoothReady()
    }

    /** The screen is showing: a saved Bluetooth printer's link starts in the background
     *  ([connectSavedPrinter]). Returns that connect (tests join it); null when one is already going. */
    fun open(): Job? {
        opened = true
        return connectSavedPrinter()
    }

    /** D4: connects to the saved Bluetooth printer in the background, so the first check or test
     *  label needn't wait for the link (one connect at a time; a network printer, or none, starts
     *  nothing). Nothing waits for it, it takes no printer lock, and nothing is checked. A refusal
     *  the crew fixes on the handheld shows in the screen's Bluetooth messages: a printer that
     *  forgot this device gets the steps, with Connect (which checks it); Bluetooth off or not
     *  allowed says so with its button, unless a Bluetooth scan's own message is showing. Any other
     *  failure (the printer off) says nothing: a check or test label will. */
    private fun connectSavedPrinter(): Job? {
        linkJob?.takeIf { it.isActive }?.let { return null }
        val job = scope.launch {
            val saved = store.settings.first().printer ?: return@launch
            val connection = saved.connection as? PrinterConnection.Bluetooth ?: return@launch
            val failure = try {
                bluetooth.connect(connection.address, connection.serial)
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                e
            }
            linkConnected(failure, saved)
        }
        linkJob = job
        return job
    }

    private fun linkConnected(failure: Exception?, saved: SavedPrinter) {
        // What an earlier try said about Bluetooth no longer holds: this one says its own.
        if (linkRefusalShowing) _state.update { it.copy(bluetoothMessage = null, bluetoothUnavailable = null) }
        if (failure == null) {
            // Up: the saved printer no longer says it forgot this device.
            if (pairingRetry == PairingRetry.Check) {
                pairingRetry = null
                _state.update { it.copy(pairingLost = null).withoutConnectOffer() }
            }
            return
        }
        val text = noteRefusal(failure, saved) ?: run {
            android.util.Log.i(TAG, "the Bluetooth printer's link didn't come up on open", failure)
            return
        }
        // Off or not allowed: said here unless a Bluetooth scan's own message is showing.
        if (bluetoothRefusal(failure) !is BluetoothPairingLost && _state.value.findMode != FindMode.BLUETOOTH) {
            _state.update { it.copy(bluetoothMessage = text) }
        }
    }

    /** The link refusal from opening the screen is showing (not a Bluetooth scan's message). */
    private val linkRefusalShowing: Boolean
        get() = _state.value.let { it.findMode == null && it.bluetoothMessage != null && it.bluetoothUnavailable != null }

    // --- choosing a printer ------------------------------------------------------------

    /** The Scan network card (and Scan again): scan mode, and a scan. A Bluetooth scan stops. */
    fun scan() {
        leaveBluetooth()
        _state.update { it.copy(findMode = FindMode.SCAN) }
        if (_state.value.scanning) return
        _state.update { it.copy(scanning = true, scanMessage = null) }
        scope.launch {
            val found = try {
                scanner()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w(TAG, "printer scan failed", e)
                null
            }
            _state.update {
                it.copy(
                    scanning = false, found = found.orEmpty(),
                    scanMessage = when {
                        found == null -> SCAN_FAILED_TEXT
                        found.isEmpty() -> NO_PRINTERS_FOUND_TEXT
                        else -> null
                    },
                )
            }
        }
    }

    /** The Enter IP card: IP mode. A Bluetooth scan stops. */
    fun enterIp() {
        leaveBluetooth()
        _state.update { it.copy(findMode = FindMode.IP) }
    }

    fun setIpText(text: String) = _state.update { it.copy(ipText = text, chooseError = null) }

    fun useIp() {
        val ip = _state.value.ipText.trim()
        if (!isIpv4(ip)) {
            _state.update { it.copy(chooseError = INVALID_IP_TEXT) }
            return
        }
        choosePrinter(ip, null)
    }

    fun choose(printer: FoundPrinter) = choosePrinter(printer.host, printer)

    /** Saves the printer at [host] (asked `~HI` first when [found] doesn't know its DPI), then checks it. */
    private fun choosePrinter(host: String, found: FoundPrinter?) {
        if (_state.value.busy) return
        beginChoosing(host)
        scope.launch {
            val saved = try {
                val dpi = found?.dpi
                if (dpi != null) {
                    SavedPrinter(host, found.model ?: DEFAULT_MODEL, found.serial.orEmpty(), dpi)
                } else {
                    // Addresses the printer for its `~HI`; what is saved is built from the answers.
                    val zebra = unsavedPrinterAt(SavedPrinter(host, DEFAULT_MODEL, "", 0))
                    val id = zebra.identify()
                    SavedPrinter(host, id.model.ifBlank { DEFAULT_MODEL }, (found?.serial ?: quietly { zebra.serial() }).orEmpty(), id.dpi)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(choosing = null, chooseError = noZebraAnswerText(PrinterConnection.Network(host))) }
                settle()
                return@launch
            }
            store.setPrinter(saved)
            _state.update { it.copy(choosing = null) }
            startChecks(saved)
        }
    }

    /** A printer is being chosen ([key] names it in `choosing`): what was shown for the last one goes. */
    private fun beginChoosing(key: String) {
        cancelChecks()
        pairingRetry = null
        rescanWhenReady = false
        relinkWhenReady = false
        _state.update {
            // The test label sheet's message goes with what it offered (a fix button, Connect).
            it.copy(choosing = key, chooseError = null, checks = emptyList(), checking = false, fontFix = null, damagedFonts = emptyList(),
                fontMessage = null, peeler = null, testMessage = null, testError = false, bluetoothMessage = null, bluetoothUnavailable = null,
                pairingLost = null)
        }
    }

    // --- Bluetooth -------------------------------------------------------------------------

    /** The Bluetooth card (and Scan again): Bluetooth mode, then [ask] for the [missing]
     *  permissions (the screen's prompt, whose answer comes back to [scanBluetooth]) or, with none
     *  missing, a scan. A device without Bluetooth LE is never asked: its scan says so at once. */
    fun pickBluetooth(missing: List<String>, ask: () -> Unit) {
        if (_state.value.busy || _state.value.checking) return
        _state.update { it.copy(findMode = FindMode.BLUETOOTH) }
        if (missing.isNotEmpty() && bluetooth.availability.value != BluetoothAvailability.UNSUPPORTED) ask() else scanBluetooth()
    }

    /** Bluetooth mode, and a scan of the printers nearby. [permitted] is false when the screen's
     *  permission prompt came back refused (precise location included: on API 31+ the link reads
     *  READY without it, but Android then hides what a scan hears): it says so without scanning,
     *  and stays so until the permissions are allowed. */
    fun scanBluetooth(permitted: Boolean = true) {
        if (_state.value.checking) {
            // The prompt's answer isn't dropped: it applies once the checks end.
            pendingPermission = permitted
            return
        }
        _state.update { it.copy(findMode = FindMode.BLUETOOTH) }
        promptRefused = !permitted
        if (!permitted) {
            endBluetoothScan()
            pairingRetry = null
            rescanWhenReady = false
            _state.update {
                it.withoutConnectOffer().copy(bluetoothMessage = BLUETOOTH_DENIED_TEXT, bluetoothUnavailable = BluetoothAvailability.UNAUTHORIZED)
            }
            return
        }
        bluetooth.refreshAvailability()
        startBluetoothScan()
    }

    /** Stop: the scan ends, and what it heard stays listed. */
    fun stopBluetoothScan() {
        bluetooth.stopScan()
    }

    /** The screen showing (the first time: [open], which warms the saved Bluetooth printer's link),
     *  or come back to the front (from Settings, say). Android sends nothing when a permission is
     *  granted, so Bluetooth is read again. Back with the link's refusal showing (Bluetooth off or
     *  not allowed on open), it connects again. A refused prompt is lifted once the permissions are
     *  [permitted], and its scan runs; until then nothing scans, whatever the link reads (the
     *  link's own refusals run again when it reads READY). */
    fun appResumed(permitted: Boolean) {
        bluetooth.refreshAvailability()
        if (!opened) {
            open()
        } else if (linkRefusalShowing) {
            connectSavedPrinter()
        }
        if (!permitted || !promptRefused) return
        promptRefused = false
        val s = _state.value
        if (s.findMode == FindMode.BLUETOOTH && bluetooth.availability.value == BluetoothAvailability.READY &&
            !s.bluetoothScanning && !s.busy && !s.checking
        ) {
            startBluetoothScan()
        } else {
            rescanWhenReady = true
        }
    }

    /** Lists what the scan hears until it ends (30 s of a ready Bluetooth, Stop, Bluetooth refused,
     *  Android not scanning, or another Bluetooth call taking the radio), then says why nothing is
     *  listed: Bluetooth's refusal; no Zebra heard, only after its full 30 s (counted once Bluetooth
     *  was ready, not from the tap) or Stop; or Android wouldn't scan (`lastScanEnd`). One ended by
     *  the screen (another mode, a choice) says nothing. */
    private fun startBluetoothScan() {
        var started = false
        _state.update {
            started = false
            if (it.bluetoothScanning) {
                it
            } else {
                started = true
                it.withoutConnectOffer().copy(bluetoothScanning = true, bluetoothFound = emptyList(), bluetoothMessage = null, bluetoothUnavailable = null)
            }
        }
        if (!started) return
        pairingRetry = null
        rescanWhenReady = false
        val run = bluetoothScanRun.incrementAndGet()
        bluetoothScanJob = scope.launch {
            try {
                bluetooth.scan().collect { found -> if (run == bluetoothScanRun.get()) _state.update { it.copy(bluetoothFound = found) } }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w(TAG, "Bluetooth scan failed", e)
            }
            if (run != bluetoothScanRun.get()) return@launch
            val availability = bluetooth.availability.value
            val refused = bluetoothUnavailableText(availability)
            val end = bluetooth.lastScanEnd
            if (refused != null) rescanWhenReady = true
            _state.update {
                when {
                    refused != null -> it.copy(bluetoothScanning = false, bluetoothUnavailable = availability, bluetoothMessage = refused)
                    end == BluetoothScanEnd.FAILED -> it.copy(bluetoothScanning = false, bluetoothMessage = SCAN_ENDED_EARLY_TEXT)
                    it.bluetoothZebras.isEmpty() && (end == BluetoothScanEnd.FINISHED || end == BluetoothScanEnd.STOPPED) ->
                        it.copy(bluetoothScanning = false, bluetoothMessage = NO_BLUETOOTH_PRINTERS_TEXT)
                    else -> it.copy(bluetoothScanning = false)
                }
            }
        }
    }

    /** Connect (what [pairingRetry] holds) goes, so whatever offered it goes with it: the pairing-lost
     *  steps above the checks and the test label sheet's (a Connect that would do nothing). */
    private fun PrinterSetupUi.withoutConnectOffer(): PrinterSetupUi {
        val sheetOffer = testError && bluetoothFixFor(testMessage) == BluetoothFix.FORGET
        return copy(pairingLost = null, testMessage = if (sheetOffer) null else testMessage, testError = testError && !sheetOffer)
    }

    /** The scan stops quietly, keeping its list (the screen moved on). */
    private fun endBluetoothScan() {
        val job = bluetoothScanJob ?: return
        bluetoothScanJob = null
        bluetoothScanRun.incrementAndGet()
        job.cancel()
        _state.update { it.copy(bluetoothScanning = false) }
    }

    /** Another way to find a printer was picked: the Bluetooth scan stops, and its message goes. */
    private fun leaveBluetooth() {
        endBluetoothScan()
        rescanWhenReady = false
        _state.update { it.copy(bluetoothMessage = null, bluetoothUnavailable = null) }
    }

    /**
     * Saves the Bluetooth printer [found] picked from the list (D9), then checks it: connects to the
     * address picked with no serial (a renamed printer's Bluetooth name isn't its serial, so it
     * would be refused as a mismatch), asks `~HI` under the lock and the guard, and saves it by
     * Device Information's serial and the address picked. A device that reports no serial is
     * refused ([NO_BLUETOOTH_SERIAL_TEXT]): it couldn't be found, or confirmed, again by it. The
     * address the link came up at is never saved: one found by a scan for the serial could be
     * another device's. A choice that fails or is left after the link came up lets that printer go
     * unless it is the saved one, so an unsaved printer isn't held from other devices.
     */
    fun chooseBluetooth(found: FoundBluetoothPrinter) {
        if (_state.value.busy) return
        endBluetoothScan()
        beginChoosing(found.address)
        scope.launch {
            var linked = false
            var serial: String? = null
            val saved = try {
                val info = bluetooth.connect(found.address, null)
                linked = true
                val s = info.serial?.takeIf { it.isNotBlank() } ?: throw NoBluetoothSerial()
                serial = s
                val connection = PrinterConnection.Bluetooth(s, found.address)
                // Addresses the printer for its `~HI`; what is saved is built from the answers.
                val id = unsavedPrinterAt(SavedPrinter(connection, DEFAULT_MODEL, s, 0)).identify()
                SavedPrinter(connection, id.model.ifBlank { DEFAULT_MODEL }, s, id.dpi)
            } catch (e: CancellationException) {
                if (linked) letGoUnlessSaved(serial, settings.value?.printer)
                throw e
            } catch (e: Exception) {
                if (linked) letGoUnlessSaved(serial, store.settings.first().printer)
                when (val refusal = bluetoothRefusal(e)) {
                    is BluetoothPairingLost -> {
                        // Android's Connected devices lists the printer by its Bluetooth name.
                        pairingRetry = PairingRetry.Choose(found)
                        _state.update { it.copy(choosing = null, pairingLost = pairingLostText(found.name)) }
                    }
                    is BluetoothUnavailable -> {
                        rescanWhenReady = true
                        _state.update {
                            it.copy(choosing = null, bluetoothUnavailable = refusal.availability, bluetoothMessage = bluetoothUnavailableText(refusal.availability))
                        }
                    }
                    else -> {
                        android.util.Log.w(TAG, "Bluetooth printer not chosen", e)
                        val text = when (e) {
                            is NoBluetoothSerial -> NO_BLUETOOTH_SERIAL_TEXT
                            is BluetoothNotZebra -> notAZebraText(found.name)
                            else -> noZebraAnswerText(PrinterConnection.Bluetooth(serial ?: found.name))
                        }
                        _state.update { it.copy(choosing = null, chooseError = text) }
                    }
                }
                settle()
                return@launch
            }
            store.setPrinter(saved)
            _state.update { it.copy(choosing = null) }
            startChecks(saved)
        }
    }

    /** A printer brought up to be chosen, then not saved, is let go; the [saved] printer's link stays
     *  (Print Labels uses it). */
    private fun letGoUnlessSaved(serial: String?, saved: SavedPrinter?) {
        val savedSerial = (saved?.connection as? PrinterConnection.Bluetooth)?.serial
        if (serial == null || savedSerial == null || !savedSerial.equals(serial, ignoreCase = true)) bluetooth.close()
    }

    /** Connect, beside the pairing-lost steps (once the printer is forgotten in Android Settings):
     *  the same choice again, or the saved printer's checks. */
    fun connectAgain() {
        when (val retry = pairingRetry) {
            is PairingRetry.Choose -> chooseBluetooth(retry.printer)
            PairingRetry.Check -> checkAgain()
            null -> Unit
        }
    }

    /** Notes a Bluetooth refusal of a call to the saved [printer] (Bluetooth off or not allowed, or
     *  the printer forgot this device, which Connect then checks again) and returns what to say;
     *  null for any other failure. */
    private fun noteRefusal(e: Throwable, printer: SavedPrinter): String? = when (val refusal = bluetoothRefusal(e)) {
        is BluetoothUnavailable -> bluetoothUnavailableText(refusal.availability)?.also {
            _state.update { s -> s.copy(bluetoothUnavailable = refusal.availability) }
        }
        is BluetoothPairingLost -> {
            val serial = (printer.connection as? PrinterConnection.Bluetooth)?.serial ?: printer.serial
            pairingLostText(serial).also { text ->
                pairingRetry = PairingRetry.Check
                _state.update { it.copy(pairingLost = text) }
            }
        }
        else -> null
    }

    // --- the checks ------------------------------------------------------------------------

    fun checkAgain() {
        if (_state.value.busy) return
        scope.launch { store.settings.first().printer?.let { startChecks(it) } }
    }

    /** The check run going (if any) is canceled: it no longer writes its ending (iOS's `cancelChecks`). */
    private fun cancelChecks(): Int {
        checksJob?.cancel()
        return checkRun.incrementAndGet()
    }

    private fun startChecks(printer: SavedPrinter, keepFontMessage: Boolean = false) {
        val run = cancelChecks()
        // A check query would end a Bluetooth scan without a word: the scan stops first.
        endBluetoothScan()
        checksJob = scope.launch { runChecks(printer, keepFontMessage, run) }
    }

    private fun put(row: CheckRow) = _state.update { s ->
        val rows = s.checks.filter { it.key != row.key } + row
        s.copy(checks = rows.sortedBy { it.key.ordinal })
    }

    /** [run]: this run's number; a run canceled or replaced since ends without writing its ending
     *  or settling (the newer run, or what canceled it, owns the screen now). */
    private suspend fun runChecks(saved: SavedPrinter, keepFontMessage: Boolean, run: Int) {
        pairingRetry = null
        relinkWhenReady = false
        // The check says Bluetooth's state in its own row: the link's message from opening goes.
        val linkMessageShowing = linkRefusalShowing
        _state.update {
            it.copy(checks = emptyList(), checking = true, fontFix = null, damagedFonts = emptyList(), peeler = null,
                fontMessage = if (keepFontMessage) it.fontMessage else null, fontError = keepFontMessage && it.fontError,
                bluetoothMessage = if (linkMessageShowing) null else it.bluetoothMessage,
                bluetoothUnavailable = null, pairingLost = null)
        }
        try {
            val zebra = printerAt(saved)
            put(CheckRow(CheckKey.ANSWERS, CheckState.RUNNING))
            var failure: Exception? = null
            val id = try {
                zebra.identify()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e
                null
            }
            if (id == null) {
                // Bluetooth off or not allowed says so here; a printer that forgot this device gets
                // the steps above the checks.
                val refusal = failure?.let(::bluetoothRefusal)
                // Bluetooth off or not allowed: once it can be used, this row goes and the link warms
                // up again (set before the row shows, so a READY that lands meanwhile isn't missed).
                if (refusal is BluetoothUnavailable && bluetoothUnavailableText(refusal.availability) != null) relinkWhenReady = true
                val refused = failure?.let { noteRefusal(it, saved) }
                // Still waiting for the rest of a font: it needs the restart.
                val cut = printerGuard.state(saved.connection) == PrinterGuard.State.FONT_CUT
                val detail = when {
                    refusal is BluetoothUnavailable && refused != null -> refused
                    cut -> FONT_INSTALL_CUT_TEXT
                    else -> noZebraAnswerText(saved.connection)
                }
                put(CheckRow(CheckKey.ANSWERS, CheckState.FAIL, detail))
                return
            }
            put(CheckRow(CheckKey.ANSWERS, CheckState.OK, "${id.model} · ${id.dpi} DPI"))
            var printer = saved
            val model = id.model.ifBlank { DEFAULT_MODEL }
            if (id.dpi != saved.dpi || model != saved.model) {
                // Another printer took this address: its DPI picks the template (the builder rebuilds).
                printer = SavedPrinter(saved.connection, model, quietly { zebra.serial() }.orEmpty(), id.dpi)
                store.setPrinter(printer)
            }

            put(CheckRow(CheckKey.DPI, CheckState.RUNNING))
            val kind = store.settings.first().kind
            // Unsynced, no build will pick a template: don't wait for one.
            val picked = if (synced()) awaitPick(kind, printer.dpi) else PickWait.Unsynced
            put(dpiRow(picked, kind, printer.dpi))

            put(CheckRow(CheckKey.STATUS, CheckState.RUNNING))
            val status = quietly { zebra.status() }
            val problems = status?.let(::statusProblems)
            put(when {
                problems == null -> CheckRow(CheckKey.STATUS, CheckState.FAIL, "Couldn't read the printer's status.")
                problems.isEmpty() -> CheckRow(CheckKey.STATUS, CheckState.OK)
                else -> CheckRow(CheckKey.STATUS, CheckState.FAIL, problems.joinToString(" "))
            })

            put(CheckRow(CheckKey.PEELER, CheckState.RUNNING))
            val peeler = quietly { zebra.peelerPresent() }
            _state.update { it.copy(peeler = peeler) }
            // Peel-off on a printer without a peeler would hold every label: print tear-off.
            if (peeler == false && store.settings.first().peel) store.setPeel(false)
            put(CheckRow(CheckKey.PEELER, CheckState.OK, peelerDetail(peeler, store.settings.first().peel)))

            put(CheckRow(CheckKey.FONTS, CheckState.RUNNING))
            put(fontsRow(zebra, (picked as? PickWait.Got)?.pick))
        } finally {
            if (run == checkRun.get()) {
                _state.update {
                    // The printer no longer says it forgot this device: the test label sheet's steps go.
                    val stale = it.pairingLost == null && it.testError && bluetoothFixFor(it.testMessage) == BluetoothFix.FORGET
                    it.copy(
                        checking = false, checkRuns = it.checkRuns + 1,
                        testMessage = if (stale) null else it.testMessage, testError = if (stale) false else it.testError,
                    )
                }
                settle()
            }
        }
    }

    private sealed interface PickWait {
        data class Got(val pick: LabelPick) : PickWait
        data object Unsupported : PickWait
        data object Unknown : PickWait
        data object Unsynced : PickWait
    }

    /** The kiosk has the move's label data (the label build's own precondition). */
    private suspend fun synced(): Boolean =
        Sync.readMeta(db) != null && db.meta().get(LABEL_CONTEXT_META_KEY) != null

    /** The builder's pick for [kind] at [dpi]: a DPI just saved waits for the build it starts. */
    private suspend fun awaitPick(kind: LabelKind, dpi: Int): PickWait = withTimeoutOrNull(pickWaitMs) {
        combine(pick, build) { p, s ->
            when {
                s.phase == LabelBuildPhase.UNSUPPORTED_DEVICE -> PickWait.Unsupported
                p != null && p.kind == kind && p.dpi == dpi -> PickWait.Got(p)
                else -> null
            }
        }.filterNotNull().first()
    } ?: PickWait.Unknown

    private fun dpiRow(picked: PickWait, kind: LabelKind, dpi: Int): CheckRow = when (picked) {
        PickWait.Unsupported -> CheckRow(CheckKey.DPI, CheckState.WARN, DEVICE_UNSUPPORTED_TEXT)
        PickWait.Unknown -> CheckRow(CheckKey.DPI, CheckState.WARN, TEMPLATES_UNKNOWN_TEXT)
        PickWait.Unsynced -> CheckRow(CheckKey.DPI, CheckState.WARN, SYNC_TO_CHECK_TEXT)
        is PickWait.Got -> {
            val p = picked.pick
            when {
                !p.synced -> CheckRow(CheckKey.DPI, CheckState.WARN, SYNC_TO_CHECK_TEXT)
                p.failed -> CheckRow(CheckKey.DPI, CheckState.WARN, BUILD_FAILED_TEXT)
                p.templateId != null -> CheckRow(CheckKey.DPI, CheckState.OK, p.templateName ?: "$dpi DPI", p.notes)
                else -> CheckRow(CheckKey.DPI, CheckState.WARN, noTemplateText(kind, dpi, p.availableDpis), p.notes)
            }
        }
    }

    private suspend fun fontsRow(zebra: SetupZebra, pick: LabelPick?): CheckRow {
        if (pick == null || !pick.synced || pick.failed) return CheckRow(CheckKey.FONTS, CheckState.WARN, FONTS_UNCHECKED_TEXT)
        val needed = pick.fonts.map { it.uppercase() }.distinct()
        if (needed.isEmpty()) return CheckRow(CheckKey.FONTS, CheckState.OK, "No printer fonts needed.")
        val onPrinter = quietly { zebra.fontEntries() }
            ?: return CheckRow(CheckKey.FONTS, CheckState.FAIL, "Couldn't read the fonts on the printer.")
        val library = db.labelFonts().all().map { KioskLabelFont(it.id, it.name, it.size, it.resident) }
        val missing = missingFonts(needed, onPrinter.map { it.name })
        // A download cut short leaves a smaller file under the right name: sending it again
        // overwrites it.
        val damaged = damagedFonts(needed, library, onPrinter)
        if (missing.isEmpty() && damaged.isEmpty()) return CheckRow(CheckKey.FONTS, CheckState.OK)
        val fix = fontFixFor(missing + damaged, library)
        _state.update { it.copy(fontFix = fix, damagedFonts = damaged) }
        val others = missing.filter { it !in fix.builtIn }
        val detail = listOfNotNull(
            others.takeIf { it.isNotEmpty() }?.let { "Missing: ${it.joinToString(", ")}." },
            damaged.takeIf { it.isNotEmpty() }?.let { "Damaged: ${it.joinToString(", ")} (reinstall)." },
            fix.builtIn.takeIf { it.isNotEmpty() }?.let(::builtInFontText),
        ).joinToString(" ")
        return CheckRow(CheckKey.FONTS, CheckState.FAIL, detail)
    }

    /** Sends each missing or damaged font the library has (its synced file), then checks again
     *  after the printer has had [FONT_SETTLE_MS] to file them. The first failure stops the
     *  installs; one that cut a font off says to restart the printer and checks nothing (the
     *  printer is waiting for the rest of the font). Leaving the screen stops it like Cancel: the
     *  font going out finishes ([LockedZebra] never cuts one) and the next never starts. */
    fun installFonts() {
        val fix = _state.value.fontFix ?: return
        if (_state.value.busy || fix.installable.isEmpty()) return
        installCanceled = false
        installRate = null
        _state.update { it.copy(installing = true, installStopping = false, fontMessage = null, fontError = false) }
        scope.launch {
            val printer = store.settings.first().printer
            if (printer == null) {
                _state.update { it.copy(installing = false, installStopping = false) }
                return@launch
            }
            val zebra = printerAt(printer)
            var failed: String? = null
            var cut = false
            var stopped = false
            val files = db.labelFonts().all().associateBy { it.name.uppercase() }
            // Each font's size (the library's), for the time left across the fonts still to send.
            val sizes = fix.installable.map { (files[it.name.uppercase()]?.size ?: 0).coerceAtLeast(0).toLong() }
            try {
                for ((index, font) in fix.installable.withIndex()) {
                    if (installCanceled || !isActive) {
                        stopped = true
                        break
                    }
                    val name = font.name.uppercase()
                    _state.update { it.copy(installFont = InstallingFont(name, index + 1, fix.installable.size)) }
                    try {
                        val file = files[name]?.fileName?.let { File(fontsDir, it) } ?: throw IOException("no file for $name")
                        val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                        zebra.installFont(name, bytes, fontStarted(bytesAfter = sizes.drop(index + 1).sum(), overBluetooth = printer.isBluetooth))
                        fontFinished()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        android.util.Log.w(TAG, "font install failed: $name", e)
                        failed = name
                        cut = printerGuard.state(printer.connection) == PrinterGuard.State.FONT_CUT
                        break
                    }
                }
            } finally {
                fontsDone()
            }
            // The screen closed: nothing more is sent or checked.
            if (!isActive) return@launch
            if (cut) {
                _state.update { it.copy(installing = false, installStopping = false, fontMessage = FONT_INSTALL_CUT_TEXT, fontError = true) }
                settle()
                return@launch
            }
            delay(FONT_SETTLE_MS)
            _state.update {
                it.copy(
                    installing = false,
                    installStopping = false,
                    // Stopped before the rest: the check shows what is still missing.
                    fontMessage = failed?.let(::fontInstallFailedText) ?: if (stopped) null else FONTS_INSTALLED_TEXT,
                    fontError = failed != null,
                )
            }
            // Fonts sent before a failure still turn green; the message stays.
            startChecks(printer, keepFontMessage = true)
        }
    }

    /** Stops a font install after the font going out: a download announces its size, so cutting
     *  one would leave the printer taking whatever comes next as font data (D8). */
    fun cancelInstall() {
        if (!_state.value.installing) return
        installCanceled = true
        _state.update { it.copy(installStopping = true) }
    }

    /** A font starts going out ([bytesAfter]: the fonts still to send after it): its progress from
     *  0, and the callback its install reports through (from any thread; a report for a font that
     *  is done, or behind a newer one, is dropped). */
    private fun fontStarted(bytesAfter: Long, overBluetooth: Boolean): WriteProgress {
        val id = ++fontsStarted
        fontGoingOut.set(FontGoingOut(id, bytesAfter, overBluetooth))
        _state.update { it.copy(installProgress = 0f, installEta = null) }
        return { sent, total -> fontProgressed(id, sent, total) }
    }

    /** The time left covers this font's bytes still to go and every font after it. It is reckoned
     *  from the font's first report, when its bytes start moving (the wait for the printer lock and
     *  a `~JX` before it aren't install time), at the speed measured since then once that has run
     *  [ETA_MEASURE_AFTER_MS] and moved [ETA_MEASURE_AFTER_BYTES]; until then at the speed an
     *  earlier font of this install measured, else a Bluetooth install guesses
     *  [INSTALL_BYTES_PER_SECOND] and a network install shows none ([guessedRate], iOS's rule). */
    private fun fontProgressed(id: Int, sent: Long, total: Long) {
        val now = nanoTime()
        val going = fontGoingOut.get()
        if (going == null || going.id != id || total <= 0) return
        val fraction = (sent.toDouble() / total).coerceIn(0.0, 1.0).toFloat()
        val first = going.firstReport ?: FirstReport(now, sent).also { going.firstReport = it }
        val elapsedMs = (now - first.atNs) / 1e6
        val moved = sent - first.sent
        if (elapsedMs >= ETA_MEASURE_AFTER_MS && moved >= ETA_MEASURE_AFTER_BYTES) installRate = moved / (elapsedMs / 1_000)
        val eta = guessedRate(going)?.let { installEtaText(total - sent + going.bytesAfter, it) }
        _state.update { s ->
            if (fontGoingOut.get()?.id != id || fraction < (s.installProgress ?: 0f)) s else s.copy(installProgress = fraction, installEta = eta)
        }
    }

    /** The speed measured so far in this install, else Bluetooth's measured 3.9 KB/s (a network
     *  install has no guess). */
    private fun guessedRate(going: FontGoingOut): Double? = installRate ?: INSTALL_BYTES_PER_SECOND.takeIf { going.overBluetooth }

    /** The font's install returned: all of it went out (the time left is the fonts after it). */
    private fun fontFinished() {
        val going = fontGoingOut.get()
        val eta = going?.let { g -> guessedRate(g)?.let { rate -> installEtaText(g.bytesAfter, rate) } }
        _state.update { it.copy(installProgress = 1f, installEta = eta) }
    }

    private fun fontsDone() {
        fontGoingOut.set(null)
        _state.update { it.copy(installProgress = null, installEta = null, installFont = null) }
    }

    // --- offsets and peel -------------------------------------------------------------------

    fun setOffsetX(text: String) = editOffsets { it.copy(offsetXText = text) }

    fun setOffsetY(text: String) = editOffsets { it.copy(offsetYText = text) }

    /** The fields as saved numbers: clamped to the allowed range; text that isn't a number keeps
     *  the saved value. */
    private fun offsets(ui: PrinterSetupUi = _state.value): Pair<Int, Int> {
        val saved = settings.value
        return (parseOffset(ui.offsetXText) ?: saved?.offsetX ?: 0) to (parseOffset(ui.offsetYText) ?: saved?.offsetY ?: 0)
    }

    private fun editOffsets(change: (PrinterSetupUi) -> PrinterSetupUi) {
        offsetsTouched = true
        _state.update(change)
        val next = offsets()
        pendingOffsets = next
        offsetsJob?.cancel()
        offsetsJob = scope.launch {
            delay(OFFSET_SAVE_DELAY_MS)
            saveOffsets(next)
        }
    }

    private suspend fun saveOffsets(next: Pair<Int, Int>) {
        store.setOffsets(next.first, next.second)
        if (pendingOffsets == next) pendingOffsets = null
    }

    /** Shows the fields as the numbers that are saved (a clamped or unreadable entry). */
    fun tidyOffsets() {
        val (x, y) = offsets()
        _state.update { it.copy(offsetXText = x.toString(), offsetYText = y.toString()) }
    }

    fun setPeel(peel: Boolean) {
        if (peel && !_state.value.peelAllowed) return
        scope.launch {
            store.setPeel(peel)
            // The Peeler row says how labels print.
            _state.update { s ->
                s.copy(checks = s.checks.map {
                    if (it.key == CheckKey.PEELER && it.state == CheckState.OK) it.copy(detail = peelerDetail(s.peeler, peel)) else it
                })
            }
        }
    }

    // --- test labels --------------------------------------------------------------------------

    fun alignmentSize(s: LabelSettings?): AlignmentSize? = s?.printer?.let { alignmentSizeFor(s.kind, it.dpi, pick.value) }

    /** Sends [which] to the saved printer with the offsets in the fields and the saved print mode. */
    fun printTest(which: TestLabel) {
        if (_state.value.busy) return
        val offsets = offsets()
        _state.update { it.copy(testing = true, testMessage = null, testError = false) }
        scope.launch {
            offsetsJob?.cancel()
            saveOffsets(offsets)
            val s = store.settings.first()
            val printer = s.printer
            if (printer == null) {
                _state.update { it.copy(testing = false) }
                return@launch
            }
            val (message, error) = try {
                val label = when (which) {
                    TestLabel.ALIGNMENT -> {
                        val size = alignmentSizeFor(s.kind, printer.dpi, pick.value)
                        parseZpl(helper("alignmentTestZpl", LabelGenArgs.alignment(size.widthDots, size.heightDots, size.label, printer.dpi))) to
                            "Alignment label (${size.label}) sent to the printer."
                    }
                    TestLabel.SAMPLE -> {
                        val templates = LabelGenArgs.templatesBody(db.labelTemplates().all().map { it.json })
                        val sample = parseSample(helper("sampleLabel", LabelGenArgs.sample(templates, s.kind, printer.dpi)))
                        val name = pick.value?.takeIf { it.kind == s.kind && it.dpi == printer.dpi }?.templateName
                        sample.zpl?.let { it to (if (name != null) "Sample label ($name) sent to the printer." else "Sample label sent to the printer.") }
                            ?: (null to sampleRefusedText(sample.reason))
                    }
                }
                val zpl = label.first
                if (zpl == null) {
                    label.second to true
                } else {
                    val shifted = parseZpl(helper("applyPrintSettings", LabelGenArgs.printSettings(zpl, offsets.first, offsets.second)))
                    printerAt(printer).send(parseZpl(helper("withPrintMode", LabelGenArgs.printMode(shifted, s.peel))))
                    label.second to false
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: LabelEngineUnsupportedException) {
                DEVICE_UNSUPPORTED_TEXT to true
            } catch (e: PrinterNeedsRestart) {
                FONT_INSTALL_CUT_TEXT to true
            } catch (e: PrinterException) {
                // Bluetooth off or not allowed, or a printer that forgot this device: what to do (the
                // screen keeps the forget-it steps, with Connect, once the sheet closes).
                val text = noteRefusal(e, printer) ?: if (e is PrinterTimeout) TEST_TIMEOUT_TEXT else printerUnreachableText(printer)
                text to true
            } catch (e: Exception) {
                android.util.Log.w(TAG, "test label failed", e)
                TEST_FAILED_TEXT to true
            }
            _state.update { it.copy(testing = false, testMessage = message, testError = error) }
            settle()
        }
    }

    /** The helpers share the generator with the label build: one can time out right after a
     *  cancelled build while the sandbox restarts, so it is asked once more. */
    private suspend fun helper(fn: String, args: String): String = try {
        engine.call(fn, args)
    } catch (e: LabelEngineTimeoutException) {
        engine.call(fn, args)
    }

    override fun onCleared() {
        // An offsets edit still waiting for its save is kept.
        pendingOffsets?.let { next -> saveScope?.launch { store.setOffsets(next.first, next.second) } }
        super.onCleared()
    }

    private suspend fun <T> quietly(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    companion object {
        private const val TAG = "PrinterSetup"
        private const val DEFAULT_MODEL = "Zebra"
        /** How long a printer gets to file a downloaded font before the re-check (PrinterStep's). */
        const val FONT_SETTLE_MS = 500L
        /** A font's measured speed is trusted (and the time left shown) once its bytes have been
         *  moving this long and [ETA_MEASURE_AFTER_BYTES] have gone: about 4 s of Bluetooth at the
         *  ZD421's 3.9 KB/s, so the first few acknowledged chunks (and the pause before them) don't
         *  swing the estimate. */
        const val ETA_MEASURE_AFTER_MS = 1_000L
        const val ETA_MEASURE_AFTER_BYTES = 16_384L
        /** A Bluetooth install's guess until it measures its own speed: the ZD421's 3.9 KB/s over
         *  Bluetooth (iOS's `INSTALL_BYTES_PER_SECOND`). A network install guesses nothing. */
        const val INSTALL_BYTES_PER_SECOND = 3_900.0
        const val OFFSET_SAVE_DELAY_MS = 500L
        /** How long the DPI check waits for the build a DPI change starts to pick a template. */
        const val PICK_WAIT_MS = 30_000L
        const val OFFSET_LIMIT = 9_999

        const val TEMPLATES_UNKNOWN_TEXT = "Couldn't read the move's label templates. Check again in a moment."
        const val SYNC_TO_CHECK_TEXT = "Sync this kiosk to check its label templates."
        const val FONTS_UNCHECKED_TEXT = "Fonts can't be checked until the move's label templates are known."
        const val TEST_TIMEOUT_TEXT = "The printer didn't take the test label in time."
        const val TEST_FAILED_TEXT = "Couldn't make the test label. Try again."

        /** A whole number of dots, clamped to ±[OFFSET_LIMIT]; null when [text] isn't one. */
        fun parseOffset(text: String): Int? =
            text.trim().toBigIntegerOrNull()?.coerceIn((-OFFSET_LIMIT).toBigInteger(), OFFSET_LIMIT.toBigInteger())?.toInt()

        /** Why there's no sample label: the generator's pick notes, or an outcome code. */
        fun sampleRefusedText(reason: String?): String = when (reason) {
            NO_TEMPLATE_AT_DPI -> "This move has no template at this printer's DPI."
            TEMPLATE_FAILED -> "The label template couldn't be built."
            TEMPLATE_UNSUPPORTED -> NEEDS_UPDATE_TEXT
            null, "" -> "No sample label for this printer."
            else -> reason
        }
    }
}

/** A Bluetooth device whose Device Information gave no serial: it couldn't be found again by it. */
private class NoBluetoothSerial : Exception("The Bluetooth device reported no serial number")

/** What Connect, beside the pairing-lost steps, tries again: choosing that Bluetooth printer, or
 *  the saved printer's checks. */
private sealed interface PairingRetry {
    data class Choose(val printer: FoundBluetoothPrinter) : PairingRetry
    data object Check : PairingRetry
}
