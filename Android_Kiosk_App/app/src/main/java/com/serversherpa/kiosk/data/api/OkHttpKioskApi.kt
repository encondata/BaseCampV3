package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.model.KioskAssetsSync
import com.serversherpa.kiosk.core.model.KioskContainersSync
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskRfidEnroll
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanBatchOut
import com.serversherpa.kiosk.core.model.KioskSetupIn
import com.serversherpa.kiosk.core.model.KioskSetupResult
import com.serversherpa.kiosk.core.model.KioskSignOutIn
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.model.KioskTrucksSync
import com.serversherpa.kiosk.core.model.LoginIn
import com.serversherpa.kiosk.core.model.PairCreateIn
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.PairPollIn
import com.serversherpa.kiosk.core.model.PairPollOut
import com.serversherpa.kiosk.core.model.PairStatus
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.model.SystemStatus
import com.serversherpa.kiosk.data.config.KioskConfig
import java.io.IOException
import java.net.URLEncoder
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

    private suspend fun apiUrl(path: String): String = config.apiUrlNow() + path

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
            val refreshed = session.refresh()
            if (refreshed != null) {
                resp.close()          // the retry replaces it
                resp = go()
            }
            if (refreshed == null || resp.code == 401) session.notifySessionEnded()
        }
        return resp
    }

    // ── auth ────────────────────────────────────────────────────────

    override suspend fun login(email: String, password: String): SessionData {
        val resp = plain { url(apiUrl("/auth/login")).post(jsonBody(LoginIn.serializer(), LoginIn(email, password))) }
        return parse(resp, SessionData.serializer()).also { session.store(it) }
    }

    override suspend fun logout() {
        try { plain { url(apiUrl("/auth/logout")).post(emptyBody) }.close() } catch (e: ApiError) { /* offline logout still clears */ }
        finally { session.clear() }
    }

    override suspend fun systemStatus(): SystemStatus =
        parse(plain { url(apiUrl("/system/status")).get() }, SystemStatus.serializer())

    // ── pairing ─────────────────────────────────────────────────────

    override suspend fun createPairRequest(serial: String, name: String): PairCreated =
        parse(plain { url(apiUrl("/kiosk/pair")).post(jsonBody(PairCreateIn.serializer(), PairCreateIn(serial, name))) }, PairCreated.serializer())

    override suspend fun pollPair(code: String, pollToken: String): PairPoll {
        val resp = plain { url(apiUrl("/kiosk/pair/$code/poll")).post(jsonBody(PairPollIn.serializer(), PairPollIn(pollToken))) }
        if (resp.code == 404) { resp.close(); return PairPoll(PairStatus.EXPIRED, null) }
        val out = parse(resp, PairPollOut.serializer())
        val status = PairStatus.fromWire(out.status)
        if (status == PairStatus.APPROVED && out.session != null) session.store(out.session)
        return PairPoll(status, out.session)
    }

    // ── heartbeat ───────────────────────────────────────────────────

    override suspend fun heartbeat(body: HeartbeatIn): HeartbeatResult =
        parse(authed { url(apiUrl("/kiosk/heartbeat")).post(jsonBody(HeartbeatIn.serializer(), body)) }, HeartbeatResult.serializer())

    override suspend fun signOut(serial: String) {
        try {
            authed { url(apiUrl("/kiosk/sign-out")).post(jsonBody(KioskSignOutIn.serializer(), KioskSignOutIn(serial))) }.close()
        } catch (e: ApiError) { /* ignore */ }
    }

    // ── setup & sync ────────────────────────────────────────────────

    private fun q(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    override suspend fun setupOptions(): SetupOptions =
        parse(authed { url(apiUrl("/kiosk/setup-options")).get() }, SetupOptions.serializer())

    override suspend fun submitSetup(body: KioskSetupIn): KioskSetupResult =
        parse(authed { url(apiUrl("/kiosk/setup")).post(jsonBody(KioskSetupIn.serializer(), body)) }, KioskSetupResult.serializer())

    override suspend fun syncAssets(initiativeId: String): KioskAssetsSync =
        parse(authed { url(apiUrl("/kiosk/sync/assets?initiative_id=${q(initiativeId)}")).get() }, KioskAssetsSync.serializer())

    override suspend fun syncPeople(): KioskPeopleSync =
        parse(authed { url(apiUrl("/kiosk/sync/people")).get() }, KioskPeopleSync.serializer())

    override suspend fun syncContainers(initiativeId: String): KioskContainersSync =
        parse(authed { url(apiUrl("/kiosk/sync/containers?initiative_id=${q(initiativeId)}")).get() }, KioskContainersSync.serializer())

    override suspend fun syncTrucks(initiativeId: String): KioskTrucksSync =
        parse(authed { url(apiUrl("/kiosk/sync/trucks?initiative_id=${q(initiativeId)}")).get() }, KioskTrucksSync.serializer())

    // ── scans, RFID, timeclock ──────────────────────────────────────

    override suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut =
        parse(authed { url(apiUrl("/kiosk/scans")).post(jsonBody(KioskScanBatchIn.serializer(), body)) }, KioskScanBatchOut.serializer())

    override suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn): KioskRfidEnroll =
        parse(authed { url(apiUrl("/kiosk/assets/${q(assetId)}/rfid")).post(jsonBody(KioskRfidEnrollIn.serializer(), body)) }, KioskRfidEnroll.serializer())

    override suspend fun timeclockStatus(personId: String): KioskTimeclockStatus =
        parse(authed { url(apiUrl("/kiosk/timeclock/${q(personId)}")).get() }, KioskTimeclockStatus.serializer())

    override suspend fun clockIn(body: ClockInIn): KioskTimeclockStatus =
        parse(authed { url(apiUrl("/kiosk/timeclock/clock-in")).post(jsonBody(ClockInIn.serializer(), body)) }, KioskTimeclockStatus.serializer())

    override suspend fun clockOut(body: ClockOutIn): KioskTimeclockStatus =
        parse(authed { url(apiUrl("/kiosk/timeclock/clock-out")).post(jsonBody(ClockOutIn.serializer(), body)) }, KioskTimeclockStatus.serializer())
}
