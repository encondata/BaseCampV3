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
import com.serversherpa.kiosk.data.station.StationStatus
import com.serversherpa.kiosk.data.station.issueAndStore
import com.serversherpa.kiosk.data.station.TIMECLOCK_STATION
import com.serversherpa.kiosk.data.station.issueStationKeyRetrying
import com.serversherpa.kiosk.data.sync.Sync
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The wizard's first step: what is this kiosk? */
enum class SetupKind { REGULAR, TIMECLOCK }

data class SetupUi(
    /** null until the stored setup has been read: the screen paints nothing then,
     *  rather than flashing the wizard at a kiosk that is already set up. */
    val wizardOpen: Boolean? = null,
    val options: SetupOptions? = null,
    val loadError: Boolean = false,
    /** 0 type, 1 move, 2 site, then (a regular kiosk only) 3 scan type and 4 labels. */
    val step: Int = 0,
    /** Null until a type is picked (or preselected from the saved setup). */
    val kind: SetupKind? = null,
    val initiativeId: String = "", val siteId: String = "", val scanStatus: String = "",
    /** A Time Clock station's "No move" and "No site" picks (their ids stay empty). */
    val noMove: Boolean = false, val noSite: Boolean = false,
    /** The last step's choice, "top" or "front"; Top until picked. */
    val labelKind: String = "top",
    val submitting: Boolean = false, val submitError: String? = null,
    /** A Time Clock setup was saved but its station key didn't arrive: the error code. */
    val keyError: String? = null,
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

/**
 * kiosk/src/pages/KioskSetup.tsx. First, what is this kiosk:
 *  - Regular: Move → Site → Scan type, then (here only) what labels print on, then the summary;
 *  - Time Clock: Move (or No move) → Site (the move's, or with no move any site or No site).
 *    Picking the site saves it with `station_type` "timeclock", issues and stores the station
 *    key ([station], bound to the API origin; one [signInBeat] and retry on `not_signed_in_here`), and signs the
 *    person out ([signOut]), which leaves the station resting on Welcome. No move data syncs.
 * A Regular setup drops any station key, since the portal has revoked it.
 */
class KioskSetupViewModel(
    private val api: KioskApi, private val prefs: KioskPrefs, private val identity: Identity,
    private val sync: Sync, scopeOverride: CoroutineScope? = null,
    /** The station key's store (it reads and writes the key off the main thread). */
    private val station: StationStatus? = null,
    private val signInBeat: suspend () -> Unit = {},
    private val signOut: suspend () -> Unit = {},
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    val selection: StateFlow<KioskSetupSelection?> = prefs.setupSelection.stateIn(scope, SharingStarted.Eagerly, null)
    val setupState: StateFlow<SetupState> = prefs.setupState.stateIn(scope, SharingStarted.Eagerly, SetupState.INCOMPLETE)
    private val _state = MutableStateFlow(SetupUi())
    val state: StateFlow<SetupUi> = _state

    private data class Saved(val hasSelection: Boolean, val setUp: Boolean)

    init {
        scope.launch {
            // Not just the first read: the saved setup can be dropped while the screen is
            // open (a Clear Setup from the portal, a move-password sign-in for another
            // move). On the summary there is then nothing to show; in "Change setup" the
            // choices belong to a setup that no longer exists. Either way the wizard
            // starts over and loads the moves, never sitting on "Loading moves…".
            var wasSetUp: Boolean? = null
            combine(prefs.setupSelection, prefs.setupState) { sel, st -> Saved(sel != null, sel != null && st.isComplete) }
                .distinctUntilChanged()
                .collect { saved ->
                    val dropped = wasSetUp == true && !saved.setUp && !saved.hasSelection
                    wasSetUp = saved.setUp
                    when (_state.value.wizardOpen) {
                        null -> { _state.update { it.copy(wizardOpen = !saved.setUp) }; if (!saved.setUp) load() }
                        false -> if (!saved.setUp) restartWizard()
                        // finish() only ever writes a selection and then COMPLETE, so it never
                        // looks like a drop: only a cleared selection restarts an open wizard.
                        true -> if (dropped) restartWizard()
                    }
                }
        }
    }

    private fun restartWizard() {
        _state.update { fresh(it) }
        load()
    }

    /** The wizard at its first step with nothing chosen. */
    private fun fresh(ui: SetupUi) = ui.copy(
        wizardOpen = true, step = 0, kind = null, submitError = null, keyError = null,
        initiativeId = "", siteId = "", scanStatus = "", noMove = false, noSite = false, labelKind = "top",
    )

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
                    val sites = if (s.noMove) opts.sites.map { it.id } else listOfNotNull(init?.source_site?.id, init?.destination_site?.id)
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
            if (preselect && sel != null) {
                val timeclock = sel.stationType == TIMECLOCK_STATION
                fresh(it).copy(
                    kind = if (timeclock) SetupKind.TIMECLOCK else SetupKind.REGULAR,
                    initiativeId = sel.initiativeId ?: "", siteId = sel.siteId ?: "", scanStatus = sel.scanStatus ?: "", labelKind = sel.labelKind,
                    noMove = timeclock && sel.initiativeId == null, noSite = timeclock && sel.siteId == null,
                )
            } else fresh(it)
        }
        load()
    }

    fun cancelWizard() = _state.update { it.copy(wizardOpen = false) }

    /** The first step. Switching type starts the later steps over. */
    fun selectKind(kind: SetupKind) = _state.update {
        if (kind == it.kind) it.copy(step = 1)
        else it.copy(kind = kind, step = 1, initiativeId = "", siteId = "", scanStatus = "", noMove = false, noSite = false, submitError = null, keyError = null)
    }

    fun selectMove(id: String) = _state.update {
        val changed = id != it.initiativeId || it.noMove
        it.copy(initiativeId = id, noMove = false, siteId = if (changed) "" else it.siteId, noSite = if (changed) false else it.noSite, step = 2)
    }

    /** A Time Clock station's "No move": its Site step lists every site, plus No site. */
    fun selectNoMove() = _state.update {
        it.copy(initiativeId = "", noMove = true, siteId = if (it.noMove) it.siteId else "", noSite = if (it.noMove) it.noSite else false, step = 2)
    }

    /** A regular kiosk goes on to the scan type; a Time Clock station saves right here. */
    fun selectSite(id: String) {
        if (_state.value.kind == SetupKind.TIMECLOCK) { finishTimeclock(id); return }
        _state.update { it.copy(siteId = id, step = 3) }
    }

    /** A Time Clock station with no move may stand at no site. */
    fun selectNoSite() = finishTimeclock(null)

    fun selectScanType(key: String) = _state.update { it.copy(scanStatus = key, step = 4) }
    fun back() = _state.update { it.copy(step = (it.step - 1).coerceAtLeast(0)) }

    /** The Site step's cards: the move's source and destination, or (a Time Clock station with
     *  no move) every site, with no role. */
    fun siteChoices(): List<Pair<SetupOptionSite, String>> {
        val ui = _state.value
        if (ui.kind == SetupKind.TIMECLOCK && ui.noMove) return ui.options?.sites.orEmpty().map { it to "" }
        val init = ui.options?.initiatives?.firstOrNull { it.id == ui.initiativeId } ?: return emptyList()
        return listOfNotNull(init.source_site?.let { it to "source" }, init.destination_site?.let { it to "destination" })
    }

    /** The last step: saves the setup with the chosen label kind. */
    fun finish(labelKind: String) {
        val ui = _state.value
        val scanKey = ui.scanStatus
        _state.update { it.copy(labelKind = labelKind, submitting = true, submitError = null) }
        scope.launch {
            try {
                val result = api.submitSetup(KioskSetupIn(identity.get().serial, ui.initiativeId, ui.siteId, scanKey))
                prefs.setSetupSelection(KioskSetupSelection(result.initiative_id, result.initiative_name, result.site_id, result.site_name, result.site_role, result.scan_status, result.scan_status_label, labelKind))
                // A regular kiosk holds no station key: the portal revoked any it had.
                station?.drop()
                prefs.setSetupState(SetupState.COMPLETE)
                prefs.dismissSetupClearNotice()   // set up again: the "administrator cleared" banner goes
                _state.update { it.copy(submitting = false, wizardOpen = false) }
                result.initiative_id?.let { sync.run(it, result.initiative_name ?: "") }
            } catch (e: Exception) {
                if (prefs.setupState.first() != SetupState.COMPLETE) prefs.setSetupState(SetupState.FAILED)
                _state.update { it.copy(submitting = false, submitError = (e as? ApiError)?.code ?: "unknown_error") }
            }
        }
    }

    /**
     * Saves a Time Clock station (KioskSetup.tsx finishTimeclock): no scan type, and the move
     * and the site may each be left out. Once the portal holds the setup this kiosk saves it
     * too (with any old key dropped), then gets the station key. A key that doesn't arrive
     * keeps the person signed in on this step with [SetupUi.keyError]; picking again retries.
     */
    private fun finishTimeclock(siteId: String?) {
        val ui = _state.value
        if (ui.submitting) return
        _state.update { it.copy(siteId = siteId ?: "", noSite = siteId == null, submitting = true, submitError = null, keyError = null) }
        scope.launch {
            val serial = identity.get().serial
            try {
                val result = api.submitSetup(KioskSetupIn(serial, ui.initiativeId.ifEmpty { null }, siteId, station_type = TIMECLOCK_STATION))
                station?.drop()
                prefs.setSetupSelection(KioskSetupSelection(
                    result.initiative_id, result.initiative_name, result.site_id, result.site_name, result.site_role,
                    stationType = TIMECLOCK_STATION,
                ))
                prefs.setSetupState(SetupState.COMPLETE)
                prefs.dismissSetupClearNotice()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (prefs.setupState.first() != SetupState.COMPLETE) prefs.setSetupState(SetupState.FAILED)
                _state.update { it.copy(submitting = false, submitError = (e as? ApiError)?.code ?: "unknown_error") }
                return@launch
            }
            try {
                if (station != null) station.issueAndStore(api, serial, signInBeat)
                else issueStationKeyRetrying(api, serial, signInBeat)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.update { it.copy(submitting = false, keyError = (e as? ApiError)?.code ?: "unknown_error") }
                return@launch
            }
            _state.update { it.copy(submitting = false, wizardOpen = false) }
            signOut()
        }
    }

    fun resync() { selection.value?.let { s -> s.initiativeId?.let { sync.run(it, s.initiativeName ?: "") } } }
}
