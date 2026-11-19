package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.update.BAD_ANSWER
import com.serversherpa.kiosk.core.update.NO_DEVICES_HOST
import com.serversherpa.kiosk.core.update.UpdateAnswer
import com.serversherpa.kiosk.core.update.UpdateAnswerWire
import com.serversherpa.kiosk.core.update.devicesUrlFor
import com.serversherpa.kiosk.core.update.toAnswer
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.api.SessionStore
import com.serversherpa.kiosk.data.api.apiErrorFrom
import com.serversherpa.kiosk.data.api.executeCall
import com.serversherpa.kiosk.data.api.q
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * Asks the Devices site whether a newer build exists. The kiosk's bearer authenticates, but a 401
 * here never ends the kiosk session: the Devices site is a neighbor, not the API.
 */
class DevicesUpdateClient(
    client: OkHttpClient,
    private val session: SessionStore,
    private val apiUrl: suspend () -> String,
) {
    private val http = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).build()

    /** null when the API URL has no devices host. */
    suspend fun devicesBase(): String? = devicesUrlFor(apiUrl())

    /** Throws ApiError (status 0 = network) on transport/HTTP failure. */
    suspend fun check(packageName: String, versionCode: Long, signingDigest: String): UpdateAnswer {
        val base = devicesBase() ?: return UpdateAnswer.Blocked(NO_DEVICES_HOST)
        val url = "$base/api/updates?platform=android&package=${q(packageName)}" +
            "&version_code=$versionCode&signing_digest=${q(signingDigest)}"
        if (session.tokenIsStale()) session.refresh()
        suspend fun go(): Response {
            val b = Request.Builder().url(url).get()
            session.accessToken()?.let { b.header("Authorization", "Bearer $it") }
            return executeCall(http, b.build())
        }
        var resp = go()
        if (resp.code == 401 && session.refresh() != null) {
            resp.close()
            resp = go()
        }
        val text = resp.use {
            if (!it.isSuccessful) throw apiErrorFrom(it)
            it.body!!.string()
        }
        val wire = try {
            KioskJson.decodeFromString(UpdateAnswerWire.serializer(), text)
        } catch (e: Exception) {
            return UpdateAnswer.Blocked(BAD_ANSWER)
        }
        return wire.toAnswer()
    }
}
