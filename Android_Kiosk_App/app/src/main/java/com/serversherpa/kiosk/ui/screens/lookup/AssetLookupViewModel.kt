package com.serversherpa.kiosk.ui.screens.lookup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.lookup.distinctTags
import com.serversherpa.kiosk.core.model.AssetScanRow
import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.lookup.AssetLookupRepository
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val LOOKUP_ERROR = "Couldn't look that up. Try again."
private const val LOAD_ERROR = "Couldn't load that asset."

/** An admin's scan history under the card. Hidden covers everyone it isn't for
 *  (and offline: the screen says it needs a connection when [LookupUi.offline]). */
sealed interface ScanHistory {
    object Hidden : ScanHistory
    object Loading : ScanHistory
    object Failed : ScanHistory
    data class Rows(val rows: List<AssetScanRow>) : ScanHistory
}

data class LookupUi(
    val value: String = "",
    val offline: Boolean = false,
    val list: KioskLookupResult? = null,
    val detail: KioskAssetDetail? = null,
    val miss: String? = null,
    val error: String? = null,
    val scans: ScanHistory = ScanHistory.Hidden,
    val notice: String? = null,
)

/**
 * Asset Lookup's state, a port of kiosk/src/pages/AssetLookup.tsx: one box, one
 * match opens the card, several show a list, none keeps the value and says so.
 * Read-only: nothing here records, queues or writes anything (no Outbox).
 *
 * Every lookup, pick and clear bumps [requestId]; an answer started under an
 * older id is dropped, so a slow first answer never replaces a newer one. The
 * screen feeds [onScan] from ScanBus and [onSweep] from the sled's bursts.
 */
class AssetLookupViewModel(
    private val repo: AssetLookupRepository,
    private val identity: Identity,
    private val isAdmin: () -> Boolean,
    private val canScans: () -> Boolean,
    scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _ui = MutableStateFlow(LookupUi())
    val ui: StateFlow<LookupUi> = _ui
    private val requestId = AtomicInteger(0)

    private fun current(mine: Int) = mine == requestId.get()

    fun onValueChange(v: String) = _ui.update { it.copy(value = v) }

    fun lookup() {
        val q = _ui.value.value.trim()
        if (q.isEmpty()) return                       // an empty Enter is a no-op
        val mine = requestId.incrementAndGet()
        // The box empties now, not on the answer: a second burst while this one
        // is in flight starts fresh instead of appending.
        _ui.value = LookupUi()
        scope.launch {
            try {
                val found = repo.find(identity.get().serial, q)
                if (!current(mine)) return@launch
                val matches = found.result.matches
                when (matches.size) {
                    0 -> _ui.update { it.copy(offline = found.offline, miss = q, value = q) }
                    1 -> {
                        _ui.update { it.copy(offline = found.offline) }
                        openAsset(matches[0].id, found.offline, mine)
                    }
                    else -> _ui.update { it.copy(offline = found.offline, list = found.result) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (current(mine)) _ui.update { it.copy(error = LOOKUP_ERROR, value = q) }
            }
        }
    }

    /** A scanner read: into the box, then looked up. */
    fun onScan(value: String) {
        _ui.update { it.copy(value = value) }
        lookup()
    }

    /** A sled sweep: one distinct tag is a scan; several can't be told apart. */
    fun onSweep(epcs: List<String>) {
        val tags = distinctTags(epcs)
        when {
            tags.isEmpty() -> return
            tags.size == 1 -> onScan(tags[0])
            else -> _ui.update { it.copy(notice = "${tags.size} tags read. Point the reader at one tag and try again.") }
        }
    }

    /** One row of the list: opened with the offline flag that list came with. */
    fun pick(id: String) {
        val mine = requestId.incrementAndGet()
        val wasOffline = _ui.value.offline
        _ui.update { it.copy(detail = null, error = null, scans = ScanHistory.Hidden, notice = null) }
        scope.launch {
            try {
                openAsset(id, wasOffline, mine)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (current(mine)) _ui.update { it.copy(error = LOOKUP_ERROR) }
            }
        }
    }

    fun clear() {
        requestId.incrementAndGet()
        _ui.value = LookupUi()
    }

    private suspend fun openAsset(id: String, wasOffline: Boolean, mine: Int) {
        val answer = repo.open(identity.get().serial, id, wasOffline, isAdmin())
        if (!current(mine)) return
        val detail = answer.detail
        if (detail == null) {
            _ui.update { it.copy(offline = answer.offline, error = LOAD_ERROR) }
            return
        }
        // History: online only, only for a device on a move, and only with scans:view.
        val full = detail.full
        val wantScans = full != null && full.moves.isNotEmpty() && !answer.offline && canScans()
        _ui.update {
            it.copy(offline = answer.offline, detail = detail,
                scans = if (wantScans) ScanHistory.Loading else ScanHistory.Hidden)
        }
        if (wantScans) loadScans(detail.id, mine)
    }

    /** Tied to the detail it was started for: dropped once anything newer began. */
    private fun loadScans(id: String, mine: Int) {
        scope.launch {
            val next = try {
                ScanHistory.Rows(repo.scans(identity.get().serial, id))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ScanHistory.Failed
            }
            if (current(mine)) _ui.update { it.copy(scans = next) }
        }
    }
}
