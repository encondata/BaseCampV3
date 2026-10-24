package com.serversherpa.kiosk.ui.screens.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.SystemStatus
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.auth.BIOMETRIC_EXPIRED_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_PASSWORD_CHANGE_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_TRY_AGAIN_MESSAGE
import com.serversherpa.kiosk.data.auth.BiometricCard
import com.serversherpa.kiosk.data.auth.BiometricOutcome
import com.serversherpa.kiosk.data.auth.BiometricPrompter
import com.serversherpa.kiosk.data.auth.BiometricSignIn
import com.serversherpa.kiosk.data.auth.KioskAuth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** BIOMETRIC is the "Sign in as …" card; CHOOSER is its Other account (the password form with every route). */
enum class LoginView { PASSWORD, CHOOSER, LINK, MOVE, BIOMETRIC }

data class LoginUi(
    val view: LoginView = LoginView.PASSWORD,
    /** The phone's biometric card, while [view] is BIOMETRIC (kept for Use password's email). */
    val card: BiometricCard? = null,
    /** A biometric sign-in is running (the prompt is up, or the server is answering). */
    val bioBusy: Boolean = false,
    /** The card's line after a sign-in that left the person on it (lockout, network, …). */
    val bioError: String? = null,
    /** The line above the password form after the card sent the person there (expired, password change, …). */
    val notice: String? = null,
    /** [notice] reads as an error (red) rather than a note. */
    val noticeError: Boolean = false,
    val email: String = "", val password: String = "", val showPassword: Boolean = false,
    val error: String? = null, val invalidEmail: Boolean = false, val invalidPassword: Boolean = false, val loading: Boolean = false,
    val movePassword: String = "", val moveError: String? = null, val moveLoading: Boolean = false,
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

/** The move form's own wording (kiosk/src/pages/Login.tsx MOVE_ERROR_MESSAGES): kiosk_not_allowed
 *  on a move sign-in is about the move's kiosk identity, not a person's account. */
val MOVE_ERROR_MESSAGES = ERROR_MESSAGES + mapOf(
    "invalid_move_password" to "That move password isn't right.",
    "move_not_active" to "That move password isn't active.",
    "move_login_rate_limited" to "Too many tries. Wait a few minutes.",
    "kiosk_not_allowed" to "That move can't sign in to kiosks right now. Ask a coordinator.",
)

class LoginViewModel(
    private val auth: KioskAuth,
    private val api: KioskApi,
    /** Null where the screen has no biometric sign-in (unit tests of the password form). */
    private val biometric: BiometricSignIn? = null,
    /** Told after each password sign-in; it decides on its own whether to offer Turn on. */
    private val enrollOffer: EnrollOffer? = null,
    scopeOverride: CoroutineScope? = null,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(LoginUi())
    val state: StateFlow<LoginUi> = _state

    // Once per screen (this ViewModel outlives a rotation; a new visit to the sign-in page makes a new one).
    private var cardLoaded = false
    private var autoPrompted = false

    fun setEmail(v: String) = _state.update { it.copy(email = v, invalidEmail = false, error = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v, invalidPassword = false, error = null) }
    fun togglePassword() = _state.update { it.copy(showPassword = !it.showPassword) }
    fun setView(v: LoginView) = _state.update { it.copy(view = v, error = null, moveError = null, movePassword = "", notice = null, bioError = null) }
    fun setMovePassword(v: String) = _state.update { it.copy(movePassword = v, moveError = null) }

    fun loadBanners() { scope.launch { try { _state.update { it.copy(status = api.systemStatus()) } } catch (e: Exception) { /* best effort */ } } }

    fun submitPassword(onDone: () -> Unit) {
        val s = _state.value
        if (s.loading) return
        if (s.email.isBlank() || s.password.isBlank()) {
            _state.update { it.copy(error = "Please enter both email and password", invalidEmail = s.email.isBlank(), invalidPassword = s.password.isBlank()) }
            return
        }
        _state.update { it.copy(loading = true, error = null) }
        scope.launch {
            try {
                auth.login(s.email.trim(), s.password)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val code = (e as? ApiError)?.code ?: "network"
                _state.update { it.copy(loading = false, error = ERROR_MESSAGES[code] ?: "Login failed. Please try again.", invalidEmail = true, invalidPassword = true, password = "") }
                return@launch
            }
            // After the try: a navigation throw is not a failed sign-in. The offer is decided in the
            // background (never on the way Home), and only after a password sign-in.
            _state.update { it.copy(loading = false) }
            enrollOffer?.afterPasswordSignIn()
            onDone()
        }
    }

    /** Sign in with the move password in the field. The server trims it; a blank entry never leaves the kiosk. */
    fun submitMove(onDone: () -> Unit) {
        val s = _state.value
        if (s.moveLoading) return
        if (s.movePassword.isBlank()) { _state.update { it.copy(moveError = "Enter the move password.") }; return }
        _state.update { it.copy(moveLoading = true, moveError = null) }
        scope.launch {
            try {
                auth.loginWithMovePassword(s.movePassword)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val code = (e as? ApiError)?.code ?: "network"
                _state.update { it.copy(moveLoading = false, movePassword = "", moveError = MOVE_ERROR_MESSAGES[code] ?: "Login failed. Please try again.") }
                return@launch
            }
            _state.update { it.copy(moveLoading = false, movePassword = "") }
            onDone()
        }
    }

    /** A QR code read by the camera is the move password: fill the field with it and sign in. */
    fun submitScannedMove(value: String, onDone: () -> Unit) {
        if (_state.value.moveLoading) return
        setMovePassword(value)
        submitMove(onDone)
    }

    // ── biometric sign-in ──────────────────────────────────────────

    /**
     * Once per screen, signed out only: the phone's card, if it has one. BiometricSignIn decides
     * who never gets one (no key, a shared station, a key Android or the server dropped). An
     * expired card is the password form with its email and the expired line, never a prompt. The
     * card arrives over the network, so it replaces the form only if the person hasn't started on it.
     */
    fun loadCard() {
        val bio = biometric ?: return
        if (cardLoaded) return
        cardLoaded = true
        if (auth.state.value is AuthState.Authed) return
        scope.launch {
            val card = bio.card() ?: return@launch
            _state.update { s ->
                val untouched = s.view == LoginView.PASSWORD && s.email.isEmpty() && s.password.isEmpty() && !s.loading
                when {
                    !untouched -> s
                    card.expired -> s.copy(card = card, email = card.email.orEmpty(), notice = BIOMETRIC_EXPIRED_MESSAGE, noticeError = false)
                    else -> s.copy(view = LoginView.BIOMETRIC, card = card, bioError = null)
                }
            }
        }
    }

    /** The prompt that starts on its own when the card appears: once per screen, never again on a
     *  recomposition or a rotation, and never for an expired card. */
    fun autoPrompt(prompter: BiometricPrompter, onDone: () -> Unit) {
        val s = _state.value
        if (autoPrompted || s.view != LoginView.BIOMETRIC || s.card == null || s.card.expired) return
        autoPrompted = true
        signInWithBiometric(prompter, onDone)
    }

    /** The card's button (and the auto prompt): the system prompt, then the server. */
    fun signInWithBiometric(prompter: BiometricPrompter, onDone: () -> Unit) {
        val bio = biometric ?: return
        val s = _state.value
        if (s.bioBusy || s.view != LoginView.BIOMETRIC) return
        _state.update { it.copy(bioBusy = true, bioError = null) }
        scope.launch {
            var lockedOut = false
            val outcome = try {
                bio.signIn(lockoutAware(prompter) { lockedOut = true })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                BiometricOutcome.Failed(BIOMETRIC_TRY_AGAIN_MESSAGE)
            }
            when (outcome) {
                BiometricOutcome.SignedIn -> { _state.update { it.copy(bioBusy = false) }; onDone() }
                BiometricOutcome.Canceled -> _state.update { it.copy(bioBusy = false, bioError = if (lockedOut) BIOMETRIC_LOCKOUT_MESSAGE else null) }
                is BiometricOutcome.Failed -> _state.update { it.copy(bioBusy = false, bioError = outcome.message) }
                BiometricOutcome.Expired -> toPassword(BIOMETRIC_EXPIRED_MESSAGE, error = false, keepEmail = true)
                BiometricOutcome.PasswordChange -> toPassword(BIOMETRIC_PASSWORD_CHANGE_MESSAGE, error = true, keepEmail = true)
                is BiometricOutcome.NotAllowed -> toPassword(outcome.message, error = true, keepEmail = true)
                BiometricOutcome.Invalidated -> toPassword(null, error = false, keepEmail = false)
            }
        }
    }

    /** The card's Use password: this person's password form, their email filled in. */
    fun usePassword() = _state.update {
        it.copy(view = LoginView.PASSWORD, email = it.card?.email.orEmpty(), password = "", bioError = null, notice = null, error = null)
    }

    /** The card's Other account: today's choices for someone else, nothing filled in. */
    fun otherAccount() = _state.update {
        it.copy(view = LoginView.CHOOSER, email = "", password = "", bioError = null, notice = null, error = null)
    }

    private fun toPassword(notice: String?, error: Boolean, keepEmail: Boolean) = _state.update {
        it.copy(
            view = LoginView.PASSWORD, bioBusy = false, bioError = null, notice = notice, noticeError = error,
            email = if (keepEmail) it.card?.email.orEmpty() else "", password = "", card = if (keepEmail) it.card else null,
        )
    }
}
