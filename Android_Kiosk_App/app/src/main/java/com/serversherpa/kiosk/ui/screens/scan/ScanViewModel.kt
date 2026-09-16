package com.serversherpa.kiosk.ui.screens.scan

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.scan.ScanIndex
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.matchScan
import com.serversherpa.kiosk.core.scan.scanTypeFor
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.OutboxSnapshot
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class LoadStatus { LOADING, READY, ERROR }

data class ScanUi(
    val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0, val value: String = "",
    val confirmDiscard: Boolean = false, val storageError: String? = null, val error: String? = null,
)

private const val STORAGE_ERROR = "Couldn't save this scan on the kiosk. Check its storage."
const val NO_MOVE_DATA = "No move data on this kiosk. Sync from Kiosk Setup."

/** kiosk/src/pages/Scan.tsx statusLabel(): what the receipt list's pill says. */
fun statusLabel(row: OutboxRow): String = when (row.status) {
    OutboxStatus.ACCEPTED -> "Sent"
    OutboxStatus.SENDING -> "Sending"
    OutboxStatus.RETRYING -> "Retrying (${row.attempts}/${OutboxMachine.BACKOFF.size})"
    OutboxStatus.FAILED -> "Failed: ${row.lastError ?: "timeout"}"
    OutboxStatus.NOMATCH -> "No match"
    OutboxStatus.QUEUED -> "Queued"
}

fun scanTime(iso: String): String = try {
    DateTimeFormatter.ofPattern("HH:mm:ss").format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
} catch (e: Exception) { iso }

/** kiosk/src/pages/Scan.tsx: match locally, flash + sound, queue in the outbox. */
class ScanViewModel(
    private val db: KioskDatabase, private val sync: Sync, private val outbox: Outbox, private val prefs: KioskPrefs,
    private val flash: FlashController, private val sound: SoundPlayer?, scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(ScanUi())
    val state: StateFlow<ScanUi> = _state
    val outboxSnapshot: StateFlow<OutboxSnapshot> = outbox.snapshot
    @Volatile private var index: ScanIndex<AssetEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { outbox.load() }
        scope.launch { load() }
        // Re-read when a sync finishes or local data was cleared (IDLE after DONE).
        scope.launch { sync.status.collect { if (it.phase == SyncPhase.DONE || it.phase == SyncPhase.IDLE) load() } }
    }

    private suspend fun load() {
        try {
            val assets = db.assets().all()
            index = buildScanIndex(assets)
            _state.update { it.copy(loadStatus = LoadStatus.READY, rosterSize = assets.size) }
        } catch (e: Exception) { _state.update { it.copy(loadStatus = LoadStatus.ERROR) } }
    }

    fun setValue(v: String) = _state.update { it.copy(value = v) }

    fun onScan(raw: String) {
        val value = raw.trim(); if (value.isEmpty()) return
        _state.update { it.copy(value = "") }
        val idx = index
        val sel = setup
        val a = appearance
        // A hardware scan can arrive before the roster or the setup is ready (the
        // typed input is disabled then). Say so instead of dropping it silently.
        if (idx == null || sel == null || _state.value.rosterSize == 0) {
            flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND)
            _state.update { it.copy(error = NO_MOVE_DATA) }
            return
        }
        _state.update { it.copy(error = null) }
        val hit = matchScan(idx, value)
        if (hit != null) { flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }
        else { flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
        scope.launch {
            try {
                outbox.enqueue(EnqueueInput(
                    scannedValue = value, scanType = hit?.let { scanTypeFor(it.kind) } ?: "barcode",
                    asset = hit?.asset?.toOutboxAsset(), siteId = sel.siteId, initiativeId = sel.initiativeId, scanStatus = sel.scanStatus,
                ))
                _state.update { it.copy(storageError = null) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) { _state.update { it.copy(storageError = STORAGE_ERROR) } }
        }
    }

    /**
     * A finished RFID sweep. The controller has already reduced it to each tag
     * once, so this does what `onScan` does, in a single pass: match locally,
     * queue, and give one piece of feedback for the whole burst rather than one
     * per tag. Fifty flashes and fifty beeps is not feedback, it is a strobe.
     *
     * Each tag's outbox write is isolated in its own try/catch rather than one
     * try around the whole loop: a sweep can be dozens of tags, and a single
     * write failure (most likely a systemic storage problem, but possibly a
     * one-off) must not cost the operator every tag that would have queued fine
     * after it. Every tag still gets a queue attempt; whatever succeeds stays
     * queued. If any write failed, storageError is set exactly as it is for a
     * single scan, so the operator sees the same toast rather than the burst
     * being silently short. The end-of-burst flash/sound still reflects whether
     * anything in the sweep matched the roster, matching onScan's convention
     * that feedback is about recognition, not persistence.
     */
    fun onBurst(values: List<String>) {
        if (values.isEmpty()) return
        val idx = index
        val sel = setup
        val a = appearance
        if (idx == null || sel == null || _state.value.rosterSize == 0) {
            flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND)
            _state.update { it.copy(error = NO_MOVE_DATA) }
            return
        }
        _state.update { it.copy(error = null) }
        scope.launch {
            var matched = 0
            var hadError = false
            for (value in values) {
                val hit = matchScan(idx, value)
                if (hit != null) matched++
                try {
                    outbox.enqueue(EnqueueInput(
                        scannedValue = value, scanType = "rfid",
                        asset = hit?.asset?.toOutboxAsset(), siteId = sel.siteId,
                        initiativeId = sel.initiativeId, scanStatus = sel.scanStatus,
                    ))
                } catch (e: CancellationException) { throw e
                } catch (e: Exception) { hadError = true }
            }
            _state.update { it.copy(storageError = if (hadError) STORAGE_ERROR else null) }
            if (matched > 0) {
                flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD)
            } else {
                flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND)
            }
        }
    }

    fun retryFailed() {
        scope.launch {
            try { outbox.retryFailed(); _state.update { it.copy(storageError = null) } }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { _state.update { it.copy(storageError = STORAGE_ERROR) } }
        }
    }

    fun clearSent() {
        scope.launch {
            try { outbox.clearSent(); _state.update { it.copy(storageError = null) } }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { _state.update { it.copy(storageError = STORAGE_ERROR) } }
        }
    }

    fun askDiscard() = _state.update { it.copy(confirmDiscard = true) }
    fun cancelDiscard() = _state.update { it.copy(confirmDiscard = false) }

    fun discardFailed() {
        _state.update { it.copy(confirmDiscard = false) }
        scope.launch {
            try { outbox.discardFailed(); _state.update { it.copy(storageError = null) } }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { _state.update { it.copy(storageError = STORAGE_ERROR) } }
        }
    }
}
