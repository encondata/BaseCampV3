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
