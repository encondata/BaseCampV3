package com.serversherpa.kiosk.data.push

import com.serversherpa.kiosk.data.api.SecretStore
import com.serversherpa.kiosk.data.config.KioskConfig

/**
 * A push registration's key, with the API base URL it was checked against
 * ([PushKeyStore.get]). The push-key call is built from [baseUrl] alone, never from the configured
 * URL read again, so a URL saved between the check and the call can't receive the key.
 * [toString] leaves the key out.
 */
class PushKey(val registrationId: String, val key: String, val baseUrl: String) {
    /** The whole `Authorization` value (api/.../services/push_registrations.py, SCHEME). */
    val header: String get() = "PushKey $registrationId.$key"

    override fun toString(): String = "PushKey(registrationId=$registrationId, baseUrl=$baseUrl)"
}

/**
 * This phone's push key, kept only in the secure store (AndroidSecretStore: EncryptedSharedPreferences
 * under an Android Keystore key) under `push.registration_id` and `push.key`, never in plain
 * preferences, never logged. The first read unlocks the Keystore key, so call it off the main thread.
 *
 * Like the station key, it is bound to the API origin that issued it (`push.origin`): asked for
 * under any other origin, it is cleared instead, so it never reaches another server.
 * `push.person_id` is whose registration it is, so another admin signed in on the owner's phone
 * never clears or replaces the owner's key.
 * `push.token_pending` marks a token update to send again on the next app start.
 */
class PushKeyStore(private val secrets: SecretStore) {

    /** The key when it was issued by [baseUrl]'s origin; a key issued elsewhere is cleared and null returned. */
    @Synchronized
    fun get(baseUrl: String): PushKey? {
        val id = secrets.get(REGISTRATION_ID)?.takeIf { it.isNotBlank() }
        val key = secrets.get(KEY)?.takeIf { it.isNotBlank() }
        if (id == null || key == null) return null
        if (secrets.get(ORIGIN) != originOf(baseUrl)) { clear(); return null }
        return PushKey(id, key, baseUrl)
    }

    /** Clears first, then writes the key, its id, its person and its origin: an app killed between
     *  two writes leaves no key or an unbound one (cleared on its next read), never an old key
     *  under a new id. */
    @Synchronized
    fun save(registrationId: String, key: String, origin: String, personId: String) {
        clear()
        secrets.put(KEY, key)
        secrets.put(REGISTRATION_ID, registrationId)
        secrets.put(PERSON_ID, personId)
        secrets.put(ORIGIN, origin)
    }

    /** Whether any key is stored, whatever its origin. */
    @Synchronized
    fun hasKey(): Boolean = !secrets.get(KEY).isNullOrBlank()

    /** The person whose registration the stored key is (the phone's owner when it was made). */
    @Synchronized
    fun personId(): String? = secrets.get(PERSON_ID)

    @Synchronized
    fun clear() {
        secrets.remove(REGISTRATION_ID)
        secrets.remove(KEY)
        secrets.remove(PERSON_ID)
        secrets.remove(ORIGIN)
        secrets.remove(TOKEN_PENDING)
    }

    /** A token update failed for a reason worth trying again (network, read-only mode). */
    @Synchronized
    fun retryPending(): Boolean = secrets.get(TOKEN_PENDING) == "1"

    @Synchronized
    fun setRetryPending(pending: Boolean) {
        if (pending) secrets.put(TOKEN_PENDING, "1") else secrets.remove(TOKEN_PENDING)
    }

    companion object {
        const val REGISTRATION_ID = "push.registration_id"
        const val KEY = "push.key"
        const val ORIGIN = "push.origin"
        const val PERSON_ID = "push.person_id"
        const val TOKEN_PENDING = "push.token_pending"

        fun originOf(baseUrl: String): String = KioskConfig.originOf(baseUrl) ?: baseUrl
    }
}
