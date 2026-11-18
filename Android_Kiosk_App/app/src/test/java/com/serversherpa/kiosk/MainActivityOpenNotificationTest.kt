package com.serversherpa.kiosk

import android.app.Activity
import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.serversherpa.kiosk.data.push.OpenNotification
import com.serversherpa.kiosk.data.push.PendingOpen
import com.serversherpa.kiosk.data.push.PushNotifier
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/** A push alert's tap reaches [MainActivity] (singleTask) in onCreate or onNewIntent; either way
 *  its extras become the container's one-shot pending open. Every activity built here is
 *  destroyed before the test ends (as in MainActivityConfigTest). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestKioskApplication::class)
class MainActivityOpenNotificationTest {
    private val app = ApplicationProvider.getApplicationContext<TestKioskApplication>()
    private val built = mutableListOf<ActivityController<*>>()

    private fun tap(id: String, owner: String?) = Intent(app, MainActivity::class.java)
        .setAction(PushNotifier.ACTION_OPEN_NOTIFICATION)
        .putExtra(PushNotifier.EXTRA_OPEN_NOTIFICATION_ID, id)
        .apply { if (owner != null) putExtra(PushNotifier.EXTRA_OWNER_PERSON_ID, owner) }

    private fun <A : Activity> build(type: Class<A>, intent: Intent): ActivityController<A> =
        Robolectric.buildActivity(type, intent).also { built += it }

    @After fun closeEveryActivity() {
        built.forEach { it.close() }
        built.clear()
        shadowOf(Looper.getMainLooper()).idle()
        val monitor = ActivityLifecycleMonitorRegistry.getInstance()
        val alive = Stage.values().filter { it != Stage.DESTROYED }.flatMap { monitor.getActivitiesInStage(it) }
        assertTrue("activities left alive: $alive", alive.isEmpty())
    }

    @Test fun a_cold_start_from_a_tap_holds_the_open() {
        build(MainActivity::class.java, tap("n1", "p1")).setup()
        assertEquals(OpenNotification("n1", "p1"), app.container.pendingOpen.pending.value)
    }

    @Test fun a_tap_while_running_arrives_in_on_new_intent() {
        val controller = build(MainActivity::class.java, Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)).setup()
        assertNull(app.container.pendingOpen.pending.value)
        controller.newIntent(tap("n2", "p1"))
        assertEquals(OpenNotification("n2", "p1"), app.container.pendingOpen.pending.value)
    }

    @Test fun only_a_tap_with_an_id_counts() {
        val p = PendingOpen()
        assertFalse(p.offer(Intent(Intent.ACTION_MAIN)))
        assertFalse(p.offer(Intent(PushNotifier.ACTION_OPEN_NOTIFICATION)))
        assertFalse(p.offer(null))
        assertNull(p.pending.value)
        // Relaunched from Recents, the old tap's intent comes back: it opens nothing again.
        assertFalse(p.offer(tap("n1", "p1").addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)))
        assertNull(p.pending.value)
        assertTrue(p.offer(tap("n1", null)))
        assertEquals(OpenNotification("n1", null), p.pending.value)
        // One shot: taken once, then gone.
        assertEquals(OpenNotification("n1", null), p.take())
        assertNull(p.take())
        assertNull(p.pending.value)
    }
}
