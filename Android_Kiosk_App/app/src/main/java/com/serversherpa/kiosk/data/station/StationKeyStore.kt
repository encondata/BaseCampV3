package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.data.api.SecretStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * This kiosk's Time Clock station key, kept only in the secure store (AndroidSecretStore:
 * EncryptedSharedPreferences under an Android Keystore key) under the account `station_key` —
 * never in plain preferences, never logged. The first read unlocks the Keystore key, so call
 * it off the main thread.
 *
 * The key is bound to the API origin that issued it (`station_key_origin`, beside it). It is
 * handed out only for that origin: asked for under any other one (the API URL was changed, by
 * anyone, signed in or not), it is cleared instead, so it can never be sent to another server.
 */
class StationKeyStore(private val secrets: SecretStore) {
    private val _present = MutableStateFlow<Boolean?>(null)
    /** Whether a usable key is stored: null until the first [get], then kept current by every
     *  read, [put] and clear, so a screen can follow a key that is dropped or arrives. */
    val present: StateFlow<Boolean?> = _present

    /** The key when it was issued by [origin]; a key issued elsewhere is cleared and null returned. */
    fun get(origin: String): String? {
        val key = secrets.get(ACCOUNT)?.takeIf { it.isNotBlank() }
        if (key != null && secrets.get(ORIGIN_ACCOUNT) != origin) { clear(); return null }
        _present.value = key != null
        return key
    }

    fun put(key: String, origin: String) {
        secrets.put(ORIGIN_ACCOUNT, origin)
        secrets.put(ACCOUNT, key)
        _present.value = true
    }

    fun clear() {
        secrets.remove(ACCOUNT)
        secrets.remove(ORIGIN_ACCOUNT)
        _present.value = false
    }

    /** A new API URL was saved: a key issued by any other origin is cleared now. */
    fun keepOnlyFor(origin: String) {
        if (secrets.get(ACCOUNT) != null && secrets.get(ORIGIN_ACCOUNT) != origin) clear()
    }

    companion object {
        const val ACCOUNT = "station_key"
        const val ORIGIN_ACCOUNT = "station_key_origin"
    }
}
