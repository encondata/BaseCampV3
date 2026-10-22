package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.HeartbeatIn
import com.serversherpa.kiosk.core.model.HeartbeatResult
import com.serversherpa.kiosk.core.model.KioskAssetsSync
import com.serversherpa.kiosk.core.model.KioskContainersSync
import com.serversherpa.kiosk.core.model.KioskLabelFonts
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskRfidEnroll
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskScanBatchIn
import com.serversherpa.kiosk.core.model.KioskScanBatchOut
import com.serversherpa.kiosk.core.model.KioskSetupIn
import com.serversherpa.kiosk.core.model.KioskSetupResult
import com.serversherpa.kiosk.core.model.KioskSignOutIn
import com.serversherpa.kiosk.core.model.KioskStationKeyIn
import com.serversherpa.kiosk.core.model.KioskStationKeyOut
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.model.KioskTrucksSync
import com.serversherpa.kiosk.core.model.LoginIn
import com.serversherpa.kiosk.core.model.MoveLoginIn
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
import okhttp3.Dispatcher
import java.net.URLEncoder
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * One call on [client], on OkHttp's own threads; a transport failure is ApiError(0, "network").
 * Shared by [OkHttpKioskApi] and [OkHttpStationApi].
 *
 * Cancellable: cancelling the coroutine (a `withTimeoutOrNull` read deadline, a screen going
 * away) cancels the HTTP call itself, which a blocking `execute()` inside `withContext(IO)`
 * never did. The body is read on the callback thread before resuming, so the whole exchange is
 * covered and callers parse it from memory without touching the network.
 */
internal suspend fun executeCall(client: OkHttpClient, request: Request): Response = suspendCancellableCoroutine { cont ->
    val call = client.newCall(request)
    cont.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            // Already cancelled: the resume is ignored.
            cont.resumeWithException(ApiError(0, "network"))
        }

        override fun onResponse(call: Call, response: Response) {
            val buffered = try {
                response.use { r ->
                    val body = r.body
                    r.newBuilder().body(body?.bytes()?.toResponseBody(body.contentType())).build()
                }
            } catch (e: Throwable) {
                // Anything at all (an IOException, or an OutOfMemoryError in bytes()): resume once
                // as a network failure rather than leave the caller waiting forever.
                cont.resumeWithException(ApiError(0, "network"))
                return
            }
            cont.resume(buffered) { _, value, _ -> value.close() }
        }
    })
}

/**
 * The shared client's dispatcher. OkHttp's default allows 5 calls per host, so a few stuck
 * heartbeat, outbox or sync calls could hold a punch in the queue for their whole 30 s read
 * timeout; 16 leaves room for it. Every call this app makes goes to its one API host (presigned
 * photo reads aside), so the overall cap matches.
 */
internal fun kioskDispatcher(): Dispatcher = Dispatcher().apply {
    maxRequests = 16
    maxRequestsPerHost = 16
}

