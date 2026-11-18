package com.serversherpa.kiosk.data.push

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PushSnooze
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.api.SecretStore
import java.io.IOException
import java.security.GeneralSecurityException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class PushActionReceiverTest {
    private val base = "https://api.example.com"
    private val app: Application = RuntimeEnvironment.getApplication()
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val api = FakeKioskApi()
    private val store = PushKeyStore(MemorySecretStore())
    private val actions = PushActions(api, store, apiBase = { base }, io = Dispatchers.Unconfined, timeoutMillis = 200)
    private val id = "4f1c2a90-0000-4000-8000-000000000001"

    private val work = SupervisorJob()

    /** The real receiver, over the fakes; [press] waits for its work to end. */
    private val receiver = object : PushActionReceiver() {
        override fun actions(context: Context): PushActions = this@PushActionReceiverTest.actions
        override fun scope(context: Context): CoroutineScope = CoroutineScope(work + Dispatchers.Unconfined)
    }

    @Before fun setUp() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        PushNotifier.createChannels(app)
        store.save("reg-1", "push-key-1", "https://api.example.com:443", "p1")
        PushNotifier(app).show(PushMessage.parse(mapOf(
            "type" to "notification", "notification_id" to id, "person_id" to "p1", "kind" to "move.status",
            "title" to "Move 12 is on hold", "body" to "The truck is late.", "critical" to "false",
            "created_at" to "2026-11-17T14:32:05+00:00",
        ))!!)
    }

    private fun alert() = shadowOf(manager).getNotification(id.hashCode())

    /** The intent the alert's button carries ([index] 0 = Snooze, 1 = Mark read), delivered. */
    private fun press(index: Int) {
        val intent: Intent = shadowOf(alert()!!.actions[index].actionIntent).savedIntent
        receiver.onReceive(app, intent)
        runBlocking { work.children.toList().joinAll() }
    }

    @Test fun snooze_action_calls_api_and_cancels() {
        api.pushSnoozeResult = { _, _ -> PushSnooze("2026-11-17T14:37:05+00:00") }
        press(0)
        assertEquals(listOf("pushSnooze"), api.calls)
        assertEquals(id, api.pushActions.single().first)
        assertEquals("PushKey reg-1.push-key-1", api.pushActions.single().second.header)
        assertEquals(base, api.pushActions.single().second.baseUrl)
        assertNull(alert())
    }

    @Test fun mark_read_action_calls_api_and_cancels() {
        press(1)
        assertEquals(listOf("pushRead"), api.calls)
        assertEquals(id, api.pushActions.single().first)
        assertNull(alert())
    }

    @Test fun failed_action_keeps_alert() {
        api.pushSnoozeResult = { _, _ -> throw ApiError(0, "network") }
        press(0)
        assertNotNull(alert())
        api.pushReadResult = { _, _ -> throw IOException("offline") }
        press(1)
        assertNotNull(alert())
        api.pushReadResult = { _, _ -> throw ApiError(423, "read_only") }
        press(1)
        assertNotNull(alert())
        assertTrue("the key stays for the next try", store.hasKey())
    }

    @Test fun slow_server_keeps_alert() {
        api.pushReadResult = { _, _ -> awaitCancellation() }
        press(1)
        assertNotNull(alert())
    }

    @Test fun already_handled_elsewhere_cancels() {
        api.pushSnoozeResult = { _, _ -> throw ApiError(409, "not_live") }
        press(0)
        assertNull(alert())
        setUp()
        api.pushReadResult = { _, _ -> throw ApiError(404, "notification_not_found") }
        press(1)
        assertNull(alert())
    }

    @Test fun other_404_keeps_alert() {
        // a 404 that isn't the API's "no such notification" (a proxy, an older server) proves nothing
        api.pushReadResult = { _, _ -> throw ApiError(404, "not_found") }
        press(1)
        assertNotNull(alert())
        api.pushSnoozeResult = { _, _ -> throw ApiError(404, "http_404") }
        press(0)
        assertNotNull(alert())
        assertTrue(store.hasKey())
    }

    @Test fun key_store_that_throws_keeps_alert_and_never_crashes() {
        // the Keystore-backed store failing on a lock-screen press: no crash, nothing sent, alert kept
        val broken = PushKeyStore(object : SecretStore {
            override fun get(key: String): String? = throw GeneralSecurityException("keystore locked")
            override fun put(key: String, value: String) = throw GeneralSecurityException("keystore locked")
            override fun remove(key: String) = throw GeneralSecurityException("keystore locked")
        })
        val failing = PushActions(api, broken, apiBase = { base }, io = Dispatchers.Unconfined, timeoutMillis = 200)
        // the app's scope has no handler; this one only records what would have crashed the app
        val escaped = mutableListOf<Throwable>()
        val brokenReceiver = object : PushActionReceiver() {
            override fun actions(context: Context): PushActions = failing
            override fun scope(context: Context): CoroutineScope =
                CoroutineScope(work + Dispatchers.Unconfined + CoroutineExceptionHandler { _, e -> escaped += e })
        }
        val intent: Intent = shadowOf(alert()!!.actions[1].actionIntent).savedIntent
        brokenReceiver.onReceive(app, intent)
        runBlocking { work.children.toList().joinAll() }
        assertEquals(emptyList<Throwable>(), escaped)
        assertEquals(emptyList<String>(), api.calls)
        assertNotNull(alert())
        assertFalse(runBlocking { failing.run(PushActionReceiver.ACTION_SNOOZE, id) })
        // a refused key the store can't clear is still just "keep the alert"
        val kept = MemorySecretStore().apply {
            put(PushKeyStore.KEY, "push-key-1")
            put(PushKeyStore.REGISTRATION_ID, "reg-1")
            put(PushKeyStore.PERSON_ID, "p1")
            put(PushKeyStore.ORIGIN, "https://api.example.com:443")
        }
        val clearFails = PushActions(api, PushKeyStore(object : SecretStore {
            override fun get(key: String): String? = kept.get(key)
            override fun put(key: String, value: String) = kept.put(key, value)
            override fun remove(key: String) = throw GeneralSecurityException("keystore locked")
        }), apiBase = { base }, io = Dispatchers.Unconfined, timeoutMillis = 200)
        api.pushReadResult = { _, _ -> throw ApiError(401, "push_key_invalid") }
        assertFalse(runBlocking { clearFails.run(PushActionReceiver.ACTION_READ, id) })
    }

    @Test fun invalid_key_clears_store_and_keeps_alert() {
        api.pushReadResult = { _, _ -> throw ApiError(401, "push_key_invalid") }
        press(1)
        assertNotNull(alert())
        assertFalse(store.hasKey())
    }

    @Test fun no_key_keeps_alert_and_calls_nothing() {
        store.clear()
        press(0)
        assertEquals(emptyList<String>(), api.calls)
        assertNotNull(alert())
    }

    @Test fun unknown_action_or_missing_id_does_nothing() {
        receiver.onReceive(app, Intent(app, PushActionReceiver::class.java).setAction("something.else").putExtra(PushActionReceiver.EXTRA_NOTIFICATION_ID, id))
        receiver.onReceive(app, Intent(app, PushActionReceiver::class.java).setAction(PushActionReceiver.ACTION_READ))
        assertEquals(emptyList<String>(), api.calls)
        assertNotNull(alert())
    }
}
