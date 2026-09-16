# Android Kiosk Implementation Plan — Part 2 of 4: Data and Input

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part 1 (`2026-09-15-android-kiosk-1-foundation.md`) must be complete first; its Global Constraints apply here verbatim.

**Goal:** The kiosk's plumbing: an OkHttp API client that mirrors `kiosk/src/lib/api.ts` (session rules included), auth state and the heartbeat, the Room database with the sync transaction, the Room-backed outbox sender, and the three scan-input sources (keyboard bus, DataWedge, camera).

**Architecture:** `data/api` owns HTTP: `SessionStore` (access token + single-flight refresh + persisted `ss_refresh` cookie), `KioskApi` (an interface so screens and tests can fake it) and `OkHttpKioskApi`. `data/auth` turns sessions into `AuthState`; `data/heartbeat` reports the kiosk while signed in and in the foreground. `data/db` + `data/sync` + `data/outbox` are the local move copy and the scan queue. `input/` publishes `ScanEvent`s onto one `ScanBus` from any source.

**Tech Stack:** OkHttp 4.12 + MockWebServer, kotlinx.serialization, Room 2.6.1 (KSP), DataStore, kotlinx.coroutines (+ `kotlinx-coroutines-test` virtual time), CameraX 1.4.2, ML Kit barcode 17.3.0, Robolectric.

**Spec:** `docs/superpowers/specs/2026-09-15-android-kiosk-design.md` (sections "Transport", "Auth", "Heartbeat", "Local database", "Sync", "Outbox", "Scan input pipeline"). Reference implementation: `kiosk/src/lib/{api,heartbeat,sync,localDb,outbox}.ts`, `kiosk/src/auth/KioskAuthContext.tsx`.

## Global Constraints (in addition to Part 1's)

- `KioskApi` is an interface; every screen and every test depends on the interface, never on `OkHttpKioskApi`.
- Network calls run on `Dispatchers.IO`; nothing in `data/` touches the main thread.
- Plain JVM tests (no Robolectric) for everything that does not need an Android `Context`; Robolectric only for Room and DataWedge.
- One deviation from the spec's file list: there is no `AuthInterceptor.kt`. The 401 → refresh → retry rule lives in `OkHttpKioskApi.authed()`, which is what `apiFetch` in `api.ts` does and is far easier to test. Record this in the spec's implementation notes in Part 3's last task.

---

