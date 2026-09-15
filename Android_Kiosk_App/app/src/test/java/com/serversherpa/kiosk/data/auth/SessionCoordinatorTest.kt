package com.serversherpa.kiosk.data.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class SessionCoordinatorTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun heartbeatRunsOnlyWhileAuthedAndForeground() = runTest {
        val api = FakeKioskApi()
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "c.preferences_pb") })
        val identity = Identity(prefs)
        val config = KioskConfig(prefs, "https://api", "https://portal", "0.1.0")
        val auth = KioskAuth(api, FakeRefresher(), identity, backgroundScope)
        val hb = Heartbeat(api, identity, config, { emptyMap() }, 60_000)
        val foreground = MutableStateFlow(true)
        SessionCoordinator(auth, hb, foreground, backgroundScope).start()
        advanceUntilIdle()
        assertEquals(0, api.heartbeats.size)
        auth.completePair(fakeSession())
        advanceUntilIdle()
        assertEquals(1, api.heartbeats.size)
        assertEquals("link", api.heartbeats[0].login_method)
        foreground.value = false
        advanceTimeBy(120_000); advanceUntilIdle()
        assertEquals(1, api.heartbeats.size)             // stopped in the background
        foreground.value = true
        advanceUntilIdle()
        assertEquals(2, api.heartbeats.size)             // resumed: immediate beat, no sign_in
        assertEquals(false, api.heartbeats[1].sign_in)
        auth.completePair(fakeSession(mustChange = true))
        advanceTimeBy(120_000); advanceUntilIdle()
        assertEquals(2, api.heartbeats.size)             // must-change-password: no heartbeat
    }
}
