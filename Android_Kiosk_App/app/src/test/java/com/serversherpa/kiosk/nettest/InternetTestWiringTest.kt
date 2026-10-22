package com.serversherpa.kiosk.nettest

import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.api.jsonResponse
import com.serversherpa.kiosk.data.api.sessionResponse
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.timeclock.screens.loadPhoto
import java.util.Base64
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Internet Test wired into the app (design 4.1, 4.2, 4.5): the real
 * [AppContainer], started with [AppContainer.start], against a MockWebServer.
 * The portal answers by path, so a call that never reaches it shows up as a
 * missing path rather than a hung queue.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InternetTestWiringTest {
    private val server = MockWebServer()

    // Held, so the level set on it isn't lost to garbage collection.
    private val serverLog: Logger = Logger.getLogger(MockWebServer::class.java.name)
    private val serverLogLevel: Level? = serverLog.level

    /** What `/auth/refresh` answers: a signed-in worker unless a test says otherwise. */
    @Volatile private var refresh: () -> MockResponse = { sessionResponse() }

    /** Every path the portal received, in order. */
    private val paths: MutableList<String> = Collections.synchronizedList(mutableListOf())

    private lateinit var c: AppContainer

    /** A setup saved for move mA. */
    private val setupA = KioskSetupSelection("mA", "Move A", "s1", "Dock 4", "source", "pre_stage", "Pre-stage")

    @Before fun setUp() {
        InternetTestRoutes.resetForTests()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                paths += path
                return when (path) {
                    "/auth/refresh" -> refresh()
                    "/system/status" -> jsonResponse(200, """{"read_only":false}""")
                    "/kiosk/sign-out", "/auth/logout" -> MockResponse().setResponseCode(204)
                    PHOTO -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(ONE_PIXEL_PNG))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        c = testContainer()
        runBlocking {
            c.prefs.setApiUrl(server.url("/").toString().trimEnd('/'))
            c.prefs.setDevMode(true)
        }
    }

    @After fun tearDown() {
        c.scope.cancel()
        c.db.close()
        InternetTestRoutes.resetForTests()
        server.shutdown()
        serverLog.level = serverLogLevel
    }

    /** Switches Internet Test on now (the two-hour clock starts now), with the Internet dial on [preset]. */
    private fun switchOn(preset: Preset) = runBlocking {
        c.internetTest.setEnabled(true)
        c.internetTest.choosePreset(Dial.INTERNET, preset)
    }

    private fun isOn(): Boolean = c.internetTest.settings.value.enabled

    /** Waits (real time: DataStore and the container run on real threads) until [ready] holds. */
    private fun await(what: String, timeoutMs: Long = 2_000, ready: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!ready()) {
            if (System.nanoTime() > deadline) fail("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    /** Starts the app and waits for the start-up restore to sign someone in. */
    private fun startSignedIn(): AuthState.Authed {
        c.start()
        await("the start-up restore") { c.auth.state.value is AuthState.Authed }
        return c.auth.state.value as AuthState.Authed
    }

    private fun millisSince(startNs: Long): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNs)

    @Test fun offIsIdentity() {
        // Nothing may sleep while the switch is off.
        val sleeps = Collections.synchronizedList(mutableListOf<Long>())
        InternetTestRoutes.sleeper = Sleeper { sleeps += it }
        startSignedIn()

        assertSame(c.httpClient, InternetTestRoutes.portal(c.httpClient))
        val started = System.nanoTime()
        runBlocking { c.api.systemStatus() }

        assertTrue("an unconditioned call took ${millisSince(started)} ms", millisSince(started) < 1_000)
        assertTrue("/system/status" in paths)
        assertEquals(emptyList<Long>(), sleeps)
    }

    @Test fun apiCallsTakeTheConditionedRouteWhileSignedInAndOn() {
        // A sleeper that only adds up the stalls, so 100% Loss runs out its timeouts at once.
        val sleeps = Collections.synchronizedList(mutableListOf<Long>())
        InternetTestRoutes.sleeper = Sleeper { sleeps += it }
        // 100% Loss opens a connection that never sends a request, which MockWebServer warns about.
        serverLog.level = Level.SEVERE
        switchOn(Preset.LOSS_100)
        startSignedIn()
        await("the Internet conditions") { InternetTestRoutes.internet == Preset.LOSS_100.profile }

        try {
            runBlocking { c.api.systemStatus() }
            fail("100% Loss should have stopped the call")
        } catch (e: ApiError) {
            assertEquals(0, e.status)
            assertEquals("network", e.code)
        }

        assertTrue("/system/status" !in paths)
        assertTrue("stalled ${sleeps.sum()} ms", sleeps.sum() >= 15_000)
    }

    /*
     * The Time Clock photo download (ConfirmPerson's loadPhoto, given the app's
     * client as TcAvatar gives it) is internet traffic too: direct while the
     * switch is off, conditioned while it is on and someone is signed in.
     */

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun photoDownloadGoesDirectWhileOff() {
        val sleeps = Collections.synchronizedList(mutableListOf<Long>())
        InternetTestRoutes.sleeper = Sleeper { sleeps += it }
        startSignedIn()

        // The router hands back the app's own client, and the download takes it as it is:
        // the real photo arrives (decoded for real, native graphics) and nothing waited.
        // (No timing check: the first native decode alone can take a second.)
        assertSame(c.httpClient, InternetTestRoutes.portal(c.httpClient))
        val photo = runBlocking { loadPhoto(c.httpClient, server.url(PHOTO).toString()) }

        assertNotNull("the photo didn't load", photo)
        assertEquals(1, photo!!.width)
        assertTrue("$paths", PHOTO in paths)
        assertEquals(emptyList<Long>(), sleeps)
    }

    @Test fun photoDownloadTakesTheConditionedRouteWhileSignedInAndOn() {
        // A sleeper that only adds up the stalls, so 100% Loss runs out its timeouts at once.
        val sleeps = Collections.synchronizedList(mutableListOf<Long>())
        InternetTestRoutes.sleeper = Sleeper { sleeps += it }
        serverLog.level = Level.SEVERE
        switchOn(Preset.LOSS_100)
        startSignedIn()
        await("the Internet conditions") { InternetTestRoutes.internet == Preset.LOSS_100.profile }

        val photo = runBlocking { loadPhoto(c.httpClient, server.url(PHOTO).toString()) }

        // No photo (the initials stay), the request never reached the portal,
        // and it stalled out the client's own 15 s connect timeout.
        assertNull(photo)
        assertTrue("$paths", PHOTO !in paths)
        assertTrue("stalled ${sleeps.sum()} ms", sleeps.sum() >= 15_000)
    }

    @Test fun restoreGoesDirectUnderTotalLoss() {
        switchOn(Preset.LOSS_100)
        val started = System.nanoTime()

        startSignedIn()

        assertTrue("the restore took ${millisSince(started)} ms", millisSince(started) < 2_000)
        assertEquals("/auth/refresh", paths.first())
        // Signed in, the conditions are in force and the switch is still on.
        await("the Internet conditions") { InternetTestRoutes.internet == Preset.LOSS_100.profile }
        assertNotSame(c.httpClient, InternetTestRoutes.portal(c.httpClient))
        assertTrue("the restore turned Internet Test off", isOn())
    }

    @Test fun signOutIsQuickUnderTotalLoss() {
        switchOn(Preset.LOSS_100)
        startSignedIn()
        await("the Internet conditions") { InternetTestRoutes.internet == Preset.LOSS_100.profile }

        val started = System.nanoTime()
        runBlocking { c.logout() }

        assertTrue("sign-out took ${millisSince(started)} ms", millisSince(started) < 2_000)
        assertTrue("$paths", "/kiosk/sign-out" in paths)
        assertTrue("$paths", "/auth/logout" in paths)
        assertTrue(c.auth.state.value is AuthState.Anon)
        assertSame(c.httpClient, InternetTestRoutes.portal(c.httpClient))
        await("the switch to turn off") { !isOn() }
    }

    @Test fun moveGuardDropTurnsOff() {
        runBlocking {
            c.prefs.setSetupSelection(setupA)
            c.prefs.setSetupState(SetupState.COMPLETE)
        }
        val moveSession = fakeSession(kioskMove = KioskMove("mB", "Move B"))
        refresh = { jsonResponse(200, KioskJson.encodeToString(SessionData.serializer(), moveSession)) }
        switchOn(Preset.THREE_G)

        val authed = startSignedIn()

        assertEquals("mB", authed.kioskMove?.initiative_id)
        await("the setup to drop") { runBlocking { c.prefs.setupSelection.first() } == null }
        await("the switch to turn off") { !isOn() }
        await("the Internet link to go direct") { InternetTestRoutes.internet == null }
        // Still signed in: only the setup went.
        assertTrue(c.auth.state.value is AuthState.Authed)
    }

    @Test fun resetAppLeavesItOn() {
        runBlocking { c.prefs.setSetupSelection(setupA) }
        switchOn(Preset.THREE_G)
        startSignedIn()
        await("the Internet conditions") { InternetTestRoutes.internet == Preset.THREE_G.profile }

        runBlocking { c.resetApp(clearLocalData = {}) }

        assertNull(runBlocking { c.prefs.setupSelection.first() })
        Thread.sleep(300)   // room for any turn-off the reset might have set off
        assertTrue("Reset app turned Internet Test off", isOn())
        assertEquals(Preset.THREE_G.profile, InternetTestRoutes.internet)
    }

    private companion object {
        /** Where the portal serves a person's photo (a presigned storage URL, in the app). */
        const val PHOTO = "/photo.png"

        /** A 1 x 1 PNG. */
        val ONE_PIXEL_PNG: ByteArray = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        )
    }
}