### Task 9: API transport — JSON, secret store, cookie jar, session store, and the auth/pairing/heartbeat endpoints

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/data/api/KioskJson.kt`, `SecretStore.kt`, `RefreshCookieJar.kt`, `SessionStore.kt`, `KioskApi.kt`, `OkHttpKioskApi.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/data/api/ApiTestSupport.kt`, `RefreshCookieJarTest.kt`, `SessionStoreTest.kt`, `OkHttpKioskApiAuthTest.kt`

**Interfaces:**
- Consumes: `KioskConfig`, `KioskPrefs` (Part 1 Task 8), the `core/model` classes, `ApiError`.
- Produces:
  - `val KioskJson: Json`
  - `interface SecretStore { fun get(key: String): String?; fun put(key: String, value: String); fun remove(key: String) }`, `class MemorySecretStore : SecretStore`, `class AndroidSecretStore(context: Context) : SecretStore`
  - `class RefreshCookieJar(secrets: SecretStore) : CookieJar`, `const val REFRESH_COOKIE = "ss_refresh"`, `fun clearRefreshCookie()`
  - `interface SessionRefresher { suspend fun refresh(): SessionData?; val sessionEnded: SharedFlow<Unit>; fun clear(); fun store(data: SessionData) }`
  - `class SessionStore(client: OkHttpClient, config: KioskConfig, scope: CoroutineScope, clock: () -> Long) : SessionRefresher` with `fun accessToken(): String?`, `fun tokenIsStale(): Boolean`, `fun sessionExpiresAt(): String?`, `fun notifySessionEnded()`
  - `interface KioskApi` (this task's members): `suspend fun login(email, password): SessionData`, `suspend fun logout()`, `suspend fun systemStatus(): SystemStatus`, `suspend fun createPairRequest(serial, name): PairCreated`, `suspend fun pollPair(code, pollToken): PairPoll`, `suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult`, `suspend fun signOut(serial)` (never throws)
  - `class OkHttpKioskApi(client, config, session: SessionStore) : KioskApi`

- [ ] **Step 1: Test support (MockWebServer + real DataStore-backed config)**

`app/src/test/java/com/serversherpa/kiosk/data/api/ApiTestSupport.kt`:

```kotlin
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
```

- [ ] **Step 2: Tests first**

`RefreshCookieJarTest.kt`:

```kotlin
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
}
```

`SessionStoreTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.api

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun refreshStoresTokenAndSendsTheCookie() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())                     // login sets the cookie
            h.api.login("a@b.c", "pw")
            h.server.enqueue(sessionResponse(cookie = null, token = "tok2"))
            val data = h.session.refresh()
            assertEquals("tok2", data?.access_token)
            assertEquals("tok2", h.session.accessToken())
            assertFalse(h.session.tokenIsStale())
            h.server.takeRequest()
            val refreshReq = h.server.takeRequest()
            assertEquals("/auth/refresh", refreshReq.path)
            assertEquals("POST", refreshReq.method)
            assertTrue(refreshReq.getHeader("Cookie")!!.contains("ss_refresh=r1"))
        }
    }

    @Test fun staleWithin30sOfExpiry() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            h.api.login("a@b.c", "pw")
            h.now += 900_000 - 31_000
            assertFalse(h.session.tokenIsStale())
            h.now += 2_000
            assertTrue(h.session.tokenIsStale())
        }
    }

    @Test fun failedRefreshClearsButNetworkErrorKeepsState() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            h.api.login("a@b.c", "pw")
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"invalid_token"}}"""))
            assertNull(h.session.refresh())
            assertNull(h.session.accessToken())
            h.server.enqueue(sessionResponse(cookie = null, token = "tok3")); h.session.refresh()
            h.server.shutdown()
            assertNull(h.session.refresh())
            assertEquals("tok3", h.session.accessToken())   // kept on a network hiccup
        }
    }

    @Test fun refreshIsSingleFlight() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse(cookie = null, token = "slow").setBodyDelay(300, TimeUnit.MILLISECONDS))
            val results = (1..5).map { async { h.session.refresh() } }.awaitAll()
            assertTrue(results.all { it?.access_token == "slow" })
            assertEquals(1, h.server.requestCount)
        }
    }
}
```

`OkHttpKioskApiAuthTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.PairStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OkHttpKioskApiAuthTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun loginSendsClientKioskAndStoresSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            val s = h.api.login("a@b.c", "pw")
            assertEquals("tok1", s.access_token)
            val req = h.server.takeRequest()
            assertEquals("/auth/login", req.path)
            assertTrue(req.body.readUtf8().contains("\"client\":\"kiosk\""))
            assertEquals("tok1", h.session.accessToken())
        }
    }

    @Test fun errorCodesComeFromDetail() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(403, """{"detail":{"code":"kiosk_not_allowed"}}"""))
            try { h.api.login("a@b.c", "pw"); fail("expected ApiError") } catch (e: ApiError) {
                assertEquals(403, e.status); assertEquals("kiosk_not_allowed", e.code)
            }
            h.server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
            try { h.api.login("a@b.c", "pw"); fail() } catch (e: ApiError) { assertEquals("unknown_error", e.code) }
        }
    }

    @Test fun networkFailureIsApiErrorNetwork() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.shutdown()
            try { h.api.systemStatus(); fail() } catch (e: ApiError) { assertEquals(0, e.status); assertEquals("network", e.code) }
        }
    }

    @Test fun authedCallRefreshesOnceOn401AndRetries() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw")
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"token_expired"}}"""))
            h.server.enqueue(sessionResponse(cookie = null, token = "tok2"))
            h.server.enqueue(jsonResponse(200, """{"device_id":"d1","name":"Kiosk","registration":"ok","token_expires_at":null}"""))
            val r = h.api.heartbeat(HeartbeatIn(serial = "s", name = "Kiosk"))
            assertEquals("ok", r.registration)
            h.server.takeRequest()
            assertEquals("Bearer tok1", h.server.takeRequest().getHeader("Authorization"))
            assertEquals("/auth/refresh", h.server.takeRequest().path)
            assertEquals("Bearer tok2", h.server.takeRequest().getHeader("Authorization"))
        }
    }

    @Test fun secondFailureEndsTheSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse()); h.api.login("a@b.c", "pw")
            var ended = false
            val collector = launch { h.session.sessionEnded.first(); ended = true }
            kotlinx.coroutines.yield()   // let the collector subscribe before the emit
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"token_expired"}}"""))
            h.server.enqueue(jsonResponse(401, """{"detail":{"code":"invalid_token"}}"""))   // refresh fails
            try { h.api.heartbeat(HeartbeatIn(serial = "s", name = "Kiosk")); fail() } catch (e: ApiError) { assertEquals(401, e.status) }
            collector.join()
            assertTrue(ended)
        }
    }

    @Test fun pairPollMapsStatusesAnd404ToExpired() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(200, """{"status":"pending","session":null}"""))
            assertEquals(PairStatus.PENDING, h.api.pollPair("ABCD1234", "pt").status)
            h.server.enqueue(sessionResponse().setBody("""{"status":"approved","session":$SESSION_JSON}"""))
            val approved = h.api.pollPair("ABCD1234", "pt")
            assertEquals(PairStatus.APPROVED, approved.status)
            assertEquals("tok1", h.session.accessToken())
            h.server.enqueue(jsonResponse(404, """{"detail":{"code":"not_found"}}"""))
            assertEquals(PairStatus.EXPIRED, h.api.pollPair("ABCD1234", "pt").status)
        }
    }

    @Test fun signOutNeverThrows() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.shutdown()
            h.api.signOut("serial")   // no exception
        }
    }
}
```

Run: `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.api.*'` → FAIL (unresolved).

- [ ] **Step 3: Implement**

`KioskJson.kt`:

```kotlin
package com.serversherpa.kiosk.data.api

import kotlinx.serialization.json.Json

/** One Json for the whole app: tolerant on decode, snake_case as declared. */
val KioskJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}
```

`SecretStore.kt`:

```kotlin
package com.serversherpa.kiosk.data.api

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Where the refresh cookie lives at rest. */
interface SecretStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

class MemorySecretStore : SecretStore {
    private val map = HashMap<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
}

/** EncryptedSharedPreferences "kiosk_session" under an Android Keystore master key. */
class AndroidSecretStore(context: Context) : SecretStore {
    private val prefs = EncryptedSharedPreferences.create(
        context, "kiosk_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
}
```

`RefreshCookieJar.kt`:

```kotlin
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
```

`SessionStore.kt`:

```kotlin
package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.data.config.KioskConfig
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

interface SessionRefresher {
    suspend fun refresh(): SessionData?
    val sessionEnded: SharedFlow<Unit>
    fun clear()
    fun store(data: SessionData)
}

/**
 * The portal's session rules, restated (see kiosk/src/lib/api.ts):
 * access token in memory only; the refresh token is the httpOnly cookie
 * the jar holds; refresh is single-flight; a non-OK refresh clears local
 * state, a network failure keeps it.
 */
class SessionStore(
    private val client: OkHttpClient,
    private val config: KioskConfig,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) : SessionRefresher {
    @Volatile private var accessToken: String? = null
    @Volatile private var accessTokenExpiresAt = 0L
    @Volatile private var sessionExpiresAt: String? = null

    private val mutex = Mutex()
    private var inFlight: Deferred<SessionData?>? = null

    private val _sessionEnded = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    override val sessionEnded: SharedFlow<Unit> = _sessionEnded

    fun accessToken(): String? = accessToken
    fun sessionExpiresAt(): String? = sessionExpiresAt
    fun tokenIsStale(): Boolean = accessToken == null || clock() > accessTokenExpiresAt - 30_000

    override fun store(data: SessionData) {
        accessToken = data.access_token
        accessTokenExpiresAt = clock() + data.expires_in * 1000L
        sessionExpiresAt = data.session_expires_at
    }

    override fun clear() {
        accessToken = null; accessTokenExpiresAt = 0L; sessionExpiresAt = null
    }

    fun notifySessionEnded() {
        clear()
        _sessionEnded.tryEmit(Unit)
    }

    override suspend fun refresh(): SessionData? {
        val job = mutex.withLock {
            inFlight ?: scope.async { doRefresh() }.also { inFlight = it }
        }
        return try { job.await() } finally { mutex.withLock { if (inFlight === job) inFlight = null } }
    }

    private suspend fun doRefresh(): SessionData? = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("${config.apiUrlNow()}/auth/refresh").post(ByteArray(0).toRequestBody(null)).build()
        try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) { clear(); return@withContext null }
                val data = KioskJson.decodeFromString(SessionData.serializer(), resp.body!!.string())
                store(data)
                data
            }
        } catch (e: IOException) {
            null   // network hiccup: keep local state
        }
    }
}
```

`KioskApi.kt` (the interface grows in Task 10; write these members now):

```kotlin
package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.model.SystemStatus

/** Every endpoint the kiosk calls — kiosk/src/lib/api.ts, function for function.
 *  Implementations throw ApiError on any non-2xx or transport failure
 *  unless a member says otherwise. */
interface KioskApi {
    suspend fun login(email: String, password: String): SessionData
    suspend fun logout()
    suspend fun systemStatus(): SystemStatus
    suspend fun createPairRequest(serial: String, name: String): PairCreated
    /** 404 reads as EXPIRED; an approved answer stores the session. */
    suspend fun pollPair(code: String, pollToken: String): PairPoll
    suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult
    /** Never throws — the kiosk is dropping its own token either way. */
    suspend fun signOut(serial: String)
}
```

`OkHttpKioskApi.kt`:

```kotlin
package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.model.KioskSignOutIn
import com.serversherpa.kiosk.core.model.LoginIn
import com.serversherpa.kiosk.core.model.PairCreateIn
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.PairPollIn
import com.serversherpa.kiosk.core.model.PairPollOut
import com.serversherpa.kiosk.core.model.PairStatus
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.model.SystemStatus
import com.serversherpa.kiosk.data.config.KioskConfig
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

class OkHttpKioskApi(
    private val client: OkHttpClient,
    private val config: KioskConfig,
    private val session: SessionStore,
) : KioskApi {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    // ── plumbing ────────────────────────────────────────────────────

    private fun <T> jsonBody(strategy: SerializationStrategy<T>, value: T): RequestBody =
        KioskJson.encodeToString(strategy, value).toRequestBody(jsonType)

    private val emptyBody: RequestBody = ByteArray(0).toRequestBody(null)

    private suspend fun execute(request: Request): Response = withContext(Dispatchers.IO) {
        try { client.newCall(request).execute() } catch (e: IOException) { throw ApiError(0, "network") }
    }

    private suspend fun url(path: String): String = config.apiUrlNow() + path

    /** Non-2xx → ApiError with detail.code (else unknown_error). Consumes the response. */
    private fun errorFrom(resp: Response): ApiError {
        val text = try { resp.body?.string() } catch (e: Exception) { null }
        var code = "unknown_error"
        var detail: kotlinx.serialization.json.JsonElement? = null
        if (!text.isNullOrBlank()) {
            try {
                val obj = KioskJson.parseToJsonElement(text).jsonObject
                detail = obj["detail"]
                code = (detail as? JsonObject)?.get("code")?.jsonPrimitive?.content ?: code
            } catch (e: Exception) { /* non-JSON body */ }
        }
        return ApiError(resp.code, code, detail)
    }

    private fun <T> parse(resp: Response, strategy: DeserializationStrategy<T>): T = resp.use {
        if (!it.isSuccessful) throw errorFrom(it)
        KioskJson.decodeFromString(strategy, it.body!!.string())
    }

    /** Unauthenticated call. `configure` runs on a fresh builder each time. */
    private suspend fun plain(configure: suspend Request.Builder.() -> Request.Builder): Response =
        execute(Request.Builder().configure().build())

    /** Authenticated call: refresh when stale, bearer header, one refresh + one retry on 401. */
    internal suspend fun authed(configure: suspend Request.Builder.() -> Request.Builder): Response {
        if (session.tokenIsStale()) session.refresh()
        suspend fun go(): Response {
            val b = Request.Builder().configure()
            session.accessToken()?.let { b.header("Authorization", "Bearer $it") }
            return execute(b.build())
        }
        var resp = go()
        if (resp.code == 401) {
            resp.close()
            val refreshed = session.refresh()
            if (refreshed != null) resp = go()
            if (refreshed == null || resp.code == 401) session.notifySessionEnded()
        }
        return resp
    }

    // ── auth ────────────────────────────────────────────────────────

    override suspend fun login(email: String, password: String): SessionData {
        val resp = plain { url(url("/auth/login")).post(jsonBody(LoginIn.serializer(), LoginIn(email, password))) }
        return parse(resp, SessionData.serializer()).also { session.store(it) }
    }

    override suspend fun logout() {
        try { plain { url(url("/auth/logout")).post(emptyBody) }.close() } catch (e: ApiError) { /* offline logout still clears */ }
        finally { session.clear() }
    }

    override suspend fun systemStatus(): SystemStatus =
        parse(plain { url(url("/system/status")).get() }, SystemStatus.serializer())

    // ── pairing ─────────────────────────────────────────────────────

    override suspend fun createPairRequest(serial: String, name: String): PairCreated =
        parse(plain { url(url("/kiosk/pair")).post(jsonBody(PairCreateIn.serializer(), PairCreateIn(serial, name))) }, PairCreated.serializer())

    override suspend fun pollPair(code: String, pollToken: String): PairPoll {
        val resp = plain { url(url("/kiosk/pair/$code/poll")).post(jsonBody(PairPollIn.serializer(), PairPollIn(pollToken))) }
        if (resp.code == 404) { resp.close(); return PairPoll(PairStatus.EXPIRED, null) }
        val out = parse(resp, PairPollOut.serializer())
        val status = PairStatus.fromWire(out.status)
        if (status == PairStatus.APPROVED && out.session != null) session.store(out.session)
        return PairPoll(status, out.session)
    }

    // ── heartbeat ───────────────────────────────────────────────────

    override suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult =
        parse(authed { url(url("/kiosk/heartbeat")).post(jsonBody(HeartbeatIn.serializer(), body)) }, HeartbeatResult.serializer())

    override suspend fun signOut(serial: String) {
        try {
            authed { url(url("/kiosk/sign-out")).post(jsonBody(KioskSignOutIn.serializer(), KioskSignOutIn(serial))) }.close()
        } catch (e: ApiError) { /* ignore */ }
    }
}
```

- [ ] **Step 4: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.api.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): OkHttp API transport with persisted refresh cookie, single-flight refresh, and 401 retry; auth/pairing/heartbeat endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The remaining endpoints (setup, sync, scans, RFID enroll, timeclock)

**Files:**
- Modify: `data/api/KioskApi.kt`, `data/api/OkHttpKioskApi.kt`
- Test: `data/api/OkHttpKioskApiEndpointsTest.kt`

**Interfaces:**
- Produces on `KioskApi`: `suspend fun setupOptions(): SetupOptions`, `suspend fun submitSetup(body: KioskSetupIn): KioskSetupResult`, `suspend fun syncAssets(initiativeId): KioskAssetsSync`, `suspend fun syncPeople(): KioskPeopleSync`, `suspend fun syncContainers(initiativeId): KioskContainersSync`, `suspend fun syncTrucks(initiativeId): KioskTrucksSync`, `suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut`, `suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn): KioskRfidEnroll`, `suspend fun timeclockStatus(personId): KioskTimeclockStatus`, `suspend fun clockIn(body: ClockInIn): KioskTimeclockStatus`, `suspend fun clockOut(body: ClockOutIn): KioskTimeclockStatus`.

- [ ] **Step 1: Tests first**

```kotlin
package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanIn
import com.serversherpa.kiosk.core.model.KioskSetupIn
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OkHttpKioskApiEndpointsTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun ApiHarness.signIn() { server.enqueue(sessionResponse()); runBlocking { api.login("a@b.c", "pw") }; server.takeRequest() }

    @Test fun setupOptionsAndSubmit() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"initiatives":[{"id":"i1","name":"Move A","status":"in_progress","status_label":"In progress","client_name":"Acme",
              "scheduled_start":"2026-09-20T00:00:00Z","scheduled_end":null,"source_site":{"id":"s1","name":"Origin"},"destination_site":null}],
              "scan_types":[{"key":"pre_stage","label":"Pre-stage","color":"#abc"}]}"""))
            val opts = h.api.setupOptions()
            assertEquals("Move A", opts.initiatives[0].name); assertEquals("Origin", opts.initiatives[0].source_site?.name)
            assertEquals("/kiosk/setup-options", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"device_id":"d","initiative_id":"i1","initiative_name":"Move A","site_id":"s1","site_name":"Origin","site_role":"source","scan_status":"pre_stage","scan_status_label":"Pre-stage"}"""))
            val res = h.api.submitSetup(KioskSetupIn("serial", "i1", "s1", "pre_stage"))
            assertEquals("source", res.site_role)
            val req = h.server.takeRequest(); assertEquals("/kiosk/setup", req.path); assertTrue(req.body.readUtf8().contains("\"scan_status\":\"pre_stage\""))
        }
    }

    @Test fun syncEndpointsEncodeTheInitiative() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"initiative_id":"i 1","initiative_name":"M","generated_at":"2026-09-15T00:00:00Z","assets":[{"id":"a","asset_id":"A-1","make_model":"X","label":{}}]}"""))
            assertEquals(1, h.api.syncAssets("i 1").assets.size)
            assertEquals("/kiosk/sync/assets?initiative_id=i%201", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"generated_at":"2026-09-15T00:00:00Z","people":[{"id":"p","display_name":"T","first_name":"T","last_name":"T","is_worker":true,"has_account":false}]}"""))
            assertEquals("T", h.api.syncPeople().people[0].display_name)
            assertEquals("/kiosk/sync/people", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"initiative_id":"i1","generated_at":"x","containers":[]}"""))
            assertEquals(0, h.api.syncContainers("i1").containers.size)
            assertEquals("/kiosk/sync/containers?initiative_id=i1", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"initiative_id":"i1","generated_at":"x","trucks":[]}"""))
            assertEquals(0, h.api.syncTrucks("i1").trucks.size)
            assertEquals("/kiosk/sync/trucks?initiative_id=i1", h.server.takeRequest().path)
        }
    }

    @Test fun scansRfidAndTimeclock() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.signIn()
            h.server.enqueue(jsonResponse(200, """{"accepted":["c1"],"rejected":[{"client_scan_id":"c2","code":"bad_site"}]}"""))
            val out = h.api.postScans(KioskScanBatchIn("serial", listOf(KioskScanIn("c1", "A-1", "barcode", "2026-09-15T00:00:00Z"))))
            assertEquals(listOf("c1"), out.accepted); assertEquals("bad_site", out.rejected[0].code)
            assertEquals("/kiosk/scans", h.server.takeRequest().path)

            h.server.enqueue(jsonResponse(409, """{"detail":{"code":"rfid_in_use","asset_id":"z","asset_name":"Other rack"}}"""))
            try { h.api.postRfidEnroll("a1", KioskRfidEnrollIn("serial", "000000000000000000100348", "pre_stage", "c3")); fail() } catch (e: ApiError) {
                assertEquals("rfid_in_use", e.code); assertEquals("Other rack", e.detailString("asset_name"))
            }
            assertEquals("/kiosk/assets/a1/rfid", h.server.takeRequest().path)

            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":false,"entry":null,"last_entry":null}"""))
            assertEquals(false, h.api.timeclockStatus("p").clocked_in)
            assertEquals("/kiosk/timeclock/p", h.server.takeRequest().path)
            h.server.enqueue(jsonResponse(200, """{"person":{"id":"p","display_name":"T"},"clocked_in":true,"entry":{"id":"e","started_at":"2026-09-15T09:00:00Z"}}"""))
            val st = h.api.clockIn(ClockInIn("serial", "p", "s1", "i1"))
            assertEquals(true, st.clocked_in)
            val req = h.server.takeRequest(); assertEquals("/kiosk/timeclock/clock-in", req.path); assertTrue(req.body.readUtf8().contains("\"site_id\":\"s1\""))
        }
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

Add to `KioskApi`:

