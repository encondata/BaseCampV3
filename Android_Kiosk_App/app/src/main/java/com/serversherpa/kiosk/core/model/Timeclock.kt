package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskTimeclockPerson(
    val id: String, val display_name: String, val first_name: String = "", val last_name: String = "",
    val preferred_name: String? = null, val avatar_url: String? = null, val rfid_tag: String? = null,
)

@Serializable
data class KioskTimeclockEntry(
    val id: String, val started_at: String, val initiative_id: String? = null, val initiative_name: String? = null,
    val site_id: String? = null, val site_name: String? = null,
)

@Serializable
data class KioskTimeclockLastEntry(val id: String, val started_at: String, val ended_at: String, val minutes: Int)

@Serializable
data class KioskTimeclockStatus(
    val person: KioskTimeclockPerson,
    val clocked_in: Boolean,
    val entry: KioskTimeclockEntry? = null,
    val last_entry: KioskTimeclockLastEntry? = null,
)

@Serializable
data class ClockInIn(val serial: String, val person_id: String, val site_id: String? = null, val initiative_id: String? = null)

@Serializable data class ClockOutIn(val serial: String, val person_id: String)
