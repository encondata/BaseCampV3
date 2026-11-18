package com.serversherpa.kiosk.ui.screens.notifications

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskNotification
import com.serversherpa.kiosk.data.api.KioskApi
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val NO_NOTIFICATIONS = "No notifications."

data class NotificationsUi(
    /** The inbox as loaded, newest first (the server's order); pages from Load more go after. */
    val items: List<KioskNotification> = emptyList(),
    /** The next page's cursor; null on the last page. */
    val nextCursor: String? = null,
    /** The first page is being read (the first load or a Refresh). */
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    /** A page has loaded at least once, so an empty list means an empty inbox. */
    val loaded: Boolean = false,
    /** The last read or button's error, in plain words. */
    val error: String? = null,
    /** Rows whose button call is in flight: their buttons wait. */
    val busy: Set<String> = emptySet(),
    /** The tapped alert's notification: outlined and scrolled to, never marked read by opening. */
    val highlightId: String? = null,
)

/** The page's words for a failed call. */
fun notificationsErrorText(e: Throwable): String {
    val code = (e as? ApiError)?.let { if (it.isNetwork) "network" else it.code }
    return when (code) {
        "network", "edge_offline" -> "No connection. Try again when you're back online."
        "not_live" -> "That notification was already read or hidden."
        "notification_not_found" -> "That notification is no longer in your inbox."
        "not_admin", "forbidden" -> "Your account can't see notifications here."
        "read_only_mode" -> "The system is in read-only mode, so changes can't be saved right now."
        else -> "Something went wrong. Try again."
    }
}

internal fun parseTime(iso: String?): Instant? = iso?.let {
    try { OffsetDateTime.parse(it).toInstant() } catch (_: Exception) { try { Instant.parse(it) } catch (_: Exception) { null } }
}

private val HHMM = DateTimeFormatter.ofPattern("HH:mm", Locale.US)
private val DAY_HHMM = DateTimeFormatter.ofPattern("MMM d, HH:mm", Locale.US)

/** A row's time, 24-hour: "14:32" today, "Nov 17, 14:32" on another day. */
fun notificationTimeLabel(createdAt: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val at = parseTime(createdAt)?.atZone(zone) ?: return ""
    return if (at.toLocalDate() == now.atZone(zone).toLocalDate()) at.format(HHMM) else at.format(DAY_HHMM)
}

/** "Snoozed until 14:37" while the snooze push is still to come; null otherwise. */
fun snoozedLabel(snoozedUntil: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
    val until = parseTime(snoozedUntil) ?: return null
    return if (until.isAfter(now)) "Snoozed until " + until.atZone(zone).format(HHMM) else null
}

/**
 * The Notifications page (spec: "Android app" › Notifications page): the signed-in admin's inbox
 * from GET /kiosk/notifications, with Mark read / Mark unread, Snooze and Hide on each row. The
 * screen calls [refresh] from its LaunchedEffect; nothing loads from init.
 */
class NotificationsViewModel(
    private val api: KioskApi,
    highlightId: String?,
    scopeOverride: CoroutineScope? = null,
    private val clock: () -> Instant = Instant::now,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(NotificationsUi(highlightId = highlightId))
    val state: StateFlow<NotificationsUi> = _state.asStateFlow()

    /** Reads the first page again (the first load, Refresh, and after a button the server refused). */
    fun refresh() {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true) }
        scope.launch {
            try {
                val page = api.listNotifications(null)
                _state.update { it.copy(items = page.items, nextCursor = page.next_cursor, loading = false, loaded = true, error = null) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = notificationsErrorText(e)) }
            }
        }
    }

    /** The next page, after the rows already shown (a row already there isn't repeated). */
    fun loadMore() {
        val s = _state.value
        val cursor = s.nextCursor ?: return
        if (s.loading || s.loadingMore) return
        _state.update { it.copy(loadingMore = true) }
        scope.launch {
            try {
                val page = api.listNotifications(cursor)
                _state.update { st ->
                    val have = st.items.map { it.id }.toSet()
                    st.copy(items = st.items + page.items.filter { it.id !in have }, nextCursor = page.next_cursor, loadingMore = false, error = null)
                }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                _state.update { it.copy(loadingMore = false, error = notificationsErrorText(e)) }
            }
        }
    }

    // Reading cancels a snooze on the server, so a read row shows none.
    fun markRead(id: String) = act(id, { api.markRead(id) }) { it.copy(read_at = clock().toString(), push_snoozed_until = null) }

    fun markUnread(id: String) = act(id, { api.markUnread(id) }) { it.copy(read_at = null) }

    fun snooze(id: String) {
        var until: String? = null
        act(id, { until = api.snooze(id).snoozedUntil }) { it.copy(push_snoozed_until = until) }
    }

    fun hide(id: String) {
        if (id in _state.value.busy) return
        _state.update { it.copy(busy = it.busy + id) }
        scope.launch {
            try {
                api.hide(id)
                _state.update { st -> st.copy(items = st.items.filterNot { it.id == id }, busy = st.busy - id, error = null) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) { failed(id, e) }
        }
    }

    /** One row's button: [call], then [change] to that row. */
    private fun act(id: String, call: suspend () -> Unit, change: (KioskNotification) -> KioskNotification) {
        if (id in _state.value.busy) return
        _state.update { it.copy(busy = it.busy + id) }
        scope.launch {
            try {
                call()
                _state.update { st -> st.copy(items = st.items.map { if (it.id == id) change(it) else it }, busy = st.busy - id, error = null) }
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) { failed(id, e) }
        }
    }

    /** Says why, and when the row has changed elsewhere (read or hidden, or gone) reloads the list
     *  so the row shows what it is now. */
    private fun failed(id: String, e: Exception) {
        _state.update { it.copy(busy = it.busy - id, error = notificationsErrorText(e)) }
        val code = (e as? ApiError)?.code
        if (code == "not_live" || code == "notification_not_found") reloadKeepingError()
    }

    private fun reloadKeepingError() {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true) }
        scope.launch {
            try {
                val page = api.listNotifications(null)
                _state.update { it.copy(items = page.items, nextCursor = page.next_cursor, loading = false, loaded = true) }
            } catch (e: CancellationException) { throw e
            } catch (_: Exception) {
                _state.update { it.copy(loading = false) }
            }
        }
    }
}
