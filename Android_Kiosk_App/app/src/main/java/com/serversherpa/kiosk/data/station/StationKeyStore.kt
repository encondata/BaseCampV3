package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.data.api.SecretStore

/** This kiosk's Time Clock station key, kept only in the secure store (AndroidSecretStore:
 *  EncryptedSharedPreferences under an Android Keystore key) under the account `station_key` —
 *  never in plain preferences, never logged. The first read unlocks the Keystore key, so call
 *  it off the main thread. */
class StationKeyStore(private val secrets: SecretStore) {
    fun get(): String? = secrets.get(ACCOUNT)?.takeIf { it.isNotBlank() }
    fun put(key: String) = secrets.put(ACCOUNT, key)
    fun clear() = secrets.remove(ACCOUNT)

    companion object { const val ACCOUNT = "station_key" }
}
