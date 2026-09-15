package com.serversherpa.kiosk.data.heartbeat

import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.auth.LoginMethod
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.Identity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * While someone is signed in and the app is in front: an immediate beat,
 * then one a minute. Each beat upserts the kiosk's Device row and returns
 * the registration state. Failures keep the last state (and any pending
 * sign_in) and are retried next tick.
 */
class Heartbeat(
    private val api: KioskApi,
    private val identity: Identity,
    private val config: KioskConfig,
    private val deviceInfo: () -> Map<String, String>,
    private val intervalMs: Long = 60_000,
) {
    private val _registration = MutableStateFlow<RegistrationState?>(null)
    val registration: StateFlow<RegistrationState?> = _registration

    private var job: Job? = null
    @Volatile private var pendingSignIn: LoginMethod? = null

    fun start(scope: CoroutineScope, signIn: LoginMethod?) {
        stop()
        if (signIn != null) pendingSignIn = signIn
        job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            while (isActive) {
                beat()
                delay(intervalMs)
            }
        }
    }

    fun stop() {
        job?.cancel(); job = null
        _registration.value = null
    }

    /** Beat right now (after a rename). Resolves after the attempt. */
    suspend fun now() = beat()

    private suspend fun beat() {
        val (serial, name) = identity.get()
        val asSignIn = pendingSignIn
        try {
            val result = api.heartbeat(HeartbeatIn(
                serial = serial, name = name, mode = "android", version = config.kioskVersion,
                raw_info = deviceInfo(), sign_in = asSignIn != null, login_method = asSignIn?.wire,
            ))
            if (asSignIn != null && pendingSignIn === asSignIn) pendingSignIn = null
            _registration.value = RegistrationState.fromWire(result.registration)
        } catch (e: Exception) {
            /* keep the last known state and any pending sign-in */
        }
    }
}
