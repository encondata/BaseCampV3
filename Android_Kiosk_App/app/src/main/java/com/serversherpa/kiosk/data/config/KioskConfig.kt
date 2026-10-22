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
        /** "scheme://host:port" of an http(s) URL, lower-cased, with the default port spelled
         *  out, so "https://Api.example" and "https://api.example:443/v1" match; null when it
         *  isn't one. What a Time Clock station key is bound to. */
        fun originOf(url: String): String? {
            val uri = try { java.net.URI(url.trim()) } catch (e: Exception) { return null }
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            val port = when {
                uri.port != -1 -> uri.port
                scheme == "https" -> 443
                scheme == "http" -> 80
                else -> return null
            }
            return "$scheme://$host:$port"
        }

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
