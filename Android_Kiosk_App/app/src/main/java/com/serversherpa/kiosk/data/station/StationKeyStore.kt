package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.data.api.SecretStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** This kiosk's Time Clock station key, kept only in the secure store (AndroidSecretStore:
 *  EncryptedSharedPreferences under an Android Keystore key) under the account `station_key` —
 *  never in plain preferences, never logged. The first read unlocks the Keystore key, so call
 *  it off the main thread. */
class StationKeyStore(private val secrets: SecretStore) {
    private val _present = MutableStateFlow<Boolean?>(null)
    /** Whether a key is stored: null until the first [get], then kept current by every read,
     *  [put] and [clear], so a screen can follow a key that is dropped or arrives. */
    val present: StateFlow<Boolean?> = _present

    fun get(): String? = secrets.get(ACCOUNT)?.takeIf { it.isNotBlank() }.also { _present.value = it != null }
    fun put(key: String) { secrets.put(ACCOUNT, key); _present.value = true }
    fun clear() { secrets.remove(ACCOUNT); _present.value = false }

    companion object { const val ACCOUNT = "station_key" }
}
