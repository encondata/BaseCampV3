package com.serversherpa.kiosk.data.heartbeat

import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.auth.LoginMethod
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * While someone is signed in and the app is in front: an immediate beat,
 * then one a minute. Each beat upserts the kiosk's Device row and returns
 * the registration state. Failures keep the last state (and any pending
 * sign_in) and are retried next tick. A Clear Setup the reply asks for is
 * applied once (setup dropped, Setup banner raised), announced on
 * [setupCleared], and acknowledged on an immediate re-beat and every beat
 * after until the reply stops asking for it.
 */
class Heartbeat(
    private val api: KioskApi,
    private val identity: Identity,
    private val config: KioskConfig,
    private val prefs: KioskPrefs,
    private val deviceInfo: () -> Map<String, String>,
    private val intervalMs: Long = 60_000,
) {
    private val _registration = MutableStateFlow<RegistrationState?>(null)
    val registration: StateFlow<RegistrationState?> = _registration

    // No replay: a collector that starts later (a shell composed for the next
    // route) never sees a clear that was already announced.
    private val _setupCleared = MutableSharedFlow<String>(extraBufferCapacity = 1)
    /** Emits a Clear Setup id the moment it is applied, so the UI can go to Setup. */
    val setupCleared: SharedFlow<String> = _setupCleared

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
            val ack = prefs.pendingSetupClearAck()
            val result = api.heartbeat(HeartbeatIn(
                serial = serial, name = name, mode = "android", version = config.kioskVersion,
                raw_info = deviceInfo(), sign_in = asSignIn != null, login_method = asSignIn?.wire,
                setup_cleared = ack,
            ))
            if (asSignIn != null && pendingSignIn === asSignIn) pendingSignIn = null
            // Settle and apply before anything else can throw, so a clear is never deferred.
            prefs.settleSetupClearAck(ack, result.clear_setup)
            val asked = result.clear_setup
            // True only the first time for an id, so the re-beat below happens at most
            // once per clear: a server repeating the id can't drive a loop.
            val applied = asked != null && prefs.applySetupClear(asked)
            _registration.value = RegistrationState.fromWire(result.registration)
            if (applied) {
                _setupCleared.tryEmit(asked!!)
                if (job?.isActive == true) beat()      // acknowledge right away (not after stop())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            /* keep the last known state, any pending sign-in and any unsent ack */
        }
    }
}
