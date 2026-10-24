package com.serversherpa.kiosk.ui.screens.login

import androidx.biometric.BiometricPrompt
import com.serversherpa.kiosk.data.auth.BiometricPrompter
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** How the system prompt's callbacks end a prompt (the part of SystemBiometricPrompter a JVM can run). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BiometricPromptingTest {
    private val signature: Signature = Signature.getInstance("SHA256withECDSA").apply {
        initSign(KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().private)
    }

    private fun ends(drive: (BiometricPrompt.AuthenticationCallback) -> Unit): List<Result<Signature?>> {
        val ends = ArrayList<Result<Signature?>>()
        drive(promptCallback { ends += it })
        return ends
    }

    /** The library's result (its constructor is package-private: the library makes it, the app only reads it). */
    private fun success(): BiometricPrompt.AuthenticationResult =
        BiometricPrompt.AuthenticationResult::class.java
            .getDeclaredConstructor(BiometricPrompt.CryptoObject::class.java, Int::class.javaPrimitiveType).apply { isAccessible = true }
            .newInstance(BiometricPrompt.CryptoObject(signature), BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC)

    @Test fun successGivesTheAuthenticatedSignature() {
        val r = ends { it.onAuthenticationSucceeded(success()) }
        assertSame(signature, r.single().getOrThrow())
    }

    @Test fun bothLockoutsThrowLockedOut() {
        for (code in listOf(BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT)) {
            val r = ends { it.onAuthenticationError(code, "locked") }
            assertTrue("$code", r.single().exceptionOrNull() is BiometricLockedOut)
        }
    }

    @Test fun anUnusableSensorThrowsUnavailable() {
        for (code in listOf(BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_BIOMETRICS, BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED)) {
            val r = ends { it.onAuthenticationError(code, "x") }
            assertTrue("$code", r.single().exceptionOrNull() is BiometricUnavailable)
        }
    }

    @Test fun cancelAndTheButtonAreNullNotLockout() {
        for (code in listOf(BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT)) {
            val r = ends { it.onAuthenticationError(code, "x") }
            assertNull("$code", r.single().getOrThrow())
        }
    }

    @Test fun aBadFingerIsNotTheEndTheNextTryCanStillSucceed() {
        val r = ends {
            it.onAuthenticationFailed()
            it.onAuthenticationFailed()
            it.onAuthenticationSucceeded(success())
        }
        assertSame(signature, r.single().getOrThrow())
    }

    @Test fun onlyTheFirstEndCounts() {
        val r = ends {
            it.onAuthenticationError(BiometricPrompt.ERROR_USER_CANCELED, "x")
            it.onAuthenticationError(BiometricPrompt.ERROR_LOCKOUT, "x")
        }
        assertEquals(1, r.size)
        assertNull(r.single().getOrThrow())
    }

    @Test fun problemAwareTurnsAProblemIntoACancelAndSaysWhich() = runBlocking {
        val seen = ArrayList<PromptProblem>()
        assertNull(problemAware(BiometricPrompter { throw BiometricLockedOut() }) { seen += it }.authenticate(signature))
        assertNull(problemAware(BiometricPrompter { throw BiometricUnavailable() }) { seen += it }.authenticate(signature))
        assertEquals(listOf(PromptProblem.LOCKED_OUT, PromptProblem.UNAVAILABLE), seen)
        assertSame(signature, problemAware(BiometricPrompter { it }) { seen += it }.authenticate(signature))
        assertEquals(2, seen.size)
    }

    @Test fun withoutAFragmentActivityThePromptAnswersNull() = runBlocking {
        assertNull(SystemBiometricPrompter(null, SIGN_IN_PROMPT_TITLE).authenticate(signature))
    }
}
