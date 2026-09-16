package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.people.PeopleIndex
import com.serversherpa.kiosk.core.people.buildPeopleIndex
import com.serversherpa.kiosk.core.people.isAmbiguousPrefix
import com.serversherpa.kiosk.core.people.matchPersonExact
import com.serversherpa.kiosk.core.people.searchPeople
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val MAX_RESULTS = 8
const val IDLE_MS = 20_000L
private const val TICK_MS = 30_000L
private const val TOAST_MS = 5_000L
private const val ERROR_MS = 3_000L

data class TimeclockUi(
    val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0,
    val value: String = "", val results: List<PersonEntity> = emptyList(),
    val selected: PersonEntity? = null, val status: KioskTimeclockStatus? = null, val statusPhase: LoadStatus = LoadStatus.LOADING,
    val punching: Boolean = false, val error: String? = null, val toast: String? = null, val nowMs: Long = 0,
)

/** "3h 12m", or "45m" under the hour. */
fun formatMinutes(total: Int): String { val m = maxOf(0, total); val h = m / 60; return if (h > 0) "${h}h ${m % 60}m" else "${m}m" }
fun minutesSince(iso: String, nowMs: Long): Int = try { maxOf(0, ((nowMs - Instant.parse(iso).toEpochMilli()) / 60_000.0).roundToInt()) } catch (e: Exception) { 0 }
fun clockTime(iso: String): String = try { DateTimeFormatter.ofPattern("h:mm a").format(Instant.parse(iso).atZone(ZoneId.systemDefault())) } catch (e: Exception) { iso }
fun initialsOf(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return "?"
    return (words.first().take(1) + (if (words.size > 1) words.last().take(1) else "")).uppercase()
}

fun punchErrorText(e: Throwable): String {
    val err = e as? ApiError
    return when {
        err?.code == "already_clocked_in" -> "They are already clocked in. Refreshing…"
        err?.code == "not_clocked_in" -> "They are not clocked in. Refreshing…"
        err?.code == "read_only_mode" || err?.status == 423 -> "The portal is in read-only mode. Try again shortly."
        err?.code == "network" -> "Can't reach the portal. The punch was not recorded."
        else -> "Couldn't record the punch (${err?.code ?: "unknown_error"})."
    }
}

/** kiosk/src/pages/Timeclock.tsx: entry (badge/id/name) and selected (one button). No local history.
 *  The screen collects ScanBus while it is composed and calls onScan; this
 *  ViewModel never collects the bus itself (it may outlive the screen). */
