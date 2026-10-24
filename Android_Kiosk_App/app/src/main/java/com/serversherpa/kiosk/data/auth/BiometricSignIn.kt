package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.BiometricEnrollment
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

/**
 * The prompt seam: the UI shows the system BiometricPrompt with `CryptoObject(signature)` and
 * returns the authenticated Signature, or null when the person cancels or the prompt gives up
 * (too many tries, lockout). Tests fake it.
 */
fun interface BiometricPrompter {
    suspend fun authenticate(signature: Signature): Signature?
}

/** The "Sign in as …" card. [email] is the one saved on this phone at enrollment (the server
 *  never sends one), for the expired state's pre-filled password form. */
data class BiometricCard(
    val keyId: String,
    val challenge: String,
    val displayName: String,
    val photoUrl: String?,
    val expired: Boolean,
    val email: String?,
)

/** How a biometric sign-in ended. Everything but [SignedIn] and [Canceled] goes to the password form. */
sealed interface BiometricOutcome {
    /** KioskAuth is Authed with the new session. */
    data object SignedIn : BiometricOutcome
    /** Past the 30 days: the password form, pre-filled, with the expired line. The key stays. */
    data object Expired : BiometricOutcome
    /** "Your password needs changing in the portal." The key stays. */
    data object PasswordChange : BiometricOutcome
    /** The password form with [message]: no kiosk access, a disabled account, or the phone is no
     *  longer this person's (reassigned, revoked; the local key is already forgotten then). */
    data class NotAllowed(val message: String) : BiometricOutcome
    /** Android invalidated the key (a new fingerprint, the screen lock removed), or there is none:
     *  forgotten on the phone; the password form, and the next password sign-in offers again. */
    data object Invalidated : BiometricOutcome
    /** The person canceled the prompt: stay on the card (try again or Use password). */
    data object Canceled : BiometricOutcome
    /** Nothing changed; stay on the card with [message] (fetch a fresh card before retrying). */
    data class Failed(val message: String) : BiometricOutcome
}

/** How Turn on ended. Every outcome but [Enrolled] leaves no key on the phone. */
sealed interface EnrollOutcome {
    data object Enrolled : EnrollOutcome
    data object Canceled : EnrollOutcome
    /** "This phone can't use fingerprint sign-in." (attestation refused, not this person's phone,
     *  or the Keystore couldn't make the key). */
    data object Unsupported : EnrollOutcome
    data class Failed(val message: String) : EnrollOutcome
}

const val BIOMETRIC_UNSUPPORTED_MESSAGE = "This phone can't use fingerprint sign-in."
const val BIOMETRIC_EXPIRED_MESSAGE = "Sign in with your password to keep using fingerprint."
const val BIOMETRIC_PASSWORD_CHANGE_MESSAGE = "Your password needs changing in the portal."
const val BIOMETRIC_RATE_LIMITED_MESSAGE = "Too many sign-in tries. Wait a few minutes, then try again."
const val BIOMETRIC_REMOVED_MESSAGE = "Fingerprint sign-in is off for this phone. Sign in with your password."
const val BIOMETRIC_KIOSK_NOT_ALLOWED_MESSAGE = "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access."
const val BIOMETRIC_ACCOUNT_DISABLED_MESSAGE = "This account is disabled. Contact your coordinator."
const val BIOMETRIC_NETWORK_MESSAGE = "Can't reach the server. Check the kiosk's network connection."
const val BIOMETRIC_TRY_AGAIN_MESSAGE = "Fingerprint sign-in didn't go through. Try again, or use your password."
const val BIOMETRIC_ENROLL_WINDOW_MESSAGE = "Sign in with your password again to turn on fingerprint sign-in."
const val BIOMETRIC_ENROLL_FAILED_MESSAGE = "Couldn't turn on fingerprint sign-in. Try again later."

/**
 * Biometric sign-in on a personal phone: who is offered enrollment, Turn on, the card, sign-in
 * and Forget. The key is [keys]; the server's key id, the person and the email are in
 * [KioskPrefs.biometric]. Keystore work runs on [io]; the prompt runs on the caller's context.
 *
 * A key this phone can no longer use (Android invalidated it, or the server no longer has it for
 * this phone) is forgotten on the phone only: the server row is useless without the private key.
 */
