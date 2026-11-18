package com.serversherpa.kiosk.data.push

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.data.api.KioskApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The phone claimed ("This is my phone") but push not set up: no FCM token (a build without
 * Firebase: [PushUnavailable]), or the registration refused. [state] is the phone's state, still on.
 */
class PushSetupFailed(val state: PersonalState, override val cause: Throwable) : Exception("push_setup_failed", cause)

/**
 * "This is my phone" and this phone's push registration (spec: "Android app"). The phone being
 * personal is the server's (PUT /kiosk/personal); the push key lives in [store], with the person
 * whose registration it is. [apiBase] is the configured API URL, read once per call (a key is bound
 * to the origin it was issued by); [personId] is the signed-in person. One call at a time.
 *
 * Callers run these on the app's own scope, not a screen's: a call cut off between the server's
 * registration and the local save would leave the server sending to a phone with no key.
 */
class PushRegistrar(
    private val api: KioskApi,
    private val store: PushKeyStore,
    private val fcm: FcmTokens,
    private val apiBase: suspend () -> String,
    private val personId: () -> String?,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Mutex()

    /** False in a build without a Firebase project: push can't be set up on any phone. */
    val pushAvailable: Boolean get() = fcm.available

    /**
     * The switch's state from the server (each Settings open, and each sign-in or start once the
     * session is bound to the phone), with this phone brought in line with it:
     * - on for the signed-in person, but no push registration on the server or no key here for
     *   the configured API: registered again, silently. A failure is reported as not registered
     *   and tried again next time. Nothing is tried in a build without Firebase.
     * - not on for them: a key here is dropped and the FCM token deleted when the phone was theirs
     *   (released or reassigned in the portal) or nobody owns it now. Another admin signed in on
     *   the owner's phone leaves the owner's key alone.
     * Throws ApiError when the state can't be read.
     */
    suspend fun check(): PersonalState = lock.withLock {
        val state = api.getPersonal()
        val me = personId()
        if (!state.on) {
            val stale = withContext(io) {
                store.hasKey() && (state.ownerName == null || store.personId() == me)
            }
            if (stale) forgetHere()
            return@withLock state
        }
        if (!fcm.available || me == null) return@withLock state
        val mine = withContext(io) { store.get(apiBase()) != null && store.personId() == me }
        if (state.pushRegistered && mine) return@withLock state
        register(state, me).getOrElse { state.copy(pushRegistered = false) }
    }

    /**
     * Claims the phone, then registers it for push with the FCM token and stores the key. A refused
     * or failed claim is a failure with its ApiError and leaves nothing stored. A claim whose push
     * step fails is a failure with [PushSetupFailed]: the phone stays claimed (biometric sign-in
     * works), and the next [check] tries the push step again.
     */
    suspend fun turnOn(): Result<PersonalState> = lock.withLock {
        val claimed = try { api.setPersonal(true) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            return@withLock Result.failure(e)
        }
        val me = personId() ?: return@withLock Result.failure(PushSetupFailed(claimed, IllegalStateException("signed_out")))
        register(claimed, me)
    }

    /**
     * Gives the phone up. The server's change also deletes its push registration, so only then is
     * the key dropped and the FCM token deleted here (a failed delete is let go: the server has
     * already stopped sending). A refused or failed change keeps everything.
     */
    suspend fun turnOff(): Result<PersonalState> = lock.withLock {
        val released = try { api.setPersonal(false) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            return@withLock Result.failure(e)
        }
        forgetHere()
        Result.success(released.copy(pushRegistered = false))
    }

    /** The push step: the token, the registration, the key saved for [me]. A CancellationException
     *  that isn't this coroutine's own (FCM canceling its work) is an ordinary failure. */
    private suspend fun register(state: PersonalState, me: String): Result<PersonalState> = try {
        val origin = PushKeyStore.originOf(apiBase())
        val registration = api.registerPush(fcm.token())
        withContext(io) { store.save(registration.registrationId, registration.pushKey, origin, me) }
        Result.success(state.copy(pushRegistered = true))
    } catch (e: CancellationException) {
        currentCoroutineContext().ensureActive()
        Result.failure(PushSetupFailed(state, e))
    } catch (e: Exception) {
        Result.failure(PushSetupFailed(state, e))
    }

    private suspend fun forgetHere() {
        withContext(io) { store.clear() }
        try { fcm.delete() } catch (e: CancellationException) { currentCoroutineContext().ensureActive() } catch (_: Exception) { }
    }

    /**
     * FCM rotated the token: send it with the push key (no session), when one is stored for the
     * configured API. A refused key (401 push_key_invalid) is dropped and never retried, since the
     * server caps refusals per address and a site's shared address would lock out other phones;
     * the next check or "This is my phone" makes a new one. Anything else is tried again on the
     * next app start.
     */
    suspend fun onNewToken(token: String) {
        val key = withContext(io) { store.get(apiBase()) } ?: return
        try {
            api.updatePushToken(token, key)
            withContext(io) { store.setRetryPending(false) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            withContext(io) {
                if (e.status == 401 && e.code == "push_key_invalid") store.clear() else store.setRetryPending(true)
            }
        } catch (_: Exception) {
            withContext(io) { store.setRetryPending(true) }
        }
    }

    /** The app started: a token update that failed before is sent again, with the current token. */
    suspend fun onAppStart() {
        if (!withContext(io) { store.retryPending() }) return
        val token = try { fcm.token() } catch (e: CancellationException) { throw e } catch (_: Exception) { return }
        onNewToken(token)
    }
}
