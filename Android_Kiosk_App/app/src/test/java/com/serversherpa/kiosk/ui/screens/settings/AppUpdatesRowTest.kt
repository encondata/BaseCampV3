package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.update.FakeAppUpdates
import com.serversherpa.kiosk.data.update.UpdateState
import com.serversherpa.kiosk.data.update.fakeOffer
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Settings › This Kiosk › App updates: the status line for each state and the Check for updates button. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class AppUpdatesRowTest {
    @get:Rule val compose = createComposeRule(StandardTestDispatcher())

    private fun show(updates: FakeAppUpdates, signedIn: Boolean = true) {
        compose.setContent { KioskTheme { AppUpdatesRow(updates, signedIn) } }
        waitForTag("app-updates")
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    /** 14:05 today in the device's zone: the row formats in that zone, so it reads 14:05 anywhere. */
    private val at1405 = ZonedDateTime.of(2026, 11, 18, 14, 5, 0, 0, ZoneId.systemDefault()).toInstant().toEpochMilli()

    @Test fun upToDateShows24HourTime() {
        show(FakeAppUpdates(UpdateState.UpToDate(at1405)))
        compose.onNodeWithText("Up to date · checked 14:05").assertIsDisplayed()
    }

    @Test fun failedShowsTheMessageAndWhenItChecked() {
        show(FakeAppUpdates(UpdateState.Failed("Couldn't reach devices.example.com.", at1405)))
        compose.onNodeWithText("Couldn't reach devices.example.com.").assertIsDisplayed()
        compose.onNodeWithText("Checked 14:05").assertIsDisplayed()
        compose.onNodeWithText("checked", substring = true, ignoreCase = false).assertDoesNotExist()
    }

    @Test fun idleCheckingAndUnavailableStatusLines() {
        val fake = FakeAppUpdates(UpdateState.Idle)
        show(fake)
        compose.onNodeWithText("Not checked yet").assertIsDisplayed()
        fake.state.value = UpdateState.Checking
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Checking…").fetchSemanticsNodes().isNotEmpty() }
        fake.state.value = UpdateState.Unavailable("This API address has no Devices site.")
        compose.waitUntil(5_000) { compose.onAllNodesWithText("This API address has no Devices site.").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun availableShowsNotesSizeAndUpdate() {
        val fake = FakeAppUpdates(UpdateState.Available(fakeOffer(), at1405))
        show(fake)
        compose.onNodeWithText("0.1.2 is available (12.4 MB)").assertIsDisplayed()
        compose.onNodeWithTag("update-notes").assertTextEquals("Faster scans.")
        compose.onNodeWithTag("update-now").assertIsDisplayed().performClick()
        compose.waitForIdle()
        assertEquals(1, fake.updates)
    }

    @Test fun availableWithoutASizeHasNoParentheses() {
        show(FakeAppUpdates(UpdateState.Available(fakeOffer(size = null), at1405)))
        compose.onNodeWithText("0.1.2 is available").assertIsDisplayed()
        compose.onNodeWithText("(", substring = true).assertDoesNotExist()
    }

    @Test fun downloadingAndInstallingShowAsOnHome() {
        val fake = FakeAppUpdates(UpdateState.Downloading(fakeOffer(), null))
        show(fake)
        compose.onNodeWithText("Downloading 0.1.2…").assertIsDisplayed()
        compose.onNodeWithTag("update-progress").assertExists()
        compose.onNodeWithTag("update-now").assertDoesNotExist()
        fake.state.value = UpdateState.Installing(fakeOffer())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Opening the installer…").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun blockedShowsTheMessage() {
        val message = "This build can't update in place. Reinstall the app from the Devices site."
        show(FakeAppUpdates(UpdateState.Blocked(message, at1405)))
        compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithTag("update-now").assertDoesNotExist()
    }

    @Test fun checkButtonCallsCheck() {
        val fake = FakeAppUpdates(UpdateState.UpToDate(at1405))
        show(fake)
        compose.onNodeWithTag("check-updates").assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals(1, fake.checks)
        compose.onNodeWithText("Sign in to check for updates.").assertDoesNotExist()
    }

    @Test fun checkDisabledSignedOutWithHint() {
        show(FakeAppUpdates(UpdateState.Idle), signedIn = false)
        compose.onNodeWithTag("check-updates").assertIsNotEnabled()
        compose.onNodeWithText("Sign in to check for updates.").assertIsDisplayed()
    }

    @Test fun checkDisabledWhileDownloading() {
        val fake = FakeAppUpdates(UpdateState.Downloading(fakeOffer(), 0.45f))
        show(fake)
        compose.onNodeWithTag("check-updates").assertIsNotEnabled()
        fake.state.value = UpdateState.Checking
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Checking…").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("check-updates").assertIsNotEnabled()
        fake.state.value = UpdateState.Installing(fakeOffer())
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Opening the installer…").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("check-updates").assertIsNotEnabled()
    }

    private fun showPanel(c: AppContainer) {
        runBlocking { c.identity.get() }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ThisKioskPanel() } }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Version").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun rowHiddenWhenUnsupported() {
        showPanel(testContainer())
        compose.onNodeWithTag("app-updates").assertDoesNotExist()
        compose.onNodeWithText("Check for updates").assertDoesNotExist()
    }

    @Test fun rowShownWhenSupported() {
        showPanel(testContainer(updates = FakeAppUpdates(UpdateState.Idle)))
        compose.onNodeWithTag("app-updates").assertExists()
        compose.onNodeWithTag("check-updates").assertExists().assertIsNotEnabled()   // signed out
    }
}
