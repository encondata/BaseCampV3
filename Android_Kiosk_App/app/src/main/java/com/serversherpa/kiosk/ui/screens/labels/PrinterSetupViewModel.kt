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
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.labels.TEMPLATE_FAILED
import com.serversherpa.kiosk.core.labels.TEMPLATE_UNSUPPORTED
import com.serversherpa.kiosk.core.labels.parseSample
import com.serversherpa.kiosk.core.labels.parseZpl
import com.serversherpa.kiosk.core.labels.printerUnreachableText
import com.serversherpa.kiosk.core.model.KioskLabelFont
import com.serversherpa.kiosk.core.printer.FontFix
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.builtInFontText
import com.serversherpa.kiosk.core.printer.fontFixFor
import com.serversherpa.kiosk.core.printer.isIpv4
import com.serversherpa.kiosk.core.printer.missingFonts
import com.serversherpa.kiosk.core.printer.noTemplateText
import com.serversherpa.kiosk.core.printer.statusProblems
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelEngineTimeoutException
import com.serversherpa.kiosk.data.labels.LabelEngineUnsupportedException
import com.serversherpa.kiosk.data.labels.LabelSettingsStore
import com.serversherpa.kiosk.data.printer.FoundPrinter
import com.serversherpa.kiosk.data.printer.NetworkZebra
import com.serversherpa.kiosk.data.printer.PrinterException
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.sync.Sync
import java.io.File
import java.io.IOException
import kotlin.math.roundToInt
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** One Zebra, as Printer Setup talks to it: [NetworkZebra] on the device. */
interface SetupZebra {
    suspend fun identify(): HostId
    suspend fun serial(): String?
    suspend fun status(): HostStatus
    suspend fun peelerPresent(): Boolean?
    suspend fun fonts(): List<String>
    suspend fun send(zpl: String)
    suspend fun installFont(name: String, bytes: ByteArray)
}

/** [NetworkZebra] as a [SetupZebra]. */
class NetworkSetupZebra(private val zebra: NetworkZebra) : SetupZebra {
    override suspend fun identify() = zebra.identify()
    override suspend fun serial() = zebra.serial()
    override suspend fun status() = zebra.status()
    override suspend fun peelerPresent() = zebra.peelerPresent()
    override suspend fun fonts() = zebra.fonts()
    override suspend fun send(zpl: String) = zebra.send(zpl)
    override suspend fun installFont(name: String, bytes: ByteArray) = zebra.installFont(name, bytes)
}

/** [inner] with every call made under [lock]: one connection to the printer at a time. */
private class LockedZebra(private val inner: SetupZebra, private val lock: Mutex) : SetupZebra {
    override suspend fun identify() = lock.withLock { inner.identify() }
    override suspend fun serial() = lock.withLock { inner.serial() }
    override suspend fun status() = lock.withLock { inner.status() }
    override suspend fun peelerPresent() = lock.withLock { inner.peelerPresent() }
    override suspend fun fonts() = lock.withLock { inner.fonts() }
    override suspend fun send(zpl: String) = lock.withLock { inner.send(zpl) }
    override suspend fun installFont(name: String, bytes: ByteArray) = lock.withLock { inner.installFont(name, bytes) }
}

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

data class PrinterSetupUi(
    val scanning: Boolean = false,
    /** Null until a scan finishes. */
    val found: List<FoundPrinter>? = null,
    val scanMessage: String? = null,
    val ipText: String = "",
    /** The host being identified and saved. */
    val choosing: String? = null,
    val chooseError: String? = null,
    val checks: List<CheckRow> = emptyList(),
    val checking: Boolean = false,
    /** How many check runs have finished. */
    val checkRuns: Int = 0,
    val fontFix: FontFix? = null,
    val installing: Boolean = false,
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
}

const val NO_PRINTERS_FOUND_TEXT = "No Zebra printers found on this network."
const val SCAN_FAILED_TEXT = "Couldn't scan the network."
const val INVALID_IP_TEXT = "That isn't a valid IP address."
const val NO_PEELER_TEXT = "This printer has no peeler."
const val FONTS_INSTALLED_TEXT = "Fonts installed."
fun noZebraAnswerText(host: String) = "No Zebra printer answered at $host."
fun fontInstallFailedText(name: String) = "Couldn't install $name."

