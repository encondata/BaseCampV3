package com.serversherpa.kiosk.core.devices

import java.time.Instant
import java.time.format.DateTimeParseException

enum class RegistrationState(val wire: String, val label: String) {
    OK("ok", "Registered"), SOON("soon", "Expires soon"), EXPIRED("expired", "Expired"), NONE("none", "Unregistered");

    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } ?: NONE }
}

/** portal/src/lib/devices.ts tokenExpiryState: ok > 7 d, soon ≤ 7 d, expired past, none null. */
const val SOON_MS: Long = 7L * 24 * 60 * 60 * 1000

fun tokenExpiryState(iso: String?, nowMs: Long = System.currentTimeMillis()): RegistrationState {
    if (iso.isNullOrBlank()) return RegistrationState.NONE
    val t = try { Instant.parse(iso).toEpochMilli() } catch (e: DateTimeParseException) { return RegistrationState.NONE }
    if (t <= nowMs) return RegistrationState.EXPIRED
    return if (t - nowMs <= SOON_MS) RegistrationState.SOON else RegistrationState.OK
}

/** portal/src/lib/devices.ts registrationLabel. */
fun registrationLabel(state: RegistrationState): String = state.label
