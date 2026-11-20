package com.serversherpa.kiosk.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.environment.Environments
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
import com.serversherpa.kiosk.useApi
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.flow.first
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
 * shows the matching copy. The gear leads to sign-in and back; signed in, Home has four tiles.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w800dp-h1280dp")
class StationModeTest {
    @get:Rule val compose = createComposeRule()

    private companion object {
        /** The test container's API URL, http://127.0.0.1:1, as an origin. */
        const val ORIGIN = "http://127.0.0.1:1"
    }

    private val tina = KioskPersonRow("p1", "Tina Turner", "Tina", "Turner", badge_uid = "BADGE-1")

    private class Station(val c: AppContainer, val api: FakeKioskApi, val station: FakeStationApi)

    /** A kiosk set up as a Time Clock station (no move, Dock 4), as after a relaunch: the key in
     *  the secure store, the station type in prefs, and the session restore finding nobody. */
    private fun station(
        key: String? = "k1", signedIn: Boolean = false,
        beforeContent: suspend AppContainer.() -> Unit = {},
        configure: FakeStationApi.() -> Unit = {},
    ): Station {
        val api = FakeKioskApi()
        val st = FakeStationApi().apply { peopleResult = { listOf(tina) }; configure() }
        val c = testContainer(api = api, stationApi = st)
        runBlocking {
            c.identity.get()                                             // the serial, as AppContainer.start makes it
            c.prefs.setSetupSelection(KioskSetupSelection(siteId = "s1", siteName = "Dock 4", siteRole = "other", stationType = "timeclock"))
            c.prefs.setSetupState(SetupState.COMPLETE)
            if (key != null) c.stationKeys.put(key, ORIGIN)
            if (signedIn) c.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60)) else c.auth.restore()
            c.beforeContent()
        }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskApp() } }
        return Station(c, api, st)
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    /** Welcome → gear → sign-in → gear → Settings › This Kiosk. */
    private fun openSettings() {
        compose.onAllNodesWithContentDescription("Settings").onFirst().performClick()
        waitForText("Back to the time clock")
        compose.onNodeWithContentDescription("Kiosk settings").performClick()
        waitForTag("env-change")
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
        compose.waitUntilIdlingMain { "people" in s.station.calls }
        assertEquals("k1", s.station.keys.first())
        compose.waitUntilIdlingMain { runBlocking { s.c.db.people().count() } == 1 }
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
        compose.waitUntilIdlingMain { runBlocking { s.c.db.people().count() } == 1 }
        compose.waitForIdle()
        s.c.scanBus.publish(ScanEvent("BADGE-1", ScanSource.DATAWEDGE))
        waitForText(KEY_MISSING_TEXT)
        assertTrue("status" in s.station.calls)
        assertNull(s.c.stationKeys.get(ORIGIN))
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
        assertNull(s.c.stationKeys.get(ORIGIN))
    }

    @Test fun pausedWhenNotRegistered() {
        val s = station { peopleResult = { throw ApiError(403, "kiosk_not_registered") } }
        waitForText(PAUSED_TEXT)
        compose.onNodeWithText("Welcome!").assertIsDisplayed()
        compose.onNodeWithTag("tc-card-name").assertIsNotEnabled()
        assertEquals("k1", s.c.stationKeys.get(ORIGIN))                       // the key is kept
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

    @Test fun stationHomeShowsFourTiles() {
        val s = station(signedIn = true)
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("tile-TIMECLOCK_STATION").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("tile-SETUP").assertIsDisplayed()
        compose.onNodeWithTag("tile-TROUBLESHOOTING").assertIsDisplayed()
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
        assertEquals("station-key-1", s.c.stationKeys.get(ORIGIN))
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

    // ---- the key stays with the server that issued it ----

    /** Welcome → gear → sign-in → gear → Settings › This Kiosk, signed out: a switch to another
     *  environment drops the key and the station setup, and the kiosk lands on sign-in. */
    @Test fun aSignedOutSwitchClearsTheKeyAndLandsOnSignIn() {
        val s = station()
        waitForText("Welcome!")
        compose.waitUntilIdlingMain { "people" in s.station.calls }
        openSettings()
        compose.onNodeWithTag("env-change").performClick()
        waitForTag("env-password")
        compose.onNodeWithTag("env-password").performTextReplacement(Environments.PASSWORD)
        compose.onNodeWithTag("env-continue").performClick()
        waitForTag("env-row-uat")
        compose.onNodeWithTag("env-row-uat").performClick()
        waitForTag("env-confirm")
        compose.onNodeWithTag("env-confirm").performClick()
        compose.waitUntilIdlingMain { runBlocking { s.c.config.apiUrlNow() } == "https://api.uat.serversherpa.com" }
        waitForText("Sign in to start scanning.")
        compose.onNodeWithText("Back to the time clock").assertDoesNotExist()   // no longer a station
        assertNull(s.c.stationKeys.get(ORIGIN))
        assertNull(runBlocking { s.c.prefs.setupSelection.first() })
    }

    /** A key stored for one API with the URL since changed (any way at all): no station request
     *  goes out, the key is dropped, and Welcome shows the waiting copy. */
    @Test fun aStoredKeyWithAChangedUrlSendsNothingAndWaits() {
        val s = station(beforeContent = { environments.useApi("https://evil.example.com") })
        waitForText(KEY_MISSING_TEXT)
        compose.mainClock.advanceTimeBy(5_000)
        assertEquals(emptyList<String>(), s.station.calls)
        assertNull(s.c.stationKeys.get(ORIGIN))
    }

    @Test fun settingsSignedOutReturnsToWelcomeAfterIdle() {
        station()
        waitForText("Welcome!")
        compose.onAllNodesWithContentDescription("Settings").onFirst().performClick()
        waitForText("Back to the time clock")
        compose.onNodeWithContentDescription("Kiosk settings").performClick()
        waitForTag("env-change")
        compose.mainClock.advanceTimeBy(30_000)
        compose.onNodeWithTag("env-change").assertIsDisplayed()            // not yet
        compose.mainClock.advanceTimeBy(31_000)
        waitForText("Welcome!")
        compose.onNodeWithTag("env-change").assertDoesNotExist()
    }

    /** The environment chooser is its own window, so the page sees none of its touches: typing
     *  in it, and tapping it, count as activity themselves. Typing the kiosk name does too. */
    @Test fun typingInSettingsSignedOutKeepsItOpen() {
        station()
        waitForText("Welcome!")
        openSettings()
        compose.mainClock.advanceTimeBy(40_000)
        compose.onNodeWithTag("kiosk-name").performTextReplacement("Dock 4 clock")
        compose.mainClock.advanceTimeBy(40_000)
        compose.onNodeWithTag("env-change").performClick()
        waitForTag("env-password")
        compose.mainClock.advanceTimeBy(40_000)
        compose.onNodeWithTag("env-password").performTextReplacement("cum")
        compose.mainClock.advanceTimeBy(40_000)
        compose.onNodeWithTag("env-password").performClick()                 // a tap inside the chooser
        compose.mainClock.advanceTimeBy(40_000)
        compose.onNodeWithTag("env-password").assertIsDisplayed()          // 200 s in, still in use
        compose.mainClock.advanceTimeBy(21_000)
        waitForText("Welcome!")
        compose.onNodeWithTag("env-password").assertDoesNotExist()
    }

    @Test fun signInSignedOutReturnsToWelcomeAfterIdle() {
        station()
        waitForText("Welcome!")
        compose.onAllNodesWithContentDescription("Settings").onFirst().performClick()
        waitForText("Back to the time clock")
        compose.mainClock.advanceTimeBy(61_000)
        waitForText("Welcome!")
        compose.onNodeWithText("Back to the time clock").assertDoesNotExist()
    }
}
