package com.serversherpa.kiosk.data.push

/**
 * This install's Firebase Cloud Messaging token. The app's one seam over Firebase: only
 * [FirebaseFcmTokens] touches it, and tests use a fake.
 */
interface FcmTokens {
    /** False in a build without a Firebase project ([NoFcmTokens]): push can't be set up at all. */
    val available: Boolean get() = true

    /** The current token (fetched or refreshed as needed). Throws [PushUnavailable] when this
     *  build has no Firebase project, or any other exception when FCM can't be reached. */
    suspend fun token(): String

    /** Deletes the token on this phone, so FCM stops delivering to it. */
    suspend fun delete()
}

/** Thrown by [FcmTokens.token] when this build has no Firebase project (no google-services.json). */
class PushUnavailable : Exception("push_unavailable")

/** A build without a Firebase project: there is no token to get, and none to delete. */
object NoFcmTokens : FcmTokens {
    override val available: Boolean get() = false
    override suspend fun token(): String = throw PushUnavailable()
    override suspend fun delete() { }
}
