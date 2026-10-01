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
