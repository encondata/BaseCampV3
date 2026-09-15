package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskScanIn(
    val client_scan_id: String,
    val scanned_value: String,
    val scan_type: String,
    val scanned_at: String,
    val asset_id: String? = null,
    val site_id: String? = null,
    val initiative_id: String? = null,
    val scan_status: String? = null,
)

@Serializable data class KioskScanBatchIn(val serial: String, val scans: List<KioskScanIn>)

@Serializable data class KioskScanRejected(val client_scan_id: String, val code: String)

@Serializable
data class KioskScanBatchOut(val accepted: List<String> = emptyList(), val rejected: List<KioskScanRejected> = emptyList())

@Serializable
data class KioskRfidEnrollIn(
    val serial: String,
    val rfid_tag: String,
    val scan_status: String,
    val client_scan_id: String,
    val site_id: String? = null,
    val initiative_id: String? = null,
)

@Serializable
data class KioskRfidEnroll(
    val asset_id: String,
    val asset_name: String? = null,
    val asset_tag: String = "",
    val serial_number: String? = null,
    val rfid_tag: String,
    val already_had_tag: Boolean = false,
)