```kotlin
    suspend fun setupOptions(): SetupOptions
    suspend fun submitSetup(body: KioskSetupIn): KioskSetupResult
    suspend fun syncAssets(initiativeId: String): KioskAssetsSync
    suspend fun syncPeople(): KioskPeopleSync
    suspend fun syncContainers(initiativeId: String): KioskContainersSync
    suspend fun syncTrucks(initiativeId: String): KioskTrucksSync
    /** Idempotent on client_scan_id; throws on anything but 200 (the outbox's back-off signal). */
    suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut
    /** 409 rfid_in_use (detail asset_name), 422 bad_rfid/rfid_too_long, 404, 423, network. */
    suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn): KioskRfidEnroll
    suspend fun timeclockStatus(personId: String): KioskTimeclockStatus
    suspend fun clockIn(body: ClockInIn): KioskTimeclockStatus
    suspend fun clockOut(body: ClockOutIn): KioskTimeclockStatus
```

Add to `OkHttpKioskApi` (imports for the models and `java.net.URLEncoder`):

```kotlin
    private fun q(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    override suspend fun setupOptions(): SetupOptions =
        parse(authed { url(url("/kiosk/setup-options")).get() }, SetupOptions.serializer())

    override suspend fun submitSetup(body: KioskSetupIn): KioskSetupResult =
        parse(authed { url(url("/kiosk/setup")).post(jsonBody(KioskSetupIn.serializer(), body)) }, KioskSetupResult.serializer())

    override suspend fun syncAssets(initiativeId: String): KioskAssetsSync =
        parse(authed { url(url("/kiosk/sync/assets?initiative_id=${q(initiativeId)}")).get() }, KioskAssetsSync.serializer())

    override suspend fun syncPeople(): KioskPeopleSync =
        parse(authed { url(url("/kiosk/sync/people")).get() }, KioskPeopleSync.serializer())

    override suspend fun syncContainers(initiativeId: String): KioskContainersSync =
        parse(authed { url(url("/kiosk/sync/containers?initiative_id=${q(initiativeId)}")).get() }, KioskContainersSync.serializer())

    override suspend fun syncTrucks(initiativeId: String): KioskTrucksSync =
        parse(authed { url(url("/kiosk/sync/trucks?initiative_id=${q(initiativeId)}")).get() }, KioskTrucksSync.serializer())

    override suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut =
        parse(authed { url(url("/kiosk/scans")).post(jsonBody(KioskScanBatchIn.serializer(), body)) }, KioskScanBatchOut.serializer())

    override suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn): KioskRfidEnroll =
        parse(authed { url(url("/kiosk/assets/${q(assetId)}/rfid")).post(jsonBody(KioskRfidEnrollIn.serializer(), body)) }, KioskRfidEnroll.serializer())

    override suspend fun timeclockStatus(personId: String): KioskTimeclockStatus =
        parse(authed { url(url("/kiosk/timeclock/${q(personId)}")).get() }, KioskTimeclockStatus.serializer())

    override suspend fun clockIn(body: ClockInIn): KioskTimeclockStatus =
        parse(authed { url(url("/kiosk/timeclock/clock-in")).post(jsonBody(ClockInIn.serializer(), body)) }, KioskTimeclockStatus.serializer())

    override suspend fun clockOut(body: ClockOutIn): KioskTimeclockStatus =
        parse(authed { url(url("/kiosk/timeclock/clock-out")).post(jsonBody(ClockOutIn.serializer(), body)) }, KioskTimeclockStatus.serializer())
```

- [ ] **Step 3: Run tests, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.api.*'
git add -A Android_Kiosk_App
git commit -m "feat(android): setup, sync, scan ingest, RFID enroll, and timeclock endpoints on the kiosk API client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Auth state, heartbeat, and the session coordinator

**Files:**
- Create: `data/auth/KioskAuth.kt`, `data/heartbeat/Heartbeat.kt`, `data/auth/SessionCoordinator.kt`
- Test: `data/FakeKioskApi.kt` (test source set — shared by later tasks), `data/auth/KioskAuthTest.kt`, `data/heartbeat/HeartbeatTest.kt`, `data/auth/SessionCoordinatorTest.kt`

**Interfaces:**
- Consumes: `KioskApi`, `SessionRefresher`, `Identity`, `KioskConfig`, `RegistrationState`, `computeCan`, `ADMIN_RANK`.
- Produces:
  - `enum class LoginMethod(val wire: String) { PASSWORD("password"), LINK("link") }`
  - `sealed interface AuthState { Loading; Anon; data class Authed(val session: SessionData) }` with `Authed` helpers `person`, `roles`, `perms`, `preferences`, `mustChangePassword`, `sessionExpiresAt`, `maxRank`, `isAdmin`, `isDeveloper`
  - `class KioskAuth(api, refresher: SessionRefresher, identity: Identity, scope)`: `val state: StateFlow<AuthState>`, `suspend fun restore()`, `suspend fun login(email, password): SessionData`, `fun completePair(data)`, `suspend fun logout()`, `fun can(resource, action): Boolean`, `fun takePendingSignIn(): LoginMethod?`
  - `class Heartbeat(api, identity, config, deviceInfo: () -> Map<String, String>, intervalMs = 60_000)`: `val registration: StateFlow<RegistrationState?>`, `fun start(scope, signIn: LoginMethod?)`, `fun stop()`, `suspend fun now()`
  - `class SessionCoordinator(auth, heartbeat, foreground: StateFlow<Boolean>, scope)`: `fun start()`

- [ ] **Step 1: Fake API for tests**

`app/src/test/java/com/serversherpa/kiosk/data/FakeKioskApi.kt`:

```kotlin
package com.serversherpa.kiosk.data

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.*
import com.serversherpa.kiosk.data.api.KioskApi

/** A KioskApi whose answers are set per test. Unset answers throw. */
open class FakeKioskApi : KioskApi {
    val calls = ArrayList<String>()
    var loginResult: () -> SessionData = { throw ApiError(401, "invalid_credentials") }
    var heartbeatResult: (HeartbeatIn) -> HeartbeatResult = { HeartbeatResult("d1", it.name, "ok", null) }
    var heartbeats = ArrayList<HeartbeatIn>()
    var systemStatusResult: () -> SystemStatus = { SystemStatus() }
    var pairCreated: () -> PairCreated = { PairCreated("ABCD1234", "pt", "https://portal/link/ABCD1234", "2026-09-15T00:05:00Z") }
    var pollResult: () -> PairPoll = { PairPoll(PairStatus.PENDING, null) }
    var setupOptionsResult: () -> SetupOptions = { SetupOptions() }
    var submitSetupResult: (KioskSetupIn) -> KioskSetupResult = { throw ApiError(500, "unknown_error") }
    var assets: () -> KioskAssetsSync = { KioskAssetsSync("i1", "Move", "now") }
    var people: () -> KioskPeopleSync = { KioskPeopleSync("now") }
    var containers: () -> KioskContainersSync = { KioskContainersSync("i1", "now") }
    var trucks: () -> KioskTrucksSync = { KioskTrucksSync("i1", "now") }
    var postScansResult: (KioskScanBatchIn) -> KioskScanBatchOut = { KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
    val scanBatches = ArrayList<KioskScanBatchIn>()
    var rfidResult: (String, KioskRfidEnrollIn) -> KioskRfidEnroll = { id, b -> KioskRfidEnroll(id, "Rack", "A-1", "SN", b.rfid_tag) }
    var statusResult: (String) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it, "Tina T"), false) }
    var clockInResult: (ClockInIn) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Tina T"), true, KioskTimeclockEntry("e", "2026-09-15T09:00:00Z")) }
    var clockOutResult: (ClockOutIn) -> KioskTimeclockStatus = { KioskTimeclockStatus(KioskTimeclockPerson(it.person_id, "Tina T"), false, null, KioskTimeclockLastEntry("e", "2026-09-15T09:00:00Z", "2026-09-15T12:12:00Z", 192)) }

    override suspend fun login(email: String, password: String) = loginResult().also { calls += "login" }
    override suspend fun logout() { calls += "logout" }
    override suspend fun systemStatus() = systemStatusResult().also { calls += "status" }
    override suspend fun createPairRequest(serial: String, name: String) = pairCreated().also { calls += "pair" }
    override suspend fun pollPair(code: String, pollToken: String) = pollResult().also { calls += "poll" }
    override suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult { calls += "heartbeat"; heartbeats += body; return heartbeatResult(body) }
    override suspend fun signOut(serial: String) { calls += "signOut" }
    override suspend fun setupOptions() = setupOptionsResult().also { calls += "setupOptions" }
    override suspend fun submitSetup(body: KioskSetupIn) = submitSetupResult(body).also { calls += "submitSetup" }
    override suspend fun syncAssets(initiativeId: String) = assets().also { calls += "syncAssets" }
    override suspend fun syncPeople() = people().also { calls += "syncPeople" }
    override suspend fun syncContainers(initiativeId: String) = containers().also { calls += "syncContainers" }
    override suspend fun syncTrucks(initiativeId: String) = trucks().also { calls += "syncTrucks" }
    override suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut { calls += "postScans"; scanBatches += body; return postScansResult(body) }
    override suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn) = rfidResult(assetId, body).also { calls += "rfid" }
    override suspend fun timeclockStatus(personId: String) = statusResult(personId).also { calls += "timeclockStatus" }
    override suspend fun clockIn(body: ClockInIn) = clockInResult(body).also { calls += "clockIn" }
    override suspend fun clockOut(body: ClockOutIn) = clockOutResult(body).also { calls += "clockOut" }
}

fun fakeSession(roles: List<String> = listOf("worker"), maxRank: Int = 20, mustChange: Boolean = false) = SessionData(
    access_token = "tok", expires_in = 900, session_expires_at = "2026-09-16T00:00:00Z",
    person = PersonOut(id = "p1", first_name = "Tina", last_name = "T", display_name = "Tina T"),
    roles = roles, must_change_password = mustChange, perms = mapOf("kiosk" to mapOf("view" to true)), max_rank = maxRank,
)

class FakeRefresher : com.serversherpa.kiosk.data.api.SessionRefresher {
    var refreshResult: () -> SessionData? = { null }
    var stored: SessionData? = null
    var cleared = 0
    override val sessionEnded = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    override suspend fun refresh(): SessionData? = refreshResult()
    override fun clear() { cleared++; stored = null }
    override fun store(data: SessionData) { stored = data }
}
```

Also a tiny in-memory identity for tests — add to the same file:

```kotlin
fun testIdentity(tmp: java.io.File, scope: kotlinx.coroutines.CoroutineScope): com.serversherpa.kiosk.data.identity.Identity =
    com.serversherpa.kiosk.data.identity.Identity(
        com.serversherpa.kiosk.data.prefs.KioskPrefs(
            androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(scope = scope) { java.io.File(tmp, "id.preferences_pb") },
        ),
    )
```

- [ ] **Step 2: Tests first**

`data/auth/KioskAuthTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class KioskAuthTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun restoreFromCookieOrAnon() = runTest {
        val api = FakeKioskApi(); val refresher = FakeRefresher()
        refresher.refreshResult = { fakeSession() }
        val auth = KioskAuth(api, refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        assertEquals(AuthState.Loading, auth.state.value)
        auth.restore()
        assertTrue(auth.state.value is AuthState.Authed)
        assertNull(auth.takePendingSignIn())   // a cookie restore is not a sign-in
        refresher.refreshResult = { null }
        auth.restore()
        assertEquals(AuthState.Anon, auth.state.value)
    }

    @Test fun loginMarksPendingPasswordSignIn() = runTest {
        val api = FakeKioskApi().apply { loginResult = { fakeSession(roles = listOf("developer"), maxRank = 100) } }
        val auth = KioskAuth(api, FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.login("a@b.c", "pw")
        val authed = auth.state.value as AuthState.Authed
        assertTrue(authed.isAdmin); assertTrue(authed.isDeveloper)
        assertEquals(LoginMethod.PASSWORD, auth.takePendingSignIn())
        assertNull(auth.takePendingSignIn())
        assertTrue(auth.can("kiosk", "view")); assertFalse(auth.can("labels", "view"))
    }

    @Test fun loginFailurePropagatesAndStaysAnon() = runTest {
        val auth = KioskAuth(FakeKioskApi(), FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        try { auth.login("a@b.c", "bad"); fail() } catch (e: ApiError) { assertEquals("invalid_credentials", e.code) }
        assertEquals(AuthState.Loading, auth.state.value)   // restore() not called in this test
    }

    @Test fun completePairAndLogout() = runTest {
        val api = FakeKioskApi(); val refresher = FakeRefresher()
        val auth = KioskAuth(api, refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.completePair(fakeSession())
        assertEquals(LoginMethod.LINK, auth.takePendingSignIn())
        auth.logout()
        assertEquals(listOf("signOut", "logout"), api.calls)
        assertEquals(AuthState.Anon, auth.state.value)
        assertEquals(1, refresher.cleared)
    }

    @Test fun sessionEndedFlipsToAnon() = runTest {
        val refresher = FakeRefresher()
        val auth = KioskAuth(FakeKioskApi(), refresher, testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.completePair(fakeSession())
        refresher.sessionEnded.tryEmit(Unit)
        advanceUntilIdle()
        assertEquals(AuthState.Anon, auth.state.value)
    }
}
```

