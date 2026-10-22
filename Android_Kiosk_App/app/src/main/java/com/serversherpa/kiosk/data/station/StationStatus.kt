package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.KioskApi
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
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused
    /** Null until the key has been read once. */
    val hasKey: StateFlow<Boolean?> = keys.present

    suspend fun key(): String? = withContext(io) { keys.get() }

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
