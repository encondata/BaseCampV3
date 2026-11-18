package com.serversherpa.kiosk.ui.screens.notifications

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskNotification
import com.serversherpa.kiosk.core.model.KioskNotificationsPage
import com.serversherpa.kiosk.core.model.PushSnooze
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.assertNothingClippedHorizontally
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Notifications page (spec: "Android app" › Notifications page), on a standard (360 dp) and a
 *  compact (320 dp) phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class NotificationsScreenTest {
    @get:Rule val compose = createComposeRule()

    private val now: Instant = Instant.now()

    private fun item(id: String, title: String, minutesAgo: Long = 1, read: Boolean = false, snoozedUntil: Instant? = null) =
        KioskNotification(
            id = id, kind = "off_move_alert", category = "moves", title = title, body = "Body of $title",
            created_at = now.minusSeconds(minutesAgo * 60).toString(),
            read_at = if (read) now.minusSeconds(30).toString() else null,
            push_snoozed_until = snoozedUntil?.toString(),
        )

    private fun admin(vararg pages: KioskNotificationsPage): Pair<AppContainer, FakeKioskApi> {
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession(roles = listOf("admin"), maxRank = 60) }
            var n = 0
            listNotificationsResult = { pages[minOf(n++, pages.size - 1)] }
        }
        val c = testContainer(api = api)
        runBlocking { c.identity.get(); c.auth.login("tina@example.com", "pw") }
        return c to api
    }

    private fun show(c: AppContainer, highlight: String? = null) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { NotificationsScreen(highlightId = highlight) } }
        }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun inRow(id: String, text: String): SemanticsNodeInteraction =
        compose.onNode(hasText(text) and hasAnyAncestor(hasTestTag("notification-$id")))

    private fun inRowCount(id: String, text: String): Int =
        compose.onAllNodes(hasText(text) and hasAnyAncestor(hasTestTag("notification-$id"))).fetchSemanticsNodes().size

    private fun hhmm(at: Instant) = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(at)

    // ── lists_items_newest_first ──

    private fun listsItemsNewestFirst() {
        val (c, _) = admin(KioskNotificationsPage(unread_count = 2, total = 3, items = listOf(
            item("n3", "Newest", minutesAgo = 1),
            item("n2", "Middle", minutesAgo = 5, read = true),
            item("n1", "Oldest", minutesAgo = 9),
        )))
        show(c)
        waitForTag("notification-n3")
        // Each row sits below the one before it (scrolled to on a short screen, so both are laid out).
        for ((above, below) in listOf("n3" to "n2", "n2" to "n1")) {
            compose.onNodeWithTag("notifications-list").performScrollToNode(hasTestTag("notification-$below"))
            fun top(id: String) = compose.onNodeWithTag("notification-$id").fetchSemanticsNode().positionInRoot.y
            assertTrue("$above above $below", top(above) < top(below))
        }
        compose.onNodeWithTag("notifications-list").performScrollToNode(hasTestTag("notification-n3"))
        // Title, body, a 24-hour time, and the unread dot on unread rows only.
        inRow("n3", "Newest").assertIsDisplayed()
        inRow("n3", "Body of Newest").assertIsDisplayed()
        compose.onNode(hasTestTag("unread-dot") and hasAnyAncestor(hasTestTag("notification-n3"))).assertExists()
        compose.onNode(hasTestTag("unread-dot") and hasAnyAncestor(hasTestTag("notification-n2"))).assertDoesNotExist()
        val time = notificationTimeLabel(now.minusSeconds(60).toString(), now)
        assertTrue("24-hour time, got $time", Regex("""(\w{3} \d{1,2}, )?\d{2}:\d{2}""").matches(time))
        assertFalse(time.contains("AM") || time.contains("PM"))
    }

    @Test fun lists_items_newest_first() = listsItemsNewestFirst()
    @Test @Config(qualifiers = "w320dp-h470dp") fun lists_items_newest_first_compact() {
        listsItemsNewestFirst()
        compose.assertNothingClippedHorizontally("notifications list")
    }

    // ── unread_row_has_mark_read_snooze_hide ──

    private fun unreadRowHasMarkReadSnoozeHide() {
        val (c, api) = admin(KioskNotificationsPage(unread_count = 1, total = 1, items = listOf(item("n1", "Off-move alert"))))
        val until = now.plusSeconds(300)
        api.snoozeResult = { PushSnooze(until.toString()) }
        show(c)
        waitForTag("notification-n1")
        inRow("n1", "Mark read").assertIsDisplayed()
        inRow("n1", "Snooze").assertIsDisplayed()
        inRow("n1", "Hide").assertIsDisplayed()
        assertEquals(0, inRowCount("n1", "Mark unread"))
        // Snooze: the server says until when, and the row says so.
        inRow("n1", "Snooze").performClick()
        compose.waitUntilIdlingMain { "snooze:n1" in api.calls }
        waitForText("Snoozed until ${hhmm(until)}")
        // Mark read: the row turns into a read row.
        inRow("n1", "Mark read").performClick()
        compose.waitUntilIdlingMain { "markRead:n1" in api.calls }
        waitForText("Mark unread")
        assertEquals(0, inRowCount("n1", "Snooze"))
        assertEquals(0, inRowCount("n1", "Mark read"))
        compose.onNode(hasTestTag("unread-dot") and hasAnyAncestor(hasTestTag("notification-n1"))).assertDoesNotExist()
    }

    @Test fun unread_row_has_mark_read_snooze_hide() = unreadRowHasMarkReadSnoozeHide()
    @Test @Config(qualifiers = "w320dp-h470dp") fun unread_row_has_mark_read_snooze_hide_compact() {
        unreadRowHasMarkReadSnoozeHide()
        compose.assertNothingClippedHorizontally("a row after Mark read")
    }

    // ── read_row_has_mark_unread_hide ──

    private fun readRowHasMarkUnreadHide() {
        val (c, api) = admin(KioskNotificationsPage(unread_count = 0, total = 1, items = listOf(item("n1", "Shipment delivered", read = true))))
        show(c)
        waitForTag("notification-n1")
        inRow("n1", "Mark unread").assertIsDisplayed()
        inRow("n1", "Hide").assertIsDisplayed()
        assertEquals(0, inRowCount("n1", "Snooze"))
        assertEquals(0, inRowCount("n1", "Mark read"))
        inRow("n1", "Hide").performClick()
        compose.waitUntilIdlingMain { "hide:n1" in api.calls }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("notification-n1")).fetchSemanticsNodes().isEmpty() }
        waitForText(NO_NOTIFICATIONS)
    }

    @Test fun read_row_has_mark_unread_hide() = readRowHasMarkUnreadHide()
    @Test @Config(qualifiers = "w320dp-h470dp") fun read_row_has_mark_unread_hide_compact() {
        val (c, _) = admin(KioskNotificationsPage(total = 1, items = listOf(item("n1", "Shipment delivered", read = true))))
        show(c)
        waitForTag("notification-n1")
        compose.assertNothingClippedHorizontally("a read row")
        inRow("n1", "Mark unread").assertIsDisplayed()
        inRow("n1", "Hide").assertIsDisplayed()
    }

    @Test fun mark_unread_turns_the_row_back_to_unread() {
        val (c, api) = admin(KioskNotificationsPage(total = 1, items = listOf(item("n1", "Shipment delivered", read = true))))
        show(c)
        waitForTag("notification-n1")
        inRow("n1", "Mark unread").performClick()
        compose.waitUntilIdlingMain { "markUnread:n1" in api.calls }
        waitForText("Mark read")
        inRow("n1", "Snooze").assertIsDisplayed()
    }

    // ── snoozed_label_24h ──

    private fun snoozedLabel24h() {
        val until = now.plusSeconds(180)
        val (c, _) = admin(KioskNotificationsPage(unread_count = 1, total = 2, items = listOf(
            item("n2", "Snoozed one", snoozedUntil = until),
            item("n1", "Snooze over", minutesAgo = 20, snoozedUntil = now.minusSeconds(600)),
        )))
        show(c)
        waitForTag("notification-n1")
        val label = "Snoozed until ${hhmm(until)}"
        inRow("n2", label).assertIsDisplayed()
        assertFalse(label.contains("AM") || label.contains("PM"))
        // A snooze that has already ended says nothing.
        assertEquals(0, compose.onAllNodes(hasText("Snoozed until", substring = true) and hasAnyAncestor(hasTestTag("notification-n1"))).fetchSemanticsNodes().size)
    }

    @Test fun snoozed_label_24h() = snoozedLabel24h()
    @Test @Config(qualifiers = "w320dp-h470dp") fun snoozed_label_24h_compact() {
        snoozedLabel24h()
        compose.assertNothingClippedHorizontally("a snoozed row")
    }

    @Test fun snooze_on_a_row_read_elsewhere_says_so_and_reloads() {
        val (c, api) = admin(
            KioskNotificationsPage(unread_count = 1, total = 1, items = listOf(item("n1", "Off-move alert"))),
            KioskNotificationsPage(unread_count = 0, total = 1, items = listOf(item("n1", "Off-move alert", read = true))),
        )
        api.snoozeResult = { throw com.serversherpa.kiosk.core.ApiError(409, "not_live") }
        show(c)
        waitForTag("notification-n1")
        inRow("n1", "Snooze").performClick()
        waitForText(notificationsErrorText(com.serversherpa.kiosk.core.ApiError(409, "not_live")))
        assertEquals("That notification was already read or hidden.", notificationsErrorText(com.serversherpa.kiosk.core.ApiError(409, "not_live")))
        waitForText("Mark unread")
        assertEquals(2, api.calls.count { it == "listNotifications" })
    }

    // ── empty_state ──

    private fun emptyState() {
        val (c, _) = admin(KioskNotificationsPage())
        show(c)
        waitForText(NO_NOTIFICATIONS)
        compose.onNodeWithText(NO_NOTIFICATIONS).assertIsDisplayed()
        assertEquals("No notifications.", NO_NOTIFICATIONS)
        compose.onNodeWithTag("notifications-refresh").assertIsDisplayed()
    }

    @Test fun empty_state() = emptyState()
    @Test @Config(qualifiers = "w320dp-h470dp") fun empty_state_compact() {
        emptyState()
        compose.assertNothingClippedHorizontally("the empty state")
    }

    // ── refresh_button_visible ──

    private fun many(count: Int, prefix: String = "n") = (1..count).map { item("$prefix$it", "Alert $prefix$it", minutesAgo = it.toLong()) }

    private fun refreshButtonVisible() {
        val (c, api) = admin(
            KioskNotificationsPage(unread_count = 30, total = 31, items = many(30), next_cursor = "c2"),
            KioskNotificationsPage(unread_count = 30, total = 31, items = listOf(item("m1", "Older one", minutesAgo = 99))),
        )
        show(c)
        waitForTag("notification-n1")
        // Pinned above the list, so a long list never hides it.
        compose.onNodeWithTag("notifications-refresh").assertIsDisplayed()
        compose.onNodeWithText("Refresh").assertIsDisplayed()
        // Load more sits at the end of the list and asks for the next page.
        compose.onNodeWithTag("notifications-list").performScrollToNode(hasTestTag("notifications-load-more"))
        compose.onNodeWithTag("notifications-load-more").assertIsDisplayed().performClick()
        compose.waitUntilIdlingMain { "c2" in api.notificationCursors }
        compose.onNodeWithTag("notifications-list").performScrollToNode(hasTestTag("notification-m1"))
        compose.onNodeWithTag("notification-m1").assertIsDisplayed()
        compose.onNodeWithTag("notifications-load-more").assertDoesNotExist()
        // The list still scrolled away from the top: Refresh is still on screen, and reloads.
        compose.onNodeWithTag("notifications-refresh").assertIsDisplayed().performClick()
        compose.waitUntilIdlingMain { api.calls.count { it == "listNotifications" } == 3 }
        assertEquals(listOf(null, "c2", null), api.notificationCursors)
    }

    @Test fun refresh_button_visible() = refreshButtonVisible()
    @Test @Config(qualifiers = "w320dp-h470dp") fun refresh_button_visible_compact() {
        refreshButtonVisible()
        compose.assertNothingClippedHorizontally("a long list")
    }

    // ── highlighted_item_not_marked_read ──

    private fun highlightedItemNotMarkedRead() {
        val (c, api) = admin(KioskNotificationsPage(unread_count = 30, total = 30, items = many(30)))
        show(c, highlight = "n25")
        waitForTag("notification-n25")
        // Scrolled to and outlined (selected), still unread, with its unread buttons.
        compose.onNodeWithTag("notification-n25").assertIsDisplayed().assertIsSelected()
        inRow("n25", "Mark read").assertIsDisplayed()
        compose.onNode(hasTestTag("unread-dot") and hasAnyAncestor(hasTestTag("notification-n25"))).assertExists()
        compose.waitForIdle()
        assertFalse(api.calls.any { it.startsWith("markRead") })
        // Only that row is outlined.
        compose.onNode(hasTestTag("notification-n24") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Selected, true))
            .assertDoesNotExist()
    }

    @Test fun highlighted_item_not_marked_read() = highlightedItemNotMarkedRead()
    @Test @Config(qualifiers = "w320dp-h470dp") fun highlighted_item_not_marked_read_compact() {
        highlightedItemNotMarkedRead()
        compose.assertNothingClippedHorizontally("a highlighted row")
    }

    @Test fun a_failed_load_says_so_and_refresh_tries_again() {
        val (c, api) = admin(KioskNotificationsPage(total = 1, items = listOf(item("n1", "Off-move alert"))))
        val ok = api.listNotificationsResult
        api.listNotificationsResult = { throw com.serversherpa.kiosk.core.ApiError(0, "network") }
        show(c)
        waitForText("No connection. Try again when you're back online.")
        api.listNotificationsResult = ok
        compose.onNodeWithTag("notifications-refresh").performClick()
        waitForTag("notification-n1")
        compose.onNodeWithText("No connection. Try again when you're back online.").assertDoesNotExist()
    }
}
