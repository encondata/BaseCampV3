package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
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
        advanceUntilIdle()
        assertEquals(AuthState.Anon, auth.state.value)
    }
}
