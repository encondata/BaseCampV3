package com.serversherpa.kiosk.data.rolodex

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.PersonOut
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.ROLODEX_META_KEY
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RolodexCacheStoreTest {
    private fun newDb() = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private fun row(db: KioskDatabase): String? = runBlocking { db.meta().get(ROLODEX_META_KEY)?.value }
    private fun waitFor(what: String, done: () -> Boolean) {
        val deadline = System.nanoTime() + 10_000_000_000L
        while (!done()) {
            if (System.nanoTime() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(20)
        }
    }

    // ── the guarded owner ──

    /** A list read or save that lands after sign-out can't put the list back on disk. */
    @Test fun aWriteAfterSignOutIsRefused() = runBlocking<Unit> {
        val db = newDb()
        var admin = true
        val store = RolodexCacheStore(db) { admin }
        assertTrue(store.write("""{"cached_at":"t1"}"""))
        assertEquals("""{"cached_at":"t1"}""", store.read())
        admin = false
        store.clear()
        assertFalse(store.write("""{"cached_at":"t2"}"""))
        assertNull(row(db))
        assertNull(store.read())
    }

    @Test fun aNonAdminReadsNothing() = runBlocking<Unit> {
        val db = newDb()
        db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}"))
        assertNull(RolodexCacheStore(db) { false }.read())
    }

    /** Sign-out disposes the screen whose scope asked for the delete: it must still happen. */
    @Test fun clearFinishesInACancelledCoroutine() = runBlocking<Unit> {
        val db = newDb()
        db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}"))
        val store = RolodexCacheStore(db) { true }
        val job = launch(Dispatchers.Default) {
            currentCoroutineContext().job.cancel()
            store.clear()
        }
        job.join()
        assertTrue(job.isCancelled)
        assertNull(row(db))
    }

    @Test fun theWatchClearsWheneverTheSessionIsntAnAdmins() = runBlocking<Unit> {
        val db = newDb()
        val store = RolodexCacheStore(db) { true }
        val state = MutableStateFlow<AuthState>(AuthState.Loading)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        store.clearWhenTheSessionEnds(state, scope)
        fun seed() = runBlocking { db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}")) }
        fun authed(id: String, rank: Int) = AuthState.Authed(fakeSession(maxRank = rank).copy(person = PersonOut(id = id, first_name = "A", last_name = "B", display_name = "A B")))
        try {
            seed()
            Thread.sleep(150)
            assertEquals("{}", row(db))                                    // Loading keeps it (launch, before restore)
            state.value = authed("p1", 60)
            Thread.sleep(150)
            assertEquals("{}", row(db))                                    // the admin it belongs to

            state.value = AuthState.Anon
            waitFor("signed out") { row(db) == null }

            state.value = authed("p1", 60); seed()
            state.value = authed("p2", 60)
            waitFor("another admin") { row(db) == null }

            seed()
            state.value = authed("p2", 40)
            waitFor("no longer an admin") { row(db) == null }
        } finally { scope.cancel() }
    }

    // ── wired into the container ──

    /** A session that ended while the app was closed: restore finds no session (no notifySessionEnded),
     *  goes signed out, and the list goes with it. */
    @Test fun aSessionThatCantBeRestoredAtLaunchClearsTheList() = runBlocking<Unit> {
        val c = testContainer(api = FakeKioskApi())
        c.db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}"))
        val watch = c.watchRolodexCache()
        try {
            c.auth.restore()                       // the refresh is refused (nothing listens on 127.0.0.1:1)
            assertEquals(AuthState.Anon, c.auth.state.value)
            waitFor("the restore's sign-out") { row(c.db) == null }
        } finally { watch.cancel() }
    }

    /** Signing out from the shell: its scope is cancelled once the session is gone, mid-logout. The
     *  delete must still run (NonCancellable in the store). */
    @Test fun signOutStillClearsTheListWhenItsScopeIsCancelledMidWay() = runBlocking<Unit> {
        val api = object : FakeKioskApi() {
            // The portal answers sign-out, and the screen that asked goes away at once.
            override suspend fun logout() { super.logout(); currentCoroutineContext().job.cancel() }
        }
        val c = testContainer(api = api)
        c.auth.completePair(fakeSession(roles = listOf("admin"), maxRank = 60))
        c.db.meta().put(MetaEntity(ROLODEX_META_KEY, "{}"))
        val job = launch(Dispatchers.Default) { c.logout() }
        job.join()
        assertTrue(job.isCancelled)
        assertEquals(AuthState.Anon, c.auth.state.value)
        assertNull(row(c.db))
    }
}
