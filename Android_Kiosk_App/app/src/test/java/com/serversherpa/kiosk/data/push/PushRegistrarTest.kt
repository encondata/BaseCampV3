package com.serversherpa.kiosk.data.push

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.core.model.PushRegistration
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import kotlinx.coroutines.CancellationException
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
    /** The signed-in person. */
    private var me: String? = "p1"
    private val registrar = registrar(fcm)

    private fun registrar(tokens: FcmTokens) =
        PushRegistrar(api, store, tokens, apiBase = { apiBase }, personId = { me }, io = Dispatchers.Unconfined)

    private fun refusal(reason: String) =
        ApiError(422, "not_eligible", buildJsonObject { put("code", JsonPrimitive("not_eligible")); put("reason", JsonPrimitive(reason)) })

    /** A key Tina's (p1) registration stored. */
    private fun storeKey() = store.save("reg-1", "push-key-1", "https://api.example.com:443", "p1")

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
        assertEquals("p1", store.personId())
        assertFalse("the key never reaches a log line", key.toString().contains("push-key-1"))
    }

    @Test fun turnOn_cancelled_token_task_is_a_failure() = runBlocking {
        // FCM canceling its own work is not this coroutine being canceled.
        fcm.tokenResult = { throw CancellationException("fcm task canceled") }
        val failed = registrar.turnOn().exceptionOrNull() as PushSetupFailed
        assertTrue(failed.state.on)
        assertNull(store.get(base))
    }

    // ── check(): each Settings open, and each sign-in / start once the session is bound ──

    @Test fun check_on_but_not_registered_registers_silently() = runBlocking {
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Tina T", pushRegistered = false) }
        assertEquals(PersonalState(on = true, ownerName = "Tina T", pushRegistered = true), registrar.check())
        assertEquals(listOf("getPersonal", "registerPush"), api.calls)
        assertEquals("reg-1", store.get(base)?.registrationId)
        assertEquals("p1", store.personId())
    }

    @Test fun check_registered_with_a_local_key_does_nothing_more() = runBlocking {
        storeKey()
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Tina T", pushRegistered = true) }
        assertTrue(registrar.check().pushRegistered)
        assertEquals(listOf("getPersonal"), api.calls)
        assertEquals(0, fcm.tokenCalls)
    }

    @Test fun check_registered_but_no_local_key_registers_again() = runBlocking {
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Tina T", pushRegistered = true) }
        assertTrue(registrar.check().pushRegistered)
        assertEquals(listOf("getPersonal", "registerPush"), api.calls)
        assertEquals("reg-1", store.get(base)?.registrationId)
    }

    @Test fun check_key_for_another_origin_registers_again() = runBlocking {
        store.save("reg-0", "old-key", "https://old.example.com:443", "p1")
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Tina T", pushRegistered = true) }
        registrar.check()
        assertEquals(listOf("getPersonal", "registerPush"), api.calls)
        assertEquals("reg-1", store.get(base)?.registrationId)
    }

    @Test fun check_without_firebase_does_not_register() = runBlocking {
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Tina T", pushRegistered = false) }
        val noFirebase = registrar(NoFcmTokens)
        assertFalse(noFirebase.pushAvailable)
        assertEquals(PersonalState(on = true, ownerName = "Tina T", pushRegistered = false), noFirebase.check())
        assertEquals(listOf("getPersonal"), api.calls)
    }

    @Test fun check_registration_failure_reports_not_registered_and_retries_next_time() = runBlocking {
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Tina T", pushRegistered = true) }
        api.registerPushResult = { throw ApiError(0, "network") }
        assertFalse("no local key: push isn't really set up", registrar.check().pushRegistered)
        api.registerPushResult = { PushRegistration("reg-2", "push-key-2") }
        assertTrue(registrar.check().pushRegistered)
        assertEquals("reg-2", store.get(base)?.registrationId)
    }

    @Test fun check_no_longer_on_clears_store_and_deletes_token() = runBlocking {
        storeKey()
        api.getPersonalResult = { PersonalState(on = false, ownerName = null) }   // released in the portal
        assertFalse(registrar.check().on)
        assertNull(store.get(base))
        assertFalse(store.hasKey())
        assertEquals(1, fcm.deletes)
        assertEquals(listOf("getPersonal"), api.calls)
    }

    @Test fun check_reassigned_away_from_the_signed_in_owner_clears_store() = runBlocking {
        storeKey()
        api.getPersonalResult = { PersonalState(on = false, ownerName = "Sam S") }
        registrar.check()
        assertFalse(store.hasKey())
        assertEquals(1, fcm.deletes)
    }

    @Test fun check_by_another_admin_on_the_owners_phone_keeps_the_owners_key() = runBlocking {
        storeKey()
        me = "p2"
        api.getPersonalResult = { PersonalState(on = false, ownerName = "Tina T") }
        registrar.check()
        assertEquals("reg-1", store.get(base)?.registrationId)
        assertEquals(0, fcm.deletes)
    }

    @Test fun check_no_longer_on_without_a_key_touches_nothing() = runBlocking {
        api.getPersonalResult = { PersonalState(on = false, ownerName = null) }
        registrar.check()
        assertEquals(0, fcm.deletes)
    }

    @Test fun check_phone_now_another_admins_registers_for_them() = runBlocking {
        storeKey()
        me = "p2"
        api.getPersonalResult = { PersonalState(on = true, ownerName = "Sam S", pushRegistered = false) }
        assertTrue(registrar.check().pushRegistered)
        assertEquals("p2", store.personId())
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
        val result = registrar(NoFcmTokens).turnOn()
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
