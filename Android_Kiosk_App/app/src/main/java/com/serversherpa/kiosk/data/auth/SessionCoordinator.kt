package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** Runs the heartbeat exactly while a usable session exists and the app is in the foreground. */
class SessionCoordinator(
    private val auth: KioskAuth,
    private val heartbeat: Heartbeat,
    private val foreground: StateFlow<Boolean>,
    private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            combine(auth.state, foreground) { state, fg ->
                fg && state is AuthState.Authed && !state.mustChangePassword
            }.distinctUntilChanged().collect { run ->
                if (run) heartbeat.start(scope, auth.takePendingSignIn()) else heartbeat.stop()
            }
        }
    }
}