class BiometricSignIn(
    private val api: KioskApi,
    private val auth: KioskAuth,
    private val keys: BiometricKeys,
    private val prefs: KioskPrefs,
    private val identity: Identity,
    /** Whether a Time Clock / RFID / Label station key is stored here (a shared station). */
    private val stationKeyPresent: suspend () -> Boolean,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    /** The phone's enrollment (whose key, and its email), or null: Settings › This Kiosk's row. */
    val enrollment: Flow<BiometricEnrollment?> = prefs.biometric

    /**
     * Whether to show the Turn on sheet now: right after a person's own password sign-in (never a
     * restored, link, biometric or move-password session, nor a move-locked one), never on a
     * shared station (a station type or a station key), with a strong biometric ready, no live
     * key of theirs here already, and the server agreeing this is their personal phone (the
     * enroll-challenge answers, which it only does inside the 10-minute enroll window).
     */
    suspend fun offerEnroll(): Boolean {
        val me = eligibleSession() ?: return false
        if (withContext(io) { keys.canUse() } != BiometricReadiness.READY) return false
        val serial = serial()
        val local = prefs.biometric.first()
        if (local != null && local.personId == me.person.id) {
            val live = withContext(io) { keys.signer() } != null && try {
                api.biometricChallenge(serial).key_id == local.keyId
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (codeOf(e) != "no_biometric") return false   // offline, throttled: ask another time
                false
            }
            if (live) return false            // this password sign-in renews it
            dropLocal()
        }
        return try {
            api.biometricEnrollChallenge(serial); true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
    }

    /** Turn on: a fresh nonce, a new key attested to it, one prompt to prove the key works, then
     *  the chain to the server. Any old key here is replaced. */
    suspend fun enroll(prompt: BiometricPrompter): EnrollOutcome {
        val me = eligibleSession() ?: return EnrollOutcome.Failed(BIOMETRIC_ENROLL_WINDOW_MESSAGE)
        val email = auth.currentSignIn?.email ?: me.person.email
        val serial = serial()
        val nonce = try {
            api.biometricEnrollChallenge(serial)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return enrollFailure(codeOf(e))
        }
        var enrolled = false
        try {
            dropLocal()
            val chain = try {
                withContext(io) { keys.create(sha256(nonce)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return EnrollOutcome.Unsupported
            }
            val signer = withContext(io) { keys.signer() } ?: return EnrollOutcome.Unsupported
            val proven = try { prompt.authenticate(signer) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                ?: return EnrollOutcome.Canceled
            try {
                withContext(io) { proven.update(nonce.toByteArray(Charsets.UTF_8)); proven.sign() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return EnrollOutcome.Unsupported
            }
            val out = try {
                api.biometricEnroll(serial, nonce, chain.map { Base64.getEncoder().encodeToString(it) })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return enrollFailure(codeOf(e))
            }
            prefs.setBiometric(BiometricEnrollment(out.key_id, me.person.id, email))
            enrolled = true
            return EnrollOutcome.Enrolled
        } finally {
            if (!enrolled) withContext(NonCancellable) { dropLocal() }
        }
    }

    /**
     * The card for the sign-in screen, or null for the password form: no key here, a shared
     * station, a key Android invalidated or the server no longer has for this phone (both
     * forgotten here), or the server out of reach. Each call may fetch a new challenge.
     */
    suspend fun card(): BiometricCard? {
        if (sharedStation()) return null
        val local = prefs.biometric.first() ?: return null
        if (withContext(io) { keys.signer() } == null) { dropLocal(); return null }
        val c = try {
            api.biometricChallenge(serial())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (codeOf(e) == "no_biometric") dropLocal()
            return null
        }
        if (c.key_id != local.keyId) { dropLocal(); return null }
        return BiometricCard(c.key_id, c.challenge, c.display_name, c.photo_url, c.expired, local.email)
    }

    /**
     * Sign in with the key: a fresh challenge (each attempt spends one), the prompt, the signed
     * challenge to the server, and the session adopted by KioskAuth (Authed, method BIOMETRIC).
     */
    suspend fun signIn(prompt: BiometricPrompter): BiometricOutcome {
        val local = prefs.biometric.first() ?: return BiometricOutcome.Invalidated
        if (sharedStation()) return BiometricOutcome.NotAllowed(BIOMETRIC_REMOVED_MESSAGE)
        val signer = withContext(io) { keys.signer() } ?: run { dropLocal(); return BiometricOutcome.Invalidated }
        val c = try {
            api.biometricChallenge(serial())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return signInFailure(codeOf(e))
        }
        if (c.key_id != local.keyId) { dropLocal(); return BiometricOutcome.NotAllowed(BIOMETRIC_REMOVED_MESSAGE) }
        if (c.expired) return BiometricOutcome.Expired
        val signed = try { prompt.authenticate(signer) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            return BiometricOutcome.Failed(BIOMETRIC_TRY_AGAIN_MESSAGE)
        } ?: return BiometricOutcome.Canceled
        val signature = try {
            withContext(io) { signed.update(c.challenge.toByteArray(Charsets.UTF_8)); signed.sign() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return BiometricOutcome.Failed(BIOMETRIC_TRY_AGAIN_MESSAGE)
        }
        val data = try {
            api.biometricSignIn(local.keyId, c.challenge, Base64.getEncoder().encodeToString(signature))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return signInFailure(codeOf(e))
        }
        auth.signInWithBiometric(data)
        return BiometricOutcome.SignedIn
    }

    /** Forget this device. Signed in: revoke on the server, then forget here. Signed out: here
     *  only. The phone always forgets; false when the server call failed. */
    suspend fun forget(signedIn: Boolean): Boolean {
        var ok = true
        if (signedIn) {
            ok = try {
                api.biometricForget(serial()); true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
        }
        dropLocal()
        return ok
    }

    // ── rules ───────────────────────────────────────────────────────

    /** The signed-in session when it may enroll: a person's own password sign-in on this launch,
     *  not locked to a move, on a phone that isn't a shared station. */
    private suspend fun eligibleSession(): AuthState.Authed? {
        val authed = auth.state.value as? AuthState.Authed ?: return null
        if (authed.kioskMove != null) return null
        if (auth.currentSignIn?.method != LoginMethod.PASSWORD) return null
        if (sharedStation()) return null
        return authed
    }

    /** A Time Clock (or any) station type, or a station key: never anyone's personal phone. */
    private suspend fun sharedStation(): Boolean =
        prefs.setupSelection.first()?.stationType != null || stationKeyPresent()

    /** Sign-in and challenge refusals. A key the server no longer has for this phone is done
     *  here too: revoked, reassigned, or no longer a personal phone. */
    private suspend fun signInFailure(code: String): BiometricOutcome = when (code) {
        "no_biometric", "not_personal_device" -> { dropLocal(); BiometricOutcome.NotAllowed(BIOMETRIC_REMOVED_MESSAGE) }
        "biometric_expired" -> BiometricOutcome.Expired
        "password_change_required" -> BiometricOutcome.PasswordChange
        "kiosk_not_allowed" -> BiometricOutcome.NotAllowed(BIOMETRIC_KIOSK_NOT_ALLOWED_MESSAGE)
        "account_disabled" -> BiometricOutcome.NotAllowed(BIOMETRIC_ACCOUNT_DISABLED_MESSAGE)
        "biometric_rate_limited" -> BiometricOutcome.Failed(BIOMETRIC_RATE_LIMITED_MESSAGE)
        "network" -> BiometricOutcome.Failed(BIOMETRIC_NETWORK_MESSAGE)
        else -> BiometricOutcome.Failed(BIOMETRIC_TRY_AGAIN_MESSAGE)   // bad_challenge, bad_signature, …
    }

    private fun enrollFailure(code: String): EnrollOutcome = when (code) {
        "attestation_failed", "not_personal_device" -> EnrollOutcome.Unsupported
        "enroll_window_closed" -> EnrollOutcome.Failed(BIOMETRIC_ENROLL_WINDOW_MESSAGE)
        "network" -> EnrollOutcome.Failed(BIOMETRIC_NETWORK_MESSAGE)
        else -> EnrollOutcome.Failed(BIOMETRIC_ENROLL_FAILED_MESSAGE)
    }

    // ── plumbing ────────────────────────────────────────────────────

    /** Forgets the key on the phone: the Keystore entry and the saved enrollment. */
    private suspend fun dropLocal() {
        try { withContext(io) { keys.delete() } } catch (e: CancellationException) { throw e } catch (e: Exception) { /* gone either way */ }
        prefs.setBiometric(null)
    }

    private suspend fun serial(): String = identity.get().serial

    private fun codeOf(e: Exception): String = (e as? ApiError)?.code ?: "network"

    private fun sha256(s: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
}
