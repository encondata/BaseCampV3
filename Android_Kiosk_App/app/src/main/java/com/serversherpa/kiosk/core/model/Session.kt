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

/** `SessionOut` — what /auth/login, /auth/refresh, and an approved pair poll return. */
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
)

@Serializable
data class LoginIn(val email: String, val password: String, val client: String = "kiosk")

@Serializable
data class SystemStatus(
    val read_only: Boolean = false,
    val read_only_message: String = "",
    val workers_paused: Boolean = false,
    val banner: String? = null,
)
