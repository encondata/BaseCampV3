package com.serversherpa.kiosk.ui.screens.timeclock.flow

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.people.PeopleIndex
import com.serversherpa.kiosk.core.people.buildPeopleIndex
import com.serversherpa.kiosk.core.people.isAmbiguousPrefix
import com.serversherpa.kiosk.core.people.matchPersonExact
import com.serversherpa.kiosk.core.people.searchPeople
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Where the flow gets its people and its punches (kiosk/src/timeclock/backend.ts). The same
 * screens run in two places: on a signed-in kiosk ([SessionTcBackend]: the synced people in Room,
 * the kiosk's own session for status and punches) and on a signed-out Time Clock station (a
 * station backend under the station key). Both send the device's zone as `tz`. Implementations
 * throw [ApiError] on failure; the view model adds the read timeout, so they need not.
 */
interface TcBackend {
    suspend fun people(): List<KioskPersonRow>
    suspend fun status(personId: String): KioskTimeclockStatus
    suspend fun clockIn(personId: String): KioskTimeclockStatus
    suspend fun clockOut(personId: String): KioskTimeclockStatus
}

/** A signed-in kiosk: people from its local copy, status and punches on its session. A clock-in
 *  carries the kiosk's setup site and move, as the old Timeclock screen's did. */
class SessionTcBackend(
    private val db: KioskDatabase,
    private val api: KioskApi,
    private val identity: Identity,
    private val prefs: KioskPrefs,
    private val zone: () -> String = ::deviceZone,
) : TcBackend {
    override suspend fun people(): List<KioskPersonRow> = db.people().all().map { it.toRow() }
    override suspend fun status(personId: String) = api.timeclockStatus(personId, zone())
    override suspend fun clockIn(personId: String): KioskTimeclockStatus {
        val setup = prefs.setupSelection.first()
        return api.clockIn(ClockInIn(identity.get().serial, personId, setup?.siteId, setup?.initiativeId, zone()))
    }
    override suspend fun clockOut(personId: String) = api.clockOut(ClockOutIn(identity.get().serial, personId, zone()))
}

internal fun PersonEntity.toRow() = KioskPersonRow(
    id, displayName, firstName.orEmpty(), lastName.orEmpty(), preferredName, rfidTag, isWorker, hasAccount, badgeUid, jobTitle, externalId,
)

const val MAX_RESULTS = 8

internal const val NOT_FOUND = "We couldn't find that code."
private const val NO_NAME_MATCH = "No one matches that name."
private const val LOOKUP_UNREACHABLE = "Can't reach the portal. Try again."
private const val LOOKUP_FAILED = "Something went wrong. Try again."
private const val NO_PEOPLE = "No people on this kiosk. Sync from Kiosk Setup."
private const val PEOPLE_FAILED = "Can't load the people list. Try again shortly."

/** Everything a screen draws: the reducer's [flow] plus what only the view model needs. */
data class TcUi(
    val mode: TcMode,
    val flow: TcState,
    /** The Enter Your Name box, or Welcome's unseen reader value. */
    val query: String = "",
    val results: List<PersonEntity> = emptyList(),
    val message: String? = null,
    /** A status read for a person just found is in flight. */
    val looking: Boolean = false,
    /** A status re-read after a 409 is in flight. */
    val refreshing: Boolean = false,
    /** Null until the first people read lands. */
    val rosterSize: Int? = null,
    val peopleFailed: Boolean = false,
) {
    val step: TcStep get() = flow.step
    val busy: Boolean get() = flow.busy || refreshing
    val hasBack: Boolean get() = step == TcStep.NAME || step == TcStep.CONFIRM || step == TcStep.ACTION || step == TcStep.CLOCK_OUT
    /** The box has text but nobody matches it (and no message says otherwise). */
    val noMatches: Boolean get() = rosterSize != null && step == TcStep.NAME && query.isNotBlank() && results.isEmpty() && message == null
    val shownMessage: String? get() = message
        ?: (if (peopleFailed && rosterSize == null) PEOPLE_FAILED else null)
        ?: (if (mode == TcMode.KIOSK && rosterSize == 0) NO_PEOPLE else null)
}