/**
 * Printer Setup (the laptop's PrinterStep, kiosk/src/components/setup/PrinterStep.tsx): pick a
 * network Zebra (a scan or a typed IP), check it, install missing fonts, print test labels, and
 * set the offsets and peel/tear. Choosing a printer saves it; the label builder rebuilds by itself
 * when its DPI changes, and offsets and peel never rebuild (they apply at send time).
 *
 * The checks inform and never block. The DPI and font checks read the builder's own template pick
 * for the saved printer ([pick]), waiting for the build a DPI change starts.
 */
class PrinterSetupViewModel(
    private val store: LabelSettingsStore,
    private val pick: StateFlow<LabelPick?>,
    private val build: StateFlow<LabelBuildStatus>,
    private val engine: LabelEngine,
    private val db: KioskDatabase,
    private val fontsDir: File,
    private val scanner: suspend () -> List<FoundPrinter>,
    zebraAt: (host: String) -> SetupZebra,
    scopeOverride: CoroutineScope? = null,
    /** Finishes an offsets save that is still waiting when the screen closes. */
    private val saveScope: CoroutineScope? = null,
    private val pickWaitMs: Long = PICK_WAIT_MS,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(PrinterSetupUi())
    val state: StateFlow<PrinterSetupUi> = _state
    /** Null until the settings are first read. */
    val settings: StateFlow<LabelSettings?> = store.settings.stateIn(scope, SharingStarted.Eagerly, null)
    val currentPick: StateFlow<LabelPick?> = pick

    /** Every printer call (checks, font installs, test labels) takes this lock, so a test label
     *  never opens a second connection while a check is talking to the printer. */
    private val printerLock = Mutex()
    private val printerAt: (String) -> SetupZebra = { host -> LockedZebra(zebraAt(host), printerLock) }
    private var checksJob: Job? = null
    private var offsetsJob: Job? = null
    @Volatile private var pendingOffsets: Pair<Int, Int>? = null
    @Volatile private var offsetsTouched = false

    init {
        // The saved offsets fill the fields once, unless someone already typed.
        scope.launch {
            val s = settings.filterNotNull().first()
            if (!offsetsTouched) _state.update { it.copy(offsetXText = s.offsetX.toString(), offsetYText = s.offsetY.toString()) }
        }
    }

    // --- choosing a printer ------------------------------------------------------------

    fun scan() {
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
        checksJob?.cancel()
        _state.update {
            it.copy(choosing = host, chooseError = null, checks = emptyList(), checking = false, fontFix = null,
                fontMessage = null, peeler = null, testMessage = null)
        }
        scope.launch {
            val saved = try {
                val dpi = found?.dpi
                if (dpi != null) {
                    SavedPrinter(host, found.model ?: DEFAULT_MODEL, found.serial.orEmpty(), dpi)
                } else {
                    val zebra = printerAt(host)
                    val id = zebra.identify()
                    SavedPrinter(host, id.model.ifBlank { DEFAULT_MODEL }, (found?.serial ?: quietly { zebra.serial() }).orEmpty(), id.dpi)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(choosing = null, chooseError = noZebraAnswerText(host)) }
                return@launch
            }
            store.setPrinter(saved)
            _state.update { it.copy(choosing = null) }
            startChecks(saved)
        }
    }

    // --- the checks ------------------------------------------------------------------------

    fun checkAgain() {
        if (_state.value.busy) return
        scope.launch { store.settings.first().printer?.let { startChecks(it) } }
    }

    private fun startChecks(printer: SavedPrinter, keepFontMessage: Boolean = false) {
        checksJob?.cancel()
        checksJob = scope.launch { runChecks(printer, keepFontMessage) }
    }

    private fun put(row: CheckRow) = _state.update { s ->
        val rows = s.checks.filter { it.key != row.key } + row
        s.copy(checks = rows.sortedBy { it.key.ordinal })
    }

    private suspend fun runChecks(saved: SavedPrinter, keepFontMessage: Boolean) {
        _state.update {
            it.copy(checks = emptyList(), checking = true, fontFix = null, peeler = null,
                fontMessage = if (keepFontMessage) it.fontMessage else null, fontError = keepFontMessage && it.fontError)
        }
        try {
            val zebra = printerAt(saved.host)
            put(CheckRow(CheckKey.ANSWERS, CheckState.RUNNING))
            val id = quietly { zebra.identify() }
            if (id == null) {
                put(CheckRow(CheckKey.ANSWERS, CheckState.FAIL, noZebraAnswerText(saved.host)))
                return
            }
            put(CheckRow(CheckKey.ANSWERS, CheckState.OK, "${id.model} · ${id.dpi} DPI"))
            var printer = saved
            val model = id.model.ifBlank { DEFAULT_MODEL }
            if (id.dpi != saved.dpi || model != saved.model) {
                // Another printer took this address: its DPI picks the template (the builder rebuilds).
                printer = SavedPrinter(saved.host, model, quietly { zebra.serial() }.orEmpty(), id.dpi)
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
            _state.update { it.copy(checking = false, checkRuns = it.checkRuns + 1) }
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
        val onPrinter = quietly { zebra.fonts() }
            ?: return CheckRow(CheckKey.FONTS, CheckState.FAIL, "Couldn't read the fonts on the printer.")
        val missing = missingFonts(needed, onPrinter)
        if (missing.isEmpty()) return CheckRow(CheckKey.FONTS, CheckState.OK)
        val library = db.labelFonts().all().map { KioskLabelFont(it.id, it.name, it.size, it.resident) }
        val fix = fontFixFor(missing, library)
        _state.update { it.copy(fontFix = fix) }
        val others = missing.filter { it !in fix.builtIn }
        val detail = listOfNotNull(
            others.takeIf { it.isNotEmpty() }?.let { "Missing: ${it.joinToString(", ")}." },
            fix.builtIn.takeIf { it.isNotEmpty() }?.let(::builtInFontText),
        ).joinToString(" ")
        return CheckRow(CheckKey.FONTS, CheckState.FAIL, detail)
    }

    /** Sends each missing font the library has (its synced file), then checks again after the
     *  printer has had [FONT_SETTLE_MS] to file them. The first failure stops the installs. */
    fun installFonts() {
        val fix = _state.value.fontFix ?: return
        if (_state.value.busy || fix.installable.isEmpty()) return
        _state.update { it.copy(installing = true, fontMessage = null, fontError = false) }
        scope.launch {
            val printer = store.settings.first().printer
            if (printer == null) {
                _state.update { it.copy(installing = false) }
                return@launch
            }
            val zebra = printerAt(printer.host)
            var failed: String? = null
            val files = db.labelFonts().all().associateBy { it.name.uppercase() }
            for (font in fix.installable) {
                val name = font.name.uppercase()
                try {
                    val file = files[name]?.fileName?.let { File(fontsDir, it) } ?: throw IOException("no file for $name")
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    zebra.installFont(name, bytes)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "font install failed: $name", e)
                    failed = name
                    break
                }
            }
            delay(FONT_SETTLE_MS)
            _state.update {
                it.copy(installing = false, fontMessage = failed?.let(::fontInstallFailedText) ?: FONTS_INSTALLED_TEXT, fontError = failed != null)
            }
            // Fonts sent before a failure still turn green; the message stays.
            startChecks(printer, keepFontMessage = true)
        }
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
                    printerAt(printer.host).send(parseZpl(helper("withPrintMode", LabelGenArgs.printMode(shifted, s.peel))))
                    label.second to false
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: LabelEngineUnsupportedException) {
                DEVICE_UNSUPPORTED_TEXT to true
            } catch (e: PrinterTimeout) {
                TEST_TIMEOUT_TEXT to true
            } catch (e: PrinterException) {
                printerUnreachableText(printer.host) to true
            } catch (e: Exception) {
                android.util.Log.w(TAG, "test label failed", e)
                TEST_FAILED_TEXT to true
            }
            _state.update { it.copy(testing = false, testMessage = message, testError = error) }
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
