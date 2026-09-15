package com.serversherpa.kiosk.core

import kotlinx.serialization.json.JsonElement

/** A non-2xx answer (`code` from the body's `detail.code`, else
 *  `unknown_error`) or a transport failure (`status` 0, code `network`). */
class ApiError(val status: Int, val code: String, val detail: JsonElement? = null) : Exception(code) {
    val isNetwork: Boolean get() = status == 0
    /** `detail.<key>` when the detail is an object with a string there. */
    fun detailString(key: String): String? =
        (detail as? kotlinx.serialization.json.JsonObject)?.get(key)
            ?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.takeIf { it.isString }?.content
}
