package com.serversherpa.kiosk.data.api

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Where the refresh cookie lives at rest. */
interface SecretStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

class MemorySecretStore : SecretStore {
    private val map = HashMap<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
}

/** EncryptedSharedPreferences "kiosk_session" under an Android Keystore master key. */
class AndroidSecretStore(context: Context) : SecretStore {
    private val prefs = EncryptedSharedPreferences.create(
        context, "kiosk_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
}
