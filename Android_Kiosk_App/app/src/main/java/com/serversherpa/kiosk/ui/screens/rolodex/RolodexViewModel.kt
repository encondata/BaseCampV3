package com.serversherpa.kiosk.ui.screens.rolodex

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.room.withTransaction
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.RolodexDetail
import com.serversherpa.kiosk.core.model.RolodexOptions
import com.serversherpa.kiosk.core.model.RolodexPhotoOut
import com.serversherpa.kiosk.core.model.RolodexRow
import com.serversherpa.kiosk.core.people.FILTER_ALL
import com.serversherpa.kiosk.core.people.FILTER_NO_PHOTO
import com.serversherpa.kiosk.core.people.RolodexEdit
import com.serversherpa.kiosk.core.people.RolodexSortKey
import com.serversherpa.kiosk.core.people.buildPatch
import com.serversherpa.kiosk.core.people.filterCounts
import com.serversherpa.kiosk.core.people.groupSections
import com.serversherpa.kiosk.core.people.matchesTerms
import com.serversherpa.kiosk.core.people.passesFilter
import com.serversherpa.kiosk.core.people.queryTerms
import com.serversherpa.kiosk.core.people.searchWords
import com.serversherpa.kiosk.core.people.sectionLetter
import com.serversherpa.kiosk.core.people.sortKey
import com.serversherpa.kiosk.core.people.validate
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.rolodex.RolodexCacheStore
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable

/** How long a Rolodex read may take before it counts as no connection (a long list on a slow link). */
internal const val ROLODEX_READ_TIMEOUT_MS = 20_000L

/**
 * The offline copy of the list, kept by [RolodexCacheStore] in the Room `meta` table: the rows and
 * options as last loaded, and when. [RolodexRow] has no email or phone, so neither is ever stored.
 */
@Serializable
internal data class RolodexCache(
    val cached_at: String,
    val workers: List<RolodexRow> = emptyList(),
    val options: RolodexOptions? = null,
)

data class RolodexUi(
    /** Every worker, sorted by last name, then first name. */
    val rows: List<RolodexRow> = emptyList(),
    /** The rows the search and the filter leave, in letter sections (A–Z, then #). */
    val sections: List<Pair<String, List<RolodexRow>>> = emptyList(),
    val query: String = "",
    /** [FILTER_ALL], a status key, or [FILTER_NO_PHOTO]. */
    val filter: String = FILTER_ALL,
    /** The filter chips in order, (key, label): All, one per status from the options, No photo. */
    val filters: List<Pair<String, String>> = listOf(FILTER_ALL to "All", FILTER_NO_PHOTO to "No photo"),
    /** Each chip's count, taken over the search-filtered list. */
    val counts: Map<String, Int> = emptyMap(),
    val selectedId: String? = null,
    /** The selected worker's page (with email and phone); null until it loads, and offline. */
    val detail: RolodexDetail? = null,
    val detailLoading: Boolean = false,
    /** The Edit form while it is open. A failed save keeps it as typed. */
    val editing: RolodexEdit? = null,
    val saving: Boolean = false,
    /** The list is being read from the server. */
    val loading: Boolean = false,
    /** The last list read failed for want of a connection: the list is the cached one, read-only. */
    val offline: Boolean = false,
    /** When the list on screen came from the server. */
    val cachedAt: Instant? = null,
    /** The worker page's error: a failed save, or a page that didn't load. */
    val error: String? = null,
    /** The list's error: no list to show, or the server refused it. */
    val listError: String? = null,
    val options: RolodexOptions = RolodexOptions(),
) {
    /** The selected worker's list row: the page shows it offline, and before the detail lands. */
    val selectedRow: RolodexRow? get() = selectedId?.let { id -> rows.firstOrNull { it.person_id == id } }

    /** "+ New" works online, once a list has loaded (a refused list leaves none), and not over an open Edit form. */
    val canStartNewWorker: Boolean get() = !offline && cachedAt != null && editing == null && !saving
}

