package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * A move-password session works only on its own move (the web kiosk's move-lock effect in
 * KioskAuthContext.tsx). A setup saved for another move by an earlier sign-in would keep
 * driving the screens and the footer, and every call naming it would be refused
 * (move_locked), so it is dropped and the crew goes back through Kiosk Setup. Keyed on the
 * move, so it runs once per sign-in and once on a cookie restore.
 */
class MoveSetupGuard(
    private val auth: StateFlow<AuthState>,
    private val prefs: KioskPrefs,
    private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            auth.map { (it as? AuthState.Authed)?.kioskMove?.initiative_id }.distinctUntilChanged().filterNotNull().collect { locked ->
                val saved = prefs.setupSelection.first()
                if (saved != null && saved.initiativeId != locked) {
                    prefs.setSetupSelection(null)
                    prefs.setSetupState(SetupState.INCOMPLETE)
                }
            }
        }
    }
}