`data/heartbeat/HeartbeatTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.heartbeat

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.LoginMethod
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class HeartbeatTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun harness(scope: kotlinx.coroutines.CoroutineScope, api: FakeKioskApi): Heartbeat {
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "hb.preferences_pb") })
        val config = KioskConfig(prefs, "https://api", "https://portal", "0.1.0")
        return Heartbeat(api, Identity(prefs), config, deviceInfo = { mapOf("model" to "MC2200") }, intervalMs = 60_000)
    }

    @Test fun beatsImmediatelyThenEveryMinuteAndReportsRegistration() = runTest {
        val api = FakeKioskApi()
        val hb = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = LoginMethod.PASSWORD)
        advanceUntilIdle()
        assertEquals(1, api.heartbeats.size)
        assertEquals(true, api.heartbeats[0].sign_in); assertEquals("password", api.heartbeats[0].login_method)
        assertEquals("android", api.heartbeats[0].mode); assertEquals("MC2200", api.heartbeats[0].raw_info["model"])
        assertEquals(RegistrationState.OK, hb.registration.value)
        advanceTimeBy(60_001); advanceUntilIdle()
        assertEquals(2, api.heartbeats.size)
        assertEquals(false, api.heartbeats[1].sign_in)   // cleared once a beat succeeded
        assertNull(api.heartbeats[1].login_method)
        hb.stop()
        assertNull(hb.registration.value)
    }

    @Test fun failedBeatKeepsPendingSignInAndLastState() = runTest {
        val api = FakeKioskApi()
        var fail = true
        api.heartbeatResult = { if (fail) throw ApiError(0, "network") else com.serversherpa.kiosk.core.model.HeartbeatResult("d", it.name, "soon", null) }
        val hb = harness(backgroundScope, api)
        hb.start(backgroundScope, signIn = LoginMethod.LINK)
        advanceUntilIdle()
        assertNull(hb.registration.value)
        fail = false
        hb.now()
        assertEquals(2, api.heartbeats.size)
        assertEquals(true, api.heartbeats[1].sign_in); assertEquals("link", api.heartbeats[1].login_method)
        assertEquals(RegistrationState.SOON, hb.registration.value)
        fail = true
        hb.now()
        assertEquals(RegistrationState.SOON, hb.registration.value)   // last state kept
    }
}
```

`data/auth/SessionCoordinatorTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class SessionCoordinatorTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun heartbeatRunsOnlyWhileAuthedAndForeground() = runTest {
        val api = FakeKioskApi()
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "c.preferences_pb") })
        val identity = Identity(prefs)
        val config = KioskConfig(prefs, "https://api", "https://portal", "0.1.0")
        val auth = KioskAuth(api, FakeRefresher(), identity, backgroundScope)
        val hb = Heartbeat(api, identity, config, { emptyMap() }, 60_000)
        val foreground = MutableStateFlow(true)
        SessionCoordinator(auth, hb, foreground, backgroundScope).start()
        advanceUntilIdle()
        assertEquals(0, api.heartbeats.size)
        auth.completePair(fakeSession())
        advanceUntilIdle()
        assertEquals(1, api.heartbeats.size)
        assertEquals("link", api.heartbeats[0].login_method)
        foreground.value = false
        advanceTimeBy(120_000); advanceUntilIdle()
        assertEquals(1, api.heartbeats.size)             // stopped in the background
        foreground.value = true
        advanceUntilIdle()
        assertEquals(2, api.heartbeats.size)             // resumed: immediate beat, no sign_in
        assertEquals(false, api.heartbeats[1].sign_in)
        auth.completePair(fakeSession(mustChange = true))
        advanceTimeBy(120_000); advanceUntilIdle()
        assertEquals(2, api.heartbeats.size)             // must-change-password: no heartbeat
    }
}
```

Run → FAIL.

- [ ] **Step 3: Implement**

`data/auth/KioskAuth.kt`:

```kotlin
package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.access.ADMIN_RANK
import com.serversherpa.kiosk.core.access.computeCan
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.SessionRefresher
import com.serversherpa.kiosk.data.identity.Identity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

enum class LoginMethod(val wire: String) { PASSWORD("password"), LINK("link") }

sealed interface AuthState {
    data object Loading : AuthState
    data object Anon : AuthState
    data class Authed(val session: SessionData) : AuthState {
        val person get() = session.person
        val roles get() = session.roles
        val perms get() = session.perms
        val preferences get() = session.preferences
        val mustChangePassword get() = session.must_change_password
        val sessionExpiresAt get() = session.session_expires_at
        val maxRank get() = session.max_rank
        val isAdmin get() = maxRank >= ADMIN_RANK
        val isDeveloper get() = "developer" in roles
    }
}

/** kiosk/src/auth/KioskAuthContext.tsx without the React. */
class KioskAuth(
    private val api: KioskApi,
    private val refresher: SessionRefresher,
    private val identity: Identity,
    scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state

    // Set only by login()/completePair(), never by a cookie restore, so the
    // API can auto-register the kiosk and record how the person signed in.
    @Volatile private var pendingSignIn: LoginMethod? = null

    init {
        scope.launch { refresher.sessionEnded.collect { _state.value = AuthState.Anon } }
    }

    /** Cookie restore on launch. */
    suspend fun restore() {
        val data = refresher.refresh()
        _state.value = if (data != null) AuthState.Authed(data) else AuthState.Anon
    }

    suspend fun login(email: String, password: String): SessionData {
        val data = api.login(email, password)
        pendingSignIn = LoginMethod.PASSWORD
        _state.value = AuthState.Authed(data)
        return data
    }

    fun completePair(data: SessionData) {
        refresher.store(data)
        pendingSignIn = LoginMethod.LINK
        _state.value = AuthState.Authed(data)
    }

    suspend fun logout() {
        api.signOut(identity.get().serial)
        api.logout()
        refresher.clear()
        _state.value = AuthState.Anon
    }

    fun can(resource: String, action: String): Boolean =
        computeCan((_state.value as? AuthState.Authed)?.perms, resource, action)

    /** The heartbeat consumes this exactly once per sign-in. */
    fun takePendingSignIn(): LoginMethod? = pendingSignIn.also { pendingSignIn = null }
}
```

`data/heartbeat/Heartbeat.kt`:

```kotlin
package com.serversherpa.kiosk.data.heartbeat

import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.auth.LoginMethod
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.Identity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * While someone is signed in and the app is in front: an immediate beat,
 * then one a minute. Each beat upserts the kiosk's Device row and returns
 * the registration state. Failures keep the last state (and any pending
 * sign_in) and are retried next tick.
 */
class Heartbeat(
    private val api: KioskApi,
    private val identity: Identity,
    private val config: KioskConfig,
    private val deviceInfo: () -> Map<String, String>,
    private val intervalMs: Long = 60_000,
) {
    private val _registration = MutableStateFlow<RegistrationState?>(null)
    val registration: StateFlow<RegistrationState?> = _registration

    private var job: Job? = null
    @Volatile private var pendingSignIn: LoginMethod? = null

    fun start(scope: CoroutineScope, signIn: LoginMethod?) {
        stop()
        if (signIn != null) pendingSignIn = signIn
        job = scope.launch {
            while (isActive) {
                beat()
                delay(intervalMs)
            }
        }
    }

    fun stop() {
        job?.cancel(); job = null
        _registration.value = null
    }

    /** Beat right now (after a rename). Resolves after the attempt. */
    suspend fun now() = beat()

    private suspend fun beat() {
        val (serial, name) = identity.get()
        val asSignIn = pendingSignIn
        try {
            val result = api.heartbeat(HeartbeatIn(
                serial = serial, name = name, mode = "android", version = config.kioskVersion,
                raw_info = deviceInfo(), sign_in = asSignIn != null, login_method = asSignIn?.wire,
            ))
            if (asSignIn != null && pendingSignIn === asSignIn) pendingSignIn = null
            _registration.value = RegistrationState.fromWire(result.registration)
        } catch (e: Exception) {
            /* keep the last known state and any pending sign-in */
        }
    }
}
```

`data/auth/SessionCoordinator.kt`:

```kotlin
package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** Runs the heartbeat exactly while a usable session exists and the app is in the foreground. */
class SessionCoordinator(
    private val auth: KioskAuth,
    private val heartbeat: Heartbeat,
    private val foreground: StateFlow<Boolean>,
    private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch {
            combine(auth.state, foreground) { state, fg ->
                fg && state is AuthState.Authed && !state.mustChangePassword
            }.distinctUntilChanged().collect { run ->
                if (run) heartbeat.start(scope, auth.takePendingSignIn()) else heartbeat.stop()
            }
        }
    }
}
```

- [ ] **Step 4: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): auth state, heartbeat with pending sign-in, and the foreground session coordinator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Room database and the sync transaction

**Files:**
- Create: `data/db/Entities.kt`, `data/db/Daos.kt`, `data/db/KioskDatabase.kt`
- Create: `data/sync/Sync.kt`
- Test: `data/db/KioskDatabaseTest.kt`, `data/sync/SyncTest.kt` (Robolectric)

**Interfaces:**
- Produces:
  - Entities: `AssetEntity : ScanAsset` (`id, assetId, name, rfid, serialNumber, make, model, makeModel, containerId, labelJson`), `PersonEntity : MatchPerson`, `ContainerEntity`, `TruckEntity`, `MetaEntity(key, value)`, `OutboxEntity`; converters `KioskAssetRow.toEntity()`, `KioskPersonRow.toEntity()`, `KioskContainerRow.toEntity()`, `KioskTruckRow.toEntity()`, `OutboxEntity.toRow()`, `OutboxRow.toEntity()`
  - DAOs: `AssetDao { all(); insertAll(); deleteAll(); count(); updateRfid(id, rfid) }`, `PersonDao { all(); insertAll(); deleteAll(); count() }`, `ContainerDao`, `TruckDao` (same four), `MetaDao { get(key); put(row); delete(key) }`, `OutboxDao { all(); upsert(rows); delete(ids) }`
  - `abstract class KioskDatabase : RoomDatabase` with `companion fun build(context): KioskDatabase` and `fun inMemory(context)`; `const val MOVE_META_KEY = "sync"`
  - `enum class SyncPhase { IDLE, RUNNING, DONE, ERROR }`, `data class SyncStatus(...)`, `@Serializable data class SyncMeta(...)`
  - `class Sync(api, db, scope, clock)`: `val status: StateFlow<SyncStatus>`, `suspend fun hydrate()`, `fun run(initiativeId, initiativeName)`, `suspend fun runNow(initiativeId, initiativeName)`, `suspend fun clearLocalData()`, `fun formatSyncedAt(iso): String`

- [ ] **Step 1: Tests first**

