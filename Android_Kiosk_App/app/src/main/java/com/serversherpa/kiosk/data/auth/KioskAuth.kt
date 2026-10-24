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

enum class LoginMethod(val wire: String) {
    PASSWORD("password"), LINK("link"), BIOMETRIC("biometric");

    companion object { fun fromWire(s: String?): LoginMethod? = entries.firstOrNull { it.wire == s } }
}

/** How the person signed in on this launch: [email] is the address typed for a password sign-in. */
data class CurrentSignIn(val method: LoginMethod, val email: String? = null)

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
        val kioskMove get() = session.kiosk_move
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

    // Set only by login()/loginWithMovePassword()/completePair()/signInWithBiometric(), never by
    // a cookie restore, so the API can auto-register the kiosk and record how the person signed in.
    @Volatile private var pendingSignIn: LoginMethod? = null

    // How this session was signed in on this launch. Unlike pendingSignIn the heartbeat never
    // takes it; a cookie restore, a move password, sign-out and a session ending all leave none.
    @Volatile private var signedIn: CurrentSignIn? = null

    /** How the person signed in on this launch: null for a restored session or a move password
     *  (a move's password isn't a person's), and once signed out. BiometricSignIn offers
     *  enrollment only after a [LoginMethod.PASSWORD] one. */
    val currentSignIn: CurrentSignIn? get() = signedIn

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            refresher.sessionEnded.collect { signedIn = null; _state.value = AuthState.Anon }
        }
    }

    /** Cookie restore on launch. */
    suspend fun restore() {
        val data = refresher.refresh()
        signedIn = null
        _state.value = if (data != null) AuthState.Authed(data) else AuthState.Anon
    }

    suspend fun login(email: String, password: String): SessionData {
        val data = api.login(email, password)
        pendingSignIn = LoginMethod.PASSWORD
        signedIn = CurrentSignIn(LoginMethod.PASSWORD, email)
        _state.value = AuthState.Authed(data)
        return data
    }

    /** A move-password sign-in. The heartbeat's login_method only knows password | link | biometric,
     *  and a move password is a password as far as device registration goes (as on the web). */
    suspend fun loginWithMovePassword(password: String): SessionData {
        val data = api.moveLogin(password)
        pendingSignIn = LoginMethod.PASSWORD
        signedIn = null
        _state.value = AuthState.Authed(data)
        return data
    }

    /** A biometric sign-in's session (BiometricSignIn), adopted as [completePair] adopts a pair's. */
    fun signInWithBiometric(data: SessionData) {
        refresher.store(data)
        pendingSignIn = LoginMethod.BIOMETRIC
        signedIn = CurrentSignIn(LoginMethod.BIOMETRIC)
        _state.value = AuthState.Authed(data)
    }

    fun completePair(data: SessionData) {
        refresher.store(data)
        pendingSignIn = LoginMethod.LINK
        signedIn = CurrentSignIn(LoginMethod.LINK)
        _state.value = AuthState.Authed(data)
    }

    suspend fun logout() {
        api.signOut(identity.get().serial)
        api.logout()
        refresher.clear()
        signedIn = null
        _state.value = AuthState.Anon
    }

    fun can(resource: String, action: String): Boolean =
        computeCan((_state.value as? AuthState.Authed)?.perms, resource, action)

    /** The heartbeat consumes this exactly once per sign-in. */
    fun takePendingSignIn(): LoginMethod? = pendingSignIn.also { pendingSignIn = null }
}
