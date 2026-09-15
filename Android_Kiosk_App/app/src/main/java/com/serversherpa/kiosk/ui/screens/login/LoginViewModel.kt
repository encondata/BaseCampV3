package com.serversherpa.kiosk.ui.screens.login

import androidx.lifecycle.ViewModel
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.SystemStatus
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.auth.KioskAuth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class LoginView { PASSWORD, CHOOSER, LINK, MOVE }

data class LoginUi(
    val view: LoginView = LoginView.PASSWORD,
    val email: String = "", val password: String = "", val showPassword: Boolean = false,
    val error: String? = null, val invalidEmail: Boolean = false, val invalidPassword: Boolean = false, val loading: Boolean = false,
    val movePassword: String = "", val moveNotice: Boolean = false,
    val status: SystemStatus = SystemStatus(),
)

val ERROR_MESSAGES = mapOf(
    "invalid_credentials" to "Invalid email or password.",
    "account_locked" to "Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.",
    "account_disabled" to "This account is disabled. Contact your coordinator.",
    "totp_required" to "This account requires a verification code. 2FA sign-in is coming soon — contact support.",
    "kiosk_not_allowed" to "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.",
    "network" to "Can't reach the server. Check the kiosk's network connection.",
)

class LoginViewModel(private val auth: KioskAuth, private val api: KioskApi, private val scope: CoroutineScope) : ViewModel() {
    private val _state = MutableStateFlow(LoginUi())
    val state: StateFlow<LoginUi> = _state

    fun setEmail(v: String) = _state.update { it.copy(email = v, invalidEmail = false, error = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v, invalidPassword = false, error = null) }
    fun togglePassword() = _state.update { it.copy(showPassword = !it.showPassword) }
    fun setView(v: LoginView) = _state.update { it.copy(view = v, error = null, moveNotice = false) }
    fun setMovePassword(v: String) = _state.update { it.copy(movePassword = v, moveNotice = false) }

    fun loadBanners() { scope.launch { try { _state.update { it.copy(status = api.systemStatus()) } } catch (e: Exception) { /* best effort */ } } }

    fun submitPassword(onDone: () -> Unit) {
        val s = _state.value
        if (s.email.isBlank() || s.password.isBlank()) {
            _state.update { it.copy(error = "Please enter both email and password", invalidEmail = s.email.isBlank(), invalidPassword = s.password.isBlank()) }
            return
        }
        _state.update { it.copy(loading = true, error = null) }
        scope.launch {
            try {
                auth.login(s.email.trim(), s.password)
                _state.update { it.copy(loading = false) }
                onDone()
            } catch (e: Exception) {
                val code = (e as? ApiError)?.code ?: "network"
                _state.update { it.copy(loading = false, error = ERROR_MESSAGES[code] ?: "Login failed. Please try again.", invalidEmail = true, invalidPassword = true, password = "") }
            }
        }
    }

    /** Move passwords have no backend yet. */
    fun submitMove() = _state.update { it.copy(moveNotice = true) }
}