/**
 * The guided time clock's side effects (kiosk/src/timeclock/TimeclockFlow.tsx): the people list,
 * matching, the status read, the punch, the flash and sound, and the timers. Transitions are
 * [reduce]'s. The state lives here, not in the composables, so a rotation keeps the step, the
 * person and the typed text.
 *
 * Two guards keep a punch honest:
 *  - one punch per tap: the reducer ignores the punch-starting events while busy, and a punch is
 *    sent only when an event takes the state into busy, so a double tap can never send two;
 *  - one person per answer: every lookup gets a fresh session number and leaving bumps it, so a
 *    status or punch that answers late is dropped rather than painted over the next person.
 *
 * Try again after a failed punch re-reads the status first: a punch whose answer was lost may
 * still have been recorded, and then the re-read shows it rather than a second punch going out.
 *
 * In KIOSK mode leaving (Done, idle, Back on Enter Your Name) emits on [exits] for the screen to
 * go Home; in STATION mode it returns to Welcome. The screen forwards scans ([onScan]), hardware
 * and on-screen keys ([onType], [onSearch]) and every touch or key ([onActivity]).
 */
class TimeclockFlowViewModel(
    val mode: TcMode,
    private val backend: TcBackend,
    private val flash: FlashController,
    private val sound: SoundPlayer?,
    appearance: Flow<Appearance>,
    /** Emits when the people list should be read again: KIOSK when a sync finishes, STATION
     *  while paused (a retry) or when a missing key arrives. */
    peopleReloads: Flow<Unit> = emptyFlow(),
    scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(TcUi(mode, initialState(mode)))
    val state: StateFlow<TcUi> = _state
    private val exitChannel = Channel<Unit>(Channel.CONFLATED)
    val exits: Flow<Unit> = exitChannel.receiveAsFlow()

    @Volatile private var look: Appearance = DEFAULT_APPEARANCE
    private var index: PeopleIndex<PersonEntity>? = null
    private var session = 0
    private var peopleRead = 0
    private var idleJob: Job? = null
    private var stepJob: Job? = null
    private var messageJob: Job? = null
    private var quietJob: Job? = null

    init {
        scope.launch { appearance.collect { look = it } }
        loadPeople()
        scope.launch { peopleReloads.collect { loadPeople() } }
    }

    // ---- the reducer ----

    private fun apply(event: TcEvent): Pair<TcState, TcState> {
        val prev = _state.value.flow
        val next = reduce(prev, event, mode)
        if (next !== prev) {
            _state.update { it.copy(flow = next) }
            if (next.step != prev.step) onStep(prev.step, next.step)
        }
        return prev to next
    }

    private fun onStep(prev: TcStep, next: TcStep) {
        stepJob?.cancel(); stepJob = null
        when (next) {
            TcStep.PRINTING -> stepJob = scope.launch { delay(PRINTING_MS); apply(TcEvent.PrintingDone) }
            TcStep.DONE -> stepJob = scope.launch { delay(DONE_MS); leave() }
            else -> {}
        }
        val start = startStep(mode)
        // Back at the start: read the people again, so a station running all day picks up new hires.
        if (next == start && prev != start) loadPeople()
        val idle = next != start && next != TcStep.DONE
        if (!idle) { idleJob?.cancel(); idleJob = null } else if (idleJob == null) startIdle()
    }

    private fun startIdle() {
        idleJob?.cancel()
        idleJob = scope.launch { delay(IDLE_MS); idleJob = null; leave() }
    }

    // ---- people ----

    private fun loadPeople() {
        val mine = ++peopleRead
        scope.launch {
            try {
                val people = read { backend.people() }.map { it.toEntity() }
                if (mine != peopleRead) return@launch
                val idx = buildPeopleIndex(people)
                index = idx
                _state.update { it.copy(rosterSize = people.size, peopleFailed = false, results = resultsFor(it.step, it.query, idx)) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (mine == peopleRead) _state.update { it.copy(peopleFailed = true) }
            }
        }
    }

    private fun resultsFor(step: TcStep, query: String, idx: PeopleIndex<PersonEntity>?): List<PersonEntity> =
        if (idx != null && step == TcStep.NAME && query.isNotBlank()) searchPeople(idx, query, MAX_RESULTS) else emptyList()

    private fun setQuery(value: String) {
        _state.update { it.copy(query = value, results = resultsFor(it.step, value, index)) }
        quietJob?.cancel(); quietJob = null
        // Welcome's unseen reader value: one nobody finished is forgotten after a moment of quiet,
        // so it can't spoil the next scan; one that waited only because it was also the start of
        // a longer tag is settled instead (the reader has stopped, so the exact match was meant).
        if (_state.value.step == TcStep.WELCOME && value.isNotEmpty()) {
            quietJob = scope.launch {
                delay(SCAN_QUIET_MS)
                quietJob = null
                val ui = _state.value
                if (ui.step != TcStep.WELCOME || ui.looking) return@launch
                val exact = index?.let { matchPersonExact(it, ui.query) }
                if (exact != null) identify(exact) else setQuery("")
            }
        }
    }

    private fun showMessage(text: String?) {
        messageJob?.cancel(); messageJob = null
        _state.update { it.copy(message = text) }
        if (text != null) messageJob = scope.launch { delay(MESSAGE_MS); _state.update { it.copy(message = null) } }
    }

    private fun typing(ui: TcUi) = ui.step == TcStep.WELCOME || ui.step == TcStep.NAME

    // ---- finding a person ----

    /** Every keystroke (on-screen or hardware). A value that names exactly one person selects them
     *  at once, unless it is also the start of a longer tag ("1003" vs "100348"), when Enter (or
     *  the rest of the scan) decides. */
    fun onType(next: String) {
        val ui = _state.value
        if (ui.looking || !typing(ui)) return
        if (ui.message != null) showMessage(null)
        val idx = index
        if (idx != null && !isAmbiguousPrefix(idx, next)) {
            matchPersonExact(idx, next)?.let { identify(it); return }
        }
        setQuery(next)
    }

    /** Search on the keyboard, or Enter. */
    fun onSearch() {
        val ui = _state.value
        val raw = ui.query.trim()
        val idx = index
        if (raw.isEmpty() || idx == null || ui.looking || !typing(ui)) return
        matchPersonExact(idx, raw)?.let { identify(it); return }
        if (ui.step == TcStep.NAME) {
            val rows = searchPeople(idx, raw, MAX_RESULTS)
            if (rows.size == 1) identify(rows[0]) else if (rows.isEmpty()) notFound(NO_NAME_MATCH, clear = false)
            return
        }
        notFound(NOT_FOUND, clear = true)
    }

    /** A whole scan from the bus (DataWedge, the camera). Only Welcome and Enter Your Name take
     *  one; a code nobody owns (an asset label, a stranger's QR) is not found. */
    fun onScan(value: String) {
        val ui = _state.value
        if (ui.looking || !typing(ui)) return
        val hit = index?.let { matchPersonExact(it, value) }
        if (hit != null) identify(hit) else notFound(NOT_FOUND, clear = true)
    }

    /** A tap on a search result. */
    fun pick(person: PersonEntity) {
        val ui = _state.value
        if (ui.looking || ui.step != TcStep.NAME) return
        identify(person)
    }

    private fun notFound(text: String, clear: Boolean) {
        bad()
        if (clear) setQuery("")
        showMessage(text)
    }

    private fun identify(person: PersonEntity) {
        val mine = ++session
        quietJob?.cancel(); quietJob = null
        showMessage(null)
        _state.update { it.copy(query = "", results = emptyList(), looking = true) }
        scope.launch {
            try {
                val status = read { backend.status(person.id) }
                if (mine != session) return@launch
                _state.update { it.copy(looking = false) }
                good()
                apply(TcEvent.Identified(status))
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (mine != session) return@launch
                _state.update { it.copy(looking = false) }
                bad()
                val code = codeOf(e)
                showMessage(if (code == "network" || code == "edge_offline") LOOKUP_UNREACHABLE else LOOKUP_FAILED)
            }
        }
    }

    // ---- the steps ----

    fun enterName() { setQuery(""); showMessage(null); apply(TcEvent.EnterName) }
    fun confirmYes() { apply(TcEvent.ConfirmYes) }
    fun confirmNo() { setQuery(""); apply(TcEvent.ConfirmNo) }
    fun chooseIn() { punch(TcEvent.ChooseIn, Punched.IN, recheck = false) }
    fun chooseOut() { apply(TcEvent.ChooseOut) }
    fun confirmClockOut() { punch(TcEvent.PunchStarted, Punched.OUT, recheck = false) }
    /** Try again after a failed punch: the same punch, after a fresh status read. */
    fun retry() { punch(TcEvent.PunchStarted, if (_state.value.step == TcStep.CLOCK_OUT) Punched.OUT else Punched.IN, recheck = true) }
    fun badgeNew() { apply(TcEvent.BadgeNew) }
    fun badgeExisting() { apply(TcEvent.BadgeExisting) }
    fun verifyContinue() { apply(TcEvent.VerifyContinue) }
    /** All Set's Done. */
    fun done() { leave() }

    /** Back to the start from any step (a station that pauses or loses its key mid-flow). */
    fun reset() { if (_state.value.step != startStep(mode)) leave() }

    fun back() {
        val ui = _state.value
        if (ui.busy || !ui.hasBack) return
        if (ui.step == TcStep.NAME) {
            session++                                // a lookup still in flight loses the screen
            showMessage(null)
            _state.update { it.copy(looking = false) }
            setQuery("")
            if (mode == TcMode.KIOSK) { leave(); return }
        }
        apply(TcEvent.Back)
    }

    /** A touch or key anywhere: the idle countdown starts again. */
    fun onActivity() { if (idleJob != null) startIdle() }

    /** Leaves the flow: back to Welcome on a station, out to Home on a kiosk. */
    private fun leave() {
        session++
        quietJob?.cancel(); quietJob = null
        showMessage(null)
        _state.update { it.copy(query = "", results = emptyList(), looking = false, refreshing = false) }
        apply(TcEvent.Reset)
        if (mode == TcMode.KIOSK) exitChannel.trySend(Unit)
    }

    // ---- punches ----

    /** Sends a punch only when [event] takes the flow into busy. */
    private fun punch(event: TcEvent, kind: Punched, recheck: Boolean) {
        if (_state.value.refreshing) return
        val (prev, next) = apply(event)
        if (!prev.busy && next.busy) send(kind, recheck)
    }

    private fun send(kind: Punched, recheck: Boolean) {
        val status = _state.value.flow.status ?: return
        val mine = session
        val personId = status.person.id
        scope.launch {
            try {
                if (recheck) {
                    val fresh = read { backend.status(personId) }
                    if (mine != session) return@launch
                    val landed = if (kind == Punched.IN) fresh.clocked_in else !fresh.clocked_in
                    if (landed) {
                        good()
                        apply(TcEvent.PunchSucceeded(fresh, kind))
                        return@launch
                    }
                }
                // No timeout: a punch that is slow may still be recorded, so it is never abandoned.
                val next = if (kind == Punched.IN) backend.clockIn(personId) else backend.clockOut(personId)
                if (mine != session) return@launch
                good()
                apply(TcEvent.PunchSucceeded(next, kind))
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (mine != session) return@launch
                bad()
                val code = codeOf(e)
                apply(TcEvent.PunchFailed(code))
                // Someone punched elsewhere in between: the portal knows better than the screen,
                // so re-read and let them choose again.
                if (code == "already_clocked_in" || code == "not_clocked_in") refresh(personId, mine)
            }
        }
    }

    private fun refresh(personId: String, mine: Int) {
        _state.update { it.copy(refreshing = true) }
        scope.launch {
            try {
                val fresh = read { backend.status(personId) }
                if (mine != session) return@launch
                _state.update { it.copy(refreshing = false) }
                apply(TcEvent.StatusRefreshed(fresh))
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                if (mine == session) _state.update { it.copy(refreshing = false) }
            }
        }
    }

    // ---- helpers ----

    /** A read that gives up after [READ_TIMEOUT_MS] as a network failure. */
    private suspend fun <T : Any> read(block: suspend () -> T): T =
        withTimeoutOrNull(READ_TIMEOUT_MS) { block() } ?: throw ApiError(0, "network")

    private fun codeOf(e: Throwable): String = (e as? ApiError)?.code ?: "unknown_error"

    private fun good() { val a = look; flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }
    private fun bad() { val a = look; flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
}