/** Non-2xx → ApiError with detail.code (else unknown_error). Consumes the response. */
internal fun apiErrorFrom(resp: Response): ApiError {
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

/** A query-string value, percent-encoded (spaces as %20). */
internal fun q(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

class OkHttpKioskApi(
    private val client: OkHttpClient,
    private val config: KioskConfig,
    private val session: SessionStore,
    private val route: (OkHttpClient) -> OkHttpClient = { it }, // INTERNET-TEST
) : KioskApi {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    // ── plumbing ────────────────────────────────────────────────────

    private fun <T> jsonBody(strategy: SerializationStrategy<T>, value: T): RequestBody =
        KioskJson.encodeToString(strategy, value).toRequestBody(jsonType)

    private val emptyBody: RequestBody = ByteArray(0).toRequestBody(null)

    private suspend fun execute(request: Request): Response = executeCall(client
        .let(route) // INTERNET-TEST
        , request)

    private suspend fun apiUrl(path: String): String = config.apiUrlNow() + path

    private fun errorFrom(resp: Response): ApiError = apiErrorFrom(resp)

    private fun <T> parse(resp: Response, strategy: DeserializationStrategy<T>): T =
        KioskJson.decodeFromString(strategy, text(resp))

    /** The 2xx body as text, untouched. Consumes the response. */
    private fun text(resp: Response): String = resp.use {
        if (!it.isSuccessful) throw errorFrom(it)
        it.body!!.string()
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

    override suspend fun moveLogin(password: String): SessionData {
        val resp = plain { url(apiUrl("/kiosk/move-login")).post(jsonBody(MoveLoginIn.serializer(), MoveLoginIn(password))) }
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

    override suspend fun setupOptions(): SetupOptions =
        parse(authed { url(apiUrl("/kiosk/setup-options")).get() }, SetupOptions.serializer())

    override suspend fun submitSetup(body: KioskSetupIn): KioskSetupResult =
        parse(authed { url(apiUrl("/kiosk/setup")).post(jsonBody(KioskSetupIn.serializer(), body)) }, KioskSetupResult.serializer())

    override suspend fun syncAssets(initiativeId: String): KioskAssetsSync =
        KioskJson.decodeFromString(KioskAssetsSync.serializer(), assetsSyncRaw(initiativeId))

    override suspend fun syncPeople(): KioskPeopleSync =
        parse(authed { url(apiUrl("/kiosk/sync/people")).get() }, KioskPeopleSync.serializer())

    override suspend fun syncContainers(initiativeId: String): KioskContainersSync =
        parse(authed { url(apiUrl("/kiosk/sync/containers?initiative_id=${q(initiativeId)}")).get() }, KioskContainersSync.serializer())

    override suspend fun syncTrucks(initiativeId: String): KioskTrucksSync =
        parse(authed { url(apiUrl("/kiosk/sync/trucks?initiative_id=${q(initiativeId)}")).get() }, KioskTrucksSync.serializer())

    // ── labels ──────────────────────────────────────────────────────

    override suspend fun assetsSyncRaw(initiativeId: String): String =
        text(authed { url(apiUrl("/kiosk/sync/assets?initiative_id=${q(initiativeId)}")).get() })

    override suspend fun labelTemplatesRaw(initiativeId: String): String =
        text(authed { url(apiUrl("/kiosk/sync/label-templates?initiative_id=${q(initiativeId)}")).get() })

    override suspend fun labelFonts(initiativeId: String): KioskLabelFonts =
        parse(authed { url(apiUrl("/kiosk/labels/fonts?initiative_id=${q(initiativeId)}")).get() }, KioskLabelFonts.serializer())

    override suspend fun labelFontContent(id: String, initiativeId: String): ByteArray {
        val resp = authed { url(apiUrl("/kiosk/labels/fonts/${q(id)}/content?initiative_id=${q(initiativeId)}")).get() }
        return resp.use {
            if (!it.isSuccessful) throw errorFrom(it)
            withContext(Dispatchers.IO) {
                try { it.body!!.bytes() } catch (e: IOException) { throw ApiError(0, "network") }
            }
        }
    }

    // ── scans, RFID, timeclock ──────────────────────────────────────

    override suspend fun postScans(body: KioskScanBatchIn): KioskScanBatchOut =
        parse(authed { url(apiUrl("/kiosk/scans")).post(jsonBody(KioskScanBatchIn.serializer(), body)) }, KioskScanBatchOut.serializer())

    override suspend fun postRfidEnroll(assetId: String, body: KioskRfidEnrollIn): KioskRfidEnroll =
        parse(authed { url(apiUrl("/kiosk/assets/${q(assetId)}/rfid")).post(jsonBody(KioskRfidEnrollIn.serializer(), body)) }, KioskRfidEnroll.serializer())

    override suspend fun timeclockStatus(personId: String, tz: String?): KioskTimeclockStatus {
        val query = tz?.let { "?tz=${q(it)}" } ?: ""
        return parse(authed { url(apiUrl("/kiosk/timeclock/${q(personId)}$query")).get() }, KioskTimeclockStatus.serializer())
    }

    override suspend fun clockIn(body: ClockInIn): KioskTimeclockStatus =
        parse(authed { url(apiUrl("/kiosk/timeclock/clock-in")).post(jsonBody(ClockInIn.serializer(), body)) }, KioskTimeclockStatus.serializer())

    override suspend fun clockOut(body: ClockOutIn): KioskTimeclockStatus =
        parse(authed { url(apiUrl("/kiosk/timeclock/clock-out")).post(jsonBody(ClockOutIn.serializer(), body)) }, KioskTimeclockStatus.serializer())

    // ── station key ─────────────────────────────────────────────────

    override suspend fun issueStationKey(serial: String): String =
        parse(authed { url(apiUrl("/kiosk/station-key")).post(jsonBody(KioskStationKeyIn.serializer(), KioskStationKeyIn(serial))) }, KioskStationKeyOut.serializer()).key
}
