package com.serversherpa.kiosk.ui.screens.enroll

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.scan.ScanIndex
import com.serversherpa.kiosk.core.scan.ScanMatchKind
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.scan.matchAssetOrSerial
import com.serversherpa.kiosk.core.scan.matchScan
import com.serversherpa.kiosk.core.scan.padRfid
import com.serversherpa.kiosk.core.scan.RfidProblem
import com.serversherpa.kiosk.core.scan.rfidProblemText
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val MAX_ENROLLMENTS = 25
private const val NO_MOVE_DATA = "No move data on this kiosk. Sync from Kiosk Setup."
private const val TOAST_MS = 5_000L
private const val ERROR_MS = 4_000L

data class EnrollmentRow(val id: String, val name: String, val serial: String?, val rfid: String, val replaced: Boolean, val at: String)

data class EnrollUi(
    val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0,
    val asset: AssetEntity? = null, val value: String = "", val tagValue: String = "",
    val saving: Boolean = false, val error: String? = null, val toast: String? = null,
    val enrollments: List<EnrollmentRow> = emptyList(),
)

fun saveErrorText(e: Throwable): String {
    val err = e as? ApiError
    return when {
        err?.code == "rfid_in_use" -> "That tag is already on ${err.detailString("asset_name") ?: "another asset"}."
        err?.code == "bad_rfid" -> rfidProblemText(RfidProblem.NOT_ALPHANUMERIC)
        err?.code == "rfid_too_long" -> rfidProblemText(RfidProblem.TOO_LONG)
        err?.code == "read_only_mode" || err?.status == 423 -> "The portal is in read-only mode. Try again shortly."
        err?.code == "network" -> "Can't reach the portal. The tag was not saved."
        else -> "Couldn't save the tag (${err?.code ?: "unknown_error"})."
    }
}

/** kiosk/src/pages/Enroll.tsx: asset (ID/serial only) → tag (padded), online only.
 *  The screen collects ScanBus while it is composed and calls onScan; this
 *  ViewModel never collects the bus itself (it may outlive the screen). */
class EnrollViewModel(
    private val db: KioskDatabase, private val sync: Sync, private val api: KioskApi, private val prefs: KioskPrefs,
    private val identity: Identity, private val flash: FlashController, private val sound: SoundPlayer?,
    scopeOverride: CoroutineScope? = null, private val clock: () -> Long = System::currentTimeMillis,
    private val idGen: () -> String = { UUID.randomUUID().toString() },
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(EnrollUi())
    val state: StateFlow<EnrollUi> = _state
    @Volatile private var index: ScanIndex<AssetEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE
    @Volatile private var checkpoint = CheckpointId.ENROLL.fallback
    private var errorJob: Job? = null
    private var toastJob: Job? = null

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { prefs.checkpoint(CheckpointId.ENROLL).collect { checkpoint = it } }
        scope.launch { load() }
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
    fun setTagValue(v: String) = _state.update { it.copy(tagValue = v) }

    private fun showError(text: String, ms: Long = ERROR_MS) {
        errorJob?.cancel(); _state.update { it.copy(error = text) }
        errorJob = scope.launch { delay(ms); _state.update { it.copy(error = null) } }
    }

    private fun showToast(text: String) {
        toastJob?.cancel(); _state.update { it.copy(toast = text) }
        toastJob = scope.launch { delay(TOAST_MS); _state.update { it.copy(toast = null) } }
    }

    private fun flashBad() { val a = appearance; flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
    private fun flashGood() { val a = appearance; flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }

    /** Routes to whichever step is current — the screen calls this from its
     *  own `LaunchedEffect` collecting `ScanBus.events`. */
    fun onScan(value: String) { if (_state.value.asset == null) submitAsset(value) else submitTag(value) }

    fun submitAsset(raw: String) {
        val value = raw.trim()
        _state.update { it.copy(value = "") }
        if (value.isEmpty()) return
        val idx = index
        // A hardware scan can arrive before the roster or the setup is ready (the
        // typed input is disabled then). Say so instead of dropping it silently.
        if (idx == null || _state.value.loadStatus != LoadStatus.READY || _state.value.rosterSize == 0 || setup == null) {
            flashBad(); showError(NO_MOVE_DATA); return
        }
        val hit = matchAssetOrSerial(idx, value)
        if (hit != null) { errorJob?.cancel(); _state.update { it.copy(asset = hit.asset, tagValue = "", error = null) }; flashGood(); return }
        flashBad()
        val asTag = matchScan(idx, value)
        showError(if (asTag?.kind == ScanMatchKind.RFID) "That's an RFID tag. Scan the asset's serial or ID first." else "No asset found for \"$value\".")
    }

    fun submitTag(raw: String) {
        val target = _state.value.asset ?: return
        if (_state.value.saving) return
        val (tag, problem) = padRfid(raw)
        if (problem != null) { _state.update { it.copy(tagValue = "") }; showError(rfidProblemText(problem)); return }
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            try {
                val sel = setup
                val result = api.postRfidEnroll(target.id, KioskRfidEnrollIn(identity.get().serial, tag!!, checkpoint, idGen(), sel?.siteId, sel?.initiativeId))
                flashGood()
                // The tag is saved on the portal at this point; a failure here only
                // means this kiosk's own copy of the roster is stale.
                try { db.assets().updateRfid(target.id, result.rfid_tag) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { showError("The tag was saved to the portal, but this kiosk's copy is stale.") }
                load()
                val name = result.asset_name ?: target.name ?: target.assetId
                showToast("Enrolled $name → ${displayRfid(result.rfid_tag)}")
                _state.update {
                    it.copy(asset = null, value = "", tagValue = "", saving = false,
                        enrollments = (listOf(EnrollmentRow(idGen(), name, result.serial_number ?: target.serialNumber, result.rfid_tag, replaced = !target.rfid.isNullOrEmpty() && !result.already_had_tag, at = Instant.ofEpochMilli(clock()).toString())) + it.enrollments).take(MAX_ENROLLMENTS))
                }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                flashBad()
                _state.update { it.copy(saving = false, tagValue = "") }
                showError(saveErrorText(e))
            }
        }
    }

    fun cancel() { errorJob?.cancel(); _state.update { it.copy(asset = null, value = "", tagValue = "", saving = false, error = null) } }
}