/** The spec's words (§4.2) for an API error code; null and unknown codes get the catch-all. */
fun rolodexErrorText(code: String?): String = when (code) {
    "network", "edge_offline" -> "No connection. Try again when you're back online."
    "forbidden", "move_locked", "kiosk_session" -> "Your account can't use the Rolodex."
    "read_only_mode" -> "The system is in read-only mode, so changes can't be saved right now."
    "email_in_use" -> "Another person already uses that email."
    "rank_too_low" -> "This person has a portal login ranked above yours."
    "cannot_target_self" -> "You can't change your own status."
    "blacklist_requires_note" -> "Add a note to blacklist someone."
    "first_name_required", "last_name_required" -> "First and last name are required."
    "file_too_large", "empty_file", "invalid_file_type", "unreadable_image", "image_too_large" ->
        "That photo couldn't be used. Take or choose another one."
    else -> "Something went wrong. Try again."
}

/** The offline banner (spec §3.15): the time the list was loaded, with the day when it isn't today. */
internal fun offlineBannerText(cachedAt: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val at = cachedAt.atZone(zone)
    val time = at.format(DateTimeFormatter.ofPattern("h:mm a", Locale.US))
    val stamp = if (at.toLocalDate() == now.atZone(zone).toLocalDate()) time
    else at.format(DateTimeFormatter.ofPattern("MMM d", Locale.US)) + ", " + time
    return "Offline · showing the list from $stamp. Changes need a connection."
}

/** The status control's choices: the active statuses, plus the worker's own if the portal has retired it. */
internal fun editStatuses(options: RolodexOptions, detail: RolodexDetail): List<Pair<String, String>> {
    val active = options.statuses.map { it.key to it.label.ifBlank { it.key } }
    return if (detail.status.isBlank() || active.any { it.first == detail.status }) active
    else active + (detail.status to detail.status_label.ifBlank { detail.status })
}

/** The company picker: None, the non-archived partners, plus the worker's own company if it has since been archived (spec §3.9). */
internal fun companyChoices(options: RolodexOptions, detail: RolodexDetail): List<Pair<String?, String>> {
    val partners: List<Pair<String?, String>> = options.partners.map { it.id to it.name }
    val own = detail.company?.takeIf { c -> partners.none { it.first == c.id } }?.let { listOf<Pair<String?, String>>(it.id to it.name) }.orEmpty()
    return listOf<Pair<String?, String>>(null to "None") + partners + own
}

/** The level picker: None, then the scale ("L3 · Lead"), plus the worker's own level if it is missing from it. */
internal fun levelChoices(options: RolodexOptions, detail: RolodexDetail): List<Pair<String?, String>> {
    val levels: List<Pair<String?, String>> = options.levels.map { it.level to (if (it.title.isBlank()) it.level else "${it.level} · ${it.title}") }
    val own = detail.level?.takeIf { l -> levels.none { it.first == l } }?.let { listOf<Pair<String?, String>>(it to it) }.orEmpty()
    return listOf<Pair<String?, String>>(null to "None") + levels + own
}

/**
 * The person in the local people table (the Time Clock's offline roster) as the Rolodex now has
 * them, so the Time Clock finds them before the next sync. The RFID tag and badge, which the
 * detail doesn't carry, are kept.
 */
internal suspend fun KioskDatabase.upsertWorker(d: RolodexDetail) = withTransaction {
    val old = people().get(d.person_id)
    people().insertAll(listOf(PersonEntity(
        id = d.person_id, displayName = d.display_name, firstName = d.first_name, lastName = d.last_name,
        preferredName = d.preferred_name, rfidTag = old?.rfidTag, isWorker = true, hasAccount = d.has_account,
        badgeUid = old?.badgeUid, jobTitle = d.job_title, externalId = d.external_id,
    )))
}

/**
 * The Rolodex (spec §4.2–§4.3): the A–Z worker list with search and filters, the selected worker's
 * page and its Edit form. The list is cached in Room for offline reading; edits need a connection.
 * Reads give up after [ROLODEX_READ_TIMEOUT_MS]; writes run under NonCancellable, so leaving the
 * screen can't half-cancel a PATCH. The photo screens and the upload live in [photos], "+ New" in
 * [newWorker]; both run in this scope and report back here (a new photo, a created worker).
 */
