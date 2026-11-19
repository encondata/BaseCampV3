package com.serversherpa.kiosk.data.push

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate

/** A tapped push alert: the notification to open, and whose it is ([ownerPersonId]; null when the
 *  alert didn't say). */
data class OpenNotification(val notificationId: String, val ownerPersonId: String?)

/**
 * The one-shot pending route a push alert's tap leaves (spec: "Android app" › Tap). MainActivity
 * offers the tap's extras in onCreate and onNewIntent; the shell takes it once someone is signed
 * in (ui/shell/KioskShell.kt PendingNotificationRedirect). It is held, untouched, across the
 * sign-in page, and a newer tap replaces an older one.
 */
class PendingOpen {
    private val _pending = MutableStateFlow<OpenNotification?>(null)
    val pending: StateFlow<OpenNotification?> = _pending.asStateFlow()

    fun offer(open: OpenNotification) { _pending.value = open }

    /** Holds [intent]'s open when it is an alert's tap with a notification id; true when it was.
     *  A relaunch from Recents hands back the old tap's intent: that opens nothing again. */
    fun offer(intent: Intent?): Boolean {
        if (intent?.action != PushNotifier.ACTION_OPEN_NOTIFICATION) return false
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
        val id = intent.getStringExtra(PushNotifier.EXTRA_OPEN_NOTIFICATION_ID)?.takeIf { it.isNotBlank() } ?: return false
        offer(OpenNotification(id, intent.getStringExtra(PushNotifier.EXTRA_OWNER_PERSON_ID)?.takeIf { it.isNotBlank() }))
        return true
    }

    /** The pending open, cleared as it is read: only one caller ever gets it. */
    fun take(): OpenNotification? = _pending.getAndUpdate { null }
}
