package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.model.StationClockIn
import com.serversherpa.kiosk.data.config.KioskConfig
import kotlinx.serialization.DeserializationStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** A signed-out Time Clock station's calls, under its station key (issued once by
 *  [KioskApi.issueStationKey]). Every call sends only `Authorization: Station <key>` and the
 *  kiosk's serial — never the session's Bearer token, never a refresh, never a session-ended
 *  signal. Implementations throw ApiError on any non-2xx or transport failure:
 *  401 station_key_invalid (drop the key), 403 kiosk_not_registered (keep it),
 *  403 wrong_station_type, 409 already_clocked_in / not_clocked_in, 423 read-only, 0 network. */
interface StationApi {
    /** GET /kiosk/station/sync/people?serial= — the roster for the name and badge doors. */
    suspend fun people(key: String, serial: String): List<KioskPersonRow>
    /** GET /kiosk/station/timeclock/{person_id}?serial=&tz= */
    suspend fun status(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus
    /** POST /kiosk/station/timeclock/clock-in {serial, person_id, tz} */
    suspend fun clockIn(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus
    /** POST /kiosk/station/timeclock/clock-out {serial, person_id, tz} */
    suspend fun clockOut(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus
}

/** Shares the app's OkHttp client and [apiErrorFrom] with [OkHttpKioskApi], but none of its
 *  session handling. The key is never logged. */
class OkHttpStationApi(
    private val client: OkHttpClient,
    private val config: KioskConfig,
) : StationApi {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private suspend fun call(key: String, path: String, configure: Request.Builder.() -> Request.Builder): Response {
        val request = Request.Builder().url(config.apiUrlNow() + path).configure()
            .header("Authorization", "Station $key").build()
        return executeCall(client, request)
    }

    private fun <T> parse(resp: Response, strategy: DeserializationStrategy<T>): T = resp.use {
        if (!it.isSuccessful) throw apiErrorFrom(it)
        KioskJson.decodeFromString(strategy, it.body!!.string())
    }

    private suspend fun punch(path: String, key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus {
        val body = KioskJson.encodeToString(StationClockIn.serializer(), StationClockIn(serial, personId, tz)).toRequestBody(jsonType)
        return parse(call(key, path) { post(body) }, KioskTimeclockStatus.serializer())
    }

    override suspend fun people(key: String, serial: String): List<KioskPersonRow> =
        parse(call(key, "/kiosk/station/sync/people?serial=${q(serial)}") { get() }, KioskPeopleSync.serializer()).people

    override suspend fun status(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus =
        parse(call(key, "/kiosk/station/timeclock/${q(personId)}?serial=${q(serial)}&tz=${q(tz)}") { get() }, KioskTimeclockStatus.serializer())

    override suspend fun clockIn(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus =
        punch("/kiosk/station/timeclock/clock-in", key, serial, personId, tz)

    override suspend fun clockOut(key: String, serial: String, personId: String, tz: String): KioskTimeclockStatus =
        punch("/kiosk/station/timeclock/clock-out", key, serial, personId, tz)
}
