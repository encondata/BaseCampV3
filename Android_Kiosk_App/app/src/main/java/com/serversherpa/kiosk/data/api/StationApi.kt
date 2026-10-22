package com.serversherpa.kiosk.data.api

import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.model.StationClockIn
import kotlinx.serialization.DeserializationStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * A station key together with the API base URL its origin was checked against
 * (StationStatus.credentials). Station calls are built from [baseUrl] alone, never from the
 * configured URL read again, so a URL saved between the check and the call can't receive the
 * key. [toString] leaves the key out.
 */
class StationCredentials(val key: String, val baseUrl: String) {
    override fun toString(): String = "StationCredentials(baseUrl=$baseUrl)"
}

/** A signed-out Time Clock station's calls, under its station key (issued once by
 *  [KioskApi.issueStationKey]). Every call sends only `Authorization: Station <key>` and the
 *  kiosk's serial — never the session's Bearer token, never a refresh, never a session-ended
 *  signal. Implementations throw ApiError on any non-2xx or transport failure:
 *  401 station_key_invalid (drop the key), 403 kiosk_not_registered (keep it),
 *  403 wrong_station_type, 409 already_clocked_in / not_clocked_in, 423 read-only, 0 network. */
interface StationApi {
    /** GET /kiosk/station/sync/people?serial= — the roster for the name and badge doors. */
    suspend fun people(creds: StationCredentials, serial: String): List<KioskPersonRow>
    /** GET /kiosk/station/timeclock/{person_id}?serial=&tz= */
    suspend fun status(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus
    /** POST /kiosk/station/timeclock/clock-in {serial, person_id, tz} */
    suspend fun clockIn(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus
    /** POST /kiosk/station/timeclock/clock-out {serial, person_id, tz} */
    suspend fun clockOut(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus
}

/** Shares the app's OkHttp client and [apiErrorFrom] with [OkHttpKioskApi], but none of its
 *  session handling, and none of its configuration: every request goes to the credentials'
 *  validated base URL. The key is never logged. */
class OkHttpStationApi(
    private val client: OkHttpClient,
) : StationApi {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private suspend fun call(creds: StationCredentials, path: String, configure: Request.Builder.() -> Request.Builder): Response {
        val request = Request.Builder().url(creds.baseUrl + path).configure()
            .header("Authorization", "Station ${creds.key}").build()
        return executeCall(client, request)
    }

    private fun <T> parse(resp: Response, strategy: DeserializationStrategy<T>): T = resp.use {
        if (!it.isSuccessful) throw apiErrorFrom(it)
        KioskJson.decodeFromString(strategy, it.body!!.string())
    }

    private suspend fun punch(path: String, creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus {
        val body = KioskJson.encodeToString(StationClockIn.serializer(), StationClockIn(serial, personId, tz)).toRequestBody(jsonType)
        return parse(call(creds, path) { post(body) }, KioskTimeclockStatus.serializer())
    }

    override suspend fun people(creds: StationCredentials, serial: String): List<KioskPersonRow> =
        parse(call(creds, "/kiosk/station/sync/people?serial=${q(serial)}") { get() }, KioskPeopleSync.serializer()).people

    override suspend fun status(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus =
        parse(call(creds, "/kiosk/station/timeclock/${q(personId)}?serial=${q(serial)}&tz=${q(tz)}") { get() }, KioskTimeclockStatus.serializer())

    override suspend fun clockIn(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus =
        punch("/kiosk/station/timeclock/clock-in", creds, serial, personId, tz)

    override suspend fun clockOut(creds: StationCredentials, serial: String, personId: String, tz: String): KioskTimeclockStatus =
        punch("/kiosk/station/timeclock/clock-out", creds, serial, personId, tz)
}
