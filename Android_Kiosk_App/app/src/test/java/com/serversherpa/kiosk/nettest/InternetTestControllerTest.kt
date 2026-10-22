package com.serversherpa.kiosk.nettest

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The controller against a real, throwaway DataStore. The store and the
 * controller both run on the test's virtual time, and the controller's clock
 * reads that same time (plus [clockOffset], for a device clock that starts
 * somewhere else), so the two-hour timer is driven by advancing the scheduler.
 * Nothing here sleeps for real.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InternetTestControllerTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Notes the Internet route in force each time a write is asked for. */
    private class WatchedStore(private val inner: DataStore<Preferences>) : DataStore<Preferences> by inner {
        val internetAtWrite = mutableListOf<LinkProfile?>()

        override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
            internetAtWrite += InternetTestRoutes.internet
            return inner.updateData(transform)
        }
    }

    private val key = stringPreferencesKey("ss.kiosk.netTest")
    private val signedIn: AuthState = AuthState.Authed(fakeSession())
    private val auth = MutableStateFlow(signedIn)
    private val devMode = MutableStateFlow(true)
    private val setupCleared = MutableSharedFlow<String>()
    private var clockOffset = 0L
    private val storeFile by lazy { File(tmp.root, "net-test.preferences_pb") }

    /** Switched on at 0, with Internet on 3G and Local network on Very Bad. */
    private val savedOn = InternetTestSettings(
        enabled = true,
        armedAtMs = 0,
        internet = DialSetting(Preset.THREE_G.id),
        local = DialSetting(Preset.VERY_BAD.id),
    )

    @After fun tearDown() {
        InternetTestRoutes.resetForTests()
    }

    private fun TestScope.newStore(): WatchedStore =
        WatchedStore(PreferenceDataStoreFactory.create(scope = backgroundScope) { storeFile })

    /** A controller started on the test's flows, with everything it launched run once. */
    private fun TestScope.started(store: DataStore<Preferences>): InternetTest =
        InternetTest(store, backgroundScope, clock = { testScheduler.currentTime + clockOffset }).also {
            it.start(auth, devMode, setupCleared)
            runCurrent()
        }

    private suspend fun DataStore<Preferences>.save(s: InternetTestSettings) {
        edit { it[key] = s.encode() }
    }

    private suspend fun DataStore<Preferences>.saved(): InternetTestSettings =
        InternetTestSettings.decode(data.first()[key])

    /** Switched on, with Internet on 3G and Local network on Very Bad. */
    private suspend fun InternetTest.onWithPresets() {
        setEnabled(true)
        choosePreset(Dial.INTERNET, Preset.THREE_G)
        choosePreset(Dial.LOCAL, Preset.VERY_BAD)
    }

    @Test fun enableWhileSignedInInstallsRoutes() = runTest {
        val test = started(newStore())
        test.onWithPresets()
        runCurrent()

        assertEquals(Preset.THREE_G.profile, InternetTestRoutes.internet)
        assertEquals(Preset.VERY_BAD.profile, InternetTestRoutes.local)
        assertTrue(test.settings.value.enabled)
        assertEquals(TEST_LIFETIME_MS, test.turnsOffAtMs())
    }

    @Test fun notSignedInMeansDirect() = runTest {
        clockOffset = 1_000
        auth.value = AuthState.Loading
        val store = newStore()
        store.save(savedOn)
        val test = started(store)

        assertEquals("the saved settings loaded", savedOn, test.settings.value)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
        assertTrue("waiting on the restore leaves the switch on", store.saved().enabled)

        auth.value = signedIn
        runCurrent()
        assertEquals(Preset.THREE_G.profile, InternetTestRoutes.internet)
        assertEquals(Preset.VERY_BAD.profile, InternetTestRoutes.local)
    }

    @Test fun anonTurnsOff() = runTest {
        clockOffset = 1_000
        auth.value = AuthState.Loading
        val store = newStore()
        store.save(savedOn)
        val test = started(store)
        assertTrue(test.settings.value.enabled)

        auth.value = AuthState.Anon
        runCurrent()

        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(store.saved().armedAtMs)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
    }

    @Test fun sessionEndingTurnsOff() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertNotNull(InternetTestRoutes.internet)

        auth.value = AuthState.Anon
        runCurrent()

        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(InternetTestRoutes.internet)
    }

    @Test fun signOutTurnsOff() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertNotNull(InternetTestRoutes.internet)

        test.beforeSignOut()

        // Direct before the switch is even written, so the sign-out's own
        // portal calls, which follow at once, are never conditioned.
        assertNull("direct before the write", store.internetAtWrite.last())
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
        assertFalse(store.saved().enabled)
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertNull(test.turnsOffAtMs())
    }

    @Test fun devModeOffTurnsOff() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertNotNull(InternetTestRoutes.internet)

        devMode.value = false
        runCurrent()

        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
    }

    @Test fun setupClearedTurnsOff() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertNotNull(InternetTestRoutes.internet)

        setupCleared.emit("clear-1")
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(InternetTestRoutes.internet)

        // Every clear counts, not only the first.
        test.setEnabled(true)
        runCurrent()
        assertTrue(test.settings.value.enabled)
        setupCleared.emit("clear-2")
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
    }

    @Test fun onSetupDroppedTurnsOff() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertNotNull(InternetTestRoutes.internet)

        test.onSetupDropped()
        runCurrent()

        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
    }

    @Test fun twoHourTimer() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertEquals(7_200_000L, test.turnsOffAtMs())

        advanceTimeBy(7_199_999)
        runCurrent()
        assertTrue(test.settings.value.enabled)
        assertNotNull(InternetTestRoutes.internet)

        advanceTimeBy(1)
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
        assertFalse(store.saved().enabled)
    }

    @Test fun editsDontExtend() = runTest {
        val store = newStore()
        val test = started(store)
        test.setEnabled(true)
        runCurrent()

        advanceTimeBy(3_600_000)
        runCurrent()
        test.choosePreset(Dial.INTERNET, Preset.THREE_G)
        test.setCustom(Dial.LOCAL, LinkProfile(downKbps = 100))
        runCurrent()
        assertEquals(7_200_000L, test.turnsOffAtMs())

        advanceTimeBy(3_599_999)
        runCurrent()
        assertTrue(test.settings.value.enabled)

        advanceTimeBy(1)
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
    }

    @Test fun switchingOnWhileOnKeepsTheClock() = runTest {
        val test = started(newStore())
        test.setEnabled(true)
        runCurrent()

        advanceTimeBy(3_600_000)
        runCurrent()
        test.setEnabled(true)
        runCurrent()
        assertEquals("already on, so not a new switch-on", 7_200_000L, test.turnsOffAtMs())

        test.setEnabled(false)
        test.setEnabled(true)
        runCurrent()
        assertEquals("off then on starts a new two hours", 10_800_000L, test.turnsOffAtMs())
    }

    @Test fun restartWithinTwoHoursKeepsCounting() = runTest {
        clockOffset = 3_600_000
        val store = newStore()
        store.save(savedOn)
        val test = started(store)
        assertTrue(test.settings.value.enabled)
        assertEquals(Preset.THREE_G.profile, InternetTestRoutes.internet)
        assertEquals(7_200_000L, test.turnsOffAtMs())

        advanceTimeBy(3_599_999)
        runCurrent()
        assertTrue(test.settings.value.enabled)

        advanceTimeBy(1)
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(InternetTestRoutes.internet)
    }

    @Test fun restartPastTwoHoursStartsOff() = runTest {
        clockOffset = 7_200_000
        val store = newStore()
        store.save(savedOn)
        val test = started(store)

        assertFalse(store.saved().enabled)
        assertFalse(test.settings.value.enabled)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
    }

    @Test fun backwardClockExpires() = runTest {
        clockOffset = 9_000
        val store = newStore()
        store.save(savedOn.copy(armedAtMs = 10_000))
        val test = started(store)

        assertFalse(store.saved().enabled)
        assertFalse(test.settings.value.enabled)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
    }

    @Test fun clockMovedPastTwoHoursGoesDirect() = runTest {
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertNotNull(InternetTestRoutes.internet)

        // The device clock jumps forward past the two hours, and the session is
        // refreshed before the timer next looks: the refresh never re-conditions.
        clockOffset = 7_200_000
        auth.value = AuthState.Authed(fakeSession(maxRank = 21))
        runCurrent()
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)

        advanceTimeBy(60_000)
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
    }

    @Test fun clockMovedBackWhileOnExpires() = runTest {
        clockOffset = 100_000
        val store = newStore()
        val test = started(store)
        test.onWithPresets()
        runCurrent()
        assertEquals(7_300_000L, test.turnsOffAtMs())

        // Back past the switch-on: the elapsed time can't be trusted.
        clockOffset = 0
        advanceTimeBy(59_999)
        runCurrent()
        assertTrue(test.settings.value.enabled)

        advanceTimeBy(1)
        runCurrent()
        assertFalse(test.settings.value.enabled)
        assertFalse(store.saved().enabled)
        assertNull(InternetTestRoutes.internet)
    }

    @Test fun offPresetOnOneDial() = runTest {
        val test = started(newStore())
        test.setEnabled(true)
        test.choosePreset(Dial.INTERNET, Preset.OFF)
        test.choosePreset(Dial.LOCAL, Preset.VERY_BAD)
        runCurrent()

        assertNull(InternetTestRoutes.internet)
        assertNotNull(InternetTestRoutes.local)
        assertEquals(Preset.VERY_BAD.profile, InternetTestRoutes.local)
    }

    @Test fun unreadableSettingLoadsOff() = runTest {
        val store = newStore()
        store.edit { it[key] = "{bad" }
        val test = started(store)

        assertEquals(InternetTestSettings(), test.settings.value)
        assertNull(InternetTestRoutes.internet)
        assertNull(InternetTestRoutes.local)
    }

    @Test fun customValuesAreClamped() = runTest {
        val store = newStore()
        val test = started(store)
        val wild = LinkProfile(
            downKbps = 0,
            upKbps = -3,
            downDelayMs = 90_000,
            upDelayMs = -1,
            downDropPct = Double.NaN,
            upDropPct = 250.0,
            dnsDelayMs = 70_000,
        )

        test.setCustom(Dial.INTERNET, wild)

        assertEquals(LinkProfile(null, null, 60_000, 0, 0.0, 100.0, 60_000), store.saved().internet.custom)
    }

    @Test fun presetNotOnTheDialIsRefused() = runTest {
        val store = newStore()
        val test = started(store)
        test.choosePreset(Dial.LOCAL, Preset.WIFI)
        runCurrent()
        assertEquals(Preset.WIFI.id, test.settings.value.local.preset)
        val writes = store.internetAtWrite.size

        test.choosePreset(Dial.LOCAL, Preset.THREE_G)
        runCurrent()

        assertEquals(Preset.WIFI.id, test.settings.value.local.preset)
        assertEquals(Preset.WIFI.id, store.saved().local.preset)
        assertEquals("nothing was written", writes, store.internetAtWrite.size)
    }

    @Test fun turningOffWhileOffWritesNothing() = runTest {
        auth.value = AuthState.Anon
        devMode.value = false
        val test = started(newStore())

        setupCleared.emit("clear-1")
        test.turnOff()
        test.setEnabled(false)
        test.onSetupDropped()
        runCurrent()

        assertFalse("the store was never written", storeFile.exists())
        assertFalse(test.settings.value.enabled)
    }

    @Test fun changingTheInternetPresetEvictsPooledConnections() = runTest {
        InternetTestRoutes.sleeper = Sleeper { }
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setBody("ok"))
            val base = OkHttpClient()
            val test = started(newStore())
            test.setEnabled(true)
            test.choosePreset(Dial.INTERNET, Preset.WIFI)
            runCurrent()

            val conditioned = InternetTestRoutes.portal(base)
            assertNotSame(base, conditioned)
            conditioned.newCall(Request.Builder().url(server.url("/")).build()).execute().use {
                assertEquals("ok", it.body!!.string())
            }
            assertEquals(1, conditioned.connectionPool.connectionCount())

            test.choosePreset(Dial.INTERNET, Preset.LTE)
            runCurrent()

            assertEquals(Preset.LTE.profile, InternetTestRoutes.internet)
            assertEquals("the Wi-Fi connection isn't reused under LTE", 0, conditioned.connectionPool.connectionCount())
        } finally {
            server.shutdown()
        }
    }
}
