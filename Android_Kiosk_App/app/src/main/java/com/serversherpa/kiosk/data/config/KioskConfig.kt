package com.serversherpa.kiosk.data.config

import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.environment.apiUrl
import com.serversherpa.kiosk.core.environment.portalUrl
import com.serversherpa.kiosk.data.environment.EnvironmentStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** Runtime configuration: the saved environment's addresses, else the build's default
 *  environment's. Read per call — never cached at construction. */
class KioskConfig(
    store: EnvironmentStore,
    defaultEnvironment: SavedEnvironment,
    val kioskVersion: String,
) {
    /** The environment this kiosk connects to. A later environment list never changes it. */
    val environment: Flow<SavedEnvironment> = store.current(defaultEnvironment)
    val apiUrl: Flow<String> = environment.map { it.apiUrl }
    val portalUrl: Flow<String> = environment.map { it.portalUrl }

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
