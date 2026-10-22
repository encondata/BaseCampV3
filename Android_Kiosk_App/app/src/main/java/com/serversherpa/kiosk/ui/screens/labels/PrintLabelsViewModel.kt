package com.serversherpa.kiosk.ui.screens.labels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.labels.DEVICE_UNSUPPORTED_TEXT
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelGenArgs
import com.serversherpa.kiosk.core.labels.LabelSendRefused
import com.serversherpa.kiosk.core.labels.LabelSendTimeout
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.PREPARE_FAILED_TEXT
import com.serversherpa.kiosk.core.labels.PrintEntry
import com.serversherpa.kiosk.core.labels.PrintQueue
import com.serversherpa.kiosk.core.labels.PrintQueueDeps
import com.serversherpa.kiosk.core.labels.PrintState
import com.serversherpa.kiosk.core.labels.PrintStep
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.labels.StoredLabel
import com.serversherpa.kiosk.core.labels.labelFor
import com.serversherpa.kiosk.core.labels.parseZpl
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.scan.ScanIndex
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.matchAssetOrSerial
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelEngineTimeoutException
import com.serversherpa.kiosk.data.labels.LabelEngineUnsupportedException
import com.serversherpa.kiosk.data.labels.LabelSettingsSource
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.printer.LabelSender
import com.serversherpa.kiosk.data.printer.PrinterException
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.printer.bluetoothRefusal
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.NO_MOVE_DATA
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PrintLabelsUi(
    val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0, val value: String = "", val error: String? = null,
)

/**
 * Print Labels (the laptop's Printing Station, kiosk/src/pages/PrintingStation.tsx): a scan
 * matched by asset ID or serial prints the asset's stored label on the saved printer and records
 * one Labeled scan through the outbox. The decisions live in [PrintQueue]. [sender] is the
 * container's: each label under the app-wide printer lock and guard (a `~JX` first after a failed
 * send, nothing while a font install is cut), to a network or a Bluetooth printer. A Bluetooth
 * failure the crew fixes on the device (Bluetooth off or not allowed, a printer that forgot it)
 * says what to do; the screen puts the button that does it beside Retry.
 */
