package com.serversherpa.kiosk.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeStationApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.timeclock.screens.KEY_MISSING_TEXT
import com.serversherpa.kiosk.ui.screens.timeclock.screens.PAUSED_TEXT
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A Time Clock station end to end through [KioskApp]: signed out it rests on Welcome (never the
 * sign-in page), its people and punches go through the station key, and a dropped or paused key
 * shows the matching copy. The gear leads to sign-in and back; signed in, Home has three tiles.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w800dp-h1280dp")
class StationModeTest {
    @get:Rule val compose = createComposeRule()

    private val tina = KioskPersonRow("p1", "Tina Turner", "Tina", "Turner", badge_uid = "BADGE-1")

    private class Station(val c: AppContainer, val api: FakeKioskApi, val station: FakeStationApi)

    /** A kiosk set up as a Time Clock station (no move, Dock 4), as after a relaunch: the key in
     *  the secure store, the station type in prefs, and the session restore finding nobody. */
    private fun station(key: String? = "k1", signedIn: Boolean = false, configure: FakeStationApi.() -> Unit = {}): Station {
        val api = FakeKioskApi()
        val st = FakeStationApi().apply { peopleResult = { listOf(tina) }; configure() }
        val c = testContainer(api = api, stationApi = st)
        runBlocking {
            c.identity.get()                                             // the serial, as AppContainer.start makes it
            c.prefs.setSetupSelection(KioskSetupSelection(siteId = "s1", siteName = "Dock 4", siteRole = "other", stationType = "timeclock"))
            c.prefs.setSetupState(SetupState.COMPLETE)
            if (key != null) c.stationKeys.put(key)
            if (signedIn) c.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60)) else c.auth.restore()
        }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskApp() } }
        return Station(c, api, st)
    }

    private fun waitForText(text: String, substring: Boolean = false) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }

    @Test fun aRelaunchedArmedStationRestsOnWelcome() {
        val s = station()
        assertEquals(AuthState.Anon, s.c.auth.state.value)
        waitForText("Welcome!")
        compose.onNodeWithText("Welcome!").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        // the people list comes from the station route, under the key, into the local copy
        compose.waitUntil(5_000) { "people" in s.station.calls }
        assertEquals("k1", s.station.keys.first())
        compose.waitUntil(5_000) { runBlocking { s.c.db.people().count() } == 1 }
        assertEquals(false, "syncPeople" in s.api.calls)                 // never the session's sync
        compose.onNodeWithText(KEY_MISSING_TEXT).assertDoesNotExist()
        compose.onNodeWithText(PAUSED_TEXT).assertDoesNotExist()
    }

    @Test fun aStationWithNoKeyWaitsForIt() {
        val s = station(key = null)
        waitForText(KEY_MISSING_TEXT)
        compose.onNodeWithText("Welcome!").assertIsDisplayed()
        compose.onNodeWithTag("tc-card-name").assertIsNotEnabled()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        assertEquals(false, "status" in s.station.calls)
    }

    /** The key is revoked mid-shift (Clear Setup, a setup elsewhere, deleted on Kiosk Devices):
     *  the next station call answers 401, the key is dropped and Welcome waits for a new one. */
    @Test fun aRevokedKeyShowsWaitingForKey() {
        val s = station { statusResult = { throw ApiError(401, "station_key_invalid") } }
        waitForText("Welcome!")
        compose.waitUntil(5_000) { runBlocking { s.c.db.people().count() } == 1 }
        compose.waitForIdle()
        s.c.scanBus.publish(ScanEvent("BADGE-1", ScanSource.DATAWEDGE))
        waitForText(KEY_MISSING_TEXT)
        assertTrue("status" in s.station.calls)
        assertNull(s.c.stationKeys.get())
        compose.onNodeWithText("Welcome!").assertIsDisplayed()
        compose.onNodeWithTag("tc-card-scan").assertIsNotEnabled()
        // no loop: nothing else goes out under the dropped key
        val sent = s.station.calls.size
        compose.mainClock.advanceTimeBy(5_000)
        assertEquals(sent, s.station.calls.size)
    }

    @Test fun aWrongStationTypeKeyIsTreatedLikeARevokedOne() {
        val s = station { peopleResult = { throw ApiError(403, "wrong_station_type") } }
        waitForText(KEY_MISSING_TEXT)
        assertNull(s.c.stationKeys.get())
    }

    @Test fun pausedWhenNotRegistered() {
        val s = station { peopleResult = { throw ApiError(403, "kiosk_not_registered") } }
        waitForText(PAUSED_TEXT)
        compose.onNodeWithText("Welcome!").assertIsDisplayed()
        compose.onNodeWithTag("tc-card-name").assertIsNotEnabled()
        assertEquals("k1", s.c.stationKeys.get())                       // the key is kept
        compose.onNodeWithText(KEY_MISSING_TEXT).assertDoesNotExist()
        compose.onNodeWithText("Can't load the people list", substring = true).assertDoesNotExist()
    }

    @Test fun gearGoesToLoginAndBackReturns() {
        station()
        waitForText("Welcome!")
        compose.onAllNodesWithContentDescription("Settings").onFirst().performClick()
        waitForText("Back to the time clock")
        compose.onAllNodesWithText("Sign in").onFirst().assertIsDisplayed()
        compose.onNodeWithText("Back to the time clock").performClick()
        waitForText("Welcome!")
        compose.onNodeWithText("Back to the time clock").assertDoesNotExist()
    }

    @Test fun stationHomeShowsThreeTiles() {
        val s = station(signedIn = true)
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("tile-TIMECLOCK_STATION").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tile-SETUP").assertIsDisplayed()
        compose.onNodeWithTag("tile-SETTINGS").assertIsDisplayed()
        for (other in listOf("SCAN", "ENROLL", "CONTAINERS", "TRUCKS", "LABELS", "TIMECLOCK")) {
            assertEquals(0, compose.onAllNodesWithTag("tile-$other").fetchSemanticsNodes().size)
        }
        compose.onNodeWithText("Time Clock").assertIsDisplayed()
        // the Time Clock tile signs out and lands on Welcome
        compose.onNodeWithTag("tile-TIMECLOCK_STATION").performClick()
        waitForText("Welcome!")
        assertEquals(AuthState.Anon, s.c.auth.state.value)
        assertTrue("logout" in s.api.calls)
        assertEquals(false, "issueStationKey" in s.api.calls)            // it already had one
    }

    @Test fun theTimeClockTileFetchesAMissingKeyFirst() {
        val s = station(key = null, signedIn = true)
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("tile-TIMECLOCK_STATION").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tile-TIMECLOCK_STATION").performClick()
        waitForText("Welcome!")
        assertEquals("station-key-1", s.c.stationKeys.get())
        compose.onNodeWithText(KEY_MISSING_TEXT).assertDoesNotExist()
    }

    @Test fun theTimeClockTileStaysSignedInWhenTheKeyIsRefused() {
        val s = station(key = null, signedIn = true)
        s.api.issueStationKeyResult = { throw ApiError(409, "kiosk_not_registered") }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("tile-TIMECLOCK_STATION").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tile-TIMECLOCK_STATION").performClick()
        waitForText("Couldn't start the time clock", substring = true)
        assertTrue(s.c.auth.state.value is AuthState.Authed)
        assertEquals(false, "logout" in s.api.calls)
    }
}
