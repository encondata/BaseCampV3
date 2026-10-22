package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskAssetRow(
    val id: String,
    val asset_id: String = "",
    val name: String? = null,
    val rfid: String? = null,
    val serial_number: String? = null,
    val make: String? = null,
    val model: String? = null,
    val make_model: String = "",
    val container_id: String? = null,
    val label: Map<String, String> = emptyMap(),
)

@Serializable
data class KioskAssetsSync(
    val initiative_id: String, val initiative_name: String, val generated_at: String,
    val assets: List<KioskAssetRow> = emptyList(),
)

@Serializable
data class KioskPersonRow(
    val id: String,
    val display_name: String,
    val first_name: String = "",
    val last_name: String = "",
    val preferred_name: String? = null,
    val rfid_tag: String? = null,
    val is_worker: Boolean = false,
    val has_account: Boolean = false,
    /** What a printed badge's QR code carries. */
    val badge_uid: String? = null,
    val job_title: String? = null,
    /** Shown as "Employee ID". */
    val external_id: String? = null,
)

@Serializable data class KioskPeopleSync(val generated_at: String, val people: List<KioskPersonRow> = emptyList())

@Serializable
data class KioskContainerRow(
    val id: String, val name: String, val rfid_tag: String? = null, val label_tag: String? = null,
    val container_type: String? = null, val status: String = "", val status_label: String = "",
    val site_id: String? = null, val site_name: String? = null, val asset_count: Int = 0,
)

@Serializable
data class KioskContainersSync(
    val initiative_id: String, val generated_at: String, val containers: List<KioskContainerRow> = emptyList(),
)

@Serializable
data class KioskTruckRow(
    val id: String, val name: String, val load_number: String? = null, val status: String = "",
    val status_label: String = "", val driver_name: String? = null,
    val start_site_id: String? = null, val start_site_name: String? = null,
    val end_site_id: String? = null, val end_site_name: String? = null, val container_count: Int = 0,
)

@Serializable
data class KioskTrucksSync(val initiative_id: String, val generated_at: String, val trucks: List<KioskTruckRow> = emptyList())

/** GET /kiosk/labels/fonts: a library font the move's label templates use. `size` is in bytes;
 *  a `resident` font is built into the printer and is never downloaded or installed. */
@Serializable
data class KioskLabelFont(val id: String, val name: String, val size: Int, val resident: Boolean = false)

/** `missing`: font names the templates reference that the library lacks. */
@Serializable
data class KioskLabelFonts(val fonts: List<KioskLabelFont> = emptyList(), val missing: List<String> = emptyList())
