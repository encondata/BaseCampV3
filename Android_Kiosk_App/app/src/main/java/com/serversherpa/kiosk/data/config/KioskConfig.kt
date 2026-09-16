package com.serversherpa.kiosk.data.config

import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** Runtime configuration: the stored URL wins, else the build default.
 *  Read per call — never cached at construction. */
class KioskConfig(
    private val prefs: KioskPrefs,
    private val defaultApiUrl: String,
    private val defaultPortalUrl: String,
    val kioskVersion: String,
) {
    val apiUrl: Flow<String> = prefs.apiUrl.map { normalizeUrl(it ?: "") ?: defaultApiUrl }
    val portalUrl: Flow<String> = prefs.portalUrl.map { normalizeUrl(it ?: "") ?: defaultPortalUrl }

    suspend fun apiUrlNow(): String = apiUrl.first()
    suspend fun portalUrlNow(): String = portalUrl.first()

    companion object {
        /** Trimmed, trailing slashes removed; only http(s) origins are accepted. */
        fun normalizeUrl(raw: String): String? {
            val v = raw.trim().trimEnd('/')
            if (v.isEmpty()) return null
            if (!v.startsWith("http://") && !v.startsWith("https://")) return null
            if (v.substringAfter("://").isEmpty()) return null
            return v
        }
    }
}
