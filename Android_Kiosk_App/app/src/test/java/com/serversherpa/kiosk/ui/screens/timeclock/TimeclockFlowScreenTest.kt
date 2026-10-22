package com.serversherpa.kiosk.ui.screens.timeclock

import android.content.res.Configuration
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.model.TodayEntry
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.timeclock.flow.FakeTcBackend
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcMode
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcStep
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TimeclockFlowViewModel
import com.serversherpa.kiosk.ui.screens.timeclock.screens.ChooseAction
import com.serversherpa.kiosk.ui.screens.timeclock.screens.ClockOutSummary
import com.serversherpa.kiosk.ui.screens.timeclock.screens.ConfirmPerson
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
/** A tablet-sized window, so every step fits without scrolling. */
@Config(sdk = [34], qualifiers = "w800dp-h1280dp")
class TimeclockFlowScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun confirmCardWithoutOptionalFields() {
        val c = testContainer()
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                ConfirmPerson(KioskTimeclockPerson("p9", "Alex Worker"), onYes = {}, onNo = {})
            }
        }
        compose.onNodeWithText("AW").assertIsDisplayed()                 // initials, no photo
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        compose.onNodeWithText("Alex Worker").assertIsDisplayed()
        compose.onNodeWithText("Yes, that's me").assertIsDisplayed()
        compose.onNodeWithText("No, search again").assertIsDisplayed()
        // no empty lines where the job title and Employee ID would go
        assertEquals(0, compose.onAllNodesWithTag("tc-person-meta").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Employee ID", substring = true).fetchSemanticsNodes().size)
    }

    @Test fun confirmCardShowsTheJobTitleAndEmployeeIdWhenSet() {
        val c = testContainer()
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                ConfirmPerson(KioskTimeclockPerson("p1", "Jimmy Henderson", job_title = "Crew lead", external_id = "E-42"), onYes = {}, onNo = {})
            }
        }
        compose.onNodeWithText("JH").assertIsDisplayed()
        compose.onNodeWithText("Crew lead").assertIsDisplayed()
        compose.onNodeWithText("Employee ID E-42").assertIsDisplayed()
    }

    @Test fun onlyTheTileThatFitsCanBeTappedAndAFailedPunchOffersTryAgain() {
        val status = KioskTimeclockStatus(KioskTimeclockPerson("p1", "Jimmy Henderson"), clocked_in = true)
        compose.setContent {
            ChooseAction(status, busy = false, notice = "Your status changed. Please choose again.", error = "Can't reach the portal. Your punch was not recorded. Try again.", onIn = {}, onOut = {}, onRetry = {})
        }
        compose.onNodeWithText("What would you like to do?").assertIsDisplayed()
        compose.onNodeWithTag("tc-tile-in").assertIsNotEnabled()
        compose.onNodeWithTag("tc-tile-out").assertIsEnabled()
        compose.onNodeWithText("Your status changed. Please choose again.").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertIsDisplayed()
    }

    @Test fun clockOutShowsTodaysTotalAndPunches() {
        val status = KioskTimeclockStatus(
            KioskTimeclockPerson("p1", "Jimmy Henderson"), clocked_in = true, today_minutes = 444,
            today_entries = listOf(TodayEntry("2026-10-20T13:00:00Z", "2026-10-20T17:00:00Z", 240), TodayEntry("2026-10-20T17:30:00Z", null, 204)),
        )
        compose.setContent { ClockOutSummary(status, busy = false, error = null, onConfirm = {}, onRetry = {}) }
        compose.onNodeWithText("You've been working for").assertIsDisplayed()
        assertEquals(2, compose.onAllNodesWithText("7h 24m").fetchSemanticsNodes().size)   // the big total and the Total row
        compose.onNodeWithText("now").assertIsDisplayed()                                  // the open shift
        assertEquals(2, compose.onAllNodesWithText("Clock In").fetchSemanticsNodes().size)
        compose.onNodeWithText("Confirm Clock Out").assertIsDisplayed()
    }

    @Test fun theKeyboardCapitalizesAtTheStartAndAfterASpaceAndHasANumbersLayer() {
        val c = testContainer()
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        lateinit var vm: TimeclockFlowViewModel
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalViewModelStoreOwner provides owner) {
                vm = kioskViewModel { TimeclockFlowViewModel(TcMode.KIOSK, FakeTcBackend(), c.flash, null, flowOf(DEFAULT_APPEARANCE)) }
                TimeclockFlowScreen(vm)
            }
        }
        for (k in listOf("J", "I", "M")) compose.onNodeWithText(k).performClick()
        compose.onNodeWithText("Space").performClick()
        compose.onNodeWithText("H").performClick()
        compose.onNodeWithContentDescription("Shift").performClick()
        compose.onNodeWithText("E").performClick()
        compose.onNodeWithText("N").performClick()
        compose.waitForIdle()
        assertEquals("Jim HEn", vm.state.value.query)
        compose.onNodeWithContentDescription("Backspace").performClick()
        compose.onNodeWithText("123").performClick()
        compose.onNodeWithText("7").performClick()
        compose.onNodeWithText("-").performClick()
        compose.onNodeWithText("ABC").performClick()
        compose.waitForIdle()
        assertEquals("Jim HE7-", vm.state.value.query)
        compose.onNodeWithTag("tc-search-text").assertTextEquals("Jim HE7-")
    }

    /** A phone in portrait: the keyboard still types and a result can be picked. (Robolectric does
     *  not measure text, so widths can't be checked here.) */
    @Config(qualifiers = "w360dp-h740dp")
    @Test fun aPhoneSizedScreenStillTypes() {
        val c = testContainer()
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        lateinit var vm: TimeclockFlowViewModel
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalViewModelStoreOwner provides owner) {
                vm = kioskViewModel { TimeclockFlowViewModel(TcMode.KIOSK, FakeTcBackend(), c.flash, null, flowOf(DEFAULT_APPEARANCE)) }
                TimeclockFlowScreen(vm)
            }
        }
        for (k in listOf("T", "I", "N", "A")) compose.onNodeWithText(k).performClick()
        compose.waitForIdle()
        assertEquals("Tina", vm.state.value.query)
        compose.onNodeWithTag("tc-search-text").assertTextEquals("Tina")
        compose.onNodeWithText("Tina Timeclock").performClick()
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
    }

    /** A rotation recreates the screen; the step, the person and the typed text live in the view
     *  model, so they survive. The screen is torn down completely and composed again in the other
     *  orientation under the same ViewModelStoreOwner (which an Activity keeps across a
     *  configuration change). */
    @Config(qualifiers = "w1280dp-h1280dp")
    @Test fun rotationKeepsTheStep() {
        val c = testContainer()
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        var shown by mutableStateOf(true)
        var landscape by mutableStateOf(false)
        var built = 0
        val seen = ArrayList<TimeclockFlowViewModel>()
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalViewModelStoreOwner provides owner) {
                if (shown) {
                    val config = Configuration(LocalConfiguration.current).apply {
                        orientation = if (landscape) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
                        screenWidthDp = if (landscape) 1280 else 800
                        screenHeightDp = if (landscape) 800 else 1280
                    }
                    CompositionLocalProvider(LocalConfiguration provides config) {
                        val vm = kioskViewModel { built++; TimeclockFlowViewModel(TcMode.KIOSK, FakeTcBackend(), c.flash, null, flowOf(DEFAULT_APPEARANCE)) }
                        seen += vm
                        TimeclockFlowScreen(vm)
                    }
                }
            }
        }
        fun rotate() { shown = false; compose.waitForIdle(); landscape = !landscape; shown = true; compose.waitForIdle() }

        for (k in listOf("H", "E", "N")) compose.onNodeWithText(k).performClick()
        compose.onNodeWithTag("tc-search-text").assertTextEquals("Hen")
        rotate()
        compose.onNodeWithText("Enter Your Name").assertIsDisplayed()
        compose.onNodeWithTag("tc-search-text").assertTextEquals("Hen")
        compose.onNodeWithText("Jimmy Henderson").performClick()
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        rotate()
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        compose.onNodeWithText("Jimmy Henderson").assertIsDisplayed()
        compose.onNodeWithText("Yes, that's me").performClick()
        rotate()
        compose.onNodeWithText("What would you like to do?").assertIsDisplayed()
        assertEquals(1, built)
        assertEquals(TcStep.ACTION, seen.last().state.value.flow.step)
        assertSame(seen.first(), seen.last())
    }
}
