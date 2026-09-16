package com.serversherpa.kiosk.ui.screens.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskSetupIn
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.SetupOptionInitiative
import com.serversherpa.kiosk.core.model.SetupOptionSite
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SetupUi(
    /** null until the stored setup has been read: the screen paints nothing then,
     *  rather than flashing the wizard at a kiosk that is already set up. */
    val wizardOpen: Boolean? = null,
    val options: SetupOptions? = null,
    val loadError: Boolean = false,
    val step: Int = 1,
    val initiativeId: String = "", val siteId: String = "", val scanStatus: String = "",
    val submitting: Boolean = false, val submitError: String? = null,
)

private fun day(iso: String): String = try {
    DateTimeFormatter.ofPattern("MMM d").format(Instant.parse(iso).atZone(ZoneId.of("UTC")))
} catch (e: Exception) { iso.take(10) }

/** "Sep 20 – Sep 22" / "Starts Sep 20" / "Ends Sep 22" / null. */
fun formatMoveDates(i: SetupOptionInitiative): String? {
    val s = i.scheduled_start?.let(::day); val e = i.scheduled_end?.let(::day)
    return when {
        s != null && e != null -> "$s – $e"
        s != null -> "Starts $s"
        e != null -> "Ends $e"
        else -> null
    }
}

/** kiosk/src/pages/KioskSetup.tsx: Move → Site → Scan type, then the summary. */
class KioskSetupViewModel(
    private val api: KioskApi, private val prefs: KioskPrefs, private val identity: Identity,
    private val sync: Sync, scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    val selection: StateFlow<KioskSetupSelection?> = prefs.setupSelection.stateIn(scope, SharingStarted.Eagerly, null)
    val setupState: StateFlow<SetupState> = prefs.setupState.stateIn(scope, SharingStarted.Eagerly, SetupState.INCOMPLETE)
    private val _state = MutableStateFlow(SetupUi())
    val state: StateFlow<SetupUi> = _state

    init {
        scope.launch {
            val sel = prefs.setupSelection.first(); val st = prefs.setupState.first()
            _state.update { it.copy(wizardOpen = !(sel != null && st.isComplete)) }
            if (_state.value.wizardOpen == true) load()
        }
    }

    fun load() {
        _state.update { it.copy(loadError = false, options = null) }
        scope.launch {
            try {
                val opts = api.setupOptions()
                _state.update { ui ->
                    // Revalidate cached choices against what the portal offers now.
                    var s = ui.copy(options = opts)
                    if (s.initiativeId.isNotEmpty() && opts.initiatives.none { it.id == s.initiativeId }) s = s.copy(initiativeId = "", siteId = "", scanStatus = "")
                    val init = opts.initiatives.firstOrNull { it.id == s.initiativeId }
                    val sites = listOfNotNull(init?.source_site?.id, init?.destination_site?.id)
                    if (s.siteId.isNotEmpty() && s.siteId !in sites) s = s.copy(siteId = "")
                    if (s.scanStatus.isNotEmpty() && opts.scan_types.none { it.key == s.scanStatus }) s = s.copy(scanStatus = "")
                    s
                }
            } catch (e: Exception) { _state.update { it.copy(loadError = true) } }
        }
    }

    fun openWizard(preselect: Boolean) {
        val sel = selection.value
        _state.update {
            if (preselect && sel != null) it.copy(wizardOpen = true, step = 1, submitError = null, initiativeId = sel.initiativeId, siteId = sel.siteId, scanStatus = sel.scanStatus)
            else it.copy(wizardOpen = true, step = 1, submitError = null, initiativeId = "", siteId = "", scanStatus = "")
        }
        load()
    }

    fun cancelWizard() = _state.update { it.copy(wizardOpen = false) }
    fun selectMove(id: String) = _state.update { it.copy(initiativeId = id, siteId = if (id != it.initiativeId) "" else it.siteId, step = 2) }
    fun selectSite(id: String) = _state.update { it.copy(siteId = id, step = 3) }
    fun back() = _state.update { it.copy(step = (it.step - 1).coerceAtLeast(1)) }

    fun siteChoices(): List<Pair<SetupOptionSite, String>> {
        val init = _state.value.options?.initiatives?.firstOrNull { it.id == _state.value.initiativeId } ?: return emptyList()
        return listOfNotNull(init.source_site?.let { it to "source" }, init.destination_site?.let { it to "destination" })
    }

    fun finish(scanKey: String) {
        val ui = _state.value
        _state.update { it.copy(scanStatus = scanKey, submitting = true, submitError = null) }
        scope.launch {
            try {
                val result = api.submitSetup(KioskSetupIn(identity.get().serial, ui.initiativeId, ui.siteId, scanKey))
                prefs.setSetupSelection(KioskSetupSelection(result.initiative_id, result.initiative_name, result.site_id, result.site_name, result.site_role, result.scan_status, result.scan_status_label))
                prefs.setSetupState(SetupState.COMPLETE)
                _state.update { it.copy(submitting = false, wizardOpen = false) }
                sync.run(result.initiative_id, result.initiative_name)
            } catch (e: Exception) {
                if (prefs.setupState.first() != SetupState.COMPLETE) prefs.setSetupState(SetupState.FAILED)
                _state.update { it.copy(submitting = false, submitError = (e as? ApiError)?.code ?: "unknown_error") }
            }
        }
    }

    fun resync() { selection.value?.let { sync.run(it.initiativeId, it.initiativeName) } }
}
