package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class KioskAuthTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun restoreFromCookieOrAnon() = runTest {
        val api = FakeKioskApi(); val refresher = FakeRefresher()
        refresher.refreshResult = { fakeSession() }
        val auth = KioskAuth(api, refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        assertEquals(AuthState.Loading, auth.state.value)
        auth.restore()
        assertTrue(auth.state.value is AuthState.Authed)
        assertNull(auth.takePendingSignIn())   // a cookie restore is not a sign-in
        refresher.refreshResult = { null }
        auth.restore()
        assertEquals(AuthState.Anon, auth.state.value)
    }

    @Test fun loginMarksPendingPasswordSignIn() = runTest {
        val api = FakeKioskApi().apply { loginResult = { fakeSession(roles = listOf("developer"), maxRank = 100) } }
        val auth = KioskAuth(api, FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.login("a@b.c", "pw")
        val authed = auth.state.value as AuthState.Authed
        assertTrue(authed.isAdmin); assertTrue(authed.isDeveloper)
        assertEquals(LoginMethod.PASSWORD, auth.takePendingSignIn())
        assertNull(auth.takePendingSignIn())
        assertTrue(auth.can("kiosk", "view")); assertFalse(auth.can("labels", "view"))
    }

    @Test fun loginFailurePropagatesAndStaysAnon() = runTest {
        val auth = KioskAuth(FakeKioskApi(), FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        try { auth.login("a@b.c", "bad"); fail() } catch (e: ApiError) { assertEquals("invalid_credentials", e.code) }
        assertEquals(AuthState.Loading, auth.state.value)   // restore() not called in this test
    }

    @Test fun completePairAndLogout() = runTest {
        val api = FakeKioskApi(); val refresher = FakeRefresher()
        val auth = KioskAuth(api, refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.completePair(fakeSession())
        assertEquals(LoginMethod.LINK, auth.takePendingSignIn())
        auth.logout()
        assertEquals(listOf("signOut", "logout"), api.calls)
        assertEquals(AuthState.Anon, auth.state.value)
        assertEquals(1, refresher.cleared)
    }

    @Test fun sessionEndedFlipsToAnon() = runTest {
        val refresher = FakeRefresher()
        val auth = KioskAuth(FakeKioskApi(), refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.completePair(fakeSession())
        refresher.sessionEnded.tryEmit(Unit)
        runCurrent()
        assertEquals(AuthState.Anon, auth.state.value)
    }

    @Test fun moveLoginSignsInLockedToTheMoveAsAPasswordSignIn() = runTest {
        val move = KioskMove("m1", "Dallas Move")
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession(kioskMove = move) } }
        val auth = KioskAuth(api, FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.loginWithMovePassword("orange-kayak-42")
        assertEquals(listOf("orange-kayak-42"), api.moveLoginPasswords)
        val authed = auth.state.value as AuthState.Authed
        assertEquals(move, authed.kioskMove)
        // The heartbeat only knows password | link; a move sign-in counts as password (as on the web).
        assertEquals(LoginMethod.PASSWORD, auth.takePendingSignIn())
    }

    @Test fun aFailedMoveLoginLeavesTheStateAlone() = runTest {
        val auth = KioskAuth(FakeKioskApi(), FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.restore()   // FakeRefresher returns null: Anon
        try { auth.loginWithMovePassword("nope"); fail("expected ApiError") } catch (e: ApiError) { assertEquals("invalid_move_password", e.code) }
        assertEquals(AuthState.Anon, auth.state.value)
        assertNull(auth.takePendingSignIn())
    }

    @Test fun biometricSignInAdoptsTheSessionAsABiometricSignIn() = runTest {
        val refresher = FakeRefresher()
        val auth = KioskAuth(FakeKioskApi(), refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        val data = fakeSession()
        auth.signInWithBiometric(data)
        assertEquals(data, (auth.state.value as AuthState.Authed).session)
        assertEquals(data, refresher.stored)
        assertEquals(LoginMethod.BIOMETRIC, auth.takePendingSignIn())
        assertEquals(CurrentSignIn(LoginMethod.BIOMETRIC), auth.currentSignIn)
        assertEquals("biometric", LoginMethod.BIOMETRIC.wire)
        assertEquals(LoginMethod.BIOMETRIC, LoginMethod.fromWire("biometric"))
    }

    @Test fun currentSignInIsOnlyAPersonsOwnSignInOnThisLaunch() = runTest {
        val refresher = FakeRefresher().apply { refreshResult = { fakeSession() } }
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession() }
            moveLoginResult = { fakeSession(kioskMove = KioskMove("m1", "Move")) }
        }
        val auth = KioskAuth(api, refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.login("tina@example.com", "pw")
        assertEquals(CurrentSignIn(LoginMethod.PASSWORD, "tina@example.com"), auth.currentSignIn)
        auth.takePendingSignIn()                       // the heartbeat taking it changes nothing here
        assertEquals(LoginMethod.PASSWORD, auth.currentSignIn?.method)
        auth.restore()                                 // a cookie restore is not a sign-in
        assertNull(auth.currentSignIn)
        auth.login("tina@example.com", "pw")
        auth.logout()
        assertNull(auth.currentSignIn)
        auth.loginWithMovePassword("orange")           // a move password isn't a person's password
        assertNull(auth.currentSignIn)
        auth.completePair(fakeSession())
        assertEquals(CurrentSignIn(LoginMethod.LINK), auth.currentSignIn)
        auth.login("tina@example.com", "pw")
        refresher.sessionEnded.tryEmit(Unit)
        runCurrent()
        assertNull(auth.currentSignIn)
    }
}
