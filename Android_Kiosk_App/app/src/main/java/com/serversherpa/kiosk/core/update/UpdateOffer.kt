package com.serversherpa.kiosk.core.update

/** A newer build the Devices site is offering: [installUrl] is the one-time download link. */
data class UpdateOffer(
    val versionName: String,
    val build: Long,
    val notes: String?,
    val size: Long?,
    val installUrl: String,
)
