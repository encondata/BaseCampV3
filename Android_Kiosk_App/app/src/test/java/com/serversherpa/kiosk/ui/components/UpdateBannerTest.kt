package com.serversherpa.kiosk.ui.components

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.update.FakeAppUpdates
import com.serversherpa.kiosk.data.update.UpdateState
import com.serversherpa.kiosk.data.update.fakeOffer
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.home.HomeScreen
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Home update banner: what each update state shows, and that the banner follows homeBannerVisible. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class UpdateBannerTest {
    @get:Rule val compose = createComposeRule(StandardTestDispatcher())

    private fun show(updates: FakeAppUpdates) {
        compose.setContent { KioskTheme { UpdateBanner(updates) } }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun available(notice: String? = null) = UpdateState.Available(fakeOffer(), checkedAtMillis = 0, notice = notice)

    @Test fun showsVersionAndBothButtons() {
        show(FakeAppUpdates(available(), bannerVisible = true))
        waitForTag("update-banner")
        compose.onNodeWithText("Update available — 0.1.2").assertIsDisplayed()
        compose.onNodeWithTag("update-now").assertIsDisplayed()
        compose.onNodeWithTag("update-later").assertIsDisplayed()
    }

    @Test fun updateAndLaterCallThrough() {
        val fake = FakeAppUpdates(available(), bannerVisible = true)
        show(fake)
        waitForTag("update-now")
        compose.onNodeWithTag("update-now").performClick()
        compose.onNodeWithTag("update-later").performClick()
        compose.waitForIdle()
        assertEquals(1, fake.updates)
        assertEquals(1, fake.laters)
    }

    @Test fun hiddenWhenTheBannerIsOff() {
        val fake = FakeAppUpdates(available(), bannerVisible = true)
        show(fake)
        waitForTag("update-banner")
        fake.homeBannerVisible.value = false
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("update-banner").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("update-banner").assertDoesNotExist()
    }

    @Test fun downloadingShowsProgress() {
        show(FakeAppUpdates(UpdateState.Downloading(fakeOffer(), 0.45f), bannerVisible = true))
        waitForTag("update-banner")
        compose.onNodeWithText("Downloading 0.1.2 — 45%").assertIsDisplayed()
        compose.onNodeWithTag("update-progress").assertExists()
        compose.onNodeWithTag("update-now").assertDoesNotExist()
    }

    @Test fun installingSaysTheInstallerIsOpening() {
        show(FakeAppUpdates(UpdateState.Installing(fakeOffer()), bannerVisible = true))
        waitForTag("update-banner")
        compose.onNodeWithText("Opening the installer…").assertIsDisplayed()
        compose.onNodeWithTag("update-now").assertDoesNotExist()
    }

    @Test fun blockedShowsTheMessageWithoutUpdate() {
        val message = "This build can't update in place. Reinstall the app from the Devices site."
        show(FakeAppUpdates(UpdateState.Blocked(message, checkedAtMillis = 0), bannerVisible = true))
        waitForTag("update-banner")
        compose.onNodeWithText("Update available").assertIsDisplayed()
        compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithTag("update-now").assertDoesNotExist()
        compose.onNodeWithTag("update-later").assertIsDisplayed()
    }

    @Test fun noticeIsShown() {
        show(FakeAppUpdates(available(notice = "Install canceled."), bannerVisible = true))
        waitForTag("update-banner")
        compose.onNodeWithText("Install canceled.").assertIsDisplayed()
        compose.onNodeWithTag("update-now").assertIsDisplayed()
    }

    @Test fun homeShowsTheBannerFromTheContainer() {
        val c = testContainer(updates = FakeAppUpdates(available(), bannerVisible = true))
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        waitForTag("update-banner")
        compose.onNodeWithTag("update-banner").assertIsDisplayed()
        compose.onNodeWithText("Update available — 0.1.2").assertIsDisplayed()
    }

    @Test fun playBuildShowsNoBanner() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        waitForTag("tile-SETTINGS")
        compose.onNodeWithTag("update-banner").assertDoesNotExist()
    }
}