class TimeclockViewModel(
    private val db: KioskDatabase, private val sync: Sync, private val api: KioskApi, private val prefs: KioskPrefs,
    private val identity: Identity, private val flash: FlashController, private val sound: SoundPlayer?,
    scopeOverride: CoroutineScope? = null, private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(TimeclockUi(nowMs = clock()))
    val state: StateFlow<TimeclockUi> = _state
    @Volatile private var index: PeopleIndex<PersonEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE
    private var statusId = 0
    private var idleJob: Job? = null
    private var tickJob: Job? = null
    private var errorJob: Job? = null
    private var toastJob: Job? = null

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { load() }
        scope.launch { sync.status.collect { if (it.phase == SyncPhase.DONE || it.phase == SyncPhase.IDLE) load() } }
    }

    private suspend fun load() {
        try {
            val people = db.people().all()
            index = buildPeopleIndex(people)
            _state.update { it.copy(loadStatus = LoadStatus.READY, rosterSize = people.size) }
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) { _state.update { it.copy(loadStatus = LoadStatus.ERROR) } }
    }

    private fun showError(text: String, ms: Long? = null) {
        errorJob?.cancel(); _state.update { it.copy(error = text) }
        if (ms != null) errorJob = scope.launch { delay(ms); _state.update { it.copy(error = null) } }
    }
    private fun showToast(text: String) {
        toastJob?.cancel(); _state.update { it.copy(toast = text) }
        toastJob = scope.launch { delay(TOAST_MS); _state.update { it.copy(toast = null) } }
    }
    private fun flashBad() { val a = appearance; flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
    private fun flashGood() { val a = appearance; flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }

    fun toEntry() {
        statusId++; errorJob?.cancel(); idleJob?.cancel(); tickJob?.cancel()
        _state.update { it.copy(selected = null, status = null, statusPhase = LoadStatus.LOADING, punching = false, value = "", results = emptyList(), error = null) }
    }

    fun bumpIdle() {
        if (_state.value.selected == null) return
        idleJob?.cancel()
        idleJob = scope.launch { delay(IDLE_MS); toEntry() }
    }

    fun select(person: PersonEntity) {
        errorJob?.cancel()
        _state.update { it.copy(error = null, value = "", results = emptyList(), selected = person, status = null, statusPhase = LoadStatus.LOADING) }
        bumpIdle()
        tickJob?.cancel(); tickJob = scope.launch { while (true) { delay(TICK_MS); _state.update { it.copy(nowMs = clock()) } } }
        loadStatus(person.id)
    }

    private fun loadStatus(personId: String) {
        val mine = ++statusId
        _state.update { it.copy(statusPhase = LoadStatus.LOADING) }
        scope.launch {
            try {
                val next = api.timeclockStatus(personId)
                if (mine != statusId) return@launch
                _state.update { it.copy(status = next, statusPhase = LoadStatus.READY, nowMs = clock()) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (mine != statusId) return@launch
                _state.update { it.copy(statusPhase = LoadStatus.ERROR) }
                showError(if ((e as? ApiError)?.code == "network") "Can't reach the portal. Try again in a moment." else "Couldn't read their status (${(e as? ApiError)?.code ?: "unknown_error"}).")
            }
        }
    }

    /** Every keystroke: a complete badge selects at once unless it is also a prefix of a longer tag. */
    fun onChange(next: String) {
        val idx = index
        if (idx != null && isAmbiguousPrefix(idx, next)) { _state.update { it.copy(value = next, results = searchPeople(idx, next, MAX_RESULTS)) }; return }
        val hit = idx?.let { matchPersonExact(it, next) }
        if (hit != null) { select(hit); return }
        _state.update { it.copy(value = next, results = if (idx != null && next.isNotBlank()) searchPeople(idx, next, MAX_RESULTS) else emptyList()) }
    }

    fun onEnter(raw: String) {
        val value = raw.trim(); val idx = index ?: return
        if (value.isEmpty()) return
        matchPersonExact(idx, value)?.let { select(it); return }
        val rows = searchPeople(idx, value, MAX_RESULTS)
        if (rows.size == 1) { select(rows[0]); return }
        if (rows.size > 1) return
        flashBad(); _state.update { it.copy(value = "") }
        showError("No worker found for \"$value\".", ERROR_MS)
    }

    fun onScan(value: String) { if (_state.value.selected == null) { onChange(value); if (_state.value.selected == null) onEnter(value) } }

    fun punch() {
        val ui = _state.value
        val person = ui.selected ?: return
        val status = ui.status ?: return
        if (ui.punching) return
        val clockingOut = status.clocked_in
        errorJob?.cancel(); _state.update { it.copy(punching = true, error = null) }
        scope.launch {
            try {
                val serial = identity.get().serial
                val sel = setup
                val next = if (clockingOut) api.clockOut(ClockOutIn(serial, person.id)) else api.clockIn(ClockInIn(serial, person.id, sel?.siteId, sel?.initiativeId))
                flashGood()
                val name = next.person.display_name
                val minutes = next.last_entry?.minutes
                showToast(if (clockingOut) "Clocked out — $name" + (minutes?.let { " · ${formatMinutes(it)}" } ?: "") else "Clocked in — $name")
                toEntry()
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                flashBad()
                _state.update { it.copy(punching = false) }
                showError(punchErrorText(e), ERROR_MS)
                bumpIdle()
                val code = (e as? ApiError)?.code
                if (code == "already_clocked_in" || code == "not_clocked_in") loadStatus(person.id)
            }
        }
    }
}
