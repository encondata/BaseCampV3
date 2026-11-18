package com.serversherpa.kiosk.ui.screens.settings

import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.push.FakeFcmTokens
import com.serversherpa.kiosk.data.push.FcmTokens
import com.serversherpa.kiosk.data.push.NoFcmTokens
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowBuild

/** Settings › This Kiosk's "This is my phone" block, on a standard (360 dp) and a compact (320 dp) phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class ThisKioskPushTest {
    @get:Rule val compose = createComposeRule()

    private val app get() = ApplicationProvider.getApplicationContext<Application>()

    private fun phone(
        maxRank: Int = 60,
        personal: PersonalState = PersonalState(on = false, ownerName = null),
        fcm: FcmTokens = FakeFcmTokens(),
    ): Pair<AppContainer, FakeKioskApi> {
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession(maxRank = maxRank) }
            getPersonalResult = { personal }
        }
        val c = testContainer(api = api, fcmTokens = fcm)
        runBlocking { c.identity.get(); c.auth.login("tina@example.com", "pw") }
        return c to api
    }

    private fun show(c: AppContainer) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ThisKioskPanel() } }
            }
        }
    }

    private fun waitForText(text: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }

    // ── hidden_for_non_admin ──

    private fun hiddenForNonAdmin() {
        val (c, api) = phone(maxRank = 20)
        show(c)
        waitForText("Serial")
        compose.waitForIdle()
        compose.onNodeWithText(PERSONAL_LABEL).assertDoesNotExist()
        compose.onNodeWithTag("personal-switch").assertDoesNotExist()
        assertFalse("a non-admin's Settings never asks", api.calls.contains("getPersonal"))
    }

    @Test fun hidden_for_non_admin() = hiddenForNonAdmin()
    @Test @Config(qualifiers = "w320dp-h470dp") fun hidden_for_non_admin_compact() = hiddenForNonAdmin()

    // ── shows_owner_when_owned_by_other ──

    private fun showsOwnerWhenOwnedByOther() {
        val (c, _) = phone(personal = PersonalState(on = false, ownerName = "Sam S"))
        show(c)
        waitForText(personalOwnedBy("Sam S"))
        compose.onNodeWithText(personalOwnedBy("Sam S")).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("personal-switch").assertDoesNotExist()
    }

    @Test fun shows_owner_when_owned_by_other() = showsOwnerWhenOwnedByOther()
    @Test @Config(qualifiers = "w320dp-h470dp") fun shows_owner_when_owned_by_other_compact() = showsOwnerWhenOwnedByOther()

    // ── blocked_shows_settings_button ──

    private fun blockedShowsSettingsButton() {
        shadowOf(app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).setNotificationsEnabled(false)
        val (c, _) = phone(personal = PersonalState(on = true, ownerName = "Tina T", pushRegistered = true))
        show(c)
        waitForText(NOTIFICATIONS_BLOCKED_TEXT)
        compose.onNodeWithTag("personal-switch").assertIsOn()
        compose.onNodeWithText(NOTIFICATIONS_BLOCKED_TEXT).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(OPEN_NOTIFICATION_SETTINGS).performScrollTo().assertIsDisplayed().performClick()
        val started = shadowOf(app).nextStartedActivity
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, started.action)
        assertEquals(app.packageName, started.getStringExtra(Settings.EXTRA_APP_PACKAGE))
    }

    @Test fun blocked_shows_settings_button() = blockedShowsSettingsButton()
    @Test @Config(qualifiers = "w320dp-h470dp") fun blocked_shows_settings_button_compact() = blockedShowsSettingsButton()

    // ── the other states ──

    @Test fun on_with_notifications_allowed_shows_no_blocked_line() {
        val (c, _) = phone(personal = PersonalState(on = true, ownerName = "Tina T", pushRegistered = true))
        show(c)
        waitForTag("personal-switch")
        compose.onNodeWithTag("personal-switch").assertIsOn()
        compose.onNodeWithText(NOTIFICATIONS_BLOCKED_TEXT).assertDoesNotExist()
        compose.onNodeWithText(OPEN_NOTIFICATION_SETTINGS).assertDoesNotExist()
    }

    @Test fun refusal_shows_its_reason_in_plain_words() {
        val (c, api) = phone()
        api.setPersonalResult = {
            throw ApiError(422, "not_eligible", buildJsonObject { put("code", JsonPrimitive("not_eligible")); put("reason", JsonPrimitive("shared_station")) })
        }
        show(c)
        waitForTag("personal-switch")
        compose.onNodeWithTag("personal-switch").performScrollTo().performClick()
        waitForText(personalErrorText(ApiError(422, "not_eligible", buildJsonObject { put("reason", JsonPrimitive("shared_station")) })))
        assertEquals("This kiosk is a shared station, so it can't be anyone's phone.",
            personalErrorText(ApiError(422, "not_eligible", buildJsonObject { put("reason", JsonPrimitive("shared_station")) })))
        assertFalse(api.calls.contains("registerPush"))
    }

    @Test fun turning_on_without_firebase_says_push_is_unavailable() {
        val (c, _) = phone(fcm = NoFcmTokens)
        show(c)
        waitForTag("personal-switch")
        compose.onNodeWithTag("personal-switch").performScrollTo().performClick()
        waitForText(PUSH_UNAVAILABLE_TEXT)
        compose.onNodeWithTag("personal-switch").assertIsOn()
    }

    @Test fun zebra_hides_the_block() {
        assertFalse(personalBlockVisible(isAdmin = true, zebra = true))
        assertFalse(personalBlockVisible(isAdmin = false, zebra = false))
        assertTrue(personalBlockVisible(isAdmin = true, zebra = false))
    }

    @Test fun hidden_for_an_admin_on_a_zebra() {
        // isZebraHost is read once, when the container is built.
        ShadowBuild.setManufacturer("Zebra Technologies")
        val (c, api) = phone()
        assertTrue(c.isZebraHost)
        show(c)
        waitForText("Serial")
        compose.waitForIdle()
        compose.onNodeWithText(PERSONAL_LABEL).assertDoesNotExist()
        assertFalse(api.calls.contains("getPersonal"))
    }

    // ── automatic registration ──

    @Test fun opening_settings_registers_push_silently() {
        val (c, api) = phone(personal = PersonalState(on = true, ownerName = "Tina T", pushRegistered = false))
        show(c)
        compose.waitUntil(5_000) { api.calls.contains("registerPush") }
        waitForTag("personal-switch")
        compose.waitForIdle()
        compose.onNodeWithTag("personal-switch").assertIsOn()
        compose.onNodeWithText(PERSONAL_PUSH_NOT_SET_UP).assertDoesNotExist()
        compose.onNodeWithText("Set up push").assertDoesNotExist()
        assertEquals("reg-1", c.pushKeys.get("http://127.0.0.1:1")?.registrationId)
    }

    @Test fun a_failed_registration_shows_only_the_status_line() {
        val (c, api) = phone(personal = PersonalState(on = true, ownerName = "Tina T", pushRegistered = false))
        api.registerPushResult = { throw ApiError(0, "network") }
        show(c)
        waitForText(PERSONAL_PUSH_NOT_SET_UP)
        compose.onNodeWithText(PERSONAL_PUSH_NOT_SET_UP).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Set up push").assertDoesNotExist()
    }

    @Test fun without_firebase_an_on_phone_says_push_is_unavailable_up_front() {
        val (c, api) = phone(personal = PersonalState(on = true, ownerName = "Tina T", pushRegistered = false), fcm = NoFcmTokens)
        show(c)
        waitForText(PUSH_UNAVAILABLE_TEXT)
        compose.onNodeWithTag("personal-switch").assertIsOn()
        compose.onNodeWithText(PERSONAL_PUSH_NOT_SET_UP).assertDoesNotExist()
        assertFalse(api.calls.contains("registerPush"))
    }

    @Test fun released_in_the_portal_clears_the_phones_key() {
        val fcm = FakeFcmTokens()
        val (c, _) = phone(personal = PersonalState(on = false, ownerName = null), fcm = fcm)
        c.pushKeys.save("reg-1", "push-key-1", "http://127.0.0.1:1", "p1")
        show(c)
        waitForTag("personal-switch")
        compose.waitUntil(5_000) { !c.pushKeys.hasKey() }
        assertEquals(1, fcm.deletes)
    }
}
