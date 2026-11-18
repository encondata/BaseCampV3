package com.serversherpa.kiosk.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskNotification
import com.serversherpa.kiosk.core.model.KioskNotificationsPage
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.push.OpenNotification
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.notifications.ownerMismatchText
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tapping a push alert (spec: "Android app" › Tap; "Someone else signed in on the owner's phone"),
 * end to end through [KioskApp]: the tap leaves a one-shot pending open on the container
 * (MainActivity), and the app opens Notifications on that item once its owner is signed in, or
 * says whose alert it is when someone else is.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class NotificationTapRoutingTest {
    @get:Rule val compose = createComposeRule()

    private val page = KioskNotificationsPage(unread_count = 1, total = 1, items = listOf(
        KioskNotification(id = "n1", kind = "off_move_alert", title = "Off-move alert", body = "3 assets on DC1",
            created_at = java.time.Instant.now().minusSeconds(60).toString()),
    ))

    private fun kiosk(signedInAs: String?, personal: PersonalState = PersonalState(on = true, ownerName = "Tina T")): Pair<AppContainer, FakeKioskApi> {
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession(roles = listOf("admin"), maxRank = 60, personId = "p1") }
            listNotificationsResult = { page }
            getPersonalResult = { personal }
        }
        val c = testContainer(api = api)
        runBlocking {
            c.identity.get()
            if (signedInAs != null) c.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60, personId = signedInAs))
            else c.auth.restore()
        }
        return c to api
    }

    private fun start(c: AppContainer) {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskApp() } }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test fun tap_signed_out_routes_after_sign_in() {
        val (c, api) = kiosk(signedInAs = null)
        assertEquals(AuthState.Anon, c.auth.state.value)
        c.pendingOpen.offer(OpenNotification("n1", "p1"))
        start(c)
        waitForTag("login-email")
        // Held across the sign-in page: nothing opened yet.
        compose.onNodeWithTag("notification-n1").assertDoesNotExist()
        assertEquals(OpenNotification("n1", "p1"), c.pendingOpen.pending.value)
        compose.onNodeWithTag("login-email").performTextInput("tina@example.com")
        compose.onNodeWithTag("login-password").performTextInput("pw")
        compose.onNodeWithTag("login-submit").performScrollTo().performClick()
        waitForTag("notification-n1")
        compose.onNodeWithTag("notification-n1").assertIsDisplayed().assertIsSelected()
        // Consumed once, and the item is not marked read by opening it.
        assertNull(c.pendingOpen.pending.value)
        assertFalse(api.calls.any { it.startsWith("markRead") })
    }

    @Test fun tap_signed_in_as_owner_opens_page() {
        val (c, api) = kiosk(signedInAs = "p1")
        start(c)
        waitForText("What would you like to do?")
        // The tap arrives while the app is open (onNewIntent).
        compose.runOnIdle { c.pendingOpen.offer(OpenNotification("n1", "p1")) }
        waitForTag("notification-n1")
        compose.onNodeWithTag("notification-n1").assertIsDisplayed().assertIsSelected()
        assertNull(c.pendingOpen.pending.value)
        assertFalse(api.calls.any { it.startsWith("markRead") })
    }

    @Test fun tap_signed_in_as_other_shows_mismatch() {
        val (c, api) = kiosk(signedInAs = "p2", personal = PersonalState(on = false, ownerName = "Sam S"))
        c.pendingOpen.offer(OpenNotification("n1", "p1"))
        start(c)
        waitForText("This alert is for Sam S. Sign in as Sam S to see it.")
        assertEquals("This alert is for Sam S. Sign in as Sam S to see it.", ownerMismatchText("Sam S"))
        compose.onNodeWithTag("mismatch-sign-out").assertIsDisplayed()
        // The other person's inbox is never opened.
        assertFalse("listNotifications" in api.calls)
        compose.onNodeWithTag("notification-n1").assertDoesNotExist()
        // Sign out leads to sign-in, still holding the alert for its owner.
        compose.onNodeWithTag("mismatch-sign-out").performClick()
        waitForTag("login-email")
        assertEquals(AuthState.Anon, c.auth.state.value)
        // Sign-in shows as soon as the session ends; the alert is held again once logout() has
        // finished (its last step resumes on the main thread), so wait with the looper running.
        compose.waitUntil(5_000) { compose.waitForIdle(); c.pendingOpen.pending.value != null }
        assertEquals(OpenNotification("n1", "p1"), c.pendingOpen.pending.value)
    }

    @Test fun mismatch_without_the_owners_name_stays_generic() {
        val (c, api) = kiosk(signedInAs = "p2")
        api.getPersonalResult = { throw ApiError(0, "network") }
        c.pendingOpen.offer(OpenNotification("n1", "p1"))
        start(c)
        waitForText("This alert is for another person. Sign in as them to see it.")
        assertEquals("This alert is for another person. Sign in as them to see it.", ownerMismatchText(null))
        compose.onNodeWithText("This alert is for another person. Sign in as them to see it.").assertIsDisplayed()
        assertFalse("listNotifications" in api.calls)
    }

    @Test fun the_home_tile_opens_the_page_without_a_highlight() {
        val (c, _) = kiosk(signedInAs = "p1")
        start(c)
        waitForTag("tile-NOTIFICATIONS")
        compose.onNodeWithTag("tile-NOTIFICATIONS").performScrollTo().performClick()
        waitForTag("notification-n1")
        compose.onNodeWithTag("notifications-refresh").assertIsDisplayed()
        val selected = compose.onNodeWithTag("notification-n1").fetchSemanticsNode().config
            .getOrElse(androidx.compose.ui.semantics.SemanticsProperties.Selected) { false }
        assertFalse(selected)
    }
}
