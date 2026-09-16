package com.serversherpa.kiosk.ui.screens.scan

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.EnqueueInput
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

data class ScanUi(val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0, val value: String = "", val confirmDiscard: Boolean = false, val storageError: String? = null)

private const val STORAGE_ERROR = "Couldn't save this scan on the kiosk. Check its storage."

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
        val idx = index ?: return
        val sel = setup ?: return
        val hit = matchScan(idx, value)
        val a = appearance
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