`data/db/KioskDatabaseTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.db

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.matchScan
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KioskDatabaseTest {
    private lateinit var db: KioskDatabase
    @Before fun setUp() { db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()) }
    @After fun tearDown() { db.close() }

    @Test fun assetsRoundTripAndMatch() = runBlocking {
        val row = KioskAssetRow(id = "a1", asset_id = "A-1", name = "Rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell R740", label = mapOf("asset_id" to "A-1"))
        db.assets().insertAll(listOf(row.toEntity()))
        val all = db.assets().all()
        assertEquals(1, all.size)
        assertEquals("A-1", all[0].label()["asset_id"])
        assertEquals("a1", matchScan(buildScanIndex(all), "100348")?.asset?.id)
        db.assets().updateRfid("a1", "000000000000000000999999")
        assertEquals("000000000000000000999999", db.assets().all()[0].rfid)
        assertEquals(1, db.assets().count())
        db.assets().deleteAll(); assertEquals(0, db.assets().count())
    }

    @Test fun metaAndOutbox() = runBlocking {
        db.meta().put(MetaEntity("sync", "{\"x\":1}"))
        assertEquals("{\"x\":1}", db.meta().get("sync")?.value)
        db.meta().delete("sync"); assertNull(db.meta().get("sync"))

        val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN1", "Dell")
        val r1 = OutboxMachine.newRow(EnqueueInput("A-1", "barcode", asset, "s", "i", "pre_stage"), "c1", 1, 0)
        val r2 = OutboxMachine.newRow(EnqueueInput("zzz", "barcode", null, "s", "i", "pre_stage"), "c2", 2, 0)
        db.outbox().upsert(listOf(r1.toEntity(), r2.toEntity()))
        val rows = db.outbox().all().map { it.toRow() }.sortedBy { it.seq }
        assertEquals(r1, rows[0]); assertEquals(r2, rows[1])
        assertEquals(OutboxStatus.NOMATCH, rows[1].status)
        db.outbox().upsert(listOf(r1.copy(status = OutboxStatus.ACCEPTED).toEntity()))
        assertEquals(OutboxStatus.ACCEPTED, db.outbox().all().first { it.clientScanId == "c1" }.toRow().status)
        db.outbox().delete(listOf("c1", "c2")); assertEquals(0, db.outbox().all().size)
    }
}
```

`data/sync/SyncTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.sync

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskAssetsSync
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncTest {
    private lateinit var db: KioskDatabase
    private val api = FakeKioskApi()
    @Before fun setUp() { db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()) }
    @After fun tearDown() { db.close() }

    private fun sync() = Sync(api, db, kotlinx.coroutines.GlobalScope, clock = { 1_700_000_000_000L })

    @Test fun successReplacesTablesAndWritesMeta() = runBlocking {
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a1", "A-1", make_model = "X"), KioskAssetRow("a2", "A-2", make_model = "Y"))) }
        api.people = { KioskPeopleSync("now", listOf(KioskPersonRow("p1", "Tina T", "Tina", "T"))) }
        val s = sync()
        s.runNow("i1", "Move A")
        val st = s.status.value
        assertEquals(SyncPhase.DONE, st.phase); assertEquals(2, st.assets); assertEquals(1, st.people); assertEquals(0, st.containers); assertEquals(0, st.trucks)
        assertEquals("2023-11-14T22:13:20Z", st.syncedAt)
        assertEquals(2, db.assets().count())
        val meta = Sync.readMeta(db)
        assertEquals("Move A", meta?.initiativeName); assertEquals(2, meta?.assets)
        // A second sync with fewer assets replaces, not appends.
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a9", "A-9", make_model = "Z"))) }
        s.runNow("i1", "Move A")
        assertEquals(listOf("a9"), db.assets().all().map { it.id })
    }

    @Test fun failedFetchLeavesTablesAndReportsCode() = runBlocking {
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a1", "A-1", make_model = "X"))) }
        val s = sync(); s.runNow("i1", "Move A")
        api.people = { throw ApiError(0, "network") }
        s.runNow("i1", "Move A")
        assertEquals(SyncPhase.ERROR, s.status.value.phase)
        assertEquals("network", s.status.value.error)
        assertEquals(1, s.status.value.assets)          // previous counts kept
        assertEquals(1, db.assets().count())
    }

    @Test fun hydrateReadsMetaAndClearEmptiesMoveTablesOnly() = runBlocking {
        api.assets = { KioskAssetsSync("i1", "Move A", "now", listOf(KioskAssetRow("a1", "A-1", make_model = "X"))) }
        sync().runNow("i1", "Move A")
        db.outbox().upsert(listOf(OutboxMachine.newRow(EnqueueInput("A-1", "barcode", null, "s", "i", "x"), "c1", 1, 0).toEntity()))
        val fresh = sync()
        assertEquals(SyncPhase.IDLE, fresh.status.value.phase)
        fresh.hydrate()
        assertEquals(SyncPhase.DONE, fresh.status.value.phase); assertEquals(1, fresh.status.value.assets)
        fresh.clearLocalData()
        assertEquals(SyncPhase.IDLE, fresh.status.value.phase)
        assertEquals(0, db.assets().count()); assertNull(db.meta().get(com.serversherpa.kiosk.data.db.MOVE_META_KEY))
        assertEquals(1, db.outbox().all().size)
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`data/db/Entities.kt`:

```kotlin
package com.serversherpa.kiosk.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskContainerRow
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTruckRow
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.people.MatchPerson
import com.serversherpa.kiosk.core.scan.ScanAsset
import com.serversherpa.kiosk.data.api.KioskJson
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

@Entity(tableName = "assets", indices = [Index("rfid"), Index("asset_id"), Index("serial_number")])
data class AssetEntity(
    @PrimaryKey override val id: String,
    @ColumnInfo(name = "asset_id") override val assetId: String,
    override val name: String?,
    override val rfid: String?,
    @ColumnInfo(name = "serial_number") override val serialNumber: String?,
    val make: String?,
    val model: String?,
    @ColumnInfo(name = "make_model") override val makeModel: String,
    @ColumnInfo(name = "container_id") val containerId: String?,
    @ColumnInfo(name = "label_json") val labelJson: String,
) : ScanAsset {
    fun label(): Map<String, String> = try {
        KioskJson.decodeFromString(MapSerializer(String.serializer(), String.serializer()), labelJson)
    } catch (e: Exception) { emptyMap() }

    fun toOutboxAsset() = OutboxAsset(id, assetId, name, rfid, serialNumber, makeModel)
}

fun KioskAssetRow.toEntity() = AssetEntity(
    id, asset_id, name, rfid, serial_number, make, model, make_model, container_id,
    KioskJson.encodeToString(MapSerializer(String.serializer(), String.serializer()), label),
)

@Entity(tableName = "people", indices = [Index("rfid_tag")])
data class PersonEntity(
    @PrimaryKey override val id: String,
    @ColumnInfo(name = "display_name") override val displayName: String,
    @ColumnInfo(name = "first_name") override val firstName: String?,
    @ColumnInfo(name = "last_name") override val lastName: String?,
    @ColumnInfo(name = "preferred_name") override val preferredName: String?,
    @ColumnInfo(name = "rfid_tag") override val rfidTag: String?,
    @ColumnInfo(name = "is_worker") override val isWorker: Boolean,
    @ColumnInfo(name = "has_account") override val hasAccount: Boolean,
) : MatchPerson

fun KioskPersonRow.toEntity() = PersonEntity(id, display_name, first_name, last_name, preferred_name, rfid_tag, is_worker, has_account)

@Entity(tableName = "containers", indices = [Index("rfid_tag"), Index("name")])
data class ContainerEntity(
    @PrimaryKey val id: String, val name: String, @ColumnInfo(name = "rfid_tag") val rfidTag: String?,
    @ColumnInfo(name = "label_tag") val labelTag: String?, @ColumnInfo(name = "container_type") val containerType: String?,
    val status: String, @ColumnInfo(name = "status_label") val statusLabel: String,
    @ColumnInfo(name = "site_id") val siteId: String?, @ColumnInfo(name = "site_name") val siteName: String?,
    @ColumnInfo(name = "asset_count") val assetCount: Int,
)

fun KioskContainerRow.toEntity() = ContainerEntity(id, name, rfid_tag, label_tag, container_type, status, status_label, site_id, site_name, asset_count)

@Entity(tableName = "trucks", indices = [Index("name"), Index("load_number")])
data class TruckEntity(
    @PrimaryKey val id: String, val name: String, @ColumnInfo(name = "load_number") val loadNumber: String?,
    val status: String, @ColumnInfo(name = "status_label") val statusLabel: String, @ColumnInfo(name = "driver_name") val driverName: String?,
    @ColumnInfo(name = "start_site_id") val startSiteId: String?, @ColumnInfo(name = "start_site_name") val startSiteName: String?,
    @ColumnInfo(name = "end_site_id") val endSiteId: String?, @ColumnInfo(name = "end_site_name") val endSiteName: String?,
    @ColumnInfo(name = "container_count") val containerCount: Int,
)

fun KioskTruckRow.toEntity() = TruckEntity(id, name, load_number, status, status_label, driver_name, start_site_id, start_site_name, end_site_id, end_site_name, container_count)

@Entity(tableName = "meta")
data class MetaEntity(@PrimaryKey val key: String, val value: String)

@Entity(tableName = "outbox", indices = [Index("status"), Index("seq")])
data class OutboxEntity(
    @PrimaryKey @ColumnInfo(name = "client_scan_id") val clientScanId: String,
    val seq: Long,
    @ColumnInfo(name = "scanned_value") val scannedValue: String,
    @ColumnInfo(name = "scan_type") val scanType: String,
    @ColumnInfo(name = "scanned_at") val scannedAt: String,
    @ColumnInfo(name = "asset_id") val assetId: String?,
    @ColumnInfo(name = "asset_tag") val assetTag: String?,
    @ColumnInfo(name = "asset_name") val assetName: String?,
    @ColumnInfo(name = "asset_rfid") val assetRfid: String?,
    @ColumnInfo(name = "asset_serial") val assetSerial: String?,
    @ColumnInfo(name = "asset_make_model") val assetMakeModel: String?,
    val matched: Boolean,
    val status: String,
    val attempts: Int,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long?,
    @ColumnInfo(name = "last_error") val lastError: String?,
    @ColumnInfo(name = "site_id") val siteId: String,
    @ColumnInfo(name = "initiative_id") val initiativeId: String,
    @ColumnInfo(name = "scan_status") val scanStatus: String,
) {
    fun toRow() = OutboxRow(
        clientScanId, seq, scannedValue, scanType, scannedAt,
        asset = assetId?.let { OutboxAsset(it, assetTag ?: "", assetName, assetRfid, assetSerial, assetMakeModel ?: "") },
        matched = matched, status = OutboxStatus.fromWire(status), attempts = attempts, nextAttemptAt = nextAttemptAt,
        lastError = lastError, siteId = siteId, initiativeId = initiativeId, scanStatus = scanStatus,
    )
}

fun OutboxRow.toEntity() = OutboxEntity(
    clientScanId, seq, scannedValue, scanType, scannedAt,
    asset?.id, asset?.assetId, asset?.name, asset?.rfid, asset?.serialNumber, asset?.makeModel,
    matched, status.wire, attempts, nextAttemptAt, lastError, siteId, initiativeId, scanStatus,
)
```

`data/db/Daos.kt`:

```kotlin
package com.serversherpa.kiosk.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface AssetDao {
    @Query("SELECT * FROM assets") suspend fun all(): List<AssetEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<AssetEntity>)
    @Query("DELETE FROM assets") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM assets") suspend fun count(): Int
    @Query("UPDATE assets SET rfid = :rfid WHERE id = :id") suspend fun updateRfid(id: String, rfid: String)
}

@Dao
interface PersonDao {
    @Query("SELECT * FROM people") suspend fun all(): List<PersonEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<PersonEntity>)
    @Query("DELETE FROM people") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM people") suspend fun count(): Int
}

@Dao
interface ContainerDao {
    @Query("SELECT * FROM containers") suspend fun all(): List<ContainerEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<ContainerEntity>)
    @Query("DELETE FROM containers") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM containers") suspend fun count(): Int
}

@Dao
interface TruckDao {
    @Query("SELECT * FROM trucks") suspend fun all(): List<TruckEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<TruckEntity>)
    @Query("DELETE FROM trucks") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM trucks") suspend fun count(): Int
}

@Dao
interface MetaDao {
    @Query("SELECT * FROM meta WHERE `key` = :key") suspend fun get(key: String): MetaEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun put(row: MetaEntity)
    @Query("DELETE FROM meta WHERE `key` = :key") suspend fun delete(key: String)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox") suspend fun all(): List<OutboxEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(rows: List<OutboxEntity>)
    @Query("DELETE FROM outbox WHERE client_scan_id IN (:ids)") suspend fun delete(ids: List<String>)
}
```

`data/db/KioskDatabase.kt`:

```kotlin
package com.serversherpa.kiosk.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

