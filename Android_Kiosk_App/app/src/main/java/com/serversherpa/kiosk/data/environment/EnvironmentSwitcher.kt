package com.serversherpa.kiosk.data.environment

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.access.ADMIN_RANK
import com.serversherpa.kiosk.core.access.SUPER_ADMIN_RANK
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.model.MeInfo
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.RefreshCookieJar
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.auth.BiometricSignIn
import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.push.PushKeyStore
import com.serversherpa.kiosk.data.push.PushRegistrar
import com.serversherpa.kiosk.data.station.StationKeyStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** What [EnvironmentSwitcher.switchTo] answered. */
sealed interface SwitchResult {
    /** Switched: the kiosk is signed out, cleared, and connects to the new environment. */
    data object Done : SwitchResult

    /** [count] unsent scans: wait for them to send, or switch again discarding them. Nothing changed. */
    data class Pending(val count: Int) : SwitchResult

    /** A gate said no ([CUSTOM_NEEDS_SUPER_ADMIN], [DISCARD_NEEDS_ADMIN] or [ACCESS_CHECK_OFFLINE]).
     *  Nothing changed. */
    data class Refused(val code: String) : SwitchResult

    companion object {
        const val CUSTOM_NEEDS_SUPER_ADMIN = "custom_needs_super_admin"
        const val DISCARD_NEEDS_ADMIN = "discard_needs_admin"
        const val ACCESS_CHECK_OFFLINE = "access_check_offline"
    }
}

/** The outbox's store couldn't be read, so the unsent scans can't be counted: no switch. */
class OutboxUnreadable : Exception("outbox_unreadable")

/**
 * Moves the kiosk to another server (spec "Who can change what" and "What a switch does"), with
 * the laptop edge's rules (kiosk_laptop/edge/src/edge/environment_switch.py). The environment
 * password is the chooser's to ask for; everything else is checked here, one switch at a time:
 *
 * - A Custom URL on a kiosk any server has registered needs the person signed in here to hold a
 *   global role of rank 80 or higher; discarding unsent scans needs rank 60 or higher. Both come
 *   live from `GET /auth/me` on the current server, asked once, and only when a gate needs it.
 *   Nobody signed in, or a refused check, never passes; an unreachable server is
 *   [SwitchResult.ACCESS_CHECK_OFFLINE]. A named switch with nothing unsent needs no check, so a
 *   kiosk stuck on a dead server can always be moved.
 * - Unsent scans (the outbox's queued and failed) are [SwitchResult.Pending] unless discarded.
 *
 * Then: biometric sign-in and the push registration are revoked on the old server while still
 * signed in, and the kiosk signs out (all best effort, offline is fine). The unsent count is taken
 * again: work that appeared meanwhile, beyond what was approved for discard, is Pending, nothing
 * cleared. The heartbeat stops and drops any reply still on its way; every refresh cookie goes;
 * Reset app runs (setup, move data, label settings, Rolodex list, station key; a sync still on
 * its way stores nothing); the outbox is discarded when asked (a batch in flight keeps no
 * outcome); the station key, push key, last sign-in method and Clear Setup record go; and the
 * new environment is saved. The kiosk's serial, name and has-been-registered flag stay, and so do
 * its appearance, sound and other device settings: Android has no settings sync, so the spec's
 * reason for resetting them doesn't apply here. The heartbeat starts again at the next sign-in.
 */
class EnvironmentSwitcher(
    private val store: EnvironmentStore,
    private val api: KioskApi,
    private val authState: () -> AuthState,
    private val outbox: Outbox,
    private val biometric: BiometricSignIn,
    private val push: () -> PushRegistrar,
    private val pushKeys: PushKeyStore,
    private val stationKeys: StationKeyStore,
    private val prefs: KioskPrefs,
    private val cookieJar: RefreshCookieJar,
    private val heartbeat: Heartbeat,
    private val logout: suspend () -> Unit,
    private val resetApp: suspend () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Mutex()

    /** Scans not yet sent: the outbox's queued (with sending and retrying) and failed. */
    fun unsentCount(): Int = outbox.snapshot.value.counts.let { it.queued + it.failed }

    /**
     * Switches to [target], discarding unsent scans when [discard] (an admin's call). Throws
     * [OutboxUnreadable] before anything is done when the outbox can't be read (an unreadable
     * outbox never counts as empty), and throws when the old server's data can't be cleared
     * (storage); the saved environment is unchanged either way.
     */
    suspend fun switchTo(target: SavedEnvironment, discard: Boolean): SwitchResult = lock.withLock {
        // The recount below reads the same loaded snapshot, which every enqueue keeps current.
        if (!outbox.load()) throw OutboxUnreadable()
        val pending = unsentCount()
        val customGate = target is SavedEnvironment.Custom && store.everRegistered.first()
        val discardGate = pending > 0 && discard
        val access = if (customGate || discardGate) {
            try { liveAccess() } catch (_: AccessCheckOffline) { return SwitchResult.Refused(SwitchResult.ACCESS_CHECK_OFFLINE) }
        } else null
        if (customGate && !(access != null && access.scope.global && access.max_rank >= SUPER_ADMIN_RANK)) {
            return SwitchResult.Refused(SwitchResult.CUSTOM_NEEDS_SUPER_ADMIN)
        }
        if (pending > 0 && !discard) return SwitchResult.Pending(pending)
        if (discardGate && !(access != null && access.max_rank >= ADMIN_RANK)) {
            return SwitchResult.Refused(SwitchResult.DISCARD_NEEDS_ADMIN)
        }

        val signedIn = authState() is AuthState.Authed
        bestEffort { biometric.forget(signedIn) }
        bestEffort { push().forgetForSwitch() }
        bestEffort { logout() }
        // Work queued while we waited on the old server is never discarded unseen.
        val unsent = unsentCount()
        if (unsent > (if (discard) pending else 0)) return SwitchResult.Pending(unsent)

        heartbeat.stopAndDropReplies()
        withContext(io) { cookieJar.clearAllRefreshCookies() }
        resetApp()
        if (discard) outbox.discardAll()
        withContext(io) {
            stationKeys.clear()
            pushKeys.clear()
        }
        prefs.clearServerRecords()
        store.save(target)
        SwitchResult.Done
    }

    /** The signed-in person's access, live from the current server; null when nobody is signed in
     *  or the server refuses to say. Throws [AccessCheckOffline] when it can't be reached. */
    private suspend fun liveAccess(): MeInfo? {
        if (authState() !is AuthState.Authed) return null
        return try {
            api.me()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 401 || e.status == 403) null else throw AccessCheckOffline()
        } catch (_: Exception) {
            null                                   // a 200 that didn't decode: no answer
        }
    }

    private class AccessCheckOffline : Exception()

    private suspend fun bestEffort(block: suspend () -> Unit) {
        try { block() } catch (e: CancellationException) { throw e } catch (_: Exception) { }
    }
}
