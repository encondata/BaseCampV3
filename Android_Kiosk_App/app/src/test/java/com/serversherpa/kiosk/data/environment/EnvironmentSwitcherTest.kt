package com.serversherpa.kiosk.data.environment

import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.environment.Environments
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.environment.asSaved
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.MeInfo
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.outbox.MemoryOutboxStore
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.OutboxStore
import com.serversherpa.kiosk.data.prefs.BiometricEnrollment
import com.serversherpa.kiosk.testContainer
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The environment switch's gates and what it clears (spec "Who can change what" and "What a
 *  switch does"), against a whole container with a fake server. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EnvironmentSwitcherTest {
    private val api = FakeKioskApi()
    private val secrets = MemorySecretStore()
    private val c: AppContainer = testContainer(api = api, secrets = secrets)
    private val switcher get() = c.environmentSwitcher
    private val uat = checkNotNull(Environments.byId("uat")).asSaved()
    private val prod = checkNotNull(Environments.byId("prod")).asSaved()
    private val custom = SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173")
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")

    @After fun tearDown() { c.scope.cancel(); c.db.close() }

    private fun me(rank: Int, global: Boolean) = MeInfo(roles = emptyList(), max_rank = rank, scope = MeInfo.Scope(global))

    private fun signIn(rank: Int = 20) = c.auth.completePair(fakeSession(maxRank = rank))

    /** [n] unsent (queued) scans in the outbox's store, as a kiosk left them. */
    private fun unsent(n: Int) = runBlocking {
        c.db.outbox().upsert((1..n).map {
            OutboxMachine.newRow(EnqueueInput("A-$it", "barcode", asset, "s1", "i1", "packed"), "c$it", it.toLong(), 0).toEntity()
        })
    }

    private fun registered() = runBlocking { c.environments.markRegistered() }

    @Test fun aNamedSwitchWithNothingUnsentIsDoneAndLeavesNothingOfTheOldServer() = runBlocking<Unit> {
        c.prefs.setSerial("K-123")
        c.prefs.setName("Dock 4")
        registered()
        c.prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s1", "Dallas", "source", "packed", "Packed"))
        c.prefs.setSignInMethod("password")
        c.prefs.applySetupClear("clear-1")
        c.prefs.setBiometric(BiometricEnrollment("key-1", "p1"))
        c.stationKeys.put("station-key-1", "http://127.0.0.1:1")
        c.pushKeys.save("reg-1", "push-key-1", "http://127.0.0.1:1", "p1")
        // A refresh cookie from a host this process never talked to (an earlier launch's server).
        secrets.put("cookie|api.old.serversherpa.com|ss_refresh", "{}")
        secrets.put("cookie|127.0.0.1|ss_refresh", "{}")
        secrets.put("unrelated", "kept")
        signIn()

        assertEquals(SwitchResult.Done, switcher.switchTo(uat, discard = false))

        assertEquals(uat, c.environments.saved.first())
        assertEquals("https://api.uat.serversherpa.com", c.config.apiUrl.first())
        assertTrue(secrets.keys().none { it.endsWith("|ss_refresh") })
        assertEquals("kept", secrets.get("unrelated"))
        assertNull(c.stationKeys.get("http://127.0.0.1:1"))
        assertFalse(c.pushKeys.hasKey())
        assertNull(c.prefs.biometric.first())
        assertNull(c.prefs.signInMethod.first())
        assertNull(c.prefs.setupClear.first())
        assertNull(c.prefs.setupSelection.first())                        // resetApp ran
        assertTrue(c.auth.state.value is AuthState.Anon)
        // Revoked on the old server while still signed in, then signed out there.
        assertTrue(api.calls.containsAll(listOf("bioForget:K-123", "deletePush", "logout")))
        assertTrue("no access check is needed", "me" !in api.calls)
        // Kept: the kiosk itself.
        assertEquals("K-123", c.prefs.serial.first())
        assertEquals("Dock 4", c.prefs.name.first())
        assertTrue(c.environments.everRegistered.first())
    }

    @Test fun unsentWorkIsPendingAndChangesNothing() = runBlocking<Unit> {
        signIn()
        unsent(2)

        assertEquals(SwitchResult.Pending(2), switcher.switchTo(uat, discard = false))

        assertEquals(2, switcher.unsentCount())
        assertEquals(2, c.db.outbox().all().size)
        assertTrue(c.auth.state.value is AuthState.Authed)
        assertTrue(c.environments.saved.first() is SavedEnvironment.Custom)  // the test server, still
    }

    @Test fun discardingWhileSignedOutIsRefused() = runBlocking<Unit> {
        unsent(2)

        assertEquals(SwitchResult.Refused("discard_needs_admin"), switcher.switchTo(uat, discard = true))

        assertTrue("nobody to ask about", "me" !in api.calls)
        assertEquals(2, c.db.outbox().all().size)
    }

    @Test fun discardingNeedsRankSixty() = runBlocking<Unit> {
        signIn()
        unsent(2)
        api.meResult = { me(40, global = true) }

        assertEquals(SwitchResult.Refused("discard_needs_admin"), switcher.switchTo(uat, discard = true))
        assertEquals(2, c.db.outbox().all().size)
    }

    @Test fun anAdminCanDiscardAndTheOutboxEnds() = runBlocking<Unit> {
        signIn(rank = 60)
        unsent(2)
        api.meResult = { me(60, global = false) }

        assertEquals(SwitchResult.Done, switcher.switchTo(uat, discard = true))

        assertEquals(uat, c.environments.saved.first())
        assertEquals(0, switcher.unsentCount())
        assertTrue(c.db.outbox().all().isEmpty())
    }

    @Test fun workQueuedWhileTheSwitchWaitsIsNeverDiscardedUnseen() = runBlocking<Unit> {
        signIn(rank = 60)
        unsent(2)
        api.meResult = {
            c.outbox.enqueue(EnqueueInput("B-1", "barcode", asset, "s1", "i1", "packed"))
            me(60, global = false)
        }

        assertEquals(SwitchResult.Pending(3), switcher.switchTo(uat, discard = true))

        assertEquals(3, c.db.outbox().all().size)
        assertTrue(c.environments.saved.first() is SavedEnvironment.Custom)
    }

    @Test fun customOnANeverRegisteredKioskIsDone() = runBlocking<Unit> {
        assertEquals(SwitchResult.Done, switcher.switchTo(custom, discard = false))

        assertEquals(custom, c.environments.saved.first())
        assertEquals("http://10.10.48.103:8000", c.config.apiUrl.first())
        assertTrue("me" !in api.calls)
    }

    @Test fun customOnARegisteredKioskNeedsAGlobalRankOfEighty() = runBlocking<Unit> {
        registered()
        signIn(rank = 100)

        api.meResult = { me(100, global = false) }
        assertEquals(SwitchResult.Refused("custom_needs_super_admin"), switcher.switchTo(custom, discard = false))
        assertTrue(c.environments.saved.first() is SavedEnvironment.Custom)
        assertTrue(c.auth.state.value is AuthState.Authed)

        api.meResult = { me(80, global = true) }
        assertEquals(SwitchResult.Done, switcher.switchTo(custom, discard = false))
        assertEquals(custom, c.environments.saved.first())
    }

    @Test fun customOnARegisteredKioskWhileSignedOutIsRefused() = runBlocking<Unit> {
        registered()
        assertEquals(SwitchResult.Refused("custom_needs_super_admin"), switcher.switchTo(custom, discard = false))
        assertTrue("me" !in api.calls)
    }

    @Test fun anAccessCheckThatCantReachTheServerIsRefused() = runBlocking<Unit> {
        registered()
        signIn(rank = 100)
        api.meResult = { throw ApiError(0, "network") }

        assertEquals(SwitchResult.Refused("access_check_offline"), switcher.switchTo(custom, discard = false))
        assertTrue(c.environments.saved.first() is SavedEnvironment.Custom)
        assertTrue(c.auth.state.value is AuthState.Authed)
    }

    @Test fun aRefusedAccessCheckIsTheGatesOwnRefusal() = runBlocking<Unit> {
        registered()
        signIn(rank = 100)
        api.meResult = { throw ApiError(401, "not_authenticated") }

        assertEquals(SwitchResult.Refused("custom_needs_super_admin"), switcher.switchTo(custom, discard = false))
    }

    /** Switching away from a dead server (Review Focus 2): nothing unsent, so no check is made. */
    @Test fun aNamedSwitchAwayFromADeadServerStillWorks() = runBlocking<Unit> {
        registered()
        signIn()
        api.meResult = { throw ApiError(0, "network") }

        assertEquals(SwitchResult.Done, switcher.switchTo(prod, discard = false))
        assertEquals(prod, c.environments.saved.first())
    }

    /** Review Focus 3: a named switch on a registered kiosk doesn't open the way to Custom. */
    @Test fun aNamedSwitchThenCustomIsRefused() = runBlocking<Unit> {
        registered()
        signIn()

        assertEquals(SwitchResult.Done, switcher.switchTo(prod, discard = false))
        assertEquals(SwitchResult.Refused("custom_needs_super_admin"), switcher.switchTo(custom, discard = false))

        assertEquals(prod, c.environments.saved.first())
        assertTrue(c.environments.everRegistered.first())
    }

    /** An outbox whose store can't be read is never taken for an empty one: the switch throws
     *  before doing anything, and the unsent scans stay for the server they belong to. */
    @Test fun anUnreadableOutboxStopsTheSwitchBeforeAnythingIsCleared() = runBlocking<Unit> {
        val kept = MemoryOutboxStore()
        kept.upsert((1..2).map { OutboxMachine.newRow(EnqueueInput("A-$it", "barcode", asset, "s1", "i1", "packed"), "c$it", it.toLong(), 0) })
        var readable = false
        val store = object : OutboxStore {
            override suspend fun all(): List<OutboxRow> = if (readable) kept.all() else throw IllegalStateException("disk")
            override suspend fun upsert(rows: List<OutboxRow>) = kept.upsert(rows)
            override suspend fun delete(ids: List<String>) = kept.delete(ids)
        }
        val outbox = Outbox(store, api, c.identity, c.scope)
        val switcher = EnvironmentSwitcher(
            c.environments, api, authState = { c.auth.state.value }, outbox, c.biometric, push = { c.pushRegistrar }, c.pushKeys,
            c.stationKeys, c.prefs, c.cookieJar, c.heartbeat, logout = { c.logout() }, resetApp = { c.resetApp() },
        )
        c.prefs.setSetupSelection(KioskSetupSelection("i1", "Move A", "s1", "Dallas", "source", "packed", "Packed"))
        secrets.put("cookie|127.0.0.1|ss_refresh", "{}")
        signIn()

        try { switcher.switchTo(uat, discard = false); fail("expected OutboxUnreadable") } catch (_: OutboxUnreadable) { }

        assertTrue(c.environments.saved.first() is SavedEnvironment.Custom)   // the test server, still
        assertEquals(2, kept.all().size)
        assertTrue(c.auth.state.value is AuthState.Authed)
        assertTrue("logout" !in api.calls)
        assertEquals("{}", secrets.get("cookie|127.0.0.1|ss_refresh"))
        assertTrue(c.prefs.setupSelection.first() != null)

        readable = true                                                       // the store reads again
        assertEquals(SwitchResult.Pending(2), switcher.switchTo(uat, discard = false))
    }
}
