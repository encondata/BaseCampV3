package com.serversherpa.kiosk.data.rolodex

import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.ROLODEX_META_KEY
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The one owner of the Rolodex's offline list, the Room meta row [ROLODEX_META_KEY] (spec §3.15).
 * Reads, writes and deletes take one lock. [allowed] says whether an admin is signed in right now,
 * and a read or write checks it inside the lock. Sign-out sets the session to signed out *before*
 * it deletes, so a list read or save that lands late can't put the list back on disk.
 */
class RolodexCacheStore(private val db: KioskDatabase, private val allowed: () -> Boolean) {
    private val lock = Mutex()

    /** The cached list's JSON, or null (none, or nobody allowed to read it is signed in). */
    suspend fun read(): String? = lock.withLock {
        if (allowed()) db.meta().get(ROLODEX_META_KEY)?.value else null
    }

    /** Stores [json] while an admin is signed in; false (nothing stored) once they aren't. */
    suspend fun write(json: String): Boolean = lock.withLock {
        if (!allowed()) return@withLock false
        db.meta().put(MetaEntity(ROLODEX_META_KEY, json))
        true
    }

    /** Deletes the list. Runs to the end even when the caller is cancelled: a sign-out disposes the
     *  screen whose scope asked for it. */
    suspend fun clear() = withContext(NonCancellable) {
        lock.withLock { db.meta().delete(ROLODEX_META_KEY) }
    }

    /**
     * Clears the list whenever the session is not an admin's: signed out by any road (Sign out, a
     * session that ended, one that couldn't be restored at launch), a non-admin session, or a
     * different person signed in. Loading keeps it.
     */
    fun clearWhenTheSessionEnds(state: Flow<AuthState>, scope: CoroutineScope): Job = scope.launch {
        var owner: String? = null
        state.collect { s ->
            val keep = when (s) {
                AuthState.Loading -> true
                AuthState.Anon -> false
                is AuthState.Authed -> s.isAdmin && (owner == null || owner == s.person.id)
            }
            owner = (s as? AuthState.Authed)?.person?.id ?: if (s == AuthState.Anon) null else owner
            if (!keep) {
                try { clear() } catch (e: CancellationException) { throw e } catch (_: Exception) { /* the next end tries again */ }
            }
        }
    }
}
