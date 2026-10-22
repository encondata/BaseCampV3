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
    /** A Clear Setup id this kiosk applied and is acknowledging (repeated until the reply stops asking). */
    val setup_cleared: String? = null,
)

@Serializable
data class HeartbeatResult(
    val device_id: String,
    val name: String,
    val registration: String,
    val token_expires_at: String? = null,
    /** A pending Clear Setup id from the portal; repeats every beat until acknowledged. */
    val clear_setup: String? = null,
)

@Serializable data class KioskSignOutIn(val serial: String)

@Serializable data class KioskStationKeyIn(val serial: String)

@Serializable data class KioskStationKeyOut(val key: String)

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

/** A site for a Time Clock station's no-move Site step (setup-options `sites`). */
typealias SetupSite = SetupOptionSite

@Serializable
data class SetupOptions(
    val initiatives: List<SetupOptionInitiative> = emptyList(),
    val scan_types: List<SetupOptionScanType> = emptyList(),
    /** Every active site, for a Time Clock station's no-move Site step. */
    val sites: List<SetupSite> = emptyList(),
)

/** A regular kiosk always sends a move, a site and a scan type. A Time Clock station
 *  (`station_type` "timeclock") sends no scan type and an optional move and site. */
@Serializable
data class KioskSetupIn(
    val serial: String,
    val initiative_id: String? = null,
    val site_id: String? = null,
    val scan_status: String? = null,
    /** "label", "rfid", "timeclock", or null for a regular kiosk. */
    val station_type: String? = null,
)

/** The API's KioskSetupOut: a Time Clock station's setup may have no move, site or scan type. */
@Serializable
data class KioskSetupResult(
    val device_id: String,
    val initiative_id: String? = null,
    val initiative_name: String? = null,
    val site_id: String? = null,
    val site_name: String? = null,
    /** "source", "destination", or "other" (a Time Clock station's site with no move). */
    val site_role: String? = null,
    val scan_status: String? = null,
    val scan_status_label: String? = null,
)

/** What Kiosk Setup saved on this kiosk (DataStore JSON). A regular kiosk's selection always has
 *  every move field; a Time Clock station's ([stationType] "timeclock") may have none of them.
 *  A selection saved before [stationType] existed reads as a regular kiosk. */
@Serializable
data class KioskSetupSelection(
    val initiativeId: String? = null,
    val initiativeName: String? = null,
    val siteId: String? = null,
    val siteName: String? = null,
    val siteRole: String? = null,
    val scanStatus: String? = null,
    val scanLabel: String? = null,
    /** What labels print on, from the setup's last step: "top" or "front". A selection saved
     *  before that step existed has none, and reads as "top". */
    val labelKind: String = "top",
    /** null for a regular kiosk; "timeclock" for a Time Clock station. */
    val stationType: String? = null,
)

/** A page header's "Move A · Dock 4" (with " · Pre-stage" when [withScan] and set). A Time
 *  Clock station's empty picks read "No move" and "No site", never "null". */
fun KioskSetupSelection.headerLine(withScan: Boolean = false): String =
    listOfNotNull(initiativeName ?: "No move", siteName ?: "No site", scanLabel?.takeIf { withScan }).joinToString(" · ")
