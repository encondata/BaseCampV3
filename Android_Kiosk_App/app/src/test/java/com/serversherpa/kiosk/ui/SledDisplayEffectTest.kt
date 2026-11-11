package com.serversherpa.kiosk.ui

import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SLED_DISPLAY_IDLE_MS
import com.serversherpa.kiosk.core.rfid.SledRouteKind
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidController
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The effects beside the NavHost: the display kept on while the sled is in use (ruling 5, the
 *  one writer of `keepScreenOn`), and the sled-screen signal including Settings › RFID (ruling 33). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SledDisplayEffectTest {
    @get:Rule val compose = createComposeRule()

    private class Rig(val c: AppContainer, val reader: FakeRfidReader, val view: () -> View) {
        var route by mutableStateOf<String?>(Routes.SCAN)
        var touch by mutableStateOf(0L)
    }

    private fun rig(now: () -> Long = System::currentTimeMillis, route: String? = Routes.SCAN): Rig {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.updateRfid { it.copy(enabled = true) } }
        c.rfid.start()
        lateinit var view: View
        val r = Rig(c, reader) { view }
        r.route = route
        compose.setContent {
            view = LocalView.current
            CompositionLocalProvider(LocalAppContainer provides c) { SledDisplayEffect(c, r.route, r.touch, now) }
        }
        compose.waitForIdle()
        return r
    }

    private fun Rig.awaitDisplay(on: Boolean) = compose.waitUntilIdlingMain { view().keepScreenOn == on }

    @Test fun theDisplayStaysOnWhileTheSledIsInUseOnScanning() {
        val r = rig()
        assertFalse(r.view().keepScreenOn)
        r.reader.setConnection(RfidConnection.Connected("RFD4031", 80))
        r.awaitDisplay(true)
        r.route = Routes.HOME
        r.awaitDisplay(false)
        r.route = Routes.LOOKUP
        r.awaitDisplay(true)
        r.reader.setConnection(RfidConnection.Connecting)
        compose.waitForIdle()
        assertTrue(r.view().keepScreenOn)
        r.reader.setConnection(RfidConnection.Failed("The sled didn't answer."))
        r.awaitDisplay(false)
        // The reader turned off.
        r.reader.setConnection(RfidConnection.Connected("RFD4031", 80))
        r.awaitDisplay(true)
        runBlocking { r.c.prefs.updateRfid { it.copy(enabled = false) } }
        r.awaitDisplay(false)
    }

    @Test fun itTurnsOffAfterTenIdleMinutes() {
        var now = 0L
        val r = rig(now = { now })
        val base = r.c.rfid.lastActivityMs.value
        now = base
        r.reader.setConnection(RfidConnection.Connected("RFD4031", 80))
        r.awaitDisplay(true)

        compose.mainClock.autoAdvance = false
        now = base + SLED_DISPLAY_IDLE_MS - 1
        compose.mainClock.advanceTimeBy(SLED_DISPLAY_IDLE_MS - 10)
        assertTrue("still on just before ten minutes", r.view().keepScreenOn)
        now = base + SLED_DISPLAY_IDLE_MS
        compose.mainClock.advanceTimeBy(1_000)
        assertFalse("released after ten idle minutes, with no further event", r.view().keepScreenOn)

        // A touch turns it on again.
        compose.mainClock.autoAdvance = true
        r.touch = now
        r.awaitDisplay(true)
    }

    @Test fun activityOnTheSledTurnsItOnAgain() {
        var now = 0L
        val r = rig(now = { now })
        val base = r.c.rfid.lastActivityMs.value
        now = base + SLED_DISPLAY_IDLE_MS
        r.reader.setConnection(RfidConnection.Connected("RFD4031", 80))
        compose.waitForIdle()
        assertFalse(r.view().keepScreenOn)
        // Activity moves in steps, so wait one out first.
        Thread.sleep(RfidController.ACTIVITY_STEP_MS + 5)
        r.c.rfid.noteActivity()
        now = r.c.rfid.lastActivityMs.value
        r.awaitDisplay(true)
    }

    @Test fun enrollKeepsItOnOnlyWhenTheLayoutUsesTheScanner() {
        val r = rig(route = Routes.ENROLL)
        r.reader.setConnection(RfidConnection.Connected("RFD4031", 80))
        compose.waitForIdle()
        assertFalse("RFID layout: both triggers read tags, no scanner in use", r.view().keepScreenOn)
        runBlocking { r.c.prefs.updateRfid { it.copy(triggerLayout = SledTriggerLayout.SPLIT) } }
        r.awaitDisplay(true)
        r.route = Routes.LABELS_PRINT
        compose.waitForIdle()
        assertTrue(r.view().keepScreenOn)
        r.reader.setConnection(RfidConnection.Connecting)
        r.awaitDisplay(false)
    }

    @Test fun sledRouteKindMapsTheFourRoutes() {
        assertEquals(setOf(Routes.SCAN, Routes.LOOKUP, Routes.ENROLL, Routes.LABELS_PRINT), SLED_ROUTES)
        assertEquals(SledRouteKind.SCAN_OR_LOOKUP, sledRouteKind(Routes.SCAN))
        assertEquals(SledRouteKind.SCAN_OR_LOOKUP, sledRouteKind(Routes.LOOKUP))
        assertEquals(SledRouteKind.ENROLL_OR_PRINT, sledRouteKind(Routes.ENROLL))
        assertEquals(SledRouteKind.ENROLL_OR_PRINT, sledRouteKind(Routes.LABELS_PRINT))
        for (other in listOf(null, Routes.HOME, Routes.SETTINGS, Routes.LABELS, Routes.LABELS_PRINTER, Routes.TIMECLOCK, Routes.LOGIN)) {
            assertEquals("$other", SledRouteKind.OTHER, sledRouteKind(other))
        }
    }

    /** The controller's flag, read directly: setSledScreenOpen has no other observable effect
     *  outside a reconnect schedule. */
    private fun RfidController.sledScreenOpen(): Boolean =
        RfidController::class.java.getDeclaredField("sledScreenOpen").apply { isAccessible = true }.getBoolean(this)

    @Test fun theRfidSettingsTabCountsAsASledScreen() {
        val c = testContainer()
        var route by mutableStateOf<String?>(Routes.SETTINGS)
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { SledScreenSignal(c, route) } }
        compose.waitForIdle()
        assertFalse(c.rfid.sledScreenOpen())

        c.settingsTab.value = SettingsTabId.RFID
        compose.waitUntilIdlingMain { c.rfid.sledScreenOpen() }
        c.settingsTab.value = SettingsTabId.ADMIN
        compose.waitUntilIdlingMain { !c.rfid.sledScreenOpen() }

        route = Routes.SCAN
        compose.waitUntilIdlingMain { c.rfid.sledScreenOpen() }
        route = Routes.HOME
        compose.waitUntilIdlingMain { !c.rfid.sledScreenOpen() }
        // The RFID tab's value only counts on the Settings route.
        c.settingsTab.value = SettingsTabId.RFID
        compose.waitForIdle()
        assertFalse(c.rfid.sledScreenOpen())
        route = Routes.SETTINGS
        compose.waitUntilIdlingMain { c.rfid.sledScreenOpen() }
    }

    /** The root's touch stamp (KioskApp): a finger going down counts, a drag's moves do not,
     *  so scrolling a list does not restamp it, and recompose the effect, on every frame. */
    @Test fun onlyAFingerGoingDownIsATouch() {
        var downs = 0
        compose.setContent {
            Box(Modifier.fillMaxSize().onEveryTouchDown { downs++ }) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("page")) {
                    repeat(60) { Text("Row $it") }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("page").performTouchInput {
            down(center)
            repeat(20) { moveBy(Offset(0f, -10f)) }
            up()
        }
        compose.waitForIdle()
        assertEquals("one gesture, one stamp", 1, downs)
        compose.onNodeWithTag("page").performTouchInput { swipeUp() }
        compose.onNodeWithTag("page").performTouchInput { click() }
        compose.waitForIdle()
        assertEquals(3, downs)
    }
}
