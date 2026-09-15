package com.serversherpa.kiosk.data.heartbeat

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.LoginMethod
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class HeartbeatTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Pumps several hops of background-scope dispatch (collector -> beat -> DataStore actor -> api call). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    private fun harness(scope: kotlinx.coroutines.CoroutineScope, api: FakeKioskApi): Heartbeat {
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "hb.preferences_pb") })
        val config = KioskConfig(prefs, "https://api", "https://portal", "0.1.0")
        return Heartbeat(api, Identity(prefs), config, deviceInfo = { mapOf("model" to "MC2200") }, intervalMs = 60_000)
    }

    @Test fun beatsImmediatelyThenEveryMinuteAndReportsRegistration() = runTest {
        val api = FakeKioskApi()
        val hb = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = LoginMethod.PASSWORD)
        settle()
        assertEquals(1, api.heartbeats.size)
        assertEquals(true, api.heartbeats[0].sign_in); assertEquals("password", api.heartbeats[0].login_method)
        assertEquals("android", api.heartbeats[0].mode); assertEquals("MC2200", api.heartbeats[0].raw_info["model"])
        assertEquals(RegistrationState.OK, hb.registration.value)
        advanceTimeBy(60_001); settle()
        assertEquals(2, api.heartbeats.size)
        assertEquals(false, api.heartbeats[1].sign_in)   // cleared once a beat succeeded
        assertNull(api.heartbeats[1].login_method)
        hb.stop()
        assertNull(hb.registration.value)
    }

    @Test fun failedBeatKeepsPendingSignInAndLastState() = runTest {
        val api = FakeKioskApi()
        var fail = true
        api.heartbeatResult = { if (fail) throw ApiError(0, "network") else com.serversherpa.kiosk.core.model.HeartbeatResult("d", it.name, "soon", null) }
        val hb = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = LoginMethod.LINK)
        settle()
        assertNull(hb.registration.value)
        fail = false
        hb.now()
        assertEquals(2, api.heartbeats.size)
        assertEquals(true, api.heartbeats[1].sign_in); assertEquals("link", api.heartbeats[1].login_method)
        assertEquals(RegistrationState.SOON, hb.registration.value)
        fail = true
        hb.now()
        assertEquals(RegistrationState.SOON, hb.registration.value)   // last state kept
    }
}
