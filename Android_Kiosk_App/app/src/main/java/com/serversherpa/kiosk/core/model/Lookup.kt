package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

// The /kiosk/assets/* Asset Lookup payloads, snake_case as the API sends them.

/** One candidate in GET /kiosk/assets/lookup. [matched] names the fields the query hit. */
@Serializable
data class KioskLookupMatch(
    val id: String,
    val name: String? = null,
    val asset_tag: String = "",
    val serial_number: String? = null,
    val matched: List<String> = emptyList(),
)

/** GET /kiosk/assets/lookup. [truncated] is true when more assets matched than were returned. */
@Serializable
data class KioskLookupResult(
    val matches: List<KioskLookupMatch> = emptyList(),
    val truncated: Boolean = false,
)

/** One end (source or destination) of an asset's route. */
@Serializable
data class KioskAssetEnd(
    val site_name: String? = null,
    val pod: String? = null,
    val rack: String? = null,
    val ru: String? = null,
    val position: String? = null,
)

@Serializable
data class KioskAssetRoute(
    val initiative_id: String,
    val initiative_name: String,
    val source: KioskAssetEnd,
    val destination: KioskAssetEnd,
)

@Serializable
data class KioskAssetMove(
    val initiative_id: String,
    val initiative_name: String,
    val status: String = "",
    val status_label: String = "",
    val status_color: String = "",
)

/** The admin-only part of the asset card; null in [KioskAssetDetail.full] for other users. */
@Serializable
data class KioskAssetFull(
    val status: String = "",
    val status_label: String = "",
    val status_color: String = "",
    val moves: List<KioskAssetMove> = emptyList(),
    val container_name: String? = null,
    val truck_name: String? = null,
    val location_detail: String = "",
)

/** GET /kiosk/assets/{id}. */
@Serializable
data class KioskAssetDetail(
    val id: String,
    val name: String? = null,
    val make: String? = null,
    val model: String? = null,
    val make_model: String = "",
    val asset_tag: String = "",
    val serial_number: String? = null,
    val rfid: String? = null,
    val routes: List<KioskAssetRoute> = emptyList(),
    val full: KioskAssetFull? = null,
)

/** One row of GET /kiosk/assets/{id}/scans. */
@Serializable
data class AssetScanRow(
    val id: String,
    val scanned_value: String = "",
    val scan_type: String = "",
    val scan_type_label: String = "",
    val scan_type_color: String = "",
    val status: String? = null,
    val status_label: String? = null,
    val status_color: String? = null,
    val scanned_at: String,
    val device_id: String = "",
    val operator_name: String? = null,
    val site_name: String? = null,
    val location_detail: String = "",
    val off_move: Boolean = false,
)
