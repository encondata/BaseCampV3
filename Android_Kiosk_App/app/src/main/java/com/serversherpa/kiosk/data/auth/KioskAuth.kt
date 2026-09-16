package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.access.ADMIN_RANK
import com.serversherpa.kiosk.core.access.computeCan
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.SessionRefresher
import com.serversherpa.kiosk.data.identity.Identity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

enum class LoginMethod(val wire: String) { PASSWORD("password"), LINK("link") }

sealed interface AuthState {
    data object Loading : AuthState
    data object Anon : AuthState
    data class Authed(val session: SessionData) : AuthState {
        val person get() = session.person
        val roles get() = session.roles
        val perms get() = session.perms
        val preferences get() = session.preferences
        val mustChangePassword get() = session.must_change_password
        val sessionExpiresAt get() = session.session_expires_at
        val maxRank get() = session.max_rank
        val isAdmin get() = maxRank >= ADMIN_RANK
        val isDeveloper get() = "developer" in roles
    }
}

/** kiosk/src/auth/KioskAuthContext.tsx without the React. */
class KioskAuth(
    private val api: KioskApi,
    private val refresher: SessionRefresher,
    private val identity: Identity,
    scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state

    // Set only by login()/completePair(), never by a cookie restore, so the
    // API can auto-register the kiosk and record how the person signed in.
    @Volatile private var pendingSignIn: LoginMethod? = null

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            refresher.sessionEnded.collect { _state.value = AuthState.Anon }
        }
    }

    /** Cookie restore on launch. */
    suspend fun restore() {
        val data = refresher.refresh()
        _state.value = if (data != null) AuthState.Authed(data) else AuthState.Anon
    }

    suspend fun login(email: String, password: String): SessionData {
        val data = api.login(email, password)
        pendingSignIn = LoginMethod.PASSWORD
        _state.value = AuthState.Authed(data)
        return data
    }

    fun completePair(data: SessionData) {
        refresher.store(data)
        pendingSignIn = LoginMethod.LINK
        _state.value = AuthState.Authed(data)
    }

    suspend fun logout() {
        api.signOut(identity.get().serial)
        api.logout()
        refresher.clear()
        _state.value = AuthState.Anon
    }

    fun can(resource: String, action: String): Boolean =
        computeCan((_state.value as? AuthState.Authed)?.perms, resource, action)

    /** The heartbeat consumes this exactly once per sign-in. */
    fun takePendingSignIn(): LoginMethod? = pendingSignIn.also { pendingSignIn = null }
}