const val MOVE_META_KEY = "sync"

@Database(
    entities = [AssetEntity::class, PersonEntity::class, ContainerEntity::class, TruckEntity::class, MetaEntity::class, OutboxEntity::class],
    version = 1, exportSchema = false,
)
abstract class KioskDatabase : RoomDatabase() {
    abstract fun assets(): AssetDao
    abstract fun people(): PersonDao
    abstract fun containers(): ContainerDao
    abstract fun trucks(): TruckDao
    abstract fun meta(): MetaDao
    abstract fun outbox(): OutboxDao

    companion object {
        fun build(context: Context): KioskDatabase =
            Room.databaseBuilder(context.applicationContext, KioskDatabase::class.java, "serversherpa-kiosk").build()

        fun inMemory(context: Context): KioskDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, KioskDatabase::class.java).allowMainThreadQueries().build()
    }
}
```

`data/sync/Sync.kt`:

```kotlin
package com.serversherpa.kiosk.data.sync

import androidx.room.withTransaction
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.toEntity
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

enum class SyncPhase { IDLE, RUNNING, DONE, ERROR }

data class SyncStatus(
    val phase: SyncPhase = SyncPhase.IDLE,
    val assets: Int? = null, val people: Int? = null, val containers: Int? = null, val trucks: Int? = null,
    val syncedAt: String? = null, val error: String? = null,
)

@Serializable
data class SyncMeta(
    val initiativeId: String, val initiativeName: String,
    val assets: Int, val people: Int, val containers: Int, val trucks: Int, val syncedAt: String,
)

/**
 * kiosk/src/lib/sync.ts: fetch all four endpoints in parallel, then
 * replace all four tables and the meta row in ONE transaction. A failed
 * fetch leaves the cached rows untouched. Sync never touches setup state.
 */
