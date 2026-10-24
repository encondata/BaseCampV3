package com.serversherpa.kiosk.ui.screens.login

import android.content.Context
import android.content.ContextWrapper
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.serversherpa.kiosk.data.auth.BiometricPrompter
import java.security.Signature
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** The card's line after too many tries (BiometricPrompt's lockouts). */
const val BIOMETRIC_LOCKOUT_MESSAGE = "Too many tries. Use your password, or try again later."
/** The card's line when the sensor can't be used right now (no hardware, none enrolled, a security update due). */
const val BIOMETRIC_UNAVAILABLE_MESSAGE = "Fingerprint isn't available right now. Use your password."
/** The Turn on sheet's versions: the person is already signed in, so no "use your password". */
const val ENROLL_LOCKOUT_MESSAGE = "Too many tries. Try again later."
const val ENROLL_UNAVAILABLE_MESSAGE = "Fingerprint isn't available right now. Try again later."

/** The system prompt's titles and its one button. The button cancels: the person stays where they were. */
internal const val SIGN_IN_PROMPT_TITLE = "Sign in to ServerSherpa"
internal const val ENROLL_PROMPT_TITLE = "Turn on fingerprint sign-in"
internal const val PROMPT_CANCEL = "Cancel"

/** Why the system prompt ended without a signature, when the person should be told. */
enum class PromptProblem { LOCKED_OUT, UNAVAILABLE }

/** Thrown by [SystemBiometricPrompter] for a [PromptProblem]. The screens turn it into their line
 *  with [problemAware]; it never reaches BiometricSignIn. */
open class BiometricPromptProblem(val problem: PromptProblem) : Exception("biometric prompt: $problem")

/** Android locked biometrics after too many tries. */
class BiometricLockedOut : BiometricPromptProblem(PromptProblem.LOCKED_OUT)

/** The sensor can't be used right now: no hardware, none enrolled, unavailable, a security update due. */
class BiometricUnavailable : BiometricPromptProblem(PromptProblem.UNAVAILABLE)

/** Tests: a fake prompt. Null (the app) means the system's BiometricPrompt. */
val LocalBiometricPrompter = staticCompositionLocalOf<BiometricPrompter?> { null }

/** The prompter for this screen: the test's, or the system prompt over this activity. */
@Composable
fun rememberBiometricPrompter(title: String): BiometricPrompter {
    LocalBiometricPrompter.current?.let { return it }
    val activity = LocalContext.current.fragmentActivity()
    return remember(activity, title) { SystemBiometricPrompter(activity, title) }
}

/** [prompter] with a [PromptProblem] turned into a cancel (null), after calling [onProblem]: the
 *  data layer sees Canceled, and the screen shows the problem's line instead of staying silent. */
fun problemAware(prompter: BiometricPrompter, onProblem: (PromptProblem) -> Unit): BiometricPrompter = BiometricPrompter { signature ->
    try {
        prompter.authenticate(signature)
    } catch (e: BiometricPromptProblem) {
        onProblem(e.problem)
        null
    }
}

/** The prompt's error codes worth a line; every other one (the person canceled, the Cancel
 *  button, the system dismissed it, a timeout) is silent. */
internal fun problemOf(errorCode: Int): PromptProblem? = when (errorCode) {
    BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> PromptProblem.LOCKED_OUT
    BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_BIOMETRICS,
    BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED -> PromptProblem.UNAVAILABLE
    else -> null
}

/**
 * How the prompt's callbacks end the wait: success gives the authenticated Signature; a lockout
 * throws [BiometricLockedOut] and an unusable sensor [BiometricUnavailable]; every other error
 * (the person canceled, the Cancel button, the system dismissed it) is null, which keeps the
 * person where they were. One bad finger
 * ([BiometricPrompt.AuthenticationCallback.onAuthenticationFailed]) is not the end: the prompt
 * stays up and lets them try again. [finish] is called at most once.
 */
internal fun promptCallback(finish: (Result<Signature?>) -> Unit): BiometricPrompt.AuthenticationCallback =
    object : BiometricPrompt.AuthenticationCallback() {
        private var done = false
        private fun end(r: Result<Signature?>) { if (!done) { done = true; finish(r) } }
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) =
            end(Result.success(result.cryptoObject?.signature))
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) =
            end(
                when (problemOf(errorCode)) {
                    PromptProblem.LOCKED_OUT -> Result.failure(BiometricLockedOut())
                    PromptProblem.UNAVAILABLE -> Result.failure(BiometricUnavailable())
                    null -> Result.success(null)
                },
            )
        override fun onAuthenticationFailed() = Unit
    }

/**
 * The system BiometricPrompt, strong biometrics only, over a `CryptoObject(signature)`. Needs a
 * [FragmentActivity] (MainActivity is one); without one it answers null. Runs on the main thread;
 * canceling the caller's coroutine dismisses the prompt.
 */
class SystemBiometricPrompter(private val activity: FragmentActivity?, private val title: String) : BiometricPrompter {
    override suspend fun authenticate(signature: Signature): Signature? {
        val act = activity ?: return null
        return withContext(Dispatchers.Main.immediate) {
            // After onSaveInstanceState BiometricPrompt drops the request without a callback, which
            // would leave the caller waiting forever: treat it as a cancel instead.
            if (act.isFinishing || act.supportFragmentManager.isStateSaved) return@withContext null
            suspendCancellableCoroutine { cont ->
                val callback = promptCallback { r -> if (cont.isActive) r.fold({ cont.resume(it) }, { cont.resumeWithException(it) }) }
                val prompt = BiometricPrompt(act, ContextCompat.getMainExecutor(act), callback)
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setNegativeButtonText(PROMPT_CANCEL)
                    .setAllowedAuthenticators(BIOMETRIC_STRONG)
                    .build()
                cont.invokeOnCancellation { act.runOnUiThread { prompt.cancelAuthentication() } }
                prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
            }
        }
    }
}

private tailrec fun Context.fragmentActivity(): FragmentActivity? = when (this) {
    is FragmentActivity -> this
    is ContextWrapper -> baseContext.fragmentActivity()
    else -> null
}
