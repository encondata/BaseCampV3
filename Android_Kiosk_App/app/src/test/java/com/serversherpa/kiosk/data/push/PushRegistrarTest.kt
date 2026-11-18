package com.serversherpa.kiosk.data.push

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.core.model.PushRegistration
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistrarTest {
    private val base = "https://api.example.com"
    private val api = FakeKioskApi()
    private val secrets = MemorySecretStore()
    private val store = PushKeyStore(secrets)
    private val fcm = FakeFcmTokens()
    private var apiBase = base
    private val registrar = PushRegistrar(api, store, fcm, apiBase = { apiBase }, io = Dispatchers.Unconfined)

    private fun refusal(reason: String) =
        ApiError(422, "not_eligible", buildJsonObject { put("code", JsonPrimitive("not_eligible")); put("reason", JsonPrimitive(reason)) })

    private fun storeKey() = store.save("reg-1", "push-key-1", "https://api.example.com:443")

    @Test fun turnOn_registers_and_stores_key() = runBlocking {
        api.setPersonalResult = { on -> PersonalState(on = on, ownerName = "Tina T") }
        api.registerPushResult = { PushRegistration(registrationId = "reg-1", pushKey = "push-key-1") }
        val result = registrar.turnOn()
        assertEquals(PersonalState(on = true, ownerName = "Tina T", pushRegistered = true), result.getOrThrow())
        assertEquals(listOf("setPersonal:true", "registerPush"), api.calls)
        assertEquals(listOf("fcm-token-1"), api.pushRegistrations)
        val key = store.get(base)!!
        assertEquals("reg-1", key.registrationId)
        assertEquals("push-key-1", key.key)
        assertEquals("PushKey reg-1.push-key-1", key.header)
        assertFalse("the key never reaches a log line", key.toString().contains("push-key-1"))
    }

    @Test fun turnOn_refused_keeps_nothing() = runBlocking {
        api.setPersonalResult = { throw refusal("owned_by_other") }
        val result = registrar.turnOn()
        val error = result.exceptionOrNull() as ApiError
        assertEquals("not_eligible", error.code)
        assertEquals("owned_by_other", error.detailString("reason"))
        assertEquals(listOf("setPersonal:true"), api.calls)
        assertEquals(0, fcm.tokenCalls)
        assertNull(store.get(base))
        assertNull(secrets.get(PushKeyStore.KEY))
    }

    @Test fun turnOn_without_firebase_keeps_the_phone_claimed() = runBlocking {
        val noFirebase = PushRegistrar(api, store, NoFcmTokens, apiBase = { apiBase }, io = Dispatchers.Unconfined)
        val result = noFirebase.turnOn()
        val failed = result.exceptionOrNull() as PushSetupFailed
        assertTrue("the phone is still claimed", failed.state.on)
        assertFalse(failed.state.pushRegistered)
        assertTrue(failed.cause is PushUnavailable)
        assertEquals(listOf("setPersonal:true"), api.calls)
        assertNull(store.get(base))
    }

    @Test fun turnOn_register_refused_keeps_no_key() = runBlocking {
        api.registerPushResult = { throw ApiError(409, "token_conflict") }
        val failed = registrar.turnOn().exceptionOrNull() as PushSetupFailed
        assertTrue(failed.state.on)
        assertEquals("token_conflict", (failed.cause as ApiError).code)
        assertNull(store.get(base))
    }

    @Test fun turnOff_clears_store_and_deletes_token() = runBlocking {
        storeKey()
        val result = registrar.turnOff()
        assertEquals(PersonalState(on = false, ownerName = null, pushRegistered = false), result.getOrThrow())
        assertEquals(listOf("setPersonal:false"), api.calls)
        assertNull(store.get(base))
        assertNull(secrets.get(PushKeyStore.KEY))
        assertNull(secrets.get(PushKeyStore.REGISTRATION_ID))
        assertEquals(1, fcm.deletes)
    }

    @Test fun turnOff_refused_keeps_the_key() = runBlocking {
        storeKey()
        api.setPersonalResult = { throw refusal("not_owner") }
        assertTrue(registrar.turnOff().isFailure)
        assertEquals("reg-1", store.get(base)?.registrationId)
        assertEquals(0, fcm.deletes)
    }

    @Test fun onNewToken_with_stored_key_sends_token() = runBlocking {
        storeKey()
        registrar.onNewToken("fcm-token-2")
        assertEquals(listOf("updatePushToken"), api.calls)
        val (token, key) = api.pushTokenUpdates.single()
        assertEquals("fcm-token-2", token)
        assertEquals("PushKey reg-1.push-key-1", key.header)
        assertEquals(base, key.baseUrl)
        assertFalse(store.retryPending())
    }

    @Test fun onNewToken_without_key_does_nothing() = runBlocking {
        registrar.onNewToken("fcm-token-2")
        assertTrue(api.calls.isEmpty())
        assertFalse(store.retryPending())
    }

    @Test fun onNewToken_key_from_another_origin_is_dropped_not_sent() = runBlocking {
        storeKey()
        apiBase = "https://other.example.com"
        registrar.onNewToken("fcm-token-2")
        assertTrue(api.calls.isEmpty())
        apiBase = base
        assertNull("the key never goes to another server", store.get(base))
    }

    @Test fun onNewToken_invalid_key_drops_it_and_stops() = runBlocking {
        storeKey()
        api.updatePushTokenResult = { _, _ -> throw ApiError(401, "push_key_invalid") }
        registrar.onNewToken("fcm-token-2")
        assertNull(store.get(base))
        assertFalse("no retry: refusals are capped per address", store.retryPending())
        registrar.onAppStart()
        assertEquals(listOf("updatePushToken"), api.calls)
    }

    @Test fun onNewToken_network_failure_retries_on_next_start() = runBlocking {
        storeKey()
        api.updatePushTokenResult = { _, _ -> throw ApiError(0, "network") }
        registrar.onNewToken("fcm-token-2")
        assertTrue(store.retryPending())
        assertEquals("reg-1", store.get(base)?.registrationId)
        api.updatePushTokenResult = { _, _ -> }
        fcm.tokenResult = { "fcm-token-3" }
        registrar.onAppStart()
        assertEquals("fcm-token-3", api.pushTokenUpdates.last().first)
        assertFalse(store.retryPending())
    }

    @Test fun onAppStart_read_only_keeps_retrying() = runBlocking {
        storeKey()
        api.updatePushTokenResult = { _, _ -> throw ApiError(423, "read_only_mode") }
        registrar.onNewToken("fcm-token-2")
        registrar.onAppStart()
        assertEquals(2, api.pushTokenUpdates.size)
        assertTrue(store.retryPending())
    }

    @Test fun onAppStart_without_a_pending_retry_does_nothing() = runBlocking {
        storeKey()
        registrar.onAppStart()
        assertTrue(api.calls.isEmpty())
        assertEquals(0, fcm.tokenCalls)
    }
}
