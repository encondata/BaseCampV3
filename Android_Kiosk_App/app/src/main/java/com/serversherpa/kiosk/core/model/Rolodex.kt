package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

// The /kiosk/rolodex/* payloads, snake_case as the API sends them (spec §4.1).

/** A worker's company (a partner). */
@Serializable data class RolodexCompany(val id: String, val name: String)

/**
 * One worker in GET /kiosk/rolodex/workers. Never carries email or phone: those load with
 * [RolodexDetail] only, and this row is what the offline list cache stores.
 */
@Serializable
data class RolodexRow(
    val person_id: String,
    val first_name: String = "",
    val last_name: String = "",
    val preferred_name: String? = null,
    /** `preferred_name or first_name` + last name. */
    val display_name: String = "",
    val job_title: String? = null,
    val company: RolodexCompany? = null,
    val trade: String? = null,
    val level: String? = null,
    val level_color: String? = null,
    /** A worker status key from [RolodexOptions.statuses] (seeded: active, standby, blacklist). */
    val status: String = "",
    val status_label: String = "",
    val status_color: String? = null,
    val has_photo: Boolean = false,
    /** Presigned and short-lived (600 s): cache photo bytes by person_id + [photo_version], never by this URL. */
    val photo_url: String? = null,
    /** Changes with every new photo; null without one. */
    val photo_version: String? = null,
    val rfid_enrolled: Boolean = false,
    val has_account: Boolean = false,
)

@Serializable data class RolodexList(val generated_at: String, val workers: List<RolodexRow> = emptyList())

/** GET /kiosk/rolodex/workers/{person_id}, and the answer to a create or an edit: the row plus contact and edit rights. */
@Serializable
data class RolodexDetail(
    val person_id: String,
    val first_name: String = "",
    val last_name: String = "",
    val preferred_name: String? = null,
    val display_name: String = "",
    val job_title: String? = null,
    val company: RolodexCompany? = null,
    val trade: String? = null,
    val level: String? = null,
    val level_color: String? = null,
    val status: String = "",
    val status_label: String = "",
    val status_color: String? = null,
    val has_photo: Boolean = false,
    val photo_url: String? = null,
    val photo_version: String? = null,
    val rfid_enrolled: Boolean = false,
    val has_account: Boolean = false,
    val email: String? = null,
    val phone: String? = null,
    /** Shown as "Employee ID"; read-only here. */
    val external_id: String? = null,
    val status_note: String? = null,
    /** False when the person has a portal login ranked at or above the admin's. Missing reads as false. */
    val can_edit: Boolean = false,
    /** False for yourself or an untouchable person. Missing reads as false. */
    val can_change_status: Boolean = false,
    /** `rank_too_low` or null. */
    val edit_block_reason: String? = null,
    /** `self`, `rank_too_low` or null. */
    val status_block_reason: String? = null,
) {
    /** This person as a list row (no email or phone), e.g. to replace the row after a save. */
    fun toRow(): RolodexRow = RolodexRow(
        person_id = person_id, first_name = first_name, last_name = last_name, preferred_name = preferred_name,
        display_name = display_name, job_title = job_title, company = company, trade = trade, level = level,
        level_color = level_color, status = status, status_label = status_label, status_color = status_color,
        has_photo = has_photo, photo_url = photo_url, photo_version = photo_version,
        rfid_enrolled = rfid_enrolled, has_account = has_account,
    )
}

@Serializable data class RolodexLevel(val level: String, val title: String = "", val color: String? = null)

@Serializable data class RolodexStatus(val key: String, val label: String = "", val color: String? = null)

@Serializable data class RolodexPartner(val id: String, val name: String)

/** GET /kiosk/rolodex/options: active statuses and non-archived partners, in the server's order. */
@Serializable
data class RolodexOptions(
    val levels: List<RolodexLevel> = emptyList(),
    val statuses: List<RolodexStatus> = emptyList(),
    val partners: List<RolodexPartner> = emptyList(),
)

/** POST /kiosk/rolodex/duplicates: names in the body, never in a URL. Null fields are left out. */
@Serializable
data class RolodexDuplicatesIn(
    val first_name: String,
    val last_name: String,
    val preferred_name: String? = null,
    val email: String? = null,
    val phone: String? = null,
)

/** A person who may already be the worker being added. */
@Serializable
data class RolodexMatch(
    val person_id: String,
    val display_name: String = "",
    val job_title: String? = null,
    /** The company's name. */
    val company: String? = null,
    /** False for staff, portal users and client contacts: no Open, only "Add the worker role there." */
    val is_worker: Boolean = false,
    val has_account: Boolean = false,
    val photo_url: String? = null,
    val photo_version: String? = null,
    /** Any of "name", "email", "phone". An email match blocks Create anyway. */
    val matched_on: List<String> = emptyList(),
)

/** The duplicates answer; [com.serversherpa.kiosk.data.api.KioskApi.rolodexDuplicates] returns its list. */
@Serializable data class RolodexDuplicatesOut(val matches: List<RolodexMatch> = emptyList())

/**
 * POST /kiosk/rolodex/workers. Null fields are left out; the server refuses unknown keys.
 * [allow_duplicate] answers a 409 `possible_duplicate`; [photo_skipped] is sent only after the
 * "Create without photo" confirmation.
 */
@Serializable
data class RolodexCreateIn(
    val first_name: String,
    val last_name: String,
    val preferred_name: String? = null,
    val job_title: String? = null,
    val phone: String? = null,
    val email: String? = null,
    val partner_id: String? = null,
    val trade: String? = null,
    val level: String? = null,
    val allow_duplicate: Boolean = false,
    val photo_skipped: Boolean = false,
)

/** PUT /kiosk/rolodex/workers/{person_id}/photo. */
@Serializable data class RolodexPhotoOut(val photo_url: String? = null, val photo_version: String? = null)
