package com.serversherpa.kiosk.data.api

import kotlinx.serialization.json.Json

/** One Json for the whole app: tolerant on decode, snake_case as declared. */
val KioskJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}