class PrintLabelsViewModel(
    private val db: KioskDatabase,
    private val sync: Sync,
    private val outbox: Outbox,
    private val prefs: KioskPrefs,
    private val labelSettings: LabelSettingsSource,
    val build: StateFlow<LabelBuildStatus>,
    private val engine: LabelEngine,
    private val sender: LabelSender,
    private val flash: FlashController,
    private val sound: SoundPlayer?,
    scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(PrintLabelsUi())
    val state: StateFlow<PrintLabelsUi> = _state
    /** Null until the settings are first read. */
    val settings: StateFlow<LabelSettings?> = labelSettings.settings.stateIn(scope, SharingStarted.Eagerly, null)
    @Volatile private var index: ScanIndex<AssetEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE

    private val queue = PrintQueue(object : PrintQueueDeps<AssetEntity> {
        override suspend fun settings(): LabelSettings = labelSettings.settings.first()

        override suspend fun label(asset: AssetEntity): PrintStep {
            val row = db.generatedLabels().get(asset.id)
            return labelFor(
                row?.let { StoredLabel(it.zpl, it.outcome, it.templateId) }, build.value,
                syncing = sync.status.value.phase == SyncPhase.RUNNING,
            )
        }

        override suspend fun prepare(zpl: String, settings: LabelSettings): PrintStep = try {
            val offset = parseZpl(helper("applyPrintSettings", LabelGenArgs.printSettings(zpl, settings.offsetX, settings.offsetY)))
            PrintStep.Ready(parseZpl(helper("withPrintMode", LabelGenArgs.printMode(offset, settings.peel))))
        } catch (e: CancellationException) {
            throw e
        } catch (e: LabelEngineUnsupportedException) {
            PrintStep.Refused(DEVICE_UNSUPPORTED_TEXT)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "couldn't apply the print settings", e)
            PrintStep.Refused(PREPARE_FAILED_TEXT)
        }

        override suspend fun send(printer: SavedPrinter, zpl: String) = try {
            sender.send(printer, zpl)
        } catch (e: PrinterTimeout) {
            throw LabelSendTimeout(e)
        } catch (e: PrinterException) {
            // Bluetooth off or not allowed, or a printer that forgot this device: what to do.
            val refusal = bluetoothRefusal(e) ?: throw e
            throw LabelSendRefused(refusal.message ?: throw e, e)
        }

        override suspend fun record(asset: AssetEntity, scannedValue: String) {
            val sel = setup ?: throw IllegalStateException("no setup selection")
            val siteId = sel.siteId ?: throw IllegalStateException("no site in the setup selection")
            val initiativeId = sel.initiativeId ?: throw IllegalStateException("no move in the setup selection")
            outbox.enqueue(EnqueueInput(
                scannedValue = scannedValue, scanType = "barcode", asset = asset.toOutboxAsset(),
                siteId = siteId, initiativeId = initiativeId, scanStatus = LABELED,
            ))
        }
    }, now = { Instant.now().toString() }, log = { message, e -> android.util.Log.w(TAG, message, e) })

    /** Newest first. */
    val entries: StateFlow<List<PrintEntry<AssetEntity>>> = queue.entries

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { outbox.load() }
        scope.launch { load() }
        // Re-read when a sync finishes or local data was cleared (IDLE after DONE).
        scope.launch { sync.status.collect { if (it.phase == SyncPhase.DONE || it.phase == SyncPhase.IDLE) load() } }
    }

    /**
     * The send-time helpers share the generator with the label build, so one can wait behind a
     * batch, or time out right after a cancelled build while the sandbox restarts: ask once more.
     */
    private suspend fun helper(fn: String, args: String): String = try {
        engine.call(fn, args)
    } catch (e: LabelEngineTimeoutException) {
        engine.call(fn, args)
    }

    private suspend fun load() {
        try {
            val assets = db.assets().all()
            index = buildScanIndex(assets)
            _state.update { it.copy(loadStatus = LoadStatus.READY, rosterSize = assets.size) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(loadStatus = LoadStatus.ERROR) }
        }
    }

    fun setValue(v: String) = _state.update { it.copy(value = v) }

    fun onScan(raw: String) {
        val value = raw.trim(); if (value.isEmpty()) return
        _state.update { it.copy(value = "") }
        val idx = index
        // A hardware scan can arrive before the roster or the setup is ready (the typed input is
        // disabled then). Say so instead of dropping it silently.
        if (idx == null || setup == null || _state.value.rosterSize == 0) {
            feedback(false)
            _state.update { it.copy(error = NO_MOVE_DATA) }
            return
        }
        _state.update { it.copy(error = null) }
        // Asset ID or serial only, as the laptop's Printing Station: a tag is not a label request.
        val asset = matchAssetOrSerial(idx, value)?.asset
        scope.launch { settled(queue.scan(asset, value)) }
    }

    fun reprint(entryId: String) { scope.launch { queue.reprint(entryId)?.let { settled(it) } } }

    fun retry(entryId: String) { scope.launch { queue.retry(entryId)?.let { settled(it) } } }

    /** Runs the move's sync again (labels need a sync since the version 2 upgrade). */
    fun syncNow() { setup?.let { s -> s.initiativeId?.let { sync.run(it, s.initiativeName ?: "") } } }

    private fun settled(entry: PrintEntry<AssetEntity>) = feedback(entry.state == PrintState.PRINTED)

    private fun feedback(good: Boolean) {
        val a = appearance
        flash.flash(hslToArgb(if (good) a.goodScan else a.notFoundScan), a.flashMs)
        sound?.play(if (good) ScanSoundKind.GOOD else ScanSoundKind.NOT_FOUND)
    }

    companion object {
        private const val TAG = "PrintLabels"
        /** The scan status a printed label records. */
        const val LABELED = "labeled"
    }
}
