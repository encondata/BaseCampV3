package com.serversherpa.kiosk.data.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The token from Firebase Cloud Messaging. The manifest turns FCM's auto-init off
 * (`firebase_messaging_auto_init_enabled`), so a shared kiosk never fetches a token or talks to
 * FCM: [token] turns it on for this phone ("This is my phone"), which also lets FCM refresh the
 * token on later starts, and [delete] turns it off again. Both settings persist across launches.
 */
class FirebaseFcmTokens : FcmTokens {
    override suspend fun token(): String {
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true
        return messaging.token.await()
    }

    override suspend fun delete() {
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = false
        messaging.deleteToken().await()
    }

    companion object {
        /** [FirebaseFcmTokens] when this build has a Firebase project (google-services.json, read by
         *  Firebase's own startup into the default app), else [NoFcmTokens]. */
        fun forApp(context: Context): FcmTokens =
            if (FirebaseApp.getApps(context).isNotEmpty()) FirebaseFcmTokens() else NoFcmTokens
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { task ->
        val error = task.exception
        when {
            error != null -> cont.resumeWithException(error)
            task.isCanceled -> cont.cancel()
            else -> cont.resume(task.result)
        }
    }
}
