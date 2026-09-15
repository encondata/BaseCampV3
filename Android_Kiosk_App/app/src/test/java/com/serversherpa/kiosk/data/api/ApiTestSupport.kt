package com.serversherpa.kiosk.data.api

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/** One MockWebServer + a config pointed at it + a client with the cookie jar. */
class ApiHarness(tmpDir: File) : AutoCloseable {
    val server = MockWebServer().also { it.start() }
    val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmpDir, "t.preferences_pb") })
    val config = KioskConfig(prefs, "https://unused.example", "https://portal.unused.example", "0.1.0").also {
        runBlocking { prefs.setApiUrl(server.url("/").toString().trimEnd('/')) }
    }
    val secrets = MemorySecretStore()
    val cookieJar = RefreshCookieJar(secrets)
    val client: OkHttpClient = OkHttpClient.Builder().cookieJar(cookieJar).build()
    var now = 1_000_000L
    val session = SessionStore(client, config, scope, clock = { now })
    val api = OkHttpKioskApi(client, config, session)

    override fun close() { server.shutdown(); scope.cancel() }
}

const val SESSION_JSON = """{"access_token":"tok1","token_type":"bearer","expires_in":900,"session_expires_at":"2026-09-16T00:00:00Z",
 "person":{"id":"p1","first_name":"Tina","last_name":"T","preferred_name":null,"display_name":"Tina T","email":null,"job_title":null,"avatar_key":null},
 "roles":["worker"],"must_change_password":false,"preferences":{"accent":"amber","theme":"light"},
 "perms":{"kiosk":{"view":true}},"max_rank":20,"scope":{"global":true,"client_ids":[],"partner_ids":[]},"password_min_length":8}"""

fun sessionResponse(cookie: String? = "ss_refresh=r1; Path=/auth; HttpOnly", token: String = "tok1"): MockResponse =
    MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
        .setBody(SESSION_JSON.replace("tok1", token)).also { if (cookie != null) it.addHeader("Set-Cookie", cookie) }

fun jsonResponse(code: Int, body: String): MockResponse =
    MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
