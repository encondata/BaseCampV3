package com.serversherpa.kiosk.data.push

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import com.serversherpa.kiosk.MainActivity
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushNotifierTest {
    private val app: Application = RuntimeEnvironment.getApplication()
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val notifier = PushNotifier(app)

    private val data = mapOf(
        "type" to "notification",
        "notification_id" to "4f1c2a90-0000-4000-8000-000000000001",
        "person_id" to "p1",
        "kind" to "move.status",
        "title" to "Move 12 is on hold",
        "body" to "The truck is late.",
        "critical" to "false",
        "created_at" to "2026-11-17T14:32:05.123456+00:00",
    )

    @Before fun setUp() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        PushNotifier.createChannels(app)       // what KioskApplication does at start
    }

    private fun show(extra: Map<String, String> = emptyMap()): Notification {
        notifier.show(PushMessage.parse(data + extra)!!)
        val id = (data + extra).getValue("notification_id")
        return checkNotNull(shadowOf(manager).getNotification(id.hashCode())) { "no notification posted" }
    }

    @Test fun parse_notification_and_clear() {
        assertEquals(
            PushMessage.Notification(
                notificationId = "4f1c2a90-0000-4000-8000-000000000001", personId = "p1", kind = "move.status",
                title = "Move 12 is on hold", body = "The truck is late.", critical = false,
                createdAt = "2026-11-17T14:32:05.123456+00:00",
            ),
            PushMessage.parse(data),
        )
        assertEquals(true, (PushMessage.parse(data + ("critical" to "true")) as PushMessage.Notification).critical)
        assertEquals(PushMessage.Clear("n-9"), PushMessage.parse(mapOf("type" to "clear", "notification_id" to "n-9")))
    }

    @Test fun parse_unknown_type_null() {
        assertNull(PushMessage.parse(data + ("type" to "something_new")))
        assertNull(PushMessage.parse(mapOf("notification_id" to "n-9")))
        assertNull("no id, nothing to show or clear", PushMessage.parse(mapOf("type" to "clear")))
        assertNull(PushMessage.parse(data - "notification_id"))
    }

    @Test fun channels_created_at_start() {
        // Both pop up as a banner with sound, like a text message (Jimmy, 2026-11-18).
        val normal = manager.getNotificationChannel("alerts")
        assertEquals("Notifications", normal.name)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, normal.importance)
        val critical = manager.getNotificationChannel("critical")
        assertEquals("Critical alerts", critical.name)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, critical.importance)
    }

    @Test fun the_old_quiet_channel_is_removed() {
        // Android never raises an existing channel's importance, so the first release's
        // default-level "notifications" channel is replaced, not changed.
        manager.createNotificationChannel(
            android.app.NotificationChannel("notifications", "Notifications", NotificationManager.IMPORTANCE_DEFAULT))
        PushNotifier.createChannels(app)
        assertNull(manager.getNotificationChannel("notifications"))
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel("alerts").importance)
    }

    @Test fun critical_goes_to_critical_channel() {
        assertEquals("alerts", show().channelId)
        assertEquals("critical", show(mapOf("notification_id" to "n-2", "critical" to "true")).channelId)
    }

    @Test fun shows_title_body_and_time_from_created_at() {
        val n = show()
        assertEquals("Move 12 is on hold", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("The truck is late.", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(OffsetDateTime.parse("2026-11-17T14:32:05.123456+00:00").toInstant().toEpochMilli(), n.`when`)
        assertTrue(n.extras.getBoolean(Notification.EXTRA_SHOW_WHEN))
    }

    @Test fun private_visibility_with_public_version() {
        val n = show()
        assertEquals(Notification.VISIBILITY_PRIVATE, n.visibility)
        val public = checkNotNull(n.publicVersion) { "no public version" }
        assertEquals("ServerSherpa", public.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("New notification", public.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }

    @Test fun has_snooze_and_mark_read_actions() {
        val n = show()
        assertEquals(listOf("Snooze", "Mark read"), n.actions.map { it.title.toString() })
        val (snooze, read) = n.actions.map { shadowOf(it.actionIntent) }
        assertTrue(snooze.isBroadcast)
        assertEquals(PushActionReceiver::class.java.name, snooze.savedIntent.component!!.className)
        assertEquals(PushActionReceiver.ACTION_SNOOZE, snooze.savedIntent.action)
        assertEquals(data["notification_id"], snooze.savedIntent.getStringExtra(PushActionReceiver.EXTRA_NOTIFICATION_ID))
        assertEquals(PushActionReceiver.ACTION_READ, read.savedIntent.action)
        assertEquals(data["notification_id"], read.savedIntent.getStringExtra(PushActionReceiver.EXTRA_NOTIFICATION_ID))
        assertTrue(n.actions.all { it.actionIntent.isImmutable })
    }

    @Test fun content_intent_opens_main_activity_with_ids() {
        val n = show()
        val tap = shadowOf(n.contentIntent)
        assertTrue(tap.isActivity)
        assertTrue(n.contentIntent.isImmutable)
        assertEquals(MainActivity::class.java.name, tap.savedIntent.component!!.className)
        assertEquals(data["notification_id"], tap.savedIntent.getStringExtra(PushNotifier.EXTRA_OPEN_NOTIFICATION_ID))
        assertEquals("p1", tap.savedIntent.getStringExtra(PushNotifier.EXTRA_OWNER_PERSON_ID))
        assertEquals(data.getValue("notification_id").hashCode(), tap.requestCode)
        // Another notification's tap is its own PendingIntent, not this one's extras overwritten.
        val other = show(mapOf("notification_id" to "n-2", "person_id" to "p1"))
        assertEquals("n-2", shadowOf(other.contentIntent).savedIntent.getStringExtra(PushNotifier.EXTRA_OPEN_NOTIFICATION_ID))
        assertEquals(data["notification_id"], shadowOf(n.contentIntent).savedIntent.getStringExtra(PushNotifier.EXTRA_OPEN_NOTIFICATION_ID))
    }

    @Test fun repush_replaces_rather_than_stacks() {
        show()
        show(mapOf("title" to "Move 12 is on hold (again)"))
        assertEquals(1, shadowOf(manager).allNotifications.size)
        assertEquals("Move 12 is on hold (again)",
            shadowOf(manager).allNotifications.single().extras.getCharSequence(Notification.EXTRA_TITLE).toString())
    }

    @Test fun clear_cancels_by_id() {
        show()
        show(mapOf("notification_id" to "n-2"))
        notifier.show(PushMessage.parse(mapOf("type" to "clear", "notification_id" to data.getValue("notification_id")))!!)
        assertNull(shadowOf(manager).getNotification(data.getValue("notification_id").hashCode()))
        assertNotNull(shadowOf(manager).getNotification("n-2".hashCode()))
        notifier.clear("n-2")
        assertEquals(0, shadowOf(manager).allNotifications.size)
    }

    @Test fun no_permission_posts_nothing() {
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        notifier.show(PushMessage.parse(data)!!)
        assertEquals(0, shadowOf(manager).allNotifications.size)
    }

    @Test fun notifications_off_posts_nothing() {
        shadowOf(manager).setNotificationsEnabled(false)
        notifier.show(PushMessage.parse(data)!!)
        assertEquals(0, shadowOf(manager).allNotifications.size)
    }

    @Test fun bad_created_at_still_shows() {
        val n = show(mapOf("created_at" to "not a time"))
        assertTrue(n.`when` > 0)
    }
}
