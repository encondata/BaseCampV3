package com.serversherpa.kiosk.ui.screens.notifications

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskNotification
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.push.OpenNotification
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.guards.AdminGate
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The words when a tapped alert belongs to someone other than the person signed in (spec:
 *  "Someone else signed in on the owner's phone"), naming the phone's owner when known. */
fun ownerMismatchText(owner: String?): String =
    if (owner.isNullOrBlank()) "This alert is for another person. Sign in as them to see it."
    else "This alert is for $owner. Sign in as $owner to see it."

/**
 * The Notifications route: [highlightId] and [ownerPersonId] come from a tapped alert (both null
 * from the Home tile). An alert for someone else never opens the signed-in person's inbox: it says
 * whose it is, with Sign out. Otherwise the inbox, for admins only (AdminGate).
 */
@Composable
fun NotificationsRoute(nav: NavHostController, highlightId: String?, ownerPersonId: String?) {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val me = (auth as? AuthState.Authed)?.person?.id ?: return
    if (ownerPersonId != null && ownerPersonId != me) {
        OwnerMismatch(onSignOut = {
            // On the app's scope, not this screen's (signing out disposes it). Once nobody is
            // signed in the alert is held again, so it opens when its owner signs in.
            container.scope.launch(Dispatchers.Main) {
                container.logout()
                highlightId?.let { container.pendingOpen.offer(OpenNotification(it, ownerPersonId)) }
                nav.navigate(Routes.LOGIN) { popUpTo(0) }
            }
        })
    } else {
        AdminGate(nav) { NotificationsScreen(highlightId) }
    }
}

/** "This alert is for <owner>": the owner's name from GET /kiosk/personal; the generic words
 *  when that call fails or nobody owns the phone now. */
@Composable
fun OwnerMismatch(onSignOut: () -> Unit) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val owner by produceState<Pair<Boolean, String?>>(false to null, container) {
        val name = try { container.api.getPersonal().ownerName } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
        // the call can resume on an OkHttp/IO thread: Compose state is written on the main thread
        withContext(Dispatchers.Main.immediate) { value = true to name }
    }
    Column(Modifier.fillMaxWidth()) {
        PageHeader("Kiosk · Notifications", "Notifications")
        if (owner.first) {
            Text(ownerMismatchText(owner.second), style = MaterialTheme.typography.bodyLarge, color = c.textDark, modifier = Modifier.padding(bottom = 16.dp))
        }
        MiniButton("Sign out", onSignOut, modifier = Modifier.testTag("mismatch-sign-out"))
    }
}

/** The inbox page; [highlightId] is outlined and scrolled to, never marked read by opening it. */
@Composable
fun NotificationsScreen(highlightId: String? = null) {
    val container = LocalAppContainer.current
    val vm = kioskViewModel { NotificationsViewModel(container.api, highlightId) }
    LaunchedEffect(vm) { vm.refresh() }
    NotificationsContent(vm)
}

/**
 * Newest first, each row with its buttons inside it. Refresh sits above the list, so a long list
 * never hides it; Load more ends the list when there is another page (spec sketch).
 */