class Sync(
    private val api: KioskApi,
    private val db: KioskDatabase,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status
    private var currentRun = 0
    private var hydrated = false

    /** Reads the persisted meta row once so a relaunch shows DONE with counts. */
    suspend fun hydrate() {
        if (hydrated) return
        hydrated = true
        val meta = readMeta(db) ?: return
        if (_status.value.phase != SyncPhase.IDLE) return
        _status.value = SyncStatus(SyncPhase.DONE, meta.assets, meta.people, meta.containers, meta.trucks, meta.syncedAt)
    }

    fun run(initiativeId: String, initiativeName: String) { scope.launch { runNow(initiativeId, initiativeName) } }

    suspend fun runNow(initiativeId: String, initiativeName: String) {
        val myRun = ++currentRun
        val previous = _status.value
        _status.value = previous.copy(phase = SyncPhase.RUNNING, error = null)
        val fetched = try {
            coroutineScope {
                val a = async { api.syncAssets(initiativeId) }
                val p = async { api.syncPeople() }
                val c = async { api.syncContainers(initiativeId) }
                val t = async { api.syncTrucks(initiativeId) }
                Fetched(a.await(), p.await(), c.await(), t.await())
            }
        } catch (e: Exception) {
            if (myRun != currentRun) return
            _status.value = previous.copy(phase = SyncPhase.ERROR, error = if (e is ApiError) e.code else "unknown_error")
            return
        }
        if (myRun != currentRun) return
        try {
            val syncedAt = Instant.ofEpochMilli(clock()).toString()
            db.withTransaction {
                db.assets().deleteAll(); db.assets().insertAll(fetched.assets.assets.map { it.toEntity() })
                db.people().deleteAll(); db.people().insertAll(fetched.people.people.map { it.toEntity() })
                db.containers().deleteAll(); db.containers().insertAll(fetched.containers.containers.map { it.toEntity() })
                db.trucks().deleteAll(); db.trucks().insertAll(fetched.trucks.trucks.map { it.toEntity() })
                val meta = SyncMeta(
                    initiativeId, initiativeName, fetched.assets.assets.size, fetched.people.people.size,
                    fetched.containers.containers.size, fetched.trucks.trucks.size, syncedAt,
                )
                db.meta().put(MetaEntity(MOVE_META_KEY, KioskJson.encodeToString(SyncMeta.serializer(), meta)))
            }
            if (myRun != currentRun) return
            hydrated = true
            _status.value = SyncStatus(
                SyncPhase.DONE, db.assets().count(), db.people().count(), db.containers().count(), db.trucks().count(), syncedAt,
            )
        } catch (e: Exception) {
            if (myRun != currentRun) return
            _status.value = previous.copy(phase = SyncPhase.ERROR, error = "storage")
        }
    }

    /** "Clear local data": the move tables and the meta row — never the outbox. */
    suspend fun clearLocalData() {
        db.withTransaction {
            db.assets().deleteAll(); db.people().deleteAll(); db.containers().deleteAll(); db.trucks().deleteAll()
            db.meta().delete(MOVE_META_KEY)
        }
        hydrated = false
        _status.value = SyncStatus()
    }

    private class Fetched(
        val assets: com.serversherpa.kiosk.core.model.KioskAssetsSync,
        val people: com.serversherpa.kiosk.core.model.KioskPeopleSync,
        val containers: com.serversherpa.kiosk.core.model.KioskContainersSync,
        val trucks: com.serversherpa.kiosk.core.model.KioskTrucksSync,
    )

    companion object {
        suspend fun readMeta(db: KioskDatabase): SyncMeta? = db.meta().get(MOVE_META_KEY)?.let {
            try { KioskJson.decodeFromString(SyncMeta.serializer(), it.value) } catch (e: Exception) { null }
        }

        /** "2:14 PM" — the time alone; the kiosk syncs per shift. */
        fun formatSyncedAt(iso: String): String = try {
            DateTimeFormatter.ofPattern("h:mm a").format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
        } catch (e: Exception) { iso }
    }
}
```

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.db.*' --tests 'com.serversherpa.kiosk.data.sync.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Room database (assets, people, containers, trucks, meta, outbox) and the one-transaction move sync

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: The outbox sender

**Files:**
- Create: `data/outbox/OutboxStore.kt`, `data/outbox/Outbox.kt`
- Test: `data/outbox/OutboxTest.kt` (plain JVM with virtual time and `MemoryOutboxStore`)

**Interfaces:**
- Consumes: `OutboxMachine` and row types (Part 1 Task 6), `KioskApi.postScans`, `Identity`, `OutboxDao` + entity converters (Task 12).
- Produces:
  - `interface OutboxStore { suspend fun all(): List<OutboxRow>; suspend fun upsert(rows: List<OutboxRow>); suspend fun delete(ids: List<String>) }`, `class RoomOutboxStore(dao: OutboxDao)`, `class MemoryOutboxStore`
  - `data class OutboxSnapshot(val rows: List<OutboxRow>, val counts: OutboxCounts)`
  - `class Outbox(store, api, identity, scope, clock, idGen)`: `val snapshot: StateFlow<OutboxSnapshot>`, `suspend fun load()`, `fun start()`, `fun stop()`, `suspend fun enqueue(input: EnqueueInput): OutboxRow`, `suspend fun retryFailed()`, `suspend fun clearSent()`, `suspend fun discardFailed()`

- [ ] **Step 1: Tests first**

```kotlin
package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskScanBatchOut
import com.serversherpa.kiosk.core.model.KioskScanRejected
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class OutboxTest {
    @get:Rule val tmp = TemporaryFolder()
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")
    private fun input(value: String = "A-1", matched: Boolean = true) = EnqueueInput(value, "barcode", if (matched) asset else null, "s1", "i1", "pre_stage")

    private fun TestScope.outbox(api: FakeKioskApi, store: MemoryOutboxStore = MemoryOutboxStore()): Outbox {
        var n = 0
        return Outbox(store, api, testIdentity(tmp.root, backgroundScope), backgroundScope, clock = { testScheduler.currentTime }, idGen = { "c${++n}" })
    }

    @Test fun matchedScansBatchAfter500msAndAreAccepted() = runTest {
        val api = FakeKioskApi()
        val ob = outbox(api); ob.start(); advanceUntilIdle()
        ob.enqueue(input()); advanceTimeBy(100); ob.enqueue(input("A-1"))
        assertEquals(0, api.scanBatches.size)
        advanceTimeBy(500); advanceUntilIdle()
        assertEquals(1, api.scanBatches.size)
        assertEquals(listOf("c1", "c2"), api.scanBatches[0].scans.map { it.client_scan_id })
        assertEquals("a1", api.scanBatches[0].scans[0].asset_id)
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
        assertEquals(2, ob.snapshot.value.counts.accepted)
        assertEquals(2L, ob.snapshot.value.rows[0].seq)   // newest first
    }

    @Test fun unmatchedNeverLeavesAndExpiresAfterTtl() = runTest {
        val api = FakeKioskApi()
        val ob = outbox(api); ob.start(); advanceUntilIdle()
        ob.enqueue(input("zzz", matched = false))
        advanceTimeBy(5_000); advanceUntilIdle()
        assertEquals(0, api.scanBatches.size)
        assertEquals(1, ob.snapshot.value.counts.nomatch)
        advanceTimeBy(OutboxMachine.NOMATCH_TTL_MS + OutboxMachine.NOMATCH_SWEEP_MS + 1); advanceUntilIdle()
        assertEquals(0, ob.snapshot.value.counts.total)
    }

    @Test fun failureBacksOffThenSucceeds() = runTest {
        val api = FakeKioskApi()
        var fail = true
        api.postScansResult = { if (fail) throw ApiError(0, "network") else KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
        val ob = outbox(api); ob.start(); advanceUntilIdle()
        ob.enqueue(input()); advanceTimeBy(600); advanceUntilIdle()
        assertEquals(1, api.scanBatches.size)
        val row = ob.snapshot.value.rows[0]
        assertEquals(OutboxStatus.RETRYING, row.status); assertEquals(1, row.attempts); assertEquals("network", row.lastError)
        fail = false
        advanceTimeBy(2_001); advanceUntilIdle()
        assertEquals(2, api.scanBatches.size)
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
    }

    @Test fun rejectionFailsImmediatelyAndRetryFailedRequeues() = runTest {
        val api = FakeKioskApi()
        api.postScansResult = { KioskScanBatchOut(rejected = it.scans.map { s -> KioskScanRejected(s.client_scan_id, "bad_site") }) }
        val ob = outbox(api); ob.start(); advanceUntilIdle()
        ob.enqueue(input()); advanceTimeBy(600); advanceUntilIdle()
        assertEquals(OutboxStatus.FAILED, ob.snapshot.value.rows[0].status)
        assertEquals("bad_site", ob.snapshot.value.rows[0].lastError)
        api.postScansResult = { KioskScanBatchOut(accepted = it.scans.map { s -> s.client_scan_id }) }
        ob.retryFailed(); advanceUntilIdle()
        assertEquals(OutboxStatus.ACCEPTED, ob.snapshot.value.rows[0].status)
    }

    @Test fun loadRecoversStrandedSendingRowsAndKeepsSeq() = runTest {
        val store = MemoryOutboxStore()
        store.upsert(listOf(OutboxMachine.newRow(input(), "old", 7, 0).copy(status = OutboxStatus.SENDING)))
        val api = FakeKioskApi()
        val ob = outbox(api, store); ob.start(); advanceUntilIdle()
        assertEquals(1, api.scanBatches.size)          // resent
        val fresh = ob.enqueue(input()); advanceUntilIdle()
        assertEquals(8L, fresh.seq)
    }

    @Test fun clearSentAndDiscardFailed() = runTest {
        val api = FakeKioskApi()
        api.postScansResult = { KioskScanBatchOut(accepted = it.scans.filter { s -> s.scanned_value == "A-1" }.map { s -> s.client_scan_id },
            rejected = it.scans.filter { s -> s.scanned_value == "B-2" }.map { s -> KioskScanRejected(s.client_scan_id, "bad_status") }) }
        val ob = outbox(api); ob.start(); advanceUntilIdle()
        ob.enqueue(input("A-1")); ob.enqueue(input("B-2")); ob.enqueue(input("nomatch", matched = false))
        advanceTimeBy(600); advanceUntilIdle()
        assertEquals(3, ob.snapshot.value.counts.total)
        ob.clearSent()
        assertEquals(listOf(OutboxStatus.FAILED), ob.snapshot.value.rows.map { it.status })
        ob.discardFailed()
        assertTrue(ob.snapshot.value.rows.isEmpty())
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`data/outbox/OutboxStore.kt`:

```kotlin
package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.data.db.OutboxDao
import com.serversherpa.kiosk.data.db.toEntity

interface OutboxStore {
    suspend fun all(): List<OutboxRow>
    suspend fun upsert(rows: List<OutboxRow>)
    suspend fun delete(ids: List<String>)
}

class RoomOutboxStore(private val dao: OutboxDao) : OutboxStore {
    override suspend fun all(): List<OutboxRow> = dao.all().map { it.toRow() }
    override suspend fun upsert(rows: List<OutboxRow>) { if (rows.isNotEmpty()) dao.upsert(rows.map { it.toEntity() }) }
    override suspend fun delete(ids: List<String>) { if (ids.isNotEmpty()) dao.delete(ids) }
}

class MemoryOutboxStore : OutboxStore {
    private val rows = LinkedHashMap<String, OutboxRow>()
    override suspend fun all(): List<OutboxRow> = rows.values.toList()
    override suspend fun upsert(rows: List<OutboxRow>) { rows.forEach { this.rows[it.clientScanId] = it } }
    override suspend fun delete(ids: List<String>) { ids.forEach { rows.remove(it) } }
}
```

`data/outbox/Outbox.kt`:

```kotlin
package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanIn
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxCounts
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

data class OutboxSnapshot(val rows: List<OutboxRow>, val counts: OutboxCounts)

/**
 * kiosk/src/lib/outbox.ts — durable queue + sender. The decisions live in
 * OutboxMachine; this class owns persistence, the in-memory mirror, the
 * batching window, the retry wake-ups, and the nomatch sweep.
 */
class Outbox(
    private val store: OutboxStore,
    private val api: KioskApi,
    private val identity: Identity,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val idGen: () -> String = { UUID.randomUUID().toString() },
) {
    private val empty = OutboxSnapshot(emptyList(), OutboxCounts(0, 0, 0, 0, 0))
    private val _snapshot = MutableStateFlow(empty)
    val snapshot: StateFlow<OutboxSnapshot> = _snapshot

    private val mutex = Mutex()
    private var all: MutableMap<String, OutboxRow> = LinkedHashMap()
    private var nextSeq = 1L
    private var loaded = false

    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var senderJob: Job? = null
    private var sweepJob: Job? = null
    private var pendingFlush: Job? = null

    private fun rebuild() {
        val rows = all.values.sortedByDescending { it.seq }
        _snapshot.value = OutboxSnapshot(rows.take(OutboxMachine.LIST_CAP), OutboxMachine.counts(rows))
    }

    /** Persists and mirrors `rows`. Caller holds the mutex. */
    private suspend fun save(rows: List<OutboxRow>) {
        store.upsert(rows)
        rows.forEach { all[it.clientScanId] = it }
        rebuild()
    }

    suspend fun load() = mutex.withLock {
        if (loaded) return@withLock
        val rows = try { store.all() } catch (e: Exception) { emptyList() }
        all = LinkedHashMap(rows.associateBy { it.clientScanId })
        nextSeq = (rows.maxOfOrNull { it.seq } ?: 0L) + 1
        val stranded = OutboxMachine.recoverStranded(rows)
        if (stranded.isNotEmpty()) save(stranded) else rebuild()
        loaded = true
    }

    fun start() {
        if (senderJob?.isActive == true) return
        senderJob = scope.launch {
            load()
            sweep()
            while (isActive) {
                flushOnce()
                val wait = when {
                    OutboxMachine.dueRows(all.values.toList(), clock()).isNotEmpty() -> 0L
                    else -> OutboxMachine.nextRetryDelayMs(all.values.toList(), clock()) ?: Long.MAX_VALUE
                }
                if (wait > 0) withTimeoutOrNull(wait) { wake.receive() }
            }
        }
        sweepJob = scope.launch {
            while (isActive) { delay(OutboxMachine.NOMATCH_SWEEP_MS); sweep() }
        }
    }

    fun stop() {
        senderJob?.cancel(); senderJob = null
        sweepJob?.cancel(); sweepJob = null
        pendingFlush?.cancel(); pendingFlush = null
    }

    private fun scheduleFlush(delayMs: Long) {
        if (pendingFlush?.isActive == true) return
        pendingFlush = scope.launch { delay(delayMs); wake.trySend(Unit) }
    }

    suspend fun enqueue(input: EnqueueInput): OutboxRow {
        load()
        val row = mutex.withLock {
            val r = OutboxMachine.newRow(input, idGen(), nextSeq++, clock())
            save(listOf(r)); r
        }
        if (row.matched) scheduleFlush(OutboxMachine.BATCH_DELAY_MS)
        return row
    }

    private suspend fun flushOnce() {
        val serial = identity.get().serial
        val batch = mutex.withLock {
            val due = OutboxMachine.dueRows(all.values.toList(), clock())
            if (due.isEmpty()) return
            OutboxMachine.markSending(due).also { save(it) }
        }
        val scans = batch.map { r ->
            KioskScanIn(r.clientScanId, r.scannedValue, r.scanType, r.scannedAt, r.asset?.id, r.siteId, r.initiativeId, r.scanStatus)
        }
        val updated = try {
            val result = api.postScans(KioskScanBatchIn(serial, scans))
            OutboxMachine.applyResponse(batch, result.accepted.toSet(), result.rejected.associate { it.client_scan_id to it.code })
        } catch (e: Exception) {
            val code = (e as? ApiError)?.code?.takeIf { it.isNotEmpty() } ?: "timeout"
            OutboxMachine.applyFailure(batch, code, clock())
        }
        mutex.withLock {
            try { save(updated) } catch (e: Exception) {
                // Storage failed: never leave rows `sending`, or they'd be stranded.
                updated.filter { all[it.clientScanId]?.status == OutboxStatus.SENDING }
                    .forEach { all[it.clientScanId] = it.copy(status = OutboxStatus.QUEUED) }
                rebuild()
            }
        }
    }

    private suspend fun sweep() = mutex.withLock {
        val stale = OutboxMachine.staleNoMatch(all.values.toList(), clock())
        if (stale.isEmpty()) return@withLock
        store.delete(stale.map { it.clientScanId })
        stale.forEach { all.remove(it.clientScanId) }
        rebuild()
    }

    suspend fun retryFailed() {
        mutex.withLock {
            val rows = OutboxMachine.retryFailed(all.values.toList())
            if (rows.isNotEmpty()) save(rows)
        }
        wake.trySend(Unit)
    }

    private suspend fun dropRows(pred: (OutboxRow) -> Boolean) = mutex.withLock {
        val drop = all.values.filter(pred)
        if (drop.isEmpty()) return@withLock
        store.delete(drop.map { it.clientScanId })
        drop.forEach { all.remove(it.clientScanId) }
        rebuild()
    }

    /** Drops accepted + nomatch; failed rows stay (the portal never got them). */
    suspend fun clearSent() = dropRows { it.status == OutboxStatus.ACCEPTED || it.status == OutboxStatus.NOMATCH }

    /** The operator confirmed these scans are being abandoned. */
    suspend fun discardFailed() = dropRows { it.status == OutboxStatus.FAILED }
}
```

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.outbox.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Room-backed outbox sender with batching, backoff, nomatch sweep, and operator actions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Scan bus and Zebra DataWedge

**Files:**
- Create: `input/ScanBus.kt`, `input/datawedge/DataWedge.kt`, `input/datawedge/DataWedgeReceiver.kt`
- Test: `input/ScanBusTest.kt`, `input/datawedge/DataWedgeTest.kt` (Robolectric)

**Interfaces:**
- Produces: `enum class ScanSource { KEYBOARD, DATAWEDGE, CAMERA }`, `data class ScanEvent(val value: String, val source: ScanSource, val symbology: String? = null)`, `class ScanBus { val events: SharedFlow<ScanEvent>; fun publish(event: ScanEvent) }`; `object DataWedge { const val PACKAGE; const val PROFILE; const val SCAN_ACTION; fun isPresent(context): Boolean; fun profileConfig(packageName): Bundle; fun configure(context); fun softScan(context, start: Boolean); fun parseScan(intent): ScanEvent? }`; `class DataWedgeReceiver(private val bus: ScanBus) : BroadcastReceiver` with `fun register(context)` / `fun unregister(context)`.

- [ ] **Step 1: Tests first**

`input/ScanBusTest.kt`:

```kotlin
package com.serversherpa.kiosk.input

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ScanBusTest {
    @Test fun deliversToTheActiveCollector() = runTest {
        val bus = ScanBus()
        val got = ArrayList<ScanEvent>()
        val job = launch { bus.events.collect { got += it } }
        advanceUntilIdle()
        bus.publish(ScanEvent(" A-1 ", ScanSource.KEYBOARD))
        bus.publish(ScanEvent("", ScanSource.CAMERA))            // blank: dropped
        advanceUntilIdle()
        assertEquals(listOf(ScanEvent("A-1", ScanSource.KEYBOARD)), got)
        job.cancel()
    }
}
```

`input/datawedge/DataWedgeTest.kt`:

```kotlin
package com.serversherpa.kiosk.input.datawedge

import android.content.Intent
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.input.ScanSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DataWedgeTest {
    @Test fun notPresentOnAPlainDevice() {
        assertFalse(DataWedge.isPresent(ApplicationProvider.getApplicationContext()))
    }

    @Test fun profileConfigShape() {
        val b = DataWedge.profileConfig("com.serversherpa.kiosk")
        assertEquals("ServerSherpaKiosk", b.getString("PROFILE_NAME"))
        assertEquals("true", b.getString("PROFILE_ENABLED"))
        assertEquals("CREATE_IF_NOT_EXIST", b.getString("CONFIG_MODE"))
        val apps = b.getParcelableArray("APP_LIST")!!.map { it as Bundle }
        assertEquals("com.serversherpa.kiosk", apps[0].getString("PACKAGE_NAME"))
        val plugins = b.getParcelableArrayList<Bundle>("PLUGIN_CONFIG")!!
        val byName = plugins.associateBy { it.getString("PLUGIN_NAME") }
        assertEquals("true", byName["BARCODE"]!!.getBundle("PARAM_LIST")!!.getString("scanner_input_enabled"))
        val intent = byName["INTENT"]!!.getBundle("PARAM_LIST")!!
        assertEquals("true", intent.getString("intent_output_enabled"))
        assertEquals(DataWedge.SCAN_ACTION, intent.getString("intent_action"))
        assertEquals("2", intent.getString("intent_delivery"))
        assertEquals("false", byName["KEYSTROKE"]!!.getBundle("PARAM_LIST")!!.getString("keystroke_output_enabled"))
    }

    @Test fun parseScanReadsDataStringAndLabel() {
        val intent = Intent(DataWedge.SCAN_ACTION)
            .putExtra("com.symbol.datawedge.data_string", " A-100 ")
            .putExtra("com.symbol.datawedge.label_type", "LABEL-TYPE-CODE128")
        val ev = DataWedge.parseScan(intent)!!
        assertEquals("A-100", ev.value); assertEquals(ScanSource.DATAWEDGE, ev.source); assertEquals("CODE128", ev.symbology)
        assertNull(DataWedge.parseScan(Intent("other")))
        assertNull(DataWedge.parseScan(Intent(DataWedge.SCAN_ACTION)))
    }

    @Test fun receiverPublishes() {
        val bus = com.serversherpa.kiosk.input.ScanBus()
        var got: com.serversherpa.kiosk.input.ScanEvent? = null
        val job = kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.Unconfined) { bus.events.collect { got = it } }
        val receiver = DataWedgeReceiver(bus)
        receiver.onReceive(ApplicationProvider.getApplicationContext(), Intent(DataWedge.SCAN_ACTION).putExtra("com.symbol.datawedge.data_string", "X1"))
        assertTrue(got?.value == "X1")
        job.cancel()
    }
}
```

(`kotlinx.coroutines.GlobalScope.launch` needs `import kotlinx.coroutines.launch`.)

Run → FAIL.

- [ ] **Step 2: Implement**

`input/ScanBus.kt`:

```kotlin
package com.serversherpa.kiosk.input

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

enum class ScanSource { KEYBOARD, DATAWEDGE, CAMERA }

data class ScanEvent(val value: String, val source: ScanSource, val symbology: String? = null)

/** Every scan source ends here; the screen on top collects. Values are
 *  trimmed and blanks dropped so no screen has to repeat that. */
class ScanBus {
    private val _events = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ScanEvent> = _events

    fun publish(event: ScanEvent) {
        val value = event.value.trim()
        if (value.isEmpty()) return
        _events.tryEmit(event.copy(value = value))
    }
}
```

`input/datawedge/DataWedge.kt`:

```kotlin
package com.serversherpa.kiosk.input.datawedge

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource

/**
 * Zebra DataWedge: on a Zebra device the built-in scan engine is driven
 * by DataWedge, which we configure (once, at startup) to broadcast every
 * scan to SCAN_ACTION and to stop typing it as keystrokes. Nothing here
 * runs on a device without the DataWedge package.
 */
object DataWedge {
    const val PACKAGE = "com.symbol.datawedge"
    const val PROFILE = "ServerSherpaKiosk"
    const val SCAN_ACTION = "com.serversherpa.kiosk.SCAN"
    private const val API_ACTION = "com.symbol.datawedge.api.ACTION"
    private const val EXTRA_DATA = "com.symbol.datawedge.data_string"
    private const val EXTRA_LABEL = "com.symbol.datawedge.label_type"

    fun isPresent(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(PACKAGE, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    /** The SET_CONFIG bundle: profile bound to our package, barcode in, intent out, keystrokes off. */
    fun profileConfig(packageName: String): Bundle {
        val app = Bundle().apply { putString("PACKAGE_NAME", packageName); putStringArray("ACTIVITY_LIST", arrayOf("*")) }
        val barcode = Bundle().apply {
            putString("PLUGIN_NAME", "BARCODE"); putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", Bundle().apply { putString("scanner_input_enabled", "true"); putString("scanner_selection", "auto") })
        }
        val intent = Bundle().apply {
            putString("PLUGIN_NAME", "INTENT"); putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", Bundle().apply {
                putString("intent_output_enabled", "true"); putString("intent_action", SCAN_ACTION)
                putString("intent_category", Intent.CATEGORY_DEFAULT); putString("intent_delivery", "2")
            })
        }
        val keystroke = Bundle().apply {
            putString("PLUGIN_NAME", "KEYSTROKE"); putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", Bundle().apply { putString("keystroke_output_enabled", "false") })
        }
        return Bundle().apply {
            putString("PROFILE_NAME", PROFILE); putString("PROFILE_ENABLED", "true"); putString("CONFIG_MODE", "CREATE_IF_NOT_EXIST")
            putParcelableArray("APP_LIST", arrayOf(app))
            putParcelableArrayList("PLUGIN_CONFIG", arrayListOf(barcode, intent, keystroke))
        }
    }

    fun configure(context: Context) {
        if (!isPresent(context)) return
        context.sendBroadcast(Intent(API_ACTION).setPackage(PACKAGE).putExtra("com.symbol.datawedge.api.SET_CONFIG", profileConfig(context.packageName)))
    }

    /** Fires the scan engine as if the trigger were pressed. */
    fun softScan(context: Context, start: Boolean) {
        if (!isPresent(context)) return
        context.sendBroadcast(Intent(API_ACTION).setPackage(PACKAGE)
            .putExtra("com.symbol.datawedge.api.SOFT_SCAN_TRIGGER", if (start) "START_SCANNING" else "STOP_SCANNING"))
    }

    fun parseScan(intent: Intent): ScanEvent? {
        if (intent.action != SCAN_ACTION) return null
        val value = intent.getStringExtra(EXTRA_DATA)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val label = intent.getStringExtra(EXTRA_LABEL)?.removePrefix("LABEL-TYPE-")
        return ScanEvent(value, ScanSource.DATAWEDGE, label)
    }
}
```

`input/datawedge/DataWedgeReceiver.kt`:

```kotlin
package com.serversherpa.kiosk.input.datawedge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.input.ScanBus

/** Registered dynamically while the app is in the foreground (DataWedge's
 *  broadcast is implicit, which a manifest receiver would not get on
 *  Android 8+). */
class DataWedgeReceiver(private val bus: ScanBus) : BroadcastReceiver() {
    private var registered = false

    override fun onReceive(context: Context, intent: Intent) {
        DataWedge.parseScan(intent)?.let { bus.publish(it) }
    }

    fun register(context: Context) {
        if (registered) return
        val filter = IntentFilter(DataWedge.SCAN_ACTION).apply { addCategory(Intent.CATEGORY_DEFAULT) }
        ContextCompat.registerReceiver(context, this, filter, ContextCompat.RECEIVER_EXPORTED)
        registered = true
    }

    fun unregister(context: Context) {
        if (!registered) return
        try { context.unregisterReceiver(this) } catch (e: IllegalArgumentException) { /* already gone */ }
        registered = false
    }
}
```

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): scan bus and Zebra DataWedge profile, soft trigger, and broadcast receiver

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Camera scanning (CameraX + ML Kit) with single and multi read

**Files:**
- Create: `input/camera/MultiReadSession.kt`, `input/camera/BarcodeAnalyzer.kt`, `input/camera/CameraScanSheet.kt`, `input/camera/CameraSupport.kt`
- Test: `input/camera/MultiReadSessionTest.kt`

**Interfaces:**
- Produces: `class MultiReadSession { fun offer(value: String): Boolean; val count: Int; val recent: List<String> }`; `enum class CameraMode { SINGLE, MULTI }`; `fun hasCamera(context: Context): Boolean`; `@Composable fun CameraScanSheet(initialMode: CameraMode = CameraMode.SINGLE, onScan: (ScanEvent) -> Unit, onDismiss: () -> Unit)`; `fun formatName(format: Int): String?`.

- [ ] **Step 1: Test first**

```kotlin
package com.serversherpa.kiosk.input.camera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MultiReadSessionTest {
    @Test fun eachDistinctValueOnceNewestFirstCapped() {
        val s = MultiReadSession()
        assertTrue(s.offer("A")); assertFalse(s.offer("A")); assertTrue(s.offer(" B "))
        (1..10).forEach { s.offer("V$it") }
        assertEquals(12, s.count)
        assertEquals(listOf("V10", "V9", "V8", "V7", "V6"), s.recent)
        assertFalse(s.offer(""))
    }
}
```

- [ ] **Step 2: Implement**

`MultiReadSession.kt`:

```kotlin
package com.serversherpa.kiosk.input.camera

/** Multi-read mode: each distinct barcode is published once per sheet open. */
class MultiReadSession {
    private val seen = LinkedHashSet<String>()
    private val order = ArrayList<String>()

    val count: Int get() = seen.size
    /** Newest first, at most five. */
    val recent: List<String> get() = order.asReversed().take(5)

    fun offer(value: String): Boolean {
        val v = value.trim()
        if (v.isEmpty() || !seen.add(v)) return false
        order.add(v)
        return true
    }
}
```

`CameraSupport.kt`:

```kotlin
package com.serversherpa.kiosk.input.camera

import android.content.Context
import android.content.pm.PackageManager
import com.google.mlkit.vision.barcode.common.Barcode

fun hasCamera(context: Context): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

fun formatName(format: Int): String? = when (format) {
    Barcode.FORMAT_QR_CODE -> "QR_CODE"; Barcode.FORMAT_CODE_128 -> "CODE128"; Barcode.FORMAT_CODE_39 -> "CODE39"
    Barcode.FORMAT_CODE_93 -> "CODE93"; Barcode.FORMAT_EAN_13 -> "EAN13"; Barcode.FORMAT_EAN_8 -> "EAN8"
    Barcode.FORMAT_UPC_A -> "UPCA"; Barcode.FORMAT_UPC_E -> "UPCE"; Barcode.FORMAT_DATA_MATRIX -> "DATAMATRIX"
    Barcode.FORMAT_PDF417 -> "PDF417"; Barcode.FORMAT_AZTEC -> "AZTEC"; Barcode.FORMAT_ITF -> "ITF"; Barcode.FORMAT_CODABAR -> "CODABAR"
    else -> null
}
```

`BarcodeAnalyzer.kt`:

```kotlin
package com.serversherpa.kiosk.input.camera

import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage

/** Runs ML Kit on each frame; `onValue(value, symbology)` per decoded barcode. */
class BarcodeAnalyzer(private val onValue: (String, String?) -> Unit) : ImageAnalysis.Analyzer {
    private val scanner = BarcodeScanning.getClient()

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
        val media = image.image
        if (media == null) { image.close(); return }
        val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { codes ->
                for (code in codes) code.rawValue?.let { onValue(it, formatName(code.format)) }
            }
            .addOnCompleteListener { image.close() }
    }

    fun close() = scanner.close()
}
```

`CameraScanSheet.kt`:

```kotlin
package com.serversherpa.kiosk.input.camera

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import java.util.concurrent.Executors

enum class CameraMode { SINGLE, MULTI }

/**
 * Full-screen camera scanner. SINGLE publishes the first barcode and
 * dismisses; MULTI publishes each distinct barcode once and stays open
 * until Done. Frames are never stored.
 */
@Composable
fun CameraScanSheet(initialMode: CameraMode = CameraMode.SINGLE, onScan: (ScanEvent) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    var mode by remember { mutableStateOf(initialMode) }
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var denied by remember { mutableStateOf(false) }
    var torch by remember { mutableStateOf(false) }
    val session = remember { MultiReadSession() }
    var count by remember { mutableIntStateOf(0) }
    var recent by remember { mutableStateOf(listOf<String>()) }
    var finished by remember { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> granted = ok; denied = !ok }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }

    val executor = remember { Executors.newSingleThreadExecutor() }
    val analyzer = remember {
        BarcodeAnalyzer { value, symbology ->
            if (finished) return@BarcodeAnalyzer
            if (mode == CameraMode.SINGLE) {
                finished = true
                onScan(ScanEvent(value, ScanSource.CAMERA, symbology))
                onDismiss()
            } else if (session.offer(value)) {
                count = session.count; recent = session.recent
                onScan(ScanEvent(value, ScanSource.CAMERA, symbology))
            }
        }
    }
    DisposableEffect(Unit) { onDispose { analyzer.close(); executor.shutdown() } }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            var cameraControl by remember { mutableStateOf<androidx.camera.core.CameraControl?>(null) }
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    val view = PreviewView(ctx)
                    val future = ProcessCameraProvider.getInstance(ctx)
                    future.addListener({
                        val provider = future.get()
                        val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                            .also { it.setAnalyzer(executor, analyzer) }
                        provider.unbindAll()
                        val camera = provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                        cameraControl = camera.cameraControl
                    }, ContextCompat.getMainExecutor(ctx))
                    view
                },
            )
            LaunchedEffect(torch) { cameraControl?.enableTorch(torch) }
            // Reticle
            Box(Modifier.align(Alignment.Center).size(240.dp).background(Color.Transparent)
                .padding(2.dp)) {
                Box(Modifier.fillMaxSize().background(Color.Transparent))
            }
        } else {
            Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (denied) "Camera access was denied. Allow it in Android Settings › Apps › ServerSherpa Kiosk." else "Requesting camera access…", color = Color.White)
            }
        }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0xCC0C1117)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { mode = CameraMode.SINGLE }) { Text(if (mode == CameraMode.SINGLE) "● Single" else "Single", color = Color.White) }
                TextButton(onClick = { mode = CameraMode.MULTI }) { Text(if (mode == CameraMode.MULTI) "● Multi" else "Multi", color = Color.White) }
                TextButton(onClick = { torch = !torch }) { Text(if (torch) "Torch on" else "Torch off", color = Color.White) }
            }
            if (mode == CameraMode.MULTI) {
                Text("$count scanned", color = Color.White)
                recent.forEach { Text(it, color = Color(0xFFE8EDF4)) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onDismiss) { Text(if (mode == CameraMode.MULTI) "Done" else "Close") }
            }
        }
    }
}
```

(The reticle boxes above are intentionally minimal; Part 3's components task may restyle them with the theme's accent border. Keep the composable compiling.)

- [ ] **Step 3: Run test, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.camera.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): CameraX + ML Kit camera scan sheet with single and multi read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## End of Part 2

Continue with `docs/superpowers/plans/2026-09-15-android-kiosk-3-shell-and-login.md`, then `2026-09-15-android-kiosk-4-feature-screens.md`.
