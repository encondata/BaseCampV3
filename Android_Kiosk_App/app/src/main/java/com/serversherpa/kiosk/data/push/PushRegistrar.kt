package com.serversherpa.kiosk.data.push

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.data.api.KioskApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The phone claimed ("This is my phone") but push not set up: no FCM token (a build without
 * Firebase: [PushUnavailable]), or the registration refused. [state] is the phone's state, still on.
 */
class PushSetupFailed(val state: PersonalState, override val cause: Throwable) : Exception("push_setup_failed", cause)

/**
 * "This is my phone" and this phone's push registration (spec: "Android app"). The phone being
 * personal is the server's (PUT /kiosk/personal); the push key lives in [store]. [apiBase] is the
 * configured API URL, read once per call; a key is bound to the origin it was issued by.
 */
class PushRegistrar(
    private val api: KioskApi,
    private val store: PushKeyStore,
    private val fcm: FcmTokens,
    private val apiBase: suspend () -> String,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    /** The switch's state from the server, on each Settings open (a portal reassignment shows). Throws ApiError. */
    suspend fun state(): PersonalState = api.getPersonal()

    /**
     * Claims the phone, then registers it for push with the FCM token and stores the key. A refused
     * or failed claim is a failure with its ApiError and leaves nothing stored. A claim whose push
     * step fails is a failure with [PushSetupFailed]: the phone stays claimed (biometric sign-in
     * works), and [registerPush] can try the push step again.
     */
    suspend fun turnOn(): Result<PersonalState> {
        val claimed = try { api.setPersonal(true) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            return Result.failure(e)
        }
        return registerPush(claimed)
    }

    /** The push step alone, on a phone already the caller's ([state] `on`). */
    suspend fun registerPush(state: PersonalState): Result<PersonalState> = try {
        val origin = PushKeyStore.originOf(apiBase())
        val registration = api.registerPush(fcm.token())
        withContext(io) { store.save(registration.registrationId, registration.pushKey, origin) }
        Result.success(state.copy(pushRegistered = true))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(PushSetupFailed(state, e))
    }

    /**
     * Gives the phone up. The server's change also deletes its push registration, so only then is
     * the key dropped and the FCM token deleted here (a failed delete is let go: the server has
     * already stopped sending). A refused or failed change keeps everything.
     */
    suspend fun turnOff(): Result<PersonalState> {
        val released = try { api.setPersonal(false) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            return Result.failure(e)
        }
        withContext(io) { store.clear() }
        try { fcm.delete() } catch (e: CancellationException) { throw e } catch (_: Exception) { }
        return Result.success(released.copy(pushRegistered = false))
    }

    /**
     * FCM rotated the token: send it with the push key (no session), when one is stored for the
     * configured API. A refused key (401 push_key_invalid) is dropped and never retried, since the
     * server caps refusals per address and a site's shared address would lock out other phones;
     * the next "This is my phone" makes a new one. Anything else is tried again on the next app start.
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
