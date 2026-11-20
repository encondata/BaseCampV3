package com.serversherpa.kiosk.data.heartbeat

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.LoginMethod
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.environment.EnvironmentStore
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.prefs.SetupClearRecord
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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

    private fun harness(scope: kotlinx.coroutines.CoroutineScope, api: FakeKioskApi): Pair<Heartbeat, KioskPrefs> {
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "hb.preferences_pb") })
        val environments = EnvironmentStore(prefs)
        val config = KioskConfig(environments, SavedEnvironment.Named("dev", "Dev", "dev.serversherpa.com"), "0.1.0")
        return Heartbeat(api, Identity(prefs), config, prefs, environments, deviceInfo = { mapOf("model" to "MC2200") }, intervalMs = 60_000) to prefs
    }

    @Test fun beatsImmediatelyThenEveryMinuteAndReportsRegistration() = runTest {
        val api = FakeKioskApi()
        val (hb, _) = harness(backgroundScope, api)
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
        val (hb, _) = harness(backgroundScope, api)
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

    @Test fun clearSetupAppliesOnceAcksOnARebeatThenStops() = runTest {
        val api = FakeKioskApi()
        // a fake server: repeats the pending id until a beat acknowledges it
        var pending: String? = "x1"
        api.heartbeatResult = {
            if (it.setup_cleared != null && it.setup_cleared == pending) pending = null
            HeartbeatResult("d", it.name, "ok", null, clear_setup = pending)
        }
        val (hb, prefs) = harness(backgroundScope, api)
        prefs.setSetupState(SetupState.COMPLETE)
        val events = mutableListOf<String>()
        backgroundScope.launch { hb.setupCleared.collect { events += it } }
        hb.start(backgroundScope, signIn = null)
        settle()
        assertEquals(listOf("x1"), events)
        assertEquals(SetupState.INCOMPLETE, prefs.setupState.first())
        assertNull(api.heartbeats[0].setup_cleared)
        assertEquals("x1", api.heartbeats[1].setup_cleared)          // immediate re-beat acks
        advanceTimeBy(60_001); settle()
        assertNull(api.heartbeats.last().setup_cleared)               // server stopped asking
        assertEquals(1, events.size)
    }

    @Test fun keepsAckingWhileTheServerRepeatsTheSameId() = runTest {
        val api = FakeKioskApi()
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = "x2") }
        val (hb, _) = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = null)
        settle(); advanceTimeBy(60_001); settle()
        assertEquals("x2", api.heartbeats.last().setup_cleared)
    }

    /** No hot loop: a server that keeps repeating one id gets one immediate re-beat, then the normal cadence. */
    @Test fun aRepeatedIdTriggersOnlyOneImmediateRebeat() = runTest {
        val api = FakeKioskApi()
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = "x5") }
        val (hb, _) = harness(backgroundScope, api)
        val events = mutableListOf<String>()
        backgroundScope.launch { hb.setupCleared.collect { events += it } }
        hb.start(backgroundScope, signIn = null)
        settle()
        assertEquals(2, api.heartbeats.size)                          // the beat + one immediate ack
        advanceTimeBy(60_001); settle()
        assertEquals(3, api.heartbeats.size)                          // then once a minute, not a loop
        assertEquals(listOf("x5"), events)
    }

    @Test fun aNullReplyToABeatWithoutTheAckDoesNotSettleIt() = runTest {
        val api = FakeKioskApi()
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = null) }
        val (_, prefs) = harness(backgroundScope, api)
        prefs.applySetupClear("x4")
        prefs.settleSetupClearAck(sentAck = null, replyId = null)     // a beat that didn't carry it
        assertEquals("x4", prefs.pendingSetupClearAck())
        prefs.settleSetupClearAck(sentAck = "x4", replyId = null)     // the beat that did
        assertNull(prefs.pendingSetupClearAck())
    }

    @Test fun anUnackedIdFromBeforeARestartIsAckedNotReapplied() = runTest {
        val api = FakeKioskApi()
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = null) }
        val (hb, prefs) = harness(backgroundScope, api)
        prefs.applySetupClear("x3")
        prefs.setSetupState(SetupState.COMPLETE)                       // set up again since
        hb.start(backgroundScope, signIn = null)
        settle()
        assertEquals("x3", api.heartbeats[0].setup_cleared)
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())   // not re-cleared
    }

    @Test fun applyIsOncePerIdAndTheNoticeDismisses() = runTest {
        val (_, prefs) = harness(backgroundScope, FakeKioskApi())
        assertEquals(true, prefs.applySetupClear("x6"))
        assertEquals(false, prefs.applySetupClear("x6"))
        assertEquals(true, prefs.setupClear.first()?.notice)
        prefs.dismissSetupClearNotice()
        assertEquals(SetupClearRecord("x6", acked = false, notice = false), prefs.setupClear.first())
        assertEquals(true, prefs.applySetupClear("x7"))              // a re-request is a new id
        assertEquals(true, prefs.setupClear.first()?.notice)
    }

    /** A station key is issued only to whoever the portal records as signed in here: signInNow
     *  sends a sign-in beat on its own, with the method of the sign-in this session came from. */
    @Test fun signInNowSendsTheSessionsOwnMethod() = runTest {
        val api = FakeKioskApi()
        val (hb, prefs) = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = LoginMethod.LINK)
        settle(); hb.stop()
        assertEquals("link", prefs.signInMethod.first())
        hb.signInNow()
        val last = api.heartbeats.last()
        assertEquals(true, last.sign_in); assertEquals("link", last.login_method)
        hb.now()
        assertEquals(false, api.heartbeats.last().sign_in)              // landed: plain again
    }

    @Test fun signInNowWithNoKnownMethodSendsNoneRatherThanAGuess() = runTest {
        val api = FakeKioskApi()
        val (hb, _) = harness(backgroundScope, api)
        hb.signInNow()
        assertEquals(true, api.heartbeats.single().sign_in)
        assertNull(api.heartbeats.single().login_method)
    }

    @Test fun signInNowKeepsAPendingSignInsMethod() = runTest {
        val api = FakeKioskApi()
        var fail = true
        api.heartbeatResult = { if (fail) throw ApiError(0, "network") else HeartbeatResult("d", it.name, "ok", null) }
        val (hb, _) = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = LoginMethod.LINK)
        settle(); hb.stop()
        fail = false
        hb.signInNow()
        assertEquals("link", api.heartbeats.last().login_method)
    }

    /** Any registration but "none" marks the kiosk as registered for good; "none" doesn't. */
    @Test fun aRegistrationSetsTheEverRegisteredFlagAndNoneDoesNot() = runTest {
        val api = FakeKioskApi()
        var registration = "none"
        api.heartbeatResult = { HeartbeatResult("d1", it.name, registration, null) }
        val (hb, prefs) = harness(backgroundScope, api)
        val environments = EnvironmentStore(prefs)
        hb.now()
        assertEquals(false, environments.everRegistered.first())
        registration = "ok"
        hb.now()
        assertEquals(true, environments.everRegistered.first())
        registration = "none"
        hb.now()
        assertEquals(true, environments.everRegistered.first())   // never cleared
    }

    /** An environment switch: a beat still waiting on the old server when the heartbeat stops
     *  writes nothing from its reply (no registration, no Clear Setup, no sign-in method), except
     *  the has-been-registered flag: a registration from any server counts for good (as on iOS). */
    @Test fun aReplyArrivingAfterStopAndDropRepliesWritesNothing() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = object : FakeKioskApi() {
            override suspend fun heartbeat(body: com.serversherpa.kiosk.core.model.HeartbeatIn): HeartbeatResult {
                gate.await(); return super.heartbeat(body)
            }
        }
        api.heartbeatResult = { HeartbeatResult("d", it.name, "ok", null, clear_setup = "x9") }
        val (hb, prefs) = harness(backgroundScope, api)
        prefs.setSetupState(SetupState.COMPLETE)
        val events = mutableListOf<String>()
        backgroundScope.launch { hb.setupCleared.collect { events += it } }
        backgroundScope.launch { hb.signInNow() }                    // outside the beat loop: stop() can't cancel it
        prefs.setSignInMethod("password")
        settle()

        hb.stopAndDropReplies()
        prefs.setSignInMethod("link")
        gate.complete(Unit); settle()

        assertEquals(1, api.heartbeats.size)
        assertNull(hb.registration.value)
        assertNull(prefs.setupClear.first())
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals("link", prefs.signInMethod.first())
        assertEquals(emptyList<String>(), events)
        assertEquals(true, prefs.everRegistered.first())
        // A beat that starts afterwards is the new server's: its reply counts.
        hb.now()
        assertEquals(RegistrationState.OK, hb.registration.value)
    }
}
