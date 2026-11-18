package com.serversherpa.kiosk.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * GET /kiosk/personal and PUT /kiosk/personal (api/.../routes/kiosk_push.py), about the phone the
 * session is bound to. [on]: the phone is the signed-in person's. [ownerName]: whoever owns it,
 * them or someone else; null when nobody does. [pushRegistered]: the phone has the person's push
 * registration (only GET says; PUT's answer leaves it false).
 */
@Serializable
data class PersonalState(
    val on: Boolean,
    @SerialName("owner_name") val ownerName: String? = null,
    @SerialName("push_registered") val pushRegistered: Boolean = false,
)

@Serializable
data class PersonalIn(val on: Boolean)

/** POST /kiosk/push/registration and PUT /kiosk/push/registration/token. */
@Serializable
data class PushTokenIn(val token: String)

/** POST /kiosk/push/registration's answer: the push key is shown this once. Never logged. */
@Serializable
data class PushRegistration(
    @SerialName("registration_id") val registrationId: String,
    @SerialName("push_key") val pushKey: String,
) {
    override fun toString(): String = "PushRegistration(registrationId=$registrationId)"
}

/** POST /kiosk/push/notifications/{id}/snooze's answer: when the snooze push goes (always 5 minutes). */
@Serializable
data class PushSnooze(@SerialName("snoozed_until") val snoozedUntil: String)
