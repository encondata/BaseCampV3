package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable data class PairCreateIn(val serial: String, val name: String)

@Serializable
data class PairCreated(val code: String, val poll_token: String, val link_url: String, val expires_at: String)

@Serializable data class PairPollIn(val poll_token: String)

enum class PairStatus { PENDING, APPROVED, DENIED, EXPIRED;
    companion object { fun fromWire(s: String) = entries.firstOrNull { it.name.equals(s, true) } ?: EXPIRED }
}

@Serializable data class PairPollOut(val status: String, val session: SessionData? = null)

data class PairPoll(val status: PairStatus, val session: SessionData?)

@Serializable
data class HeartbeatIn(
    val serial: String,
    val name: String,
    val mode: String = "android",
    val version: String? = null,
    val raw_info: Map<String, String> = emptyMap(),
    val sign_in: Boolean = false,
    val login_method: String? = null,
)

@Serializable
data class HeartbeatResult(
    val device_id: String,
    val name: String,
    val registration: String,
    val token_expires_at: String? = null,
)

@Serializable data class KioskSignOutIn(val serial: String)

@Serializable data class SetupOptionSite(val id: String, val name: String)

@Serializable
data class SetupOptionInitiative(
    val id: String,
    val name: String,
    val status: String,
    val status_label: String,
    val client_name: String? = null,
    val scheduled_start: String? = null,
    val scheduled_end: String? = null,
    val source_site: SetupOptionSite? = null,
    val destination_site: SetupOptionSite? = null,
)

@Serializable data class SetupOptionScanType(val key: String, val label: String, val color: String)

@Serializable
data class SetupOptions(
    val initiatives: List<SetupOptionInitiative> = emptyList(),
    val scan_types: List<SetupOptionScanType> = emptyList(),
)

@Serializable
data class KioskSetupIn(val serial: String, val initiative_id: String, val site_id: String, val scan_status: String)

@Serializable
data class KioskSetupResult(
    val device_id: String,
    val initiative_id: String,
    val initiative_name: String,
    val site_id: String,
    val site_name: String,
    val site_role: String,
    val scan_status: String,
    val scan_status_label: String,
)

/** What Kiosk Setup saved on this kiosk (DataStore JSON). */
@Serializable
data class KioskSetupSelection(
    val initiativeId: String,
    val initiativeName: String,
    val siteId: String,
    val siteName: String,
    val siteRole: String,
    val scanStatus: String,
    val scanLabel: String,
)
