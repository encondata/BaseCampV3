package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.auth.BIOMETRIC_ENROLL_FAILED_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_UNSUPPORTED_MESSAGE
import com.serversherpa.kiosk.data.auth.BiometricPrompter
import com.serversherpa.kiosk.data.auth.BiometricSignIn
import com.serversherpa.kiosk.data.auth.EnrollOutcome
import com.serversherpa.kiosk.data.auth.KioskAuth
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val ENROLL_OFFER_TEXT = "Use fingerprint or face to sign in on this phone? You'll sign in with your password again every 30 days."

/** The sheet while it shows: [busy] while Turn on runs, [message] after one that didn't work. */
data class EnrollOfferUi(val busy: Boolean = false, val message: String? = null)

/**
 * The Turn on offer after a password sign-in. It lives in the app (AppContainer), not the sign-in
 * screen: the screen is gone by the time the server answers, and the sign-in never waits for it.
 * [state] is non-null while the sheet should show. The offer only lands while the same person is
 * still signed in; signing out (or the session ending) closes it and stops a running Turn on.
 * BiometricSignIn decides who is offered: never a move password, a shared station or a restored
 * session.
 *
 * The work runs on the app's background scope. A sign-out's close and an answer's write hold
 * [lock], so they never interleave; a write also re-checks who is signed in after it lands, since
 * the sign-out itself (auth's state) may change on another thread just before.
 */
class EnrollOffer(
    private val biometric: BiometricSignIn,
    private val auth: KioskAuth,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<EnrollOfferUi?>(null)
    val state: StateFlow<EnrollOfferUi?> = _state
    private val lock = Any()
    private var deciding: Job? = null
    private var turningOn: Job? = null

    /** Tests: the job deciding the latest offer (a close forgets it, so capture it first). */
    internal val decidingJob: Job? get() = synchronized(lock) { deciding }

    init {
        scope.launch {
            auth.state.collect { if (it !is AuthState.Authed) close() }
        }
    }

    /** After a person's password sign-in: asks in the background, shows the sheet on a yes. */
    fun afterPasswordSignIn() {
        val person = signedIn() ?: return
        synchronized(lock) {
            deciding?.cancel()
            deciding = scope.launch {
                if (!biometric.offerEnroll()) return@launch
                show(person, EnrollOfferUi(), replaceOnly = false)
            }
        }
    }

    /** Not now: nothing is stored, so the next password sign-in asks again. */
    fun notNow() = close()

    /** Turn on: the system prompt once, then the key to the server. The sheet closes when it's on. */
    fun turnOn(prompter: BiometricPrompter) {
        val person = signedIn() ?: return close()
        synchronized(lock) {
            val now = _state.value ?: return
            if (now.busy) return
            _state.value = EnrollOfferUi(busy = true)
            turningOn = scope.launch { runTurnOn(person, prompter) }
        }
    }

    private suspend fun runTurnOn(person: String, prompter: BiometricPrompter) {
        var problem: PromptProblem? = null
        val outcome = try {
            biometric.enroll(problemAware(prompter) { problem = it })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            EnrollOutcome.Failed(BIOMETRIC_ENROLL_FAILED_MESSAGE)   // the enrollment couldn't be saved
        }
        val next = when (outcome) {
            EnrollOutcome.Enrolled -> null
            EnrollOutcome.Canceled -> EnrollOfferUi(message = sheetLine(problem))
            EnrollOutcome.Unsupported -> EnrollOfferUi(message = BIOMETRIC_UNSUPPORTED_MESSAGE)
            is EnrollOutcome.Failed -> EnrollOfferUi(message = outcome.message)
        }
        if (next == null) _state.value = null else show(person, next, replaceOnly = true)
    }

    /** Shows [next] while [person] is still signed in; [replaceOnly] replaces an open sheet only
     *  (one a sign-out closed stays closed). Re-checked after the write. */
    private fun show(person: String, next: EnrollOfferUi, replaceOnly: Boolean) {
        synchronized(lock) {
            if (signedIn() != person) return
            _state.update { cur -> if (replaceOnly && cur == null) null else next }
        }
        if (signedIn() != person) close()
    }

    private fun close() = synchronized(lock) {
        deciding?.cancel()
        deciding = null
        turningOn?.cancel()
        turningOn = null
        _state.value = null
    }

    /** Who is signed in, if a person may be offered: not while the password must change first. */
    private fun signedIn(): String? {
        val authed = auth.state.value as? AuthState.Authed ?: return null
        if (authed.mustChangePassword) return null
        return authed.person.id
    }

    private fun sheetLine(problem: PromptProblem?): String? = when (problem) {
        PromptProblem.LOCKED_OUT -> ENROLL_LOCKOUT_MESSAGE
        PromptProblem.UNAVAILABLE -> ENROLL_UNAVAILABLE_MESSAGE
        null -> null
    }
}

/** Beside the app's NavHost: the sheet over whichever signed-in screen the person is on. */
@Composable
fun EnrollOfferHost(offer: EnrollOffer) {
    // Collected on the main thread, where the offer's state changes (see ThisKioskPanel's row).
    val ui by offer.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    val prompter = rememberBiometricPrompter(ENROLL_PROMPT_TITLE)
    ui?.let { EnrollOfferSheet(it, onTurnOn = { offer.turnOn(prompter) }, onNotNow = offer::notNow) }
}

/** "Use fingerprint or face …?" with Turn on and Not now, rounded, sized to its words. */
@Composable
fun EnrollOfferSheet(ui: EnrollOfferUi, onTurnOn: () -> Unit, onNotNow: () -> Unit) {
    val c = LocalKioskColors.current
    Dialog(onDismissRequest = { if (!ui.busy) onNotNow() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.widthIn(max = 440.dp).fillMaxWidth().padding(16.dp).testTag("enroll-offer-sheet")
                .background(c.paper, RoundedCornerShape(16.dp))
                .verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            Text("SIGN-IN", style = MaterialTheme.typography.labelSmall, color = c.textMute)
            Text("Fingerprint sign-in", style = MaterialTheme.typography.headlineSmall, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
            Text(ENROLL_OFFER_TEXT, style = MaterialTheme.typography.bodyMedium, color = c.textDark, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
            KioskToast(ui.message, error = true)
            Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SolidButton(if (ui.busy) "Turning on…" else "Turn on", onTurnOn, enabled = !ui.busy, modifier = Modifier.fillMaxWidth().testTag("enroll-offer-turn-on"))
                MiniButton("Not now", onNotNow, enabled = !ui.busy, modifier = Modifier.fillMaxWidth().testTag("enroll-offer-not-now"))
            }
        }
    }
}
