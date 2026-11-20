package com.serversherpa.kiosk.data.api

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshCookieJarTest {
    private val api = "https://api.dev.serversherpa.com/auth/login".toHttpUrl()

    @Test fun persistsOnlyTheRefreshCookieAndSendsItToItsHost() {
        val secrets = MemorySecretStore()
        val jar = RefreshCookieJar(secrets)
        val refresh = Cookie.parse(api, "ss_refresh=abc; Path=/auth; HttpOnly; Secure")!!
        val other = Cookie.parse(api, "csrftoken=zzz; Path=/")!!
        jar.saveFromResponse(api, listOf(refresh, other))

        // A fresh jar over the same secrets still has the refresh cookie (persisted) but not the other one.
        val reloaded = RefreshCookieJar(secrets)
        val forRefresh = reloaded.loadForRequest("https://api.dev.serversherpa.com/auth/refresh".toHttpUrl())
        assertEquals(listOf("ss_refresh"), forRefresh.map { it.name })
        assertEquals("abc", forRefresh.single().value)
        // Path /auth: not sent to /kiosk/heartbeat.
        assertTrue(reloaded.loadForRequest("https://api.dev.serversherpa.com/kiosk/heartbeat".toHttpUrl()).isEmpty())
        // Other host: not sent.
        assertTrue(reloaded.loadForRequest("https://api.serversherpa.com/auth/refresh".toHttpUrl()).isEmpty())
    }

    @Test fun clearForgetsIt() {
        val jar = RefreshCookieJar(MemorySecretStore())
        jar.saveFromResponse(api, listOf(Cookie.parse(api, "ss_refresh=abc; Path=/auth")!!))
        jar.clearRefreshCookie()
        assertTrue(jar.loadForRequest("https://api.dev.serversherpa.com/auth/refresh".toHttpUrl()).isEmpty())
    }

    /** An environment switch: every stored refresh cookie goes, including one from a host this
     *  process never talked to (an earlier launch's server). Other secrets stay. */
    @Test fun clearAllForgetsEveryHostsRefreshCookie() {
        val secrets = MemorySecretStore()
        secrets.put("cookie|api.old.serversherpa.com|ss_refresh", "{}")
        secrets.put("station_key", "kept")
        val jar = RefreshCookieJar(secrets)
        jar.saveFromResponse(api, listOf(Cookie.parse(api, "ss_refresh=abc; Path=/auth")!!, Cookie.parse(api, "csrftoken=zzz; Path=/")!!))

        jar.clearAllRefreshCookies()

        assertEquals(setOf("station_key"), secrets.keys())
        assertTrue(jar.loadForRequest("https://api.dev.serversherpa.com/auth/refresh".toHttpUrl()).isEmpty())
    }
}