class RolodexViewModel(
    private val api: KioskApi,
    private val db: KioskDatabase,
    /** The offline list's one owner (AppContainer.rolodexCache): it refuses writes once the admin has signed out. */
    private val cache: RolodexCacheStore,
    scopeOverride: CoroutineScope? = null,
    private val clock: () -> Instant = { Instant.now() },
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(RolodexUi(loading = true))
    val state: StateFlow<RolodexUi> = _state

    /** The camera badge's photo screens and the upload, plus new workers' photos that didn't upload (Try again). */
    val photos = RolodexPhotoFlow(api, scope, signedIn = { cache.adminSignedIn }, onUploaded = ::applyPhoto)

    /** "+ New". */
    val newWorker = NewWorkerFlow(api, scope, photos, signedIn = { cache.adminSignedIn }, onCreated = ::openCreated, onOpen = { select(it) })

    /** One worker with the parts the list needs worked out once: typing never folds the list again. */
    private class Entry(val row: RolodexRow, val key: RolodexSortKey, val words: List<String>, val letter: String)

    /** Every worker, sorted by [Entry.key]. Read and written on the scope's thread only. */
    private var index: List<Entry> = emptyList()
    private var rows: List<RolodexRow> = emptyList()
    private var loadJob: Job? = null
    private var detailJob: Job? = null

    init { load() }

    // ── the list ──

    /** Shows the cached list at once (if there is one), then reads the list from the server. */
    fun load() {
        if (loadJob?.isActive == true) return
        loadJob = scope.launch {
            if (index.isEmpty()) readCache()?.let { showCache(it) }
            fetch()
        }
    }

    /** Reads the list from the server again (the refresh action). */
    fun refresh() {
        if (loadJob?.isActive == true) return
        loadJob = scope.launch { fetch() }
    }

    fun setQuery(query: String) = _state.update { project(it.copy(query = query)) }

    fun setFilter(filter: String) = _state.update { project(it.copy(filter = filter)) }

    private suspend fun fetch() {
        _state.update { it.copy(loading = true, listError = null) }
        try {
            val (list, options) = coroutineScope {
                // The options only build the chips and pickers: without them the list still shows.
                val options = async {
                    try { read { api.rolodexOptions() } } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                }
                read { api.rolodexWorkers() } to options.await()
            }
            val now = clock()
            setIndex(withContext(Dispatchers.Default) { list.workers.map(::entry).sortedBy { it.key } })
            _state.update { project(it.copy(loading = false, offline = false, cachedAt = now, listError = null, options = options ?: it.options)) }
            writeCache()
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) {
            val err = e as? ApiError
            when {
                // No connection: the last list, read-only, with its time in the banner.
                err?.isNetwork == true -> {
                    if (index.isEmpty()) readCache()?.let { showCache(it) }
                    _state.update {
                        it.copy(loading = false, offline = true, listError = if (index.isEmpty()) rolodexErrorText("network") else null)
                    }
                }
                // Refused (no longer an admin, a move password): nothing may stay on screen or on disk.
                err?.status == 403 -> {
                    setIndex(emptyList())
                    deleteCache()
                    _state.update {
                        project(it.copy(loading = false, offline = false, cachedAt = null, listError = rolodexErrorText(err.code),
                            selectedId = null, detail = null, editing = null, error = null))
                    }
                }
                else -> _state.update { it.copy(loading = false, listError = rolodexErrorText(err?.code)) }
            }
        }
    }

    // ── the worker page ──

    /**
     * Opens [personId]'s page (null closes it). Tapping the open worker again retries a page that
     * failed to load. While a save runs, and while the Edit form is open, another worker can't be
     * opened (the form is closed with Save or Cancel first).
     */
    fun select(personId: String?) {
        val s = _state.value
        if (s.saving) return
        if (s.editing != null && personId != null && personId != s.selectedId) return
        if (personId != null && personId == s.selectedId && (s.detail != null || s.detailLoading)) return
        detailJob?.cancel()
        _state.update { it.copy(selectedId = personId, detail = null, editing = null, error = null, detailLoading = personId != null) }
        if (personId != null) detailJob = scope.launch { loadDetail(personId) }
    }

    private suspend fun loadDetail(personId: String) {
        try {
            val detail = read { api.rolodexWorker(personId) }
            if (_state.value.selectedId != personId) return
            replaceRow(detail.toRow())
            _state.update { project(it.copy(detail = detail, detailLoading = false, error = null)) }
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) {
            if (_state.value.selectedId != personId) return
            _state.update { it.copy(detailLoading = false, error = rolodexErrorText((e as? ApiError)?.code)) }
        }
    }

    /** Opens the Edit form on the worker's current values. Not offline, and not for someone the admin can't edit. */
    fun startEdit() {
        val s = _state.value
        val detail = s.detail ?: return
        if (!detail.can_edit || s.offline || s.editing != null || s.saving) return
        _state.update { it.copy(editing = RolodexEdit.from(detail), error = null) }
    }

    fun cancelEdit() {
        if (_state.value.saving) return
        _state.update { it.copy(editing = null, error = null) }
    }

    /** The form as typed. The status and its note stay put when the admin can't change this worker's status. */
    fun updateEdit(edit: RolodexEdit) {
        val s = _state.value
        val detail = s.detail ?: return
        if (s.editing == null || s.saving) return
        val kept = if (detail.can_change_status) edit else edit.copy(status = detail.status, statusNote = detail.status_note ?: "")
        _state.update { it.copy(editing = kept) }
    }

    /**
     * Sends only the changed fields (cleared ones as null). A second tap while saving does nothing.
     * A failure keeps the form as typed and shows the spec's words; success updates the page, the
     * list row, the offline copy and the Time Clock's roster.
     */
    fun save() {
        val s = _state.value
        val detail = s.detail ?: return
        val edit = s.editing ?: return
        if (s.saving) return
        validate(edit)?.let { problem -> _state.update { it.copy(error = problem) }; return }
        val patch = buildPatch(detail, edit)
        if (patch.isEmpty()) { _state.update { it.copy(editing = null, error = null) }; return }
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            try {
                // Not cancelled by leaving the screen: a PATCH the server may already have applied
                // runs to its answer, and the roster gets the result.
                val updated = withContext(NonCancellable) {
                    api.rolodexUpdate(detail.person_id, patch).also { saved ->
                        try { db.upsertWorker(saved) } catch (e: CancellationException) { throw e } catch (_: Exception) { /* the next people sync brings it */ }
                    }
                }
                replaceRow(updated.toRow())
                _state.update { project(it.copy(detail = updated, editing = null, saving = false, error = null)) }
                writeCache()
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                _state.update { it.copy(saving = false, error = rolodexErrorText((e as? ApiError)?.code)) }
            }
        }
    }

    // ── photos and new workers (spec §3.6, §3.17, §4.2) ──

    /** The camera badge: the photo sheet, for a worker the admin may edit, online. */
    fun startPhoto() {
        val s = _state.value
        val detail = s.detail ?: return
        if (!detail.can_edit || s.offline || s.editing != null || s.saving) return
        photos.start(PhotoTarget(detail.person_id, detail.display_name.ifBlank { "${detail.first_name} ${detail.last_name}".trim() }))
    }

    /** "+ New" ([RolodexUi.canStartNewWorker]). */
    fun startNewWorker() {
        if (!_state.value.canStartNewWorker) return
        newWorker.start()
    }

    /** Sends [jpeg] as [personId]'s photo; the page, the list row and the offline copy then show it. Throws the API's error. */
    suspend fun uploadPhoto(personId: String, jpeg: ByteArray): RolodexPhotoOut = photos.uploadPhoto(personId, jpeg)

    /** Try again for a new worker's photo that didn't upload. It needs a connection (spec §3.15). */
    fun retryPhoto(personId: String) {
        if (_state.value.offline) return
        photos.retry(personId)
    }

    /**
     * A worker just created: their page opens from the create's answer (no fetch), their row joins
     * the list (no reload), the Time Clock's roster has them, and the offline copy follows.
     */
    private suspend fun openCreated(created: RolodexDetail) {
        try { db.upsertWorker(created) } catch (e: CancellationException) { throw e } catch (_: Exception) { /* the next people sync brings them */ }
        replaceRow(created.toRow())
        detailJob?.cancel()
        _state.update { project(it.copy(selectedId = created.person_id, detail = created, detailLoading = false, editing = null, error = null)) }
        writeCache()
    }

    /** A new photo on the page and the list row (an open Edit form is left alone), then the offline copy. */
    private suspend fun applyPhoto(personId: String, out: RolodexPhotoOut) {
        index.firstOrNull { it.row.person_id == personId }?.row?.let {
            replaceRow(it.copy(has_photo = true, photo_url = out.photo_url, photo_version = out.photo_version))
        }
        _state.update { s ->
            val detail = s.detail?.takeIf { it.person_id == personId }?.copy(has_photo = true, photo_url = out.photo_url, photo_version = out.photo_version)
            project(s.copy(detail = detail ?: s.detail))
        }
        writeCache()
    }

    /** The spec's words for an API error code (§4.2). */
    fun errorText(code: String?): String = rolodexErrorText(code)

    // ── helpers ──

    private fun entry(row: RolodexRow) = Entry(row, sortKey(row), searchWords(row), sectionLetter(row.last_name))

    private fun setIndex(entries: List<Entry>) {
        index = entries
        rows = entries.map { it.row }
    }

    /** Puts [row] in place of the worker's old one; only that row is folded again. */
    private fun replaceRow(row: RolodexRow) {
        setIndex((index.filter { it.row.person_id != row.person_id } + entry(row)).sortedBy { it.key })
    }

    /** [s] with the list, sections, chips and counts worked out from the index, the query and the filter. */
    private fun project(s: RolodexUi): RolodexUi {
        val statuses = s.options.statuses.map { it.key to it.label.ifBlank { it.key } }
            .ifEmpty { rows.filter { it.status.isNotBlank() }.map { it.status to it.status_label.ifBlank { it.status } }.distinctBy { it.first } }
        val filters = listOf(FILTER_ALL to "All") + statuses + (FILTER_NO_PHOTO to "No photo")
        val filter = if (filters.any { it.first == s.filter }) s.filter else FILTER_ALL
        val terms = queryTerms(s.query)
        val searched = if (terms.isEmpty()) index else index.filter { matchesTerms(it.words, terms) }
        val counts = filterCounts(searched.map { it.row }, statuses.map { it.first })
        val shown = if (filter == FILTER_ALL) searched else searched.filter { passesFilter(it.row, filter) }
        return s.copy(
            rows = rows,
            sections = groupSections(shown) { it.letter }.map { (letter, entries) -> letter to entries.map { it.row } },
            filters = filters, filter = filter, counts = counts,
        )
    }

    private suspend fun showCache(cache: RolodexCache) {
        val at = try { Instant.parse(cache.cached_at) } catch (_: Exception) { null }
        setIndex(withContext(Dispatchers.Default) { cache.workers.map(::entry).sortedBy { it.key } })
        _state.update { project(it.copy(cachedAt = at, options = cache.options ?: it.options)) }
    }

    private suspend fun readCache(): RolodexCache? = try {
        cache.read()?.let { text ->
            withContext(Dispatchers.Default) { KioskJson.decodeFromString(RolodexCache.serializer(), text) }
        }
    } catch (e: CancellationException) { throw e } catch (_: Exception) { null }

    /** Best effort: a list that couldn't be cached still shows. The store refuses it after sign-out. */
    private suspend fun writeCache() {
        val s = _state.value
        val copy = RolodexCache((s.cachedAt ?: clock()).toString(), rows, s.options)
        try {
            val text = withContext(Dispatchers.Default) { KioskJson.encodeToString(RolodexCache.serializer(), copy) }
            cache.write(text)
        } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    }

    private suspend fun deleteCache() {
        try { cache.clear() } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    }

    /** A read that gives up after [ROLODEX_READ_TIMEOUT_MS] as no connection. */
    private suspend fun <T : Any> read(block: suspend () -> T): T =
        withTimeoutOrNull(ROLODEX_READ_TIMEOUT_MS) { block() } ?: throw ApiError(0, "network")
}
