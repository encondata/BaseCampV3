package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskTimeclockPerson(
    val id: String, val display_name: String, val first_name: String = "", val last_name: String = "",
    val preferred_name: String? = null, val avatar_url: String? = null, val rfid_tag: String? = null,
    val job_title: String? = null,
    /** Shown as "Employee ID". */
    val external_id: String? = null,
)

@Serializable
data class KioskTimeclockEntry(
    val id: String, val started_at: String, val initiative_id: String? = null, val initiative_name: String? = null,
    val site_id: String? = null, val site_name: String? = null,
)

@Serializable
data class KioskTimeclockLastEntry(val id: String, val started_at: String, val ended_at: String, val minutes: Int)

/** One entry's share of today, for the Clock Out screen's punches table. `minutes` is clipped
 *  to today; `clock_out_at` is null while the entry is still open. */
@Serializable
data class TodayEntry(val clock_in_at: String, val clock_out_at: String? = null, val minutes: Int)

@Serializable
data class KioskTimeclockStatus(
    val person: KioskTimeclockPerson,
    val clocked_in: Boolean,
    val entry: KioskTimeclockEntry? = null,
    val last_entry: KioskTimeclockLastEntry? = null,
    /** Minutes worked today, "today" local to the kiosk's site (else [ClockInIn.tz], else UTC). */
    val today_minutes: Int = 0,
    /** Today's punches, oldest first. */
    val today_entries: List<TodayEntry> = emptyList(),
)

/** `tz` is the device's IANA zone (`ZoneId.systemDefault().id`), sent on every status read and
 *  punch: "today" falls back to it when the kiosk's site has no zone. */
@Serializable
data class ClockInIn(
    val serial: String, val person_id: String, val site_id: String? = null, val initiative_id: String? = null,
    val tz: String? = null,
)

@Serializable data class ClockOutIn(val serial: String, val person_id: String, val tz: String? = null)

/** A Time Clock station's punch under its station key, for both clock-in and clock-out
 *  (the API's KioskStationClockIn). No site or move: the station's own setup supplies them. */
@Serializable data class StationClockIn(val serial: String, val person_id: String, val tz: String? = null)
