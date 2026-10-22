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
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
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

    private class Rig(val c: com.serversherpa.kiosk.AppContainer, val vm: TimeclockFlowViewModel)

    /** The flow in KIOSK mode (it opens on Enter Your Name) over [backend]. */
    private fun rig(backend: FakeTcBackend = FakeTcBackend(), mode: TcMode = TcMode.KIOSK): Rig {
        val c = testContainer()
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        lateinit var vm: TimeclockFlowViewModel
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c, LocalViewModelStoreOwner provides owner) {
                vm = kioskViewModel { TimeclockFlowViewModel(mode, backend, c.flash, null, flowOf(DEFAULT_APPEARANCE)) }
                TimeclockFlowScreen(vm)
            }
        }
        compose.waitForIdle()
        return Rig(c, vm)
    }

    private val box get() = compose.onNodeWithTag("tc-search-text")
    private fun resultCount() = compose.onNodeWithTag("tc-results").fetchSemanticsNode().children.size

    @Test fun theNameBoxIsATextFieldForTheSystemKeyboardAndHasFocus() {
        rig()
        compose.mainClock.advanceTimeBy(100)           // the step's focus request waits a frame or two
        box.assertIsFocused()
        box.performTextInput("Hen")
        box.assertTextEquals("Hen")
    }

    @Test fun typingFiltersTheResults() {
        val r = rig()
        box.performTextInput("t")
        compose.onNodeWithText("Tina Timeclock").assertIsDisplayed()
        compose.onNodeWithText("Jimmy Henderson").assertDoesNotExist()
        box.performTextReplacement("hen")
        compose.onNodeWithText("Jimmy Henderson").assertIsDisplayed()
        compose.onNodeWithText("Tina Timeclock").assertDoesNotExist()
        assertEquals(listOf("p1"), r.vm.state.value.results.map { it.id })
        box.performTextReplacement("nobody")
        compose.onNodeWithText("No one matches that name yet. Keep typing or check the spelling.").assertIsDisplayed()
    }

    @Test fun theImeSearchActionWithASingleHitAutoPicks() {
        val r = rig()
        box.performTextInput("hen jim")
        assertEquals(TcStep.NAME, r.vm.state.value.step)
        box.performImeAction()
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        assertEquals("p1", r.vm.state.value.flow.status?.person?.id)
    }

    @Test fun theImeSearchActionWithNoHitSaysSo() {
        rig()
        box.performTextInput("nobody")
        box.performImeAction()
        compose.onNodeWithText("No one matches that name.").assertIsDisplayed()
    }

    @Test fun aScanIntoTheBoxSelectsAtOnce() {
        val r = rig()
        // a reader typing into the box (HID wedge, DataWedge keystrokes): a badge UUID
        box.performTextInput("B-UID-1")
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        assertEquals("p1", r.vm.state.value.flow.status?.person?.id)
    }

    @Test fun anAmbiguousTagInTheBoxWaitsForTheRest() {
        val r = rig()
        box.performTextInput("1003")                    // Tina's tag, and the start of Jimmy's
        assertEquals(TcStep.NAME, r.vm.state.value.step)
        box.performTextInput("48")
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        assertEquals("p1", r.vm.state.value.flow.status?.person?.id)
    }

    @Test fun aScannerOnTheBusStillSelectsOnTheNameStep() {
        val r = rig()
        box.performTextInput("Ji")                      // half-typed, keyboard up
        r.c.scanBus.publish(ScanEvent("B-UID-1", ScanSource.DATAWEDGE))
        compose.waitForIdle()
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
        assertEquals("p1", r.vm.state.value.flow.status?.person?.id)
    }

    @Test fun resultsChangingDoesNotMoveTheBox() {
        val crew = listOf("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet")
            .mapIndexed { i, last -> KioskPersonRow("s$i", "Sam $last", "Sam", last) }
        rig(FakeTcBackend().apply { peopleResult = { crew } })
        box.performTextInput("Sa")
        assertEquals(8, resultCount())
        val boxAt = compose.onNodeWithTag("tc-search-box", useUnmergedTree = true).getBoundsInRoot()
        val listAt = compose.onNodeWithTag("tc-results").getBoundsInRoot()
        box.performTextReplacement("Sam Alp")
        assertEquals(1, resultCount())
        assertEquals(boxAt, compose.onNodeWithTag("tc-search-box", useUnmergedTree = true).getBoundsInRoot())
        assertEquals(listAt, compose.onNodeWithTag("tc-results").getBoundsInRoot())
        box.performTextReplacement("Sa")
        assertEquals(8, resultCount())
        assertEquals(boxAt, compose.onNodeWithTag("tc-search-box", useUnmergedTree = true).getBoundsInRoot())
    }

    /** A phone in portrait: typing filters and a result can be picked. (Robolectric does not
     *  measure text, so widths can't be checked here.) */
    @Config(qualifiers = "w360dp-h740dp")
    @Test fun aPhoneSizedScreenStillTypes() {
        val r = rig()
        box.performTextInput("Tina")
        assertEquals("Tina", r.vm.state.value.query)
        compose.onNodeWithText("Tina Timeclock").performClick()
        compose.onNodeWithText("Is this you?").assertIsDisplayed()
    }

    @Config(qualifiers = "w1280dp-h800dp-land")
    @Test fun landscapePutsTheResultsBesideTheBox() {
        rig()
        box.performTextInput("t")
        val boxAt = compose.onNodeWithTag("tc-search-box", useUnmergedTree = true).getBoundsInRoot()
        val listAt = compose.onNodeWithTag("tc-results").getBoundsInRoot()
        org.junit.Assert.assertTrue("results right of the box: $boxAt vs $listAt", listAt.left >= boxAt.right)
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

        compose.onNodeWithTag("tc-search-text").performTextInput("Hen")
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
