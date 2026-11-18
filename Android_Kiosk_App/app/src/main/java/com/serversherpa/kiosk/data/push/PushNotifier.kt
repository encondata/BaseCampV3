package com.serversherpa.kiosk.data.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.MainActivity
import com.serversherpa.kiosk.R
import java.time.Instant
import java.time.OffsetDateTime

/**
 * Shows and takes down push alerts (spec: "Android app" › FirebaseMessagingService). Each alert's
 * Android id is the notification id's hash, so a snooze push replaces its alert and a clear finds it.
 * Alerts are private: a phone hiding sensitive content shows only the public version on the lock
 * screen. Nothing is posted while notifications are off for the app (on Android 13+, until
 * POST_NOTIFICATIONS is granted).
 */
class PushNotifier(private val context: Context) {

    fun show(msg: PushMessage) {
        when (msg) {
            is PushMessage.Clear -> clear(msg.notificationId)
            is PushMessage.Notification -> post(msg)
        }
    }

    fun clear(notificationId: String) {
        NotificationManagerCompat.from(context).cancel(androidId(notificationId))
    }

    private fun post(msg: PushMessage.Notification) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val id = androidId(msg.notificationId)
        val channel = if (msg.critical) CHANNEL_CRITICAL else CHANNEL_NOTIFICATIONS
        val public = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle(PUBLIC_TITLE)
            .setContentText(PUBLIC_TEXT)
            .build()
        val alert = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle(msg.title.ifBlank { PUBLIC_TITLE })
            .setContentText(msg.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(msg.body))
            .setWhen(whenOf(msg.createdAt))
            .setShowWhen(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setAutoCancel(true)
            .setContentIntent(openIntent(msg, id))
            .addAction(0, SNOOZE, actionIntent(PushActionReceiver.ACTION_SNOOZE, msg.notificationId, id))
            .addAction(0, MARK_READ, actionIntent(PushActionReceiver.ACTION_READ, msg.notificationId, id))
            .build()
        manager.notify(id, alert)
    }

    /** Opens the app on this notification (Task 12 reads the extras). Its own request code, so
     *  another alert's tap never overwrites these extras. */
    private fun openIntent(msg: PushMessage.Notification, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_NOTIFICATION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN_NOTIFICATION_ID, msg.notificationId)
            .putExtra(EXTRA_OWNER_PERSON_ID, msg.personId)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun actionIntent(action: String, notificationId: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, PushActionReceiver::class.java)
            .setAction(action)
            .putExtra(PushActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        /** Ordinary alerts. Both channels are high importance, so alerts pop up as a banner with
         *  sound and their buttons, like a text message (Jimmy, 2026-11-18). The id changed from
         *  "notifications" because Android never raises an existing channel's importance. */
        const val CHANNEL_NOTIFICATIONS = "alerts"
        const val CHANNEL_CRITICAL = "critical"
        private const val OLD_CHANNEL_NOTIFICATIONS = "notifications"
        const val ACTION_OPEN_NOTIFICATION = "com.serversherpa.kiosk.push.OPEN_NOTIFICATION"
        const val EXTRA_OPEN_NOTIFICATION_ID = "open_notification_id"
        const val EXTRA_OWNER_PERSON_ID = "owner_person_id"

        private const val PUBLIC_TITLE = "ServerSherpa"
        private const val PUBLIC_TEXT = "New notification"
        private const val SNOOZE = "Snooze"
        private const val MARK_READ = "Mark read"

        fun androidId(notificationId: String): Int = notificationId.hashCode()

        /** The two channels, made at app start (KioskApplication); making them again changes nothing.
         *  Removes the first release's quiet "notifications" channel. */
        fun createChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            manager.deleteNotificationChannel(OLD_CHANNEL_NOTIFICATIONS)
            manager.createNotificationChannels(listOf(
                NotificationChannel(CHANNEL_NOTIFICATIONS, "Notifications", NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CHANNEL_CRITICAL, "Critical alerts", NotificationManager.IMPORTANCE_HIGH),
            ))
        }

        /** The alert's time from `created_at` (the system shows it in the phone's clock format);
         *  now when it can't be read. */
        internal fun whenOf(createdAt: String): Long = try {
            OffsetDateTime.parse(createdAt).toInstant().toEpochMilli()
        } catch (_: Exception) {
            try { Instant.parse(createdAt).toEpochMilli() } catch (_: Exception) { System.currentTimeMillis() }
        }
    }
}
