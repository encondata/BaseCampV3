package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class PersonOut(
    val id: String,
    val first_name: String,
    val last_name: String,
    val preferred_name: String? = null,
    val display_name: String,
    val email: String? = null,
    val job_title: String? = null,
    val avatar_url: String? = null,
)

/** The two preferences the kiosk honors; the rest are ignored on decode. */
@Serializable
data class UiPreferences(val accent: String = "amber", val theme: String = "light")

/** The move a move-password session is locked to (`kiosk_move` on the session). */
@Serializable
data class KioskMove(val initiative_id: String, val name: String)

/** `SessionOut` — what /auth/login, /kiosk/move-login, /auth/refresh, and an approved pair poll return. */
@Serializable
data class SessionData(
    val access_token: String,
    val expires_in: Int,
    val session_expires_at: String,
    val person: PersonOut,
    val roles: List<String> = emptyList(),
    val must_change_password: Boolean = false,
    val preferences: UiPreferences = UiPreferences(),
    val perms: Map<String, Map<String, Boolean>> = emptyMap(),
    val max_rank: Int = 0,
    /** Set only on a move-password sign-in: the session works on this move alone. */
    val kiosk_move: KioskMove? = null,
)

@Serializable
data class LoginIn(val email: String, val password: String, val client: String = "kiosk")

@Serializable
data class MoveLoginIn(val password: String)

@Serializable
data class SystemStatus(
    val read_only: Boolean = false,
    val read_only_message: String = "",
    val workers_paused: Boolean = false,
    val banner: String? = null,
)

// ── biometric sign-in (/kiosk/biometric/*) ──────────────────────────

/** enroll-challenge and challenge: the kiosk's serial. */
@Serializable
data class BiometricSerialIn(val serial: String)

/** A signed enroll nonce (5 minutes). The key's attestation challenge is the SHA-256 of its UTF-8 bytes. */
@Serializable
data class BiometricEnrollChallengeOut(val nonce: String)

/** [chain]: KeyStore.getCertificateChain, leaf first, each certificate's DER in standard base64. */
@Serializable
data class BiometricEnrollIn(val serial: String, val nonce: String, val chain: List<String>)

@Serializable
data class BiometricEnrollOut(val key_id: String, val security_level: String, val renews_at: String)

/** [challenge]: sign its UTF-8 bytes with SHA256withECDSA. [expired]: past the 30 days, so the
 *  password form instead. No email comes from the server; the app keeps it from enrollment. */
@Serializable
data class BiometricChallengeOut(
    val key_id: String,
    val challenge: String,
    val display_name: String,
    val photo_url: String? = null,
    val expired: Boolean = false,
)

/** [signature]: the DER ECDSA signature, standard base64. */
@Serializable
data class BiometricSignInIn(val key_id: String, val challenge: String, val signature: String)
