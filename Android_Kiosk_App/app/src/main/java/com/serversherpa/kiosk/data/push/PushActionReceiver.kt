package com.serversherpa.kiosk.data.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.serversherpa.kiosk.KioskApplication
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.KioskApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The alert's Snooze and Mark read buttons, from the lock screen too: no session, only the push key
 * (spec decision 12). [run] answers whether the alert should come down:
 * - done: yes.
 * - 404, or 409 not_live: it was already read, hidden or removed elsewhere, so yes.
 * - 401 push_key_invalid: the key is dead, so it is dropped (like a token update's refusal, never
 *   retried); the alert stays.
 * - no key for the configured API, read-only mode, the network, a slow server: the alert stays so
 *   the admin can try again.
 * The key is never logged.
 */
class PushActions(
    private val api: KioskApi,
    private val store: PushKeyStore,
    private val apiBase: suspend () -> String,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /** Under a broadcast's time limit, so the receiver always finishes. */
    private val timeoutMillis: Long = 8_000,
) {
    suspend fun run(action: String, notificationId: String): Boolean {
        val key = withContext(io) { store.get(apiBase()) } ?: return false
        return try {
            withTimeoutOrNull(timeoutMillis) {
                when (action) {
                    PushActionReceiver.ACTION_SNOOZE -> api.pushSnooze(notificationId, key)
                    PushActionReceiver.ACTION_READ -> api.pushRead(notificationId, key)
                    else -> return@withTimeoutOrNull null
                }
                true
            } ?: false
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            when {
                e.status == 404 -> true
                e.status == 409 && e.code == "not_live" -> true
                e.status == 401 && e.code == "push_key_invalid" -> { withContext(io) { store.clear() }; false }
                else -> false
            }
        } catch (_: Exception) {
            false
        }
    }
}

/**
 * Receives the alert buttons' broadcasts (not exported: only this app's own PendingIntents reach
 * it). The call runs past onReceive under goAsync, on the app's scope, and the alert is taken down
 * when [PushActions.run] says so.
 */
open class PushActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != ACTION_SNOOZE && action != ACTION_READ) return
        val notificationId = intent.getStringExtra(EXTRA_NOTIFICATION_ID)?.takeIf { it.isNotBlank() } ?: return
        val actions = actions(context) ?: return
        val pending: PendingResult? = goAsync()
        val app = context.applicationContext
        scope(context).launch {
            try {
                if (actions.run(action, notificationId)) PushNotifier(app).clear(notificationId)
            } finally {
                pending?.finish()
            }
        }
    }

    /** The app's [PushActions]; a test receiver hands in its own. */
    internal open fun actions(context: Context): PushActions? =
        (context.applicationContext as? KioskApplication)?.container?.pushActions

    /** Where the call runs: the app's own scope, not tied to any screen. */
    internal open fun scope(context: Context): CoroutineScope =
        (context.applicationContext as? KioskApplication)?.container?.scope ?: CoroutineScope(Dispatchers.Default)

    companion object {
        const val ACTION_SNOOZE = "com.serversherpa.kiosk.push.SNOOZE"
        const val ACTION_READ = "com.serversherpa.kiosk.push.MARK_READ"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }
}
