package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.StationCredentials
import com.serversherpa.kiosk.data.config.KioskConfig
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

/** The station type a Time Clock station saves with its setup. */
const val TIMECLOCK_STATION = "timeclock"

/**
 * What a Time Clock station's Welcome needs to know about its key (constraints, station errors):
 *  - 401 `station_key_invalid` and 403 `wrong_station_type` drop the key, and Welcome waits for
 *    a new one ([hasKey] false);
 *  - 403 `kiosk_not_registered` keeps the key and pauses the station ([paused]) until a call
 *    goes through again (someone signs in here, or an admin renews it on Kiosk Devices).
 * The key is read on [io], never the main thread (the first read unlocks the Keystore).
 */
class StationStatus(
    private val keys: StationKeyStore,
    /** The configured API base URL right now (KioskConfig.apiUrlNow): a key is used only at
     *  the origin that issued it. */
    private val apiBase: suspend () -> String,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused
    /** Null until the key has been read once. */
    val hasKey: StateFlow<Boolean?> = keys.present

    /**
     * The key with the base URL it was checked against, only when that URL's origin is the one
     * that issued the key; otherwise the key is cleared and null comes back (Welcome then waits
     * for a key, and nothing is sent). Station calls use the returned base URL and never read
     * the configuration again, so the key can't follow a URL saved after this check.
     */
    suspend fun credentials(): StationCredentials? {
        val base = apiBase()
        val origin = KioskConfig.originOf(base) ?: base
        return withContext(io) { keys.get(origin) }?.let { StationCredentials(it, base) }
    }

    /** Stores a freshly issued key, bound to [origin]: the API origin it was issued by. */
    suspend fun store(key: String, origin: String) = withContext(io) { keys.put(key, origin) }

    /** Drops the key (a new setup, Clear Setup, a dropped move setup). */
    suspend fun drop() = withContext(io) { keys.clear() }

    /** The configured API's origin, for a key about to be issued. */
    suspend fun origin(): String = apiBase().let { KioskConfig.originOf(it) ?: it }

    /** A station call went through: the station is running. */
    fun ok() { _paused.value = false }

    /** A station call failed: drop the key or pause, as the error says. */
    suspend fun failed(e: ApiError) {
        when {
            e.status == 401 || (e.status == 403 && e.code == "wrong_station_type") -> withContext(io) { keys.clear() }
            e.status == 403 && e.code == "kiosk_not_registered" -> _paused.value = true
        }
    }
}

/**
 * Issues this kiosk's key and stores it bound to the API origin it was asked of (read before
 * the call, so a URL saved meanwhile can't adopt it). Throws ApiError.
 */
suspend fun StationStatus.issueAndStore(api: KioskApi, serial: String, signInBeat: suspend () -> Unit) {
    val origin = origin()
    store(issueStationKeyRetrying(api, serial, signInBeat), origin)
}

/**
 * `POST /kiosk/station-key` for this kiosk. The portal issues the key only to the person its
 * device row says is signed in here, which a sign-in heartbeat records; when that beat hasn't
 * landed (403 `not_signed_in_here`), [signInBeat] sends one and the issue is tried once more.
 */
suspend fun issueStationKeyRetrying(api: KioskApi, serial: String, signInBeat: suspend () -> Unit): String =
    try {
        api.issueStationKey(serial)
    } catch (e: ApiError) {
        if (e.status != 403 || e.code != "not_signed_in_here") throw e
        signInBeat()
        api.issueStationKey(serial)
    }