@Composable
internal fun NotificationsContent(vm: NotificationsViewModel) {
    val c = LocalKioskColors.current
    // Collected on the main thread (like Settings' rows), so Compose state is never written off it.
    val ui by vm.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    val listState = rememberLazyListState()
    // "Now" for the time labels and the snooze lines: taken again when the list changes, and when
    // the next snooze on screen ends, so its line goes then.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(ui.items) { now = Instant.now() }
    val nextEnd = ui.items.mapNotNull { parseTime(it.push_snoozed_until) }.filter { it.isAfter(now) }.minOrNull()
    LaunchedEffect(nextEnd) {
        if (nextEnd != null) {
            delay(Duration.between(Instant.now(), nextEnd).toMillis().coerceAtLeast(0) + 500)
            now = Instant.now()
        }
    }
    // The tapped alert's row: scrolled to once, the first time it is in the list.
    var scrolledToHighlight by rememberSaveable { mutableStateOf(false) }
    val highlightIndex = ui.items.indexOfFirst { it.id == ui.highlightId }
    LaunchedEffect(highlightIndex) {
        if (highlightIndex >= 0 && !scrolledToHighlight) {
            listState.scrollToItem(highlightIndex)
            scrolledToHighlight = true
        }
    }

    Column(Modifier.fillMaxSize()) {
        PageHeader("Kiosk · Notifications", "Notifications")
        MiniButton("Refresh", vm::refresh, enabled = !ui.loading, modifier = Modifier.padding(bottom = 8.dp).testTag("notifications-refresh"))
        ui.error?.let { KioskToast(it, error = true) }
        when {
            !ui.loaded -> if (ui.loading) Text("Loading…", style = MaterialTheme.typography.bodyLarge, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
            ui.items.isEmpty() -> Text(NO_NOTIFICATIONS, style = MaterialTheme.typography.bodyLarge, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
            else -> LazyColumn(
                Modifier.weight(1f).fillMaxWidth().testTag("notifications-list"),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(top = 4.dp, bottom = 8.dp),
            ) {
                items(ui.items, key = { it.id }) { n ->
                    NotificationRow(
                        n, now = now, highlighted = n.id == ui.highlightId, busy = n.id in ui.busy,
                        onMarkRead = { vm.markRead(n.id) }, onMarkUnread = { vm.markUnread(n.id) },
                        onSnooze = { vm.snooze(n.id) }, onHide = { vm.hide(n.id) },
                    )
                }
                if (ui.nextCursor != null) item(key = "load-more") {
                    MiniButton("Load more", vm::loadMore, enabled = !ui.loadingMore, modifier = Modifier.fillMaxWidth().testTag("notifications-load-more"))
                }
            }
        }
    }
}

/** One notification: the unread dot, title and 24-hour time, the body, "Snoozed until HH:MM",
 *  then its buttons (Mark read, Snooze, Hide unread; Mark unread, Hide read), wrapping on a
 *  narrow phone. The tapped alert's row is outlined in the accent. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NotificationRow(
    n: KioskNotification, now: Instant, highlighted: Boolean, busy: Boolean,
    onMarkRead: () -> Unit, onMarkUnread: () -> Unit, onSnooze: () -> Unit, onHide: () -> Unit,
) {
    val c = LocalKioskColors.current
    val unread = n.read_at == null
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier.fillMaxWidth().testTag("notification-${n.id}").semantics { selected = highlighted }
            .clip(shape).background(c.paper)
            .border(if (highlighted) 2.dp else 1.dp, if (highlighted) c.accent else c.paperLine, shape)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (unread) {
                Box(Modifier.padding(end = 8.dp).size(10.dp).clip(CircleShape).background(c.accent).testTag("unread-dot").semantics { contentDescription = "Unread" })
            }
            Text(
                n.title, style = MaterialTheme.typography.titleMedium, color = c.textDark,
                fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal, modifier = Modifier.weight(1f),
            )
            Text(
                notificationTimeLabel(n.created_at, now), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium,
                color = c.textMute, maxLines = 1, softWrap = false, modifier = Modifier.padding(start = 8.dp),
            )
        }
        if (n.body.isNotBlank()) {
            Text(n.body, style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
        }
        snoozedLabel(n.push_snoozed_until, now)?.let {
            Text(it, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
        }
        FlowRow(
            Modifier.padding(top = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (unread) {
                MiniButton("Mark read", onMarkRead, enabled = !busy)
                MiniButton("Snooze", onSnooze, enabled = !busy)
            } else {
                MiniButton("Mark unread", onMarkUnread, enabled = !busy)
            }
            MiniButton("Hide", onHide, enabled = !busy)
        }
    }
}
