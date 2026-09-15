package com.serversherpa.kiosk.data.api

import kotlinx.serialization.Serializable
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

const val REFRESH_COOKIE = "ss_refresh"

@Serializable
private data class StoredCookie(
    val name: String, val value: String, val expiresAt: Long, val domain: String, val path: String,
    val secure: Boolean, val httpOnly: Boolean, val hostOnly: Boolean,
) {
    fun toCookie(): Cookie = Cookie.Builder().name(name).value(value).expiresAt(expiresAt).path(path)
        .let { if (hostOnly) it.hostOnlyDomain(domain) else it.domain(domain) }
        .let { if (secure) it.secure() else it }
        .let { if (httpOnly) it.httpOnly() else it }
        .build()

    companion object {
        fun of(c: Cookie) = StoredCookie(c.name, c.value, c.expiresAt, c.domain, c.path, c.secure, c.httpOnly, c.hostOnly)
    }
}

/**
 * The web kiosk lets the browser hold `ss_refresh`; here the jar holds
 * it, encrypted at rest, keyed by the API host. Every other cookie stays
 * in memory for the process only.
 */
class RefreshCookieJar(private val secrets: SecretStore) : CookieJar {
    private val memory = HashMap<String, Cookie>()      // "$domain|$name" -> cookie (non-refresh cookies)
    private val hosts = HashSet<String>()               // every host we stored or were asked about

    private fun refreshKey(domain: String) = "cookie|$domain|$REFRESH_COOKIE"

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) {
            if (c.name == REFRESH_COOKIE) {
                hosts.add(c.domain)
                secrets.put(refreshKey(c.domain), KioskJson.encodeToString(StoredCookie.serializer(), StoredCookie.of(c)))
            } else {
                memory["${c.domain}|${c.name}"] = c
            }
        }
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        hosts.add(url.host)
        val out = ArrayList<Cookie>()
        secrets.get(refreshKey(url.host))?.let { raw ->
            val c = try { KioskJson.decodeFromString(StoredCookie.serializer(), raw).toCookie() } catch (e: Exception) { null }
            if (c != null && c.matches(url) && c.expiresAt > System.currentTimeMillis()) out.add(c)
        }
        for (c in memory.values) if (c.matches(url) && c.expiresAt > System.currentTimeMillis()) out.add(c)
        return out
    }

    /** Forgets the refresh cookie for every host this jar has seen (logout / session ended). */
    @Synchronized
    fun clearRefreshCookie() {
        hosts.forEach { secrets.remove(refreshKey(it)) }
        memory.clear()
    }
}
